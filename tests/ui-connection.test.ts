import { expect, test } from "bun:test"

import { MobileAuth } from "../src/server/auth"
import { EventHub } from "../src/server/events"
import { MobileServer, type MobileEvent } from "../src/server/http"
import * as shared from "../src/shared/protocol"
import { FakeBridge } from "./fixtures/fake-bridge"
import * as uiProtocol from "../ui/src/lib/protocol"
import { abortTurn, reconcilePending, respondToPermission, type PendingPrompt } from "../ui/src/App"
import { ApiClient, UnauthorizedError } from "../ui/src/lib/api"
import {
  applyWireData,
  createAppStore,
  initialAppState,
  parseSseData,
  reduce,
  type AppState,
} from "../ui/src/lib/appState"
import {
  backoffDelay,
  createConnection,
  StreamClient,
  type EventSourceLike,
  type SseMessageLike,
  type Timers,
  type VisibilityHost,
} from "../ui/src/lib/stream"

/* ----------------------------------------------------------------- mocks -- */

class FakeEventSource implements EventSourceLike {
  static readonly instances: FakeEventSource[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: SseMessageLike) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  static reset(): void {
    FakeEventSource.instances.length = 0
  }

  static get last(): FakeEventSource {
    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
    if (!source) throw new Error("no EventSource was created")
    return source
  }

  close(): void {
    this.closed = true
  }

  open(): void {
    this.onopen?.({})
  }

  /** Mirrors the browser: `lastEventId` carries over when a frame has no id. */
  emit(data: string, lastEventId = ""): void {
    this.onmessage?.({ data, lastEventId })
  }

  fail(): void {
    this.onerror?.({})
  }
}

class FakeTimers implements Timers {
  private seq = 0
  private readonly entries = new Map<number, { handler: () => void; ms: number }>()

  setTimeout(handler: () => void, ms: number): unknown {
    const id = ++this.seq
    this.entries.set(id, { handler, ms })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.entries.delete(handle)
  }

  /** Runs every pending timer whose delay matches `ms` (all when omitted). */
  fire(ms?: number): number {
    const due = [...this.entries.entries()].filter(([, entry]) => ms === undefined || entry.ms === ms)
    for (const [id, entry] of due) {
      this.entries.delete(id)
      entry.handler()
    }
    return due.length
  }

  get pendingDelays(): number[] {
    return [...this.entries.values()].map((entry) => entry.ms)
  }

