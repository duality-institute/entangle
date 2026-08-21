/*
 * entangle — SSE connection manager
 *
 * This module exists because of opencode issue #10721: iOS Safari silently
 * kills a backgrounded EventSource. `readyState` keeps reporting OPEN, no
 * `error` fires, and the conversation appears to roll back when the user
 * returns. Three mechanisms together are the fix:
 *
 *   1. lastEventId replay  — every reconnect resumes from the last applied id.
 *      `EventSource` cannot set headers, so we pass `?lastEventId=` (the server
 *      honours both that and the `Last-Event-ID` header).
 *   2. staleness watchdog  — the server's heartbeat data frames fire
 *      `onmessage`, which rearms the timer without entering application state.
 *      After 30s of true wire silence we probe `/api/state`: a 401 means
 *      unpaired (stop); otherwise we recycle the suspect socket. Recycling is
 *      lossless because replay refills the gap.
 *   3. visibilitychange    — close on hidden, reopen with replay on visible.
 *
 * Backoff is 1s → 2s → 4s → 8s → capped at 10s. A 401 stops retrying entirely.
 */

import { isSseReplayGap, type SseFrame } from "./protocol";
import { parseSseData, type AppStore, type ConnectionState } from "./appState";
import { ApiClient, UnauthorizedError } from "./api";

const STALE_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;

