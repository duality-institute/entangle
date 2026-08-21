/*
 * Application assembly for API, store, stream, pagination, and optimistic sends.
 * Prompt POSTs are asynchronous, so local placeholders remain until matching
 * server messages arrive. Each server echo may retire exactly one placeholder.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import AbortButton from "./components/AbortButton";
import AgentPicker from "./components/AgentPicker";
import Composer from "./components/Composer";
import ModelPicker from "./components/ModelPicker";
import PermissionSheet, { type PermissionResponse } from "./components/PermissionSheet";
import StatusPill from "./components/StatusPill";
import { Transcript } from "./components/Transcript";
import UnpairedScreen from "./components/UnpairedScreen";
import { createStreamBuffer, useStreamBuffer } from "./components/streamBuffer";
import { useKeyboardInset } from "./hooks/useKeyboardInset";
import { ApiClient } from "./lib/api";
import { createAppStore, useAppState, type AppStore } from "./lib/appState";
import type { ChatMessageDto, Part, PermissionDto, PromptRequest } from "./lib/protocol";
import { createConnection } from "./lib/stream";

/** Scroll distance from the top that counts as a pull-down for older history. */
const PULL_SLOP = 24;

export interface PendingPrompt {
  correlationID: string;
  text: string;
}

/**
 * The correlation id doubles as the placeholder's style hook: `queued_` when the
 * prompt was typed while a turn was already running, `pending_` otherwise.
 * Encoding it in the id (which never changes for a given prompt) keeps the part
 * renderer untouched and free of a "pending" concept it has no business knowing.
 */