  get scheduledCount(): number {
    return this.seq
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/* ------------------------------------------------------------- fixtures -- */

/** Exactly what the server writes after `data: ` for a real event. */
function wireFrame(id: number, event: string, data: unknown): string {
  return JSON.stringify({ id, sessionID: "ses_1", event, data })
}

/** The gap frame: `data: {"gap":true}\n\n` with NO `id:` line. */
const GAP_WIRE = JSON.stringify({ gap: true })

function textPart(id: string, messageID: string, text: string) {
  return { id, sessionID: "ses_1", messageID, type: "text" as const, text }
}

function assistantInfo(id: string) {
  return { id, sessionID: "ses_1", role: "assistant" }
}

function seededState(): AppState {
  return reduce(initialAppState, {
    type: "sse/frame",
    frame: { id: 1, sessionID: "ses_1", event: "message.updated", data: { info: assistantInfo("msg_1") } },
  })
}

/* ------------------------------------------------------------- protocol -- */

test("the browser-side SSE guards behave identically to the shared ones", () => {
  // ui/src/lib/protocol.ts mirrors the guards so rollup does not drag zod into
  // the phone bundle (+22 kB gz, measured). This locks the copy to the original.
  const inputs: unknown[] = [
    { gap: true },
    { gap: false },
    { gap: 1 },
    JSON.parse(GAP_WIRE),
    JSON.parse(wireFrame(1, "message.updated", { info: assistantInfo("m") })),
    JSON.parse(wireFrame(2, "message.part.updated", { part: textPart("p", "m", "x") })),
    JSON.parse(wireFrame(3, "session.status", {})),
    JSON.parse(wireFrame(4, "session.idle", {})),
    JSON.parse(wireFrame(5, "session.error", {})),
    JSON.parse(wireFrame(6, "permission.updated", {})),
    JSON.parse(wireFrame(7, "permission.replied", {})),
    JSON.parse(wireFrame(8, "session.compacted", {})),
    { id: 1, event: "nope.unknown", data: {} },
    { id: 1.5, event: "session.idle", data: {} },
    { id: "1", event: "session.idle", data: {} },
    { id: 1, event: "session.idle" },
    { event: "session.idle", data: {} },
    null,
    undefined,
    "gap",
    42,
    [],
  ]

  for (const input of inputs) {
    expect([input, uiProtocol.isSseFrame(input)]).toEqual([input, shared.isSseFrame(input)])
    expect([input, uiProtocol.isSseReplayGap(input)]).toEqual([input, shared.isSseReplayGap(input)])
  }
  for (const event of shared.SseEvents) {
    expect(uiProtocol.isSseFrame({ id: 1, sessionID: "ses_1", event, data: null })).toBe(true)
  }
})

/* ------------------------------------------------------------- reducer 1 -- */

test("connection transitions run connecting -> live -> reconnecting -> unpaired", () => {
  const store = createAppStore()
  const seen: string[] = []
  store.subscribe((state) => seen.push(state.connection))

  expect(store.getState().connection).toBe("connecting")
  store.dispatch({ type: "connection/set", connection: "live" })
  store.dispatch({ type: "connection/set", connection: "live" }) // no-op, no notify
  store.dispatch({ type: "connection/set", connection: "reconnecting" })
  store.dispatch({ type: "connection/set", connection: "unpaired" })

  expect(seen).toEqual(["live", "reconnecting", "unpaired"])
  expect(store.getState().connection).toBe("unpaired")
})

/* ------------------------------------------------------------- reducer 2 -- */

test("raw wire frames reach the store: message upsert then streaming part deltas", () => {
  const store = createAppStore()

  // Boundary test: feed the exact bytes the server writes after `data: `.
  store.dispatch({
    type: "sse/frame",
    frame: JSON.parse(wireFrame(7, "message.updated", { info: assistantInfo("msg_1") })),
  })
  for (const [id, text] of [
    [8, "Hel"],
    [9, "Hello wor"],
    [10, "Hello world"],
  ] as const) {
    store.dispatch({
      type: "sse/frame",
      frame: JSON.parse(wireFrame(id, "message.part.updated", { part: textPart("prt_1", "msg_1", text) })),
    })
  }

  const state = store.getState()
  expect(state.messages).toHaveLength(1)
  expect(state.messages[0]!.parts).toHaveLength(1)
  expect((state.messages[0]!.parts[0] as { text: string }).text).toBe("Hello world")
  expect(state.lastEventId).toBe(10)
})

test("a frame from another session cannot contaminate a loaded transcript", () => {
  const store = createAppStore()
  store.dispatch({
    type: "state/loaded",
    session: { id: "ses_1", title: "Pinned", status: { type: "idle" } },
  })
  store.dispatch({
    type: "sse/frame",
    frame: {
      id: 7,
      sessionID: "ses_other",
      event: "message.updated",
      data: { info: { ...assistantInfo("msg_foreign"), sessionID: "ses_other" } },
    },
  })

  expect(store.getState().messages).toEqual([])
  expect(store.getState().lastEventId).toBe(7)
  expect(store.getState().session?.id).toBe("ses_1")
})

/* ------------------------------------------------------------- reducer 3 -- */

test("gap frame requests a refetch and never advances lastEventId", () => {
  const store = createAppStore(seededState())
  store.dispatch({ type: "sse/frame", frame: { id: 42, sessionID: "ses_1", event: "session.idle", data: {} } })
  const before = store.getState()
  expect(before.lastEventId).toBe(42)

  // Parsed with the shared guards, straight off the wire.
  const parsed = parseSseData(GAP_WIRE)
  expect(parsed).toEqual({ gap: true })

  const after = applyWireData(before, GAP_WIRE)
  expect(after.lastEventId).toBe(42) // MUST NOT move: the gap frame carries no id
  expect(after.refetchToken).toBe(before.refetchToken + 1)
})

/* ------------------------------------------------------------- reducer 4 -- */

test("session.status, permission lifecycle and session.compacted are applied", () => {
  let state = seededState()

  state = applyWireData(state, wireFrame(2, "session.status", { sessionID: "ses_1", status: { type: "busy" } }))
  expect(state.sessionStatus).toEqual({ type: "busy" })

  state = applyWireData(
    state,
    wireFrame(3, "permission.updated", { id: "perm_1", sessionID: "ses_1", title: "Run rm -rf" }),
  )
  expect(state.permission?.title).toBe("Run rm -rf")

  state = applyWireData(
    state,
    wireFrame(4, "permission.replied", { sessionID: "ses_1", permissionID: "perm_1", response: "once" }),
  )
  expect(state.permission).toBeUndefined()

  const before = state.refetchToken
  state = applyWireData(state, wireFrame(5, "session.compacted", { sessionID: "ses_1" }))
  expect(state.refetchToken).toBe(before + 1)
  expect(state.lastEventId).toBe(5)

  // Garbage on the wire must not throw or mutate.
  expect(applyWireData(state, "not json")).toBe(state)
  expect(applyWireData(state, JSON.stringify({ id: "nope", event: "message.updated" }))).toBe(state)
})

/* --------------------------------------------------------- optimistic 1 -- */

/** The server's echo of a user prompt, shaped as `/api/messages` returns it. */
function userEcho(id: string, text: string): shared.ChatMessageDto {
  return {
    info: {
      id,
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude" },
    },
    parts: [textPart(`${id}_prt`, id, text)],
  } as unknown as shared.ChatMessageDto
}

/*
 * The bug this locks: reconciling by TEXT made the first echo of "continue"
 * retire BOTH placeholders, so the second bubble vanished until its own
 * message.updated landed. One echo may retire exactly one placeholder.
 */
test("two identical-text sends are retired one echo at a time, in order", () => {
  const first: PendingPrompt = { correlationID: "pending_a", text: "continue" }
  const second: PendingPrompt = { correlationID: "queued_b", text: "continue" }
  const settled = new Set<string>()

  const afterFirst = reconcilePending([first, second], [userEcho("msg_1", "continue")], settled)
  expect(afterFirst.pending).toEqual([second]) // the OLDER bubble goes first
  expect(afterFirst.settled).toEqual(["msg_1"])
  for (const id of afterFirst.settled) settled.add(id)

  // Every part frame re-renders with the same echo present: strictly a no-op,
  // and the identical array is returned so React skips the update entirely.
  const replay = reconcilePending(afterFirst.pending, [userEcho("msg_1", "continue")], settled)
  expect(replay.pending).toBe(afterFirst.pending)
  expect(replay.settled).toEqual([])

  const afterSecond = reconcilePending(
    afterFirst.pending,
    [userEcho("msg_1", "continue"), userEcho("msg_2", "continue")],
    settled,
  )
  expect(afterSecond.pending).toEqual([])
  expect(afterSecond.settled).toEqual(["msg_2"]) // never msg_1 again
})

/* --------------------------------------------------------- optimistic 2 -- */

test("reconciliation matches per correlation id and ignores assistant traffic", () => {
  const alpha: PendingPrompt = { correlationID: "pending_a", text: "alpha" }
  const beta: PendingPrompt = { correlationID: "pending_b", text: "beta" }

  // An assistant reply quoting the prompt must never retire a bubble.
  const noise = {
    info: assistantInfo("msg_bot"),
    parts: [textPart("prt_bot", "msg_bot", "alpha")],
  } as unknown as shared.ChatMessageDto
  const untouched = reconcilePending([alpha, beta], [noise], new Set())
  expect(untouched.pending).toEqual([alpha, beta])
  expect(untouched.settled).toEqual([])

  // Out-of-order echoes retire their own text, not their position.
  const result = reconcilePending([alpha, beta], [userEcho("msg_2", "beta")], new Set())
  expect(result.pending).toEqual([alpha])
  expect(result.settled).toEqual(["msg_2"])
})

/* ----------------------------------------------------------------- api 1 -- */

test("401 flips the app to unpaired once and never retries", async () => {
  let calls = 0
  const store = createAppStore()
  const api = new ApiClient({
    fetch: async () => {
      calls++
      return json({ error: "unpaired" }, 401)
    },
    onUnauthorized: () => store.dispatch({ type: "connection/set", connection: "unpaired" }),
  })

  await expect(api.getState()).rejects.toBeInstanceOf(UnauthorizedError)
  expect(store.getState().connection).toBe("unpaired")
  expect(calls).toBe(1)

  // Latched: further calls fail locally without touching the network.
  await expect(api.getMessages()).rejects.toBeInstanceOf(UnauthorizedError)
  await expect(api.sendPrompt({ text: "hi" })).rejects.toBeInstanceOf(UnauthorizedError)
  expect(calls).toBe(1)
  expect(await api.probe()).toBe(false)
})

/* ----------------------------------------------------------------- api 2 -- */

test("POSTs carry the CSRF header from /api/state with same-origin credentials", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const api = new ApiClient({
    fetch: async (url, init = {}) => {
      seen.push({ url, init })
      if (url === "/api/state") return json({ csrf: "tok-123", session: { id: "ses_1", status: { type: "idle" } } })
      return json({ ok: true })
    },
  })

  await api.sendPrompt({ text: "hello", agent: "build" })
  await api.abort()
  await api.respondPermission("perm/1", { response: "once" })

  expect(seen.map((entry) => entry.url)).toEqual([
    "/api/state",
    "/api/prompt",
    "/api/abort",
    "/api/permissions/perm%2F1",
  ])
  for (const entry of seen) expect(entry.init.credentials).toBe("same-origin")
  for (const entry of seen.slice(1)) {
    const headers = entry.init.headers as Record<string, string>
    expect(headers["X-Entangle-CSRF"]).toBe("tok-123")
    expect(headers["X-Entangle-Session"]).toBe("ses_1")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(entry.init.method).toBe("POST")
  }
  // The GET must not carry a CSRF header.
  expect((seen[0]!.init.headers as Record<string, string>)["X-Entangle-CSRF"]).toBeUndefined()
  expect(JSON.parse(seen[1]!.init.body as string)).toEqual({ text: "hello", agent: "build" })
})

test("history response from another session is rejected before reaching the store", async () => {
  const api = new ApiClient({
    fetch: async (url) => {
      if (url === "/api/state") {
        return json({ csrf: "tok", session: { id: "ses_1", title: "Pinned", status: { type: "idle" } } })
      }
      return json({ sessionID: "ses_other", messages: [] })
    },
  })

  await api.getState()
  await expect(api.getMessages()).rejects.toThrow("Session changed while loading history")
})

test("an existing client stops when its authentication cookie is rebound to another chat", async () => {
  let sessionID = "ses_1"
  let unpaired = 0
  const api = new ApiClient({
    fetch: async () => json({
      csrf: "tok",
      session: { id: sessionID, title: sessionID, status: { type: "idle" } },
    }),
    onUnauthorized: () => {
      unpaired += 1
    },
  })

  await api.getState()
  sessionID = "ses_other"

  await expect(api.getState()).rejects.toThrow("paired to another chat")
  expect(unpaired).toBe(1)
  expect(await api.probe()).toBe(false)
})

/* --------------------------------------------------------- mutations 1 -- */

/** A store already showing a permission sheet, seeded off the real wire guard. */
function storeAwaitingPermission(id = "perm_1", title = "Run rm -rf /") {
  const store = createAppStore()
  store.dispatch({
    type: "sse/frame",
    frame: { id: 1, sessionID: "ses_1", event: "permission.updated", data: { id, sessionID: "ses_1", title } },
  })
  return store
}

/** Serves CSRF from /api/state and hands every mutation to `reply`. */
function mutationApi(reply: () => Response): ApiClient {
  return new ApiClient({
    fetch: async (url) =>
      url === "/api/state"
        ? json({ csrf: "tok", session: { id: "ses_1", status: { type: "idle" } } })
        : reply(),
  })
}

/*
 * The defect this locks: `permission/cleared` dispatches BEFORE the request, so
 * a failed reply used to leave the sheet gone and the composer re-enabled while
 * the server had recorded nothing — the agent stays blocked forever behind a UI
 * that says the approval went through.
 */
test("a failed permission reply restores the request and surfaces the error", async () => {
  const store = storeAwaitingPermission()
  const target = store.getState().permission!
  const api = mutationApi(() => json({ error: "bridge unavailable" }, 502))

  await respondToPermission(api, store, "once", target)

  const after = store.getState()
  expect(after.permission).toEqual(target) // the pending request is NOT lost
  expect(after.error).toBe("bridge unavailable") // …and the user is told
})

test("a successful permission reply clears the sheet and raises no error", async () => {
  const store = storeAwaitingPermission()
  const seen: string[] = []
  const api = new ApiClient({
    fetch: async (url, init = {}) => {
      seen.push(url)
      if (url === "/api/state") return json({ csrf: "tok", session: { id: "ses_1", status: { type: "idle" } } })
      expect(JSON.parse(init.body as string)).toEqual({ response: "always" })
      return json({ ok: true })
    },
  })

  await respondToPermission(api, store, "always", store.getState().permission!)

  expect(seen).toEqual(["/api/state", "/api/permissions/perm_1"])
  expect(store.getState().permission).toBeUndefined()
  expect(store.getState().error).toBeUndefined()
})

/* --------------------------------------------------------- mutations 2 -- */

test("a stale permission restore never clobbers a newer request", () => {
  const store = storeAwaitingPermission("perm_1", "old request")
  const stale = store.getState().permission!

  // The optimistic clear, then a NEW request arrives while the reply is in flight.
  store.dispatch({ type: "permission/cleared", id: "perm_1" })
  store.dispatch({
    type: "sse/frame",
    frame: { id: 2, sessionID: "ses_1", event: "permission.updated", data: { id: "perm_2", sessionID: "ses_1", title: "new request" } },
  })

  store.dispatch({ type: "permission/restored", permission: stale })
  expect(store.getState().permission?.id).toBe("perm_2")
})

/* --------------------------------------------------------- mutations 3 -- */

test("abort surfaces a genuine failure but stays silent when nothing was running", async () => {
  const store = createAppStore()
  let failing = true
  const api = mutationApi(() =>
    failing ? json({ error: "abort rejected by opencode" }, 502) : json({ aborted: false }),
  )

  await abortTurn(api, store)
  expect(store.getState().error).toBe("abort rejected by opencode")

  // `200 {"aborted": false}` means the session was already idle. That is a
  // SUCCESS and must never reach the banner.
  store.dispatch({ type: "error/set", error: undefined })
  failing = false
  await abortTurn(api, store)
  expect(store.getState().error).toBeUndefined()
})

/* --------------------------------------------------------- mutations 4 -- */

/*
 * A failed abort leaves the turn RUNNING, so the session never leaves `busy` and
 * AbortButton's optimistic latch has nothing to release it — the button stayed
 * disabled on "stopping…" forever and the only control that can stop the turn
 * was gone. `abortTurn` reports the failure so the owner can re-arm it.
 */
test("a failed abort reports failure so the button re-arms; a successful one does not", async () => {
  const store = createAppStore()
  let failing = true
  let calls = 0
  const api = new ApiClient({
    fetch: async (url) => {
      if (url === "/api/state") return json({ csrf: "tok", session: { id: "ses_1", status: { type: "idle" } } })
      calls++
      return failing ? json({ error: "abort failed: bridge unavailable" }, 502) : json({ aborted: true })
    },
  })

  expect(await abortTurn(api, store)).toBe(false) // -> owner bumps rearmToken
  expect(store.getState().error).toBe("abort failed: bridge unavailable")
  expect(calls).toBe(1)

  // The retry must reach the server: nothing local may swallow a second attempt.
  expect(await abortTurn(api, store)).toBe(false)
  expect(calls).toBe(2)

  failing = false
  expect(await abortTurn(api, store)).toBe(true) // success path unchanged: no re-arm
  expect(calls).toBe(3)
})

/* -------------------------------------------------------------- stream 1 -- */

test("lastEventId advances on real frames and is preserved across reconnects", () => {
  FakeEventSource.reset()
  const timers = new FakeTimers()
  const ids: number[] = []
  const client = new StreamClient({
    timers,
    visibility: null,
    createEventSource: (url) => new FakeEventSource(url),
    onLastEventId: (id) => ids.push(id),
  })

  client.start()
  expect(FakeEventSource.last.url).toBe("/api/events") // no cursor on first connect
  FakeEventSource.last.open()
  expect(client.connectionState).toBe("live")

  FakeEventSource.last.emit(wireFrame(1, "session.idle", {}), "1")
  FakeEventSource.last.emit(wireFrame(2, "session.idle", {}), "2")
  expect(client.lastEventId).toBe(2)

  // Out-of-order/stale replay must not rewind the cursor.
  FakeEventSource.last.emit(wireFrame(1, "session.idle", {}), "1")
  expect(client.lastEventId).toBe(2)
  expect(ids).toEqual([1, 2])

  const previous = FakeEventSource.last
  previous.fail()
  expect(previous.closed).toBe(true)
  expect(client.connectionState).toBe("reconnecting")
  timers.fire(1000)
  expect(FakeEventSource.last.url).toBe("/api/events?lastEventId=2")

  client.stop()
})

/* -------------------------------------------------------------- stream 2 -- */

test("a gap frame triggers onGap without moving the stream cursor", () => {
  FakeEventSource.reset()
  const timers = new FakeTimers()
  let gaps = 0
  const client = new StreamClient({
    timers,
    visibility: null,
    createEventSource: (url) => new FakeEventSource(url),
    onGap: () => gaps++,
  })

  client.start()
  FakeEventSource.last.open()
  FakeEventSource.last.emit(wireFrame(11, "session.idle", {}), "11")
  expect(client.lastEventId).toBe(11)

  // Real browser behaviour: no `id:` line, so lastEventId carries over as "11".
  FakeEventSource.last.emit(GAP_WIRE, "11")
  expect(gaps).toBe(1)
  expect(client.lastEventId).toBe(11)

  // Same when the browser has no id buffered at all.
  FakeEventSource.last.emit(GAP_WIRE, "")
  expect(gaps).toBe(2)
  expect(client.lastEventId).toBe(11)

  FakeEventSource.last.fail()
  timers.fire(1000)
  expect(FakeEventSource.last.url).toBe("/api/events?lastEventId=11")

  client.stop()
})

/* -------------------------------------------------------------- stream 3 -- */

test("reconnect backoff doubles then caps at 10s and resets after a live frame", () => {
  expect([0, 1, 2, 3, 4, 5, 99].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000, 10000])

  FakeEventSource.reset()
  const timers = new FakeTimers()
  const client = new StreamClient({
    timers,
    visibility: null,
    createEventSource: (url) => new FakeEventSource(url),
  })

  const retries: number[] = []
  client.start()
  for (let attempt = 0; attempt < 6; attempt++) {
    FakeEventSource.last.fail()
    const delay = timers.pendingDelays.find((pending) => pending < 15_000)
    if (delay === undefined) throw new Error("retry timer was not scheduled")
    retries.push(delay)
    timers.fire(delay)
  }
  expect(retries).toEqual([1000, 2000, 4000, 8000, 10000, 10000])

  // A successful frame proves the socket works: the ladder starts over.
  FakeEventSource.last.emit(wireFrame(3, "session.idle", {}), "3")
  FakeEventSource.last.fail()
  expect(timers.pendingDelays).toContain(1000)

  client.stop()
})

