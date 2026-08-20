/*
 * Framework-light reducer and observable store. Everything below `useAppState`
 * runs without a DOM; the React binding uses only portable hooks.
 */

import { useEffect, useState } from "react";

import {
  isSseFrame,
  isSseReplayGap,
  type AgentDto,
  type ChatMessageDto,
  type Message,
  type Part,
  type PermissionDto,
  type ProviderDto,
  type SessionInfoDto,
  type SessionStatus,
  type SseFrame,
  type SseReplayGap,
} from "./protocol";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "unpaired";

export type ModelRef = { providerID: string; modelID: string };

export interface AppState {
  connection: ConnectionState;
  messages: ChatMessageDto[];
  agents: AgentDto[];
  providers: ProviderDto[];
  nextAgent?: string;
  nextModel?: ModelRef;
  permission?: PermissionDto;
  sessionStatus: SessionStatus;
  session?: SessionInfoDto;
  /** Highest SSE event id applied. Replay resumes from here. */
  lastEventId: number;
  /**
   * Bumped whenever the transcript must be refetched wholesale (replay gap or
   * `session.compacted`). Consumers watch the number, not a boolean, so two
   * gaps in a row cannot be collapsed into one refetch.
   */
  refetchToken: number;
  /** Last non-fatal error text (e.g. `session.error`). */
  error?: string;
}

export const initialAppState: AppState = {
  connection: "connecting",
  messages: [],
  agents: [],
  providers: [],
  sessionStatus: { type: "idle" },
  lastEventId: 0,
  refetchToken: 0,
};

type AppAction =
  | { type: "connection/set"; connection: ConnectionState }
  | { type: "state/loaded"; session?: SessionInfoDto; agent?: string; model?: ModelRef }
  | { type: "messages/loaded"; messages: ChatMessageDto[] }
  | { type: "agents/loaded"; agents: AgentDto[] }
  | { type: "providers/loaded"; providers: ProviderDto[] }
  | { type: "next/agent"; agent?: string }
  | { type: "next/model"; model?: ModelRef }
  | { type: "permission/cleared"; id?: string }
  | { type: "permission/restored"; permission: PermissionDto }
  | { type: "lastEventId/set"; id: number }
  | { type: "refetch/requested" }
  | { type: "error/set"; error?: string }
  | { type: "sse/frame"; frame: SseFrame }
  | { type: "sse/gap" };

/* ------------------------------------------------------------------ wire -- */

/**
 * Parses one SSE `data:` payload using the shared protocol guards.
 *
 * ⚠️ THE ID LIVES ON THE WIRE, NOT IN THE PAYLOAD. The server writes
 * `id: <n>\ndata: {"event":…,"data":…}` — verified in tests/http.test.ts, which
 * asserts the payload does NOT contain `"id":`. So `id` is supplied by the
 * caller from the `id:` line (`MessageEvent.lastEventId`); a payload that
 * carries its own id is still accepted so replayed test fixtures keep working.
 *
 * The replay gap arrives as `data: {"gap":true}` with NO `id:` line — an id
 * would corrupt the browser's `Last-Event-ID` cursor — so callers must treat a
 * gap as "refetch everything" and leave `lastEventId` untouched.
 */