function correlationID(queued: boolean): string {
  return `${queued ? "queued" : "pending"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface Reconciliation {
  /** Placeholders still awaiting an echo, in send order. */
  pending: PendingPrompt[];
  /** Server message ids that each retired exactly one placeholder just now. */
  settled: string[];
}

/**
 * Retires one placeholder per unclaimed server echo, oldest echo first, matching
 * the oldest same-text placeholder. Pure: the caller owns `settled` and must fold
 * the returned ids into it, which is what stops an echo claiming a second bubble.
 */
export function reconcilePending(
  pending: PendingPrompt[],
  messages: ChatMessageDto[],
  settled: ReadonlySet<string>,
): Reconciliation {
  const remaining = [...pending];
  const claimed: string[] = [];

  for (const message of messages) {
    if (remaining.length === 0) break;
    if (message.info.role !== "user" || settled.has(message.info.id)) continue;
    const text = pendingText(message);
    const index = remaining.findIndex((prompt) => prompt.text === text);
    if (index === -1) continue;
    remaining.splice(index, 1);
    claimed.push(message.info.id);
  }

  return { pending: claimed.length === 0 ? pending : remaining, settled: claimed };
}

/**
 * opencode error names are stable identifiers; their `message` bodies are
 * stack-ish and often mention the desktop's filesystem. A phone cannot fix any
 * of these, so every sentence says what happened and where to go.
 */
function describeError(error: string): string {
  if (/auth/i.test(error)) return "provider auth failed — fix on your computer";
  if (/aborted/i.test(error)) return "the turn was stopped";
  if (/overload|rate.?limit|429/i.test(error)) return "the provider is overloaded — try again shortly";
  if (/output.?length|context|token/i.test(error)) return "the model ran out of room — start a new turn";
  return error;
}

function pendingText(message: ChatMessageDto): string {
  return message.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function placeholderMessage(
  prompt: PendingPrompt,
  sessionID: string,
  agent: string,
  model: { providerID: string; modelID: string },
): ChatMessageDto {
  const created = Date.now();
  return {
    info: {
      id: prompt.correlationID,
      sessionID,
      role: "user",
      time: { created },
      agent,
      model,
    },
    parts: [
      {
        id: `${prompt.correlationID}_text`,
        sessionID,
        messageID: prompt.correlationID,
        type: "text",
        text: prompt.text,
        time: { start: created },
      },
    ],
  };
}

/* ------------------------------------------------------ failing mutations -- */

/**
 * The sheet is cleared optimistically so approving feels instant, but a reply
 * that never reached the server must NOT look like an approval — the agent would
 * stay blocked forever behind a UI that says it went through. On failure the
 * request is put back and the error surfaces. Restoring a request the server did
 * in fact record is self-healing: its `permission.replied` frame clears it again.
 */
export async function respondToPermission(
  api: Pick<ApiClient, "respondPermission">,
  store: AppStore,
  response: PermissionResponse,
  target: PermissionDto,
): Promise<void> {
  store.dispatch({ type: "permission/cleared", id: target.id });
  try {
    await api.respondPermission(target.id, { response });
  } catch (error) {
    store.dispatch({ type: "permission/restored", permission: target });
    store.dispatch({ type: "error/set", error: (error as Error).message });
  }
}

/**
 * `200 {"aborted": false}` (nothing was running) resolves and stays silent; only
 * a genuine rejection — the server's `502` — reaches the banner. Without this the
 * status pill would sit on `busy` forever with no hint that the stop failed.
 *
 * Resolves `false` when the stop failed. The caller needs that because a failed
 * abort leaves the turn running: the session never leaves `busy`, so the button's
 * optimistic latch has nothing to release it and the user loses the only control
 * that can stop the turn.
 */
export async function abortTurn(
  api: Pick<ApiClient, "abort">,
  store: AppStore,
): Promise<boolean> {
  try {
    await api.abort();
    return true;
  } catch (error) {
    store.dispatch({ type: "error/set", error: (error as Error).message });
    return false;
  }
}

export default function App() {
  useKeyboardInset();

  const store = useMemo(() => createAppStore(), []);
  const buffer = useMemo(() => createStreamBuffer(), []);
  const state = useAppState(store);
  const streamTexts = useStreamBuffer(buffer);

  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [abortRearm, setAbortRearm] = useState(0);
  const [streamingPartID, setStreamingPartID] = useState<string | undefined>(undefined);

  const olderCursor = useRef<string | undefined>(undefined);
  const [scrollPort, setScrollPort] = useState<HTMLElement | null>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  // Server user messages that can no longer confirm a send: either they already
  // retired a placeholder, or they were on screen before the placeholder existed.
  const settled = useRef(new Set<string>());
  // Scroll fires many times per gesture; a state flag lands a render too late
  // to stop the second call, so the in-flight latch has to be a ref.
  const fetchingOlder = useRef(false);

  const api = useMemo(
    () =>
      new ApiClient({
        onUnauthorized: () => store.dispatch({ type: "connection/set", connection: "unpaired" }),
        // `createConnection` drops the pagination cursor (it only cares about the
        // newest page), so the ladder is kept here instead. A fetch with no cursor
        // is a fresh transcript and therefore resets it.
        onPage: (page, cursor) => {
          if (cursor === undefined) olderCursor.current = page.cursor;
        },
      }),
    [store],
  );

  const connection = useMemo(
    () =>
      createConnection({
        api,
        store,
        onPartFrame: (frame) => {
          const data = frame.data as { part?: Part; delta?: string } | null;
          const part = data?.part;
          if (!part?.id) return;
          const text = (part as { text?: unknown }).text;
          // The wire part already carries the accumulated text, so publishing it
          // is idempotent — a replayed frame cannot double-append a token.
          if (typeof text === "string") buffer.set(part.id, text);
          else if (data?.delta) buffer.append(part.id, data.delta);
          if (part.type === "text" || part.type === "reasoning") {
            setStreamingPartID((current) => (current === part.id ? current : part.id));
          }
        },
      }),
    [api, buffer, store],
  );

  useEffect(() => {
    let cancelled = false;
    void connection.start().finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
      connection.stop();
    };
  }, [connection]);

  const busy = state.sessionStatus.type === "busy" || state.sessionStatus.type === "retry";
  // Derived, never latched: two overlapping turns (a prompt queued while one is
  // running) produce busy→busy→idle→idle, so an effect watching the transition
  // clears the caret on the FIRST idle and leaves it stuck on the second turn.
  const activePartID = busy ? streamingPartID : undefined;

  // Reconcile: the server's copy of a prompt has landed, so drop that ONE
  // placeholder — the `settled` fold is what lets a second identical send survive.
  useEffect(() => {
    if (pending.length === 0) return;
    const reconciled = reconcilePending(pending, state.messages, settled.current);
    if (reconciled.settled.length === 0) return;
    for (const id of reconciled.settled) settled.current.add(id);
    setPending(reconciled.pending);
  }, [pending, state.messages]);

  const send = useCallback(
    (text: string) => {
      const prompt: PendingPrompt = { correlationID: correlationID(busy), text };
      // Text already on screen predates this prompt and cannot be its echo —
      // without this, re-sending old text would self-confirm instantly. An echo
      // whose parts have not landed yet is textless, so it stays claimable.
      for (const message of store.getState().messages) {
        if (message.info.role === "user" && pendingText(message) !== "") {
          settled.current.add(message.info.id);
        }
      }
      setPending((current) => [...current, prompt]);
      setSending(true);
      const request: PromptRequest = {
        text,
        ...(state.nextAgent ? { agent: state.nextAgent } : {}),
        ...(state.nextModel ? { model: state.nextModel } : {}),
      };
      void api
        .sendPrompt(request)
        .catch((error: Error) => {
          setPending((current) =>
            current.filter((entry) => entry.correlationID !== prompt.correlationID),
          );
          store.dispatch({ type: "error/set", error: error.message });
        })
        .finally(() => setSending(false));
    },
    [api, busy, state.nextAgent, state.nextModel, store],
  );

  const abort = useCallback(() => {
    void abortTurn(api, store).then((stopped) => {
      if (!stopped) setAbortRearm((token) => token + 1);
    });
  }, [api, store]);

  const loadOlder = useCallback(() => {
    const cursor = olderCursor.current;
    const node = scrollPort;
    if (!cursor || !node || fetchingOlder.current) return;
    fetchingOlder.current = true;
    setLoadingOlder(true);
    anchor.current = { height: node.scrollHeight, top: node.scrollTop };
    void api
      .getMessages(cursor)
      .then((page) => {
        olderCursor.current = page.cursor;
        const known = new Set(store.getState().messages.map((message) => message.info.id));
        const older = page.messages.filter((message) => !known.has(message.info.id));
        if (older.length === 0) {
          anchor.current = null;
          return;
        }
        // History arriving from the past cannot be the echo of a live send.
        for (const message of older) {
          if (message.info.role === "user") settled.current.add(message.info.id);
        }
        store.dispatch({
          type: "messages/loaded",
          messages: [...older, ...store.getState().messages],
        });
      })
      .catch(() => {
        anchor.current = null;
      })
      .finally(() => {
        fetchingOlder.current = false;
        setLoadingOlder(false);
      });
  }, [api, scrollPort, store]);

  // The transcript owns its scroll port and forwards the node; App only listens.
  useEffect(() => {
    const node = scrollPort;
    if (!node) return;
    const onScroll = () => {
      if (node.scrollTop <= PULL_SLOP) loadOlder();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [loadOlder, scrollPort]);

  // Prepending taller content moves everything under the reader's thumb. The
  // scroll offset is restored by the height delta BEFORE the browser paints.
  useLayoutEffect(() => {
    const node = scrollPort;
    const previous = anchor.current;
    if (!node || !previous) return;
    anchor.current = null;
    node.scrollTop = node.scrollHeight - previous.height + previous.top;
  }, [scrollPort, state.messages]);

  const sessionID = state.session?.id ?? "";
  const agent = state.nextAgent ?? "build";
  const providerID = state.nextModel?.providerID ?? "";
  const modelID = state.nextModel?.modelID ?? "";

  const messages = useMemo(
    () =>
      pending.length === 0
        ? state.messages
        : [
            ...state.messages,
            ...pending.map((prompt) =>
              placeholderMessage(prompt, sessionID, agent, { providerID, modelID }),
            ),
          ],
    [agent, modelID, pending, providerID, sessionID, state.messages],
  );

  const permission = state.permission;

  if (state.connection === "unpaired") {
    return <UnpairedScreen />;
  }

  return (
    <div className="app-shell" data-testid="app-shell" data-connection={state.connection}>
      <header className="app-header" data-testid="app-header">
        <div className="app-header__brand">
          <span className="rings rings--sm" aria-hidden="true" />
          <div className="app-header__titles">
            <span className="app-header__name">entangle</span>
            <span className="app-header__meta" data-testid="header-meta">
              {state.connection === "live"
                ? state.session?.title ?? "opencode bridge"
                : `${state.connection}…`}
            </span>
          </div>
        </div>
        <StatusPill status={state.sessionStatus} error={state.error} />
      </header>

      {state.error ? (
        <div className="error-banner" data-testid="error-banner" role="alert">
          <span className="error-banner__text">{describeError(state.error)}</span>
          <button
            type="button"
            className="error-banner__dismiss"
            data-testid="error-dismiss"
            aria-label="Dismiss error"
            onClick={() => store.dispatch({ type: "error/set", error: undefined })}
          >
            ✕
          </button>
        </div>
      ) : null}

      {loadingOlder ? (
        <div className="older-loader" data-testid="older-loading" role="status">
          loading earlier messages…
        </div>
      ) : null}

      <Transcript
        ref={setScrollPort}
        messages={messages}
        streamTexts={streamTexts}
        streamingPartID={activePartID}
        empty={hydrated ? <EmptyTranscript /> : <TranscriptSkeleton />}
      />

      <Composer
        disabled={!!permission || sending}
        submitDisabled={state.connection !== "live"}
        onSend={send}
        hint={busy ? "generation running — new prompts are queued" : undefined}
      >
        <AgentPicker
          agents={state.agents}
          value={state.nextAgent}
          onChange={(next) => store.dispatch({ type: "next/agent", agent: next })}
        />
        <ModelPicker
          providers={state.providers}
          value={state.nextModel}
          onChange={(next) => store.dispatch({ type: "next/model", model: next })}
        />
        <span className="composer__meta-spacer" />
        <AbortButton status={state.sessionStatus} onAbort={abort} rearmToken={abortRearm} />
      </Composer>

      <PermissionSheet
        permission={permission}
        onRespond={(response, target) => void respondToPermission(api, store, response, target)}
      />
    </div>
  );
}

function EmptyTranscript() {
  return (
    <div className="transcript__empty">
      <span className="rings rings--lg" aria-hidden="true" />
      <h1 className="transcript__empty-title">Paired and waiting</h1>
      <p className="transcript__empty-body">
        Your conversation will appear here once the session is connected.
      </p>
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="skeleton" data-testid="loading-skeleton" role="status" aria-label="Loading conversation">
      <span className="skeleton__bar skeleton__bar--user" />
      <span className="skeleton__bar" />
      <span className="skeleton__bar skeleton__bar--short" />
      <span className="skeleton__bar skeleton__bar--user" />
      <span className="skeleton__bar" />
    </div>
  );
}