/* -------------------------------------------------------------- stream 4 -- */

test("hidden closes the EventSource and visible reconnects with the replay cursor", () => {
  FakeEventSource.reset()
  const timers = new FakeTimers()
  const listeners = new Set<() => void>()
  const host: VisibilityHost & { visibilityState: string } = {
    visibilityState: "visible",
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  }
  const client = new StreamClient({
    timers,
    visibility: host,
    createEventSource: (url) => new FakeEventSource(url),
  })

  client.start()
  FakeEventSource.last.open()
  FakeEventSource.last.emit(wireFrame(5, "session.idle", {}), "5")
  const backgrounded = FakeEventSource.last

  host.visibilityState = "hidden"
  for (const listener of listeners) listener()
  expect(backgrounded.closed).toBe(true)
  expect(FakeEventSource.instances).toHaveLength(1)
  expect(timers.pendingDelays).toEqual([]) // no watchdog burning in the background

  host.visibilityState = "visible"
  for (const listener of listeners) listener()
  expect(FakeEventSource.instances).toHaveLength(2)
  expect(FakeEventSource.last.url).toBe("/api/events?lastEventId=5")

  client.stop()
})

/* -------------------------------------------------------------- stream 5 -- */

test("the 30s watchdog recycles a silent socket but stops dead on a 401", async () => {
  FakeEventSource.reset()
  const timers = new FakeTimers()
  let alive = true
  const states: string[] = []
  const client = new StreamClient({
    timers,
    visibility: null,
    createEventSource: (url) => new FakeEventSource(url),
    probe: async () => alive,
    onConnection: (state) => states.push(state),
  })

  client.start()
  FakeEventSource.last.open()
  FakeEventSource.last.emit(wireFrame(4, "session.idle", {}), "4")
  const zombie = FakeEventSource.last

  expect(timers.fire(30_000)).toBe(1)
  await flush()
  expect(zombie.closed).toBe(true)
  expect(FakeEventSource.last).not.toBe(zombie)
  expect(FakeEventSource.last.url).toBe("/api/events?lastEventId=4")

  // Now the probe 401s: unpaired, everything torn down, nothing rescheduled.
  alive = false
  timers.fire(30_000)
  await flush()
  expect(client.connectionState).toBe("unpaired")
  expect(FakeEventSource.last.closed).toBe(true)
  expect(timers.pendingDelays).toEqual([])
  expect(states[states.length - 1]).toBe("unpaired")

  const count = FakeEventSource.instances.length
  timers.fire()
  await flush()
  expect(FakeEventSource.instances).toHaveLength(count) // no retry loop
})