export function parseSseData(raw: string, id = 0): SseFrame | SseReplayGap | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (isSseReplayGap(payload)) return payload;
  if (isSseFrame(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const stamped = { id, ...(payload as Record<string, unknown>) };
  return isSseFrame(stamped) ? stamped : null;
}

/** Boundary helper: raw wire text (plus its `id:` line) in, next state out. */
export function applyWireData(state: AppState, raw: string, id = 0): AppState {
  const parsed = parseSseData(raw, id);
  if (!parsed) return state;
  if (isSseReplayGap(parsed)) return reduce(state, { type: "sse/gap" });
  return reduce(state, { type: "sse/frame", frame: parsed });
}

/* --------------------------------------------------------------- helpers -- */

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** `message.updated` carries `{ info: Message }`; tolerate a bare Message too. */
function readMessage(data: unknown): Message | undefined {
  const outer = record(data);
  if (!outer) return undefined;
  const candidate = record(outer.info) ?? outer;
  return typeof candidate.id === "string" ? (candidate as unknown as Message) : undefined;
}

/** `message.part.updated` carries `{ part: Part; delta?: string }`. */
function readPart(data: unknown): Part | undefined {
  const outer = record(data);
  if (!outer) return undefined;
  const candidate = record(outer.part) ?? outer;
  return typeof candidate.id === "string" && typeof candidate.messageID === "string"
    ? (candidate as unknown as Part)
    : undefined;
}

function readStatus(data: unknown): SessionStatus | undefined {
  const outer = record(data);
  if (!outer) return undefined;
  const candidate = record(outer.status) ?? outer;
  return typeof candidate.type === "string" ? (candidate as unknown as SessionStatus) : undefined;
}

function readPermission(data: unknown): PermissionDto | undefined {
  const outer = record(data);
  if (!outer) return undefined;
  const candidate = record(outer.permission) ?? outer;
  if (typeof candidate.id !== "string") return undefined;
  return {
    id: candidate.id,
    sessionID: typeof candidate.sessionID === "string" ? candidate.sessionID : "",
    title: typeof candidate.title === "string" ? candidate.title : "Permission requested",
    metadata: record(candidate.metadata),
  };
}

/**
 * `session.error` is relayed verbatim from opencode, whose payload is
 * `{ sessionID?, error: { name, data?: { message? } } }` — an OBJECT, not a
 * string. The NAME is the only machine-readable part (`ProviderAuthError`,
 * `MessageAbortedError`, …) and the app maps it to a human sentence, so it must
 * survive into the store. A bare string payload is still accepted.
 */
function readError(data: unknown): string {
  const outer = record(data);
  const raw = outer?.error;
  if (typeof raw === "string" && raw !== "") return raw;
  const error = record(raw) ?? outer;
  const name = typeof error?.name === "string" ? error.name : undefined;
  const detail = record(error?.data);
  const message = typeof detail?.message === "string" ? detail.message : undefined;
  if (name && message) return `${name}: ${message}`;
  return name ?? message ?? "The session reported an error.";
}

function upsertMessage(messages: ChatMessageDto[], info: Message): ChatMessageDto[] {
  const index = messages.findIndex((entry) => entry.info.id === info.id);
  if (index === -1) return [...messages, { info, parts: [] }];
  const next = messages.slice();
  next[index] = { info, parts: messages[index]!.parts };
  return next;
}

/**
 * Appends (or replaces) a streaming part inside its owning message. opencode
 * re-emits the whole part as text grows, so an id match is an in-place replace.
 */
function upsertPart(messages: ChatMessageDto[], part: Part): ChatMessageDto[] {
  const index = messages.findIndex((entry) => entry.info.id === part.messageID);
  if (index === -1) return messages;
  const message = messages[index]!;
  const partIndex = message.parts.findIndex((entry) => entry.id === part.id);
  const parts = message.parts.slice();
  if (partIndex === -1) parts.push(part);
  else parts[partIndex] = part;
  const next = messages.slice();
  next[index] = { info: message.info, parts };
  return next;
}

function applyFrame(state: AppState, frame: SseFrame): AppState {
  switch (frame.event) {
    case "message.updated": {
      const info = readMessage(frame.data);
      return info ? { ...state, messages: upsertMessage(state.messages, info) } : state;
    }
    case "message.part.updated": {
      const part = readPart(frame.data);
      if (!part) return state;
      return { ...state, messages: upsertPart(state.messages, part) };
    }
    case "session.status": {
      const status = readStatus(frame.data);
      return status ? { ...state, sessionStatus: status } : state;
    }
    case "session.idle":
      return { ...state, sessionStatus: { type: "idle" } };
    case "session.error":
      return { ...state, error: readError(frame.data), sessionStatus: { type: "idle" } };
    case "permission.updated": {
      const permission = readPermission(frame.data);
      return permission ? { ...state, permission } : state;
    }
    case "permission.replied": {
      const data = record(frame.data);
      const id = typeof data?.permissionID === "string" ? data.permissionID : data?.id;
      if (!state.permission) return state;
      if (typeof id === "string" && state.permission.id !== id) return state;
      return { ...state, permission: undefined };
    }
    case "session.compacted":
      // The server rewrote history; only a full refetch can be trusted.
      return { ...state, refetchToken: state.refetchToken + 1 };
    default:
      return state;
  }
}

/* --------------------------------------------------------------- reducer -- */

export function reduce(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "connection/set":
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
    case "state/loaded":
      return {
        ...state,
        session: action.session ?? state.session,
        sessionStatus: action.session?.status ?? state.sessionStatus,
        nextAgent: action.agent ?? state.nextAgent,
        nextModel: action.model ?? state.nextModel,
      };
    case "messages/loaded":
      return { ...state, messages: action.messages };
    case "agents/loaded":
      return { ...state, agents: action.agents };
    case "providers/loaded":
      return { ...state, providers: action.providers };
    case "next/agent":
      return { ...state, nextAgent: action.agent };
    case "next/model":
      return { ...state, nextModel: action.model };
    case "permission/cleared":
      if (!state.permission) return state;
      if (action.id && state.permission.id !== action.id) return state;
      return { ...state, permission: undefined };
    case "permission/restored":
      // Undo of an optimistic clear whose reply never reached the server. A
      // newer request may have taken the slot while it was in flight; that one
      // is live and the stale restore must not clobber it.
      return state.permission ? state : { ...state, permission: action.permission };
    case "lastEventId/set":
      return action.id > state.lastEventId ? { ...state, lastEventId: action.id } : state;
    case "refetch/requested":
      return { ...state, refetchToken: state.refetchToken + 1 };
    case "error/set":
      return { ...state, error: action.error };
    case "sse/frame": {
      const applied = state.session && action.frame.sessionID !== state.session.id
        ? state
        : applyFrame(state, action.frame);
      return action.frame.id > applied.lastEventId
        ? { ...applied, lastEventId: action.frame.id }
        : applied;
    }
    case "sse/gap":
      // NOTE: `lastEventId` is intentionally NOT advanced. The gap frame has no
      // `id:` line on the wire, so advancing here would skip real events.
      return { ...state, refetchToken: state.refetchToken + 1 };
    default:
      return state;
  }
}

/* ----------------------------------------------------------------- store -- */

export interface AppStore {
  getState(): AppState;
  dispatch(action: AppAction): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
}

export function createAppStore(initial: AppState = initialAppState): AppStore {
  let state = initial;
  const listeners = new Set<(state: AppState) => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next !== state) {
        state = next;
        for (const listener of listeners) listener(state);
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Thin React binding. Any component can subscribe directly to the store, so
 * App never has to prop-drill connection state through the tree.
 */
export function useAppState(store: AppStore): AppState {
  const [state, setState] = useState<AppState>(() => store.getState());
  useEffect(() => {
    setState(store.getState());
    return store.subscribe(setState);
  }, [store]);
  return state;
}