/** 1s, 2s, 4s, 8s, then flat 10s forever. */
export function backoffDelay(attempt: number): number {
  if (attempt <= 0) return BACKOFF_BASE_MS;
  if (attempt >= 30) return BACKOFF_MAX_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export type SseMessageLike = { data: string; lastEventId?: string };

/** Structural subset of `EventSource` — keeps this module DOM-lib free. */
export interface EventSourceLike {
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: SseMessageLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

type EventSourceFactory = (url: string) => EventSourceLike;

type TimerHandle = unknown;

export interface Timers {
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const realTimers: Timers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface VisibilityHost {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

function defaultEventSource(url: string): EventSourceLike {
  const ctor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
  if (!ctor) throw new Error("EventSource is unavailable in this environment");
  return new ctor(url);
}

function defaultVisibility(): VisibilityHost | undefined {
  const host = (globalThis as { document?: Partial<VisibilityHost> }).document;
  return host && typeof host.addEventListener === "function" ? (host as VisibilityHost) : undefined;
}

function numericId(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

interface StreamClientOptions {
  url?: string;
  lastEventId?: number;
  staleMs?: number;
  onFrame?(frame: SseFrame): void;
  /** Replay gap: refetch everything. `lastEventId` is NOT advanced. */
  onGap?(): void;
  onConnection?(state: ConnectionState): void;
  onLastEventId?(id: number): void;
  /** Liveness/auth probe. `false` means 401 → unpaired, stop retrying. */
  probe?(): Promise<boolean>;
  createEventSource?: EventSourceFactory;
  timers?: Timers;
  /** Pass `null` to disable visibility handling (tests, SSR). */
  visibility?: VisibilityHost | null;
}

export class StreamClient {
  private readonly url: string;
  private readonly staleMs: number;
  private readonly createEventSource: EventSourceFactory;
  private readonly timers: Timers;
  private readonly visibility: VisibilityHost | undefined;
  private readonly options: StreamClientOptions;

  private source: EventSourceLike | undefined;
  private staleTimer: TimerHandle;
  private retryTimer: TimerHandle;
  private started = false;
  private suspended = false;
  private attempt = 0;
  private connection: ConnectionState = "connecting";

  /** Highest applied event id; the replay cursor. */
  lastEventId: number;
  constructor(options: StreamClientOptions = {}) {
    this.options = options;
    this.url = options.url ?? "/api/events";
    this.staleMs = options.staleMs ?? STALE_TIMEOUT_MS;
    this.createEventSource = options.createEventSource ?? defaultEventSource;
    this.timers = options.timers ?? realTimers;
    this.visibility = options.visibility === null ? undefined : options.visibility ?? defaultVisibility();
    this.lastEventId = options.lastEventId ?? 0;
  }

  get connectionState(): ConnectionState {
    return this.connection;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.visibility?.addEventListener("visibilitychange", this.handleVisibility);
    this.open("connecting");
  }

  stop(): void {
    this.started = false;
    this.visibility?.removeEventListener("visibilitychange", this.handleVisibility);
    this.clearTimers();
    this.closeSource();
  }

  /** Manual reconnect (e.g. a "retry" button). Resets the backoff ladder. */
  reconnectNow(): void {
    if (!this.started || this.connection === "unpaired") return;
    this.attempt = 0;
    this.clearTimers();
    this.closeSource();
    this.open("reconnecting");
  }

  private buildUrl(): string {
    if (this.lastEventId <= 0) return this.url;
    // EventSource cannot set the Last-Event-ID header, hence the query param.
    const separator = this.url.includes("?") ? "&" : "?";
    return `${this.url}${separator}lastEventId=${this.lastEventId}`;
  }

  private open(state: ConnectionState): void {
    if (!this.started || this.suspended || this.connection === "unpaired") return;
    this.setConnection(state);
    const source = this.createEventSource(this.buildUrl());
    this.source = source;
    source.onopen = () => this.markAlive();
    source.onmessage = (event) => this.handleMessage(event);
    source.onerror = () => this.handleError();
    this.armWatchdog();
  }

  private handleMessage(event: SseMessageLike): void {
    this.markAlive();
    const wireId = numericId(event.lastEventId);
    const parsed = parseSseData(event.data, wireId ?? 0);
    if (!parsed) return;
    if (isSseReplayGap(parsed)) {
      // No `id:` line on the wire → the cursor must stay exactly where it was.
      this.options.onGap?.();
      return;
    }
    const id = wireId ?? parsed.id;
    if (id > this.lastEventId) {
      this.lastEventId = id;
      this.options.onLastEventId?.(id);
    }
    this.options.onFrame?.(parsed);
  }

  private handleError(): void {
    this.closeSource();
    if (!this.started || this.suspended || this.connection === "unpaired") return;
    this.setConnection("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.timers.clearTimeout(this.retryTimer);
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.started || this.suspended) return;
    if (this.options.probe) {
      const alive = await this.options.probe();
      if (!this.started || this.suspended) return;
      if (!alive) {
        this.setUnpaired();
        return;
      }
    }
    this.open("reconnecting");
  }

  /** Any message or open event proves the socket works: reset the ladder. */
  private markAlive(): void {
    this.attempt = 0;
    if (this.connection !== "unpaired") this.setConnection("live");
    this.armWatchdog();
  }

  private armWatchdog(): void {
    this.timers.clearTimeout(this.staleTimer);
    this.staleTimer = this.timers.setTimeout(() => {
      this.staleTimer = undefined;
      void this.handleStale();
    }, this.staleMs);
  }

  private async handleStale(): Promise<void> {
    if (!this.started || this.suspended || this.connection === "unpaired") return;
    if (this.options.probe) {
      const alive = await this.options.probe();
      if (!this.started || this.suspended) return;
      if (!alive) {
        this.setUnpaired();
        return;
      }
      // Server reachable but our socket has been silent: assume iOS killed it.
      // Replay makes recycling free, so recycle rather than trust readyState.
      this.closeSource();
      this.setConnection("reconnecting");
      this.open("reconnecting");
      return;
    }
    this.handleError();
  }

  private handleVisibility = (): void => {
    if (!this.started) return;
    if (this.visibility?.visibilityState === "hidden") {
      this.suspended = true;
      this.clearTimers();
      this.closeSource();
      return;
    }
    if (!this.suspended) return;
    this.suspended = false;
    if (this.connection === "unpaired") return;
    this.attempt = 0;
    this.open("reconnecting");
  };

  private setUnpaired(): void {
    this.clearTimers();
    this.closeSource();
    this.setConnection("unpaired");
    this.stop();
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.options.onConnection?.(state);
  }

  private clearTimers(): void {
    this.timers.clearTimeout(this.staleTimer);
    this.timers.clearTimeout(this.retryTimer);
    this.staleTimer = undefined;
    this.retryTimer = undefined;
  }

  private closeSource(): void {
    if (!this.source) return;
    const source = this.source;
    this.source = undefined;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
  }
}

/* ------------------------------------------------------------ controller -- */

interface ConnectionOptions {
  api: ApiClient;
  store: AppStore;
  /** Feeds the rAF buffer without going through a React render. */
  onPartFrame?(frame: SseFrame): void;
  stream?: Omit<StreamClientOptions, "onFrame" | "onGap" | "onConnection" | "onLastEventId" | "probe">;
}

export interface Connection {
  start(): Promise<void>;
  stop(): void;
  /** Full transcript refetch — used for replay gaps and `session.compacted`. */
  refresh(): Promise<void>;
  readonly client: StreamClient;
}

/**
 * Wires an `ApiClient` and an `AppStore` to a `StreamClient`.
 */
export function createConnection(options: ConnectionOptions): Connection {
  const { api, store } = options;
  let refreshing: Promise<void> | null = null;

  const toUnpaired = () => {
    store.dispatch({ type: "connection/set", connection: "unpaired" });
    client.stop();
  };

  const guard = async (work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        toUnpaired();
        return false;
      }
      store.dispatch({ type: "error/set", error: (error as Error).message });
      return false;
    }
  };

  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing;
    const request = guard(async () => {
      const { messages } = await api.getMessages();
      store.dispatch({ type: "messages/loaded", messages });
    })
      .then(() => undefined)
      .finally(() => {
        refreshing = null;
      });
    refreshing = request;
    return request;
  };

  const client = new StreamClient({
    ...options.stream,
    probe: () => api.probe(),
    onConnection: (connection) => store.dispatch({ type: "connection/set", connection }),
    onLastEventId: (id) => store.dispatch({ type: "lastEventId/set", id }),
    onGap: () => {
      store.dispatch({ type: "sse/gap" });
      void refresh();
    },
    onFrame: (frame) => {
      const before = store.getState().refetchToken;
      store.dispatch({ type: "sse/frame", frame });
      if (frame.event === "message.part.updated") options.onPartFrame?.(frame);
      // `session.compacted` bumps the token inside the reducer.
      if (store.getState().refetchToken !== before) void refresh();
    },
  });

  return {
    client,
    stop: () => client.stop(),
    refresh,
    async start() {
      store.dispatch({ type: "connection/set", connection: "connecting" });
      const loaded = await guard(async () => {
        const state = await api.getState();
        store.dispatch({
          type: "state/loaded",
          session: state.session,
          agent: state.agent,
          model: state.model,
        });
        if (typeof state.lastEventId === "number") {
          client.lastEventId = state.lastEventId;
          store.dispatch({ type: "lastEventId/set", id: state.lastEventId });
        }
        const [messages, agents, providers] = await Promise.all([
          api.getMessages(),
          api.getAgents(),
          api.getProviders(),
        ]);
        store.dispatch({ type: "messages/loaded", messages: messages.messages });
        store.dispatch({ type: "agents/loaded", agents });
        store.dispatch({ type: "providers/loaded", providers: providers.providers });
      });
      if (!loaded || store.getState().connection === "unpaired") return;
      client.start();
    },
  };
}