test("an observable heartbeat rearms the watchdog without advancing the replay cursor", () => {
  FakeEventSource.reset()
  const timers = new FakeTimers()
  const frames: shared.SseFrame[] = []
  const states: string[] = []
  const client = new StreamClient({
    lastEventId: 7,
    timers,
    visibility: null,
    createEventSource: (url) => new FakeEventSource(url),
    onFrame: (frame) => frames.push(frame),
    onConnection: (state) => states.push(state),
  })

  client.start()
  FakeEventSource.last.open()
  const scheduledBeforeHeartbeat = timers.scheduledCount
  FakeEventSource.last.emit(JSON.stringify({ heartbeat: true }), "7")

  expect(timers.scheduledCount).toBe(scheduledBeforeHeartbeat + 1)
  expect(timers.pendingDelays).toEqual([30_000])
  expect(client.lastEventId).toBe(7)
  expect(frames).toEqual([])
  expect(states).toEqual(["live"])
  expect(FakeEventSource.instances).toHaveLength(1)

  client.stop()
})

/* ---------------------------------------------------------- controller 1 -- */

test("createConnection hydrates the store and refetches the transcript on a gap", async () => {
  FakeEventSource.reset()
  const timers = new FakeTimers()
  const store = createAppStore()
  let messageCalls = 0
  const api = new ApiClient({
    fetch: async (url) => {
      if (url === "/api/state") {
        return json({
          csrf: "tok",
          session: { id: "ses_1", title: "demo", status: { type: "idle" } },
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
          lastEventId: 3,
        })
      }
      if (url === "/api/messages") {
        messageCalls++
        return json({
          sessionID: "ses_1",
          messages: [{ info: assistantInfo("msg_1"), parts: [textPart("prt_1", "msg_1", `pass ${messageCalls}`)] }],
        })
      }
      if (url === "/api/agents") return json([{ name: "build", mode: "primary", builtIn: true }])
      if (url === "/api/providers") return json({ providers: [{ id: "anthropic" }], default: { anthropic: "claude" } })
      return json({ error: "unexpected" }, 500)
    },
  })

  const connection = createConnection({
    api,
    store,
    stream: { timers, visibility: null, createEventSource: (url) => new FakeEventSource(url) },
  })
  await connection.start()

  const hydrated = store.getState()
  expect(hydrated.session?.title).toBe("demo")
  expect(hydrated.nextAgent).toBe("build")
  expect(hydrated.nextModel).toEqual({ providerID: "anthropic", modelID: "claude" })
  expect(hydrated.agents).toHaveLength(1)
  expect(hydrated.lastEventId).toBe(3)
  expect(messageCalls).toBe(1)
  // The server's cursor is reused, so replay resumes instead of restarting.
  expect(FakeEventSource.last.url).toBe("/api/events?lastEventId=3")

  FakeEventSource.last.open()
  FakeEventSource.last.emit(GAP_WIRE, "3")
  await flush()
  expect(messageCalls).toBe(2)
  expect(store.getState().lastEventId).toBe(3)
  expect((store.getState().messages[0]!.parts[0] as { text: string }).text).toBe("pass 2")

  connection.stop()
})

/* ---------------------------------------------------------- controller 2 -- */

test("a 401 anywhere in the connection lifecycle parks the app in unpaired", async () => {
  FakeEventSource.reset()
  const timers = new FakeTimers()
  const store = createAppStore()
  const api = new ApiClient({ fetch: async () => json({ error: "gone" }, 401) })

  const connection = createConnection({
    api,
    store,
    stream: { timers, visibility: null, createEventSource: (url) => new FakeEventSource(url) },
  })
  await connection.start()

  expect(store.getState().connection).toBe("unpaired")
  expect(FakeEventSource.instances).toHaveLength(0) // never even opened the stream
  expect(timers.pendingDelays).toEqual([])

  connection.stop()
})

test("an unavailable pinned chat parks the app without opening an event stream", async () => {
  FakeEventSource.reset()
  const store = createAppStore()
  const api = new ApiClient({
    fetch: async () => json({ error: "paired chat is no longer available; scan a fresh QR code" }, 410),
  })
  const connection = createConnection({
    api,
    store,
    stream: { visibility: null, createEventSource: (url) => new FakeEventSource(url) },
  })

  await connection.start()

  expect(store.getState().connection).toBe("unpaired")
  expect(FakeEventSource.instances).toHaveLength(0)
})

test("failed hydration never opens an event stream or enables the composer", async () => {
  FakeEventSource.reset()
  const store = createAppStore()
  const api = new ApiClient({ fetch: async () => json({ error: "internal server error" }, 500) })
  const connection = createConnection({
    api,
    store,
    stream: { visibility: null, createEventSource: (url) => new FakeEventSource(url) },
  })

  await connection.start()

  expect(store.getState().connection).toBe("connecting")
  expect(store.getState().error).toBe("internal server error")
  expect(FakeEventSource.instances).toHaveLength(0)
})

/* ------------------------------------------------------- REAL WIRE SEAM -- */

/*
 * Cross-layer regression lock. Every mocked frame above puts the event id INSIDE
 * the JSON payload, but the real server writes `id: <n>` on its own line and
 * tests/http.test.ts asserts the payload does NOT contain `"id":`. Both suites
 * were green while the browser silently dropped every single event. This test
 * therefore reads bytes off the ACTUAL MobileServer and feeds them through the
 * ACTUAL client parser — the only shape of test that can catch this class of
 * seam bug.
 */
test("frames written by the real MobileServer are applied by the real client parser", async () => {
    const bridge = new FakeBridge()
    const auth = new MobileAuth(60_000)
    const events = new EventHub<MobileEvent>()
    const server = new MobileServer({ bridge, auth, events, options: { host: "127.0.0.1", port: 0 } })
  await server.start()
  try {
    const pairing = auth.createPairing("ses_fixture")
    const localOrigin = new URL(server.origin)
    localOrigin.hostname = "127.0.0.1"
    const paired = await fetch(`${localOrigin.origin}/pair?token=${pairing.token}`, { redirect: "manual" })
    const cookie = paired.headers.get("set-cookie")?.split(";", 1)[0] ?? ""

    const response = await fetch(`${localOrigin.origin}/api/events`, { headers: { cookie } })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": open\n\n")
    bridge.emit("session.status", { sessionID: "ses_fixture", status: { type: "busy" } })
    const block = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()

    const idLine = block.split("\n").find((line) => line.startsWith("id: "))
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "))
    expect(idLine).toBe("id: 1")
    expect(dataLine).toBeDefined()

    const wireId = Number(idLine!.slice(4))
    const raw = dataLine!.slice(6)
    expect((JSON.parse(raw) as { id?: number }).id).toBeUndefined() // the id is ONLY on the wire
    expect(uiProtocol.isSseFrame(JSON.parse(raw))).toBe(false) // …so the bare guard rejects it
    expect(parseSseData(raw, wireId)).toEqual({
      id: 1,
      sessionID: "ses_fixture",
      event: "session.status",
      data: { sessionID: "ses_fixture", status: { type: "busy" } },
    })

    const next = applyWireData(initialAppState, raw, wireId)
    expect(next.sessionStatus).toEqual({ type: "busy" })
    expect(next.lastEventId).toBe(1)
  } finally {
    await server.stop()
  }
})
