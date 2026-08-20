import { expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { OpencodeBridge } from "../src/server/bridge"
import type { PermissionDto, SseFrame } from "../src/shared/protocol"
import {
  FakeBridge,
  FIXTURE_AGENTS,
  FIXTURE_ASSISTANT_MESSAGE,
  FIXTURE_ASSISTANT_PARTS,
  FIXTURE_MESSAGES,
  FIXTURE_PART_TYPES,
  FIXTURE_PROVIDERS,
  FIXTURE_SCRIPT,
  FIXTURE_SESSION_ID,
  FIXTURE_USER_MESSAGE,
  FIXTURE_USER_PARTS,
} from "./fixtures/fake-bridge"

type StubOptions = {
  query?: Record<string, unknown>
  headers?: Record<string, string>
  path?: Record<string, string>
  body?: unknown
}

type StubCall = { method: string; options: StubOptions }

type StubData = {
  sessions?: unknown[]
  session?: unknown
  statuses?: Record<string, unknown>
  messages?: unknown[] | ((limit: number) => unknown[])
  agents?: unknown[]
  providers?: unknown
}

const DEFAULT_SESSION = {
  id: FIXTURE_SESSION_ID,
  title: "Entangle bridge wiring",
  projectID: "prj_1",
  directory: "/repo",
  version: "1.18.18",
  time: { created: 1_700_000_000_000, updated: 1_700_000_009_000 },
}

function createStub(data: StubData = {}) {
  const calls: StubCall[] = []
  const messagesFor = typeof data.messages === "function"
    ? data.messages
    : () => data.messages ?? [{ info: FIXTURE_USER_MESSAGE, parts: FIXTURE_USER_PARTS }]

  const handler = (method: string, result: unknown) => (options: StubOptions = {}) => {
    calls.push({ method, options })
    return Promise.resolve({ data: result })
  }

  const client = {
    session: {
      list: handler("session.list", data.sessions ?? [DEFAULT_SESSION]),
      get: handler("session.get", data.session ?? DEFAULT_SESSION),
      status: handler("session.status", data.statuses ?? { [FIXTURE_SESSION_ID]: { type: "busy" } }),
      messages: (options: StubOptions = {}) => {
        calls.push({ method: "session.messages", options })
        return Promise.resolve({ data: messagesFor(Number(options.query?.limit ?? 0)) })
      },
      promptAsync: handler("session.promptAsync", undefined),
      abort: handler("session.abort", true),
      prompt: () => {
        throw new Error("the blocking prompt endpoint must never be called")
      },
    },
    app: {
      agents: handler("app.agents", data.agents ?? FIXTURE_AGENTS),
      log: handler("app.log", true),
    },
    config: { providers: handler("config.providers", data.providers ?? FIXTURE_PROVIDERS) },
    postSessionIdPermissionsPermissionId: handler("permissions.respond", true),
  }

  return { client: client as unknown as OpencodeClient, calls }
}

function collect(bridge: OpencodeBridge): SseFrame[] {
  const frames: SseFrame[] = []
  bridge.onEvent((frame) => frames.push(frame))
  return frames
}

test("listAgents drops subagent-mode agents and maps the rest to AgentDto", async () => {
  const { client } = createStub()
  const agents = await new OpencodeBridge(client, "/repo").listAgents()

  expect(agents.map((agent) => agent.name)).toEqual(["build", "plan", "review"])
  expect(agents.every((agent) => agent.mode !== "subagent")).toBe(true)
  expect(agents[0]).toEqual({
    name: "build",
    mode: "primary",
    builtIn: true,
    description: "Default coding agent",
    color: "#7ee7c7",
  })
  expect(Object.keys(agents[0] ?? {}).includes("permission")).toBe(false)
})

test("listAgents drops opencode's hidden system agents so only TUI-selectable agents reach the phone", async () => {
  const hidden = (name: string) => ({
    name,
    mode: "primary",
    hidden: true,
    permission: { edit: "deny", bash: { "*": "deny" } },
    tools: {},
    options: {},
  })
  const { client } = createStub({
    agents: [...FIXTURE_AGENTS, hidden("compaction"), hidden("title"), hidden("summary")],
  })

  const agents = await new OpencodeBridge(client, "/repo").listAgents()

  expect(agents.map((agent) => agent.name)).toEqual(["build", "plan", "review"])
})

test("currentAgentModel derives the agent and model from the last user message", async () => {
  const laterUser = {
    ...FIXTURE_USER_MESSAGE,
    id: "msg_user_2",
    agent: "plan",
    model: { providerID: "openai", modelID: "gpt-5" },
  }
  const { client } = createStub({
    messages: [
      { info: FIXTURE_USER_MESSAGE, parts: FIXTURE_USER_PARTS },
      { info: FIXTURE_ASSISTANT_MESSAGE, parts: FIXTURE_ASSISTANT_PARTS },
      { info: laterUser, parts: [] },
    ],
  })

  const current = await new OpencodeBridge(client, "/repo").currentAgentModel(FIXTURE_SESSION_ID)

  expect(current).toEqual({ agent: "plan", model: { providerID: "openai", modelID: "gpt-5" } })
})

test("currentAgentModel yields no agent and no model for an empty history", async () => {
  const { client } = createStub({ messages: [] })

  const current = await new OpencodeBridge(client, "/repo").currentAgentModel(FIXTURE_SESSION_ID)

  expect(current.agent).toBeUndefined()
  expect(current.model).toBeUndefined()
  expect(current).toEqual({})
})

test("ingestEvent drops event types outside the mobile allow-list", async () => {
  const { client } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  bridge.ingestEvent({ type: "todo.updated", properties: { sessionID: FIXTURE_SESSION_ID, todos: [] } })
  bridge.ingestEvent({ type: "file.edited", properties: { file: "src/server/bridge.ts" } })
  bridge.ingestEvent({ type: "session.diff", properties: { sessionID: FIXTURE_SESSION_ID, diff: [] } })
  bridge.ingestEvent({ type: "message.part.removed", properties: { sessionID: FIXTURE_SESSION_ID } })
  bridge.ingestEvent({ type: "server.connected", properties: {} })
  bridge.ingestEvent("not-an-event")
  bridge.ingestEvent({ properties: {} })

  expect(frames).toEqual([])

  bridge.ingestEvent({ type: "session.idle", properties: { sessionID: FIXTURE_SESSION_ID } })
  expect(frames.map((frame) => frame.event)).toEqual(["session.idle"])
})

test("ingestEvent preserves the streaming delta all the way into the emitted frame", async () => {
  const { client } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  bridge.ingestEvent({
    type: "message.part.updated",
    properties: { part: FIXTURE_ASSISTANT_PARTS[1], delta: "Reading the " },
  })
  bridge.ingestEvent({
    type: "message.part.updated",
    properties: { part: FIXTURE_ASSISTANT_PARTS[1] },
  })

  const streamed = frames[0]?.data as { part: { id: string }; delta?: string }
  expect(frames[0]?.event).toBe("message.part.updated")
  expect(streamed.delta).toBe("Reading the ")
  expect(streamed.part.id).toBe("prt_text")

  const withoutDelta = frames[1]?.data as { delta?: string }
  expect(withoutDelta.delta).toBeUndefined()

  const wire = JSON.parse(JSON.stringify(frames[0])) as SseFrame
  expect((wire.data as { delta?: string }).delta).toBe("Reading the ")
})

test("every scripted delta in the FakeBridge fixture survives ingestEvent", async () => {
  const { client } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  for (const step of FIXTURE_SCRIPT) {
    bridge.ingestEvent({ type: step.event, properties: step.data })
  }

  const deltas = frames
    .filter((frame) => frame.event === "message.part.updated")
    .map((frame) => (frame.data as { delta?: string }).delta)
  expect(deltas).toEqual(["Reading the ", "bridge module now."])
  expect(deltas.join("")).toBe("Reading the bridge module now.")
})

test("ingestEvent normalises permission.updated into a PermissionDto", async () => {
  const { client } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  bridge.ingestEvent({
    type: "permission.updated",
    properties: {
      id: "per_1",
      type: "bash",
      sessionID: FIXTURE_SESSION_ID,
      messageID: "msg_assistant_1",
      title: "Run `bun test`",
      metadata: { command: "bun test" },
      time: { created: 1_700_000_005_000 },
    },
  })
  bridge.ingestEvent({
    type: "permission.replied",
    properties: { sessionID: FIXTURE_SESSION_ID, permissionID: "per_1", response: "once" },
  })

  expect(frames[0]?.data as PermissionDto).toEqual({
    id: "per_1",
    sessionID: FIXTURE_SESSION_ID,
    title: "Run `bun test`",
    metadata: { command: "bun test" },
  })
  expect(frames[1]?.event).toBe("permission.replied")
  expect(frames[1]?.data).toEqual({ sessionID: FIXTURE_SESSION_ID, permissionID: "per_1", response: "once" })
  expect(frames.map((frame) => frame.id)).toEqual([1, 2])
})

/*
 * Payload captured verbatim from opencode 1.18.18 while a real `bash` tool call waited for approval. The SDK's
 * own types declare `permission.updated` with `title`/`pattern`; the binary
 * sends `permission.asked` with `permission`/`patterns` and no title. Listening
 * for the declared name dropped every real permission request, so the sheet
 * never opened and the agent stayed wedged — invisible to any test that feeds
 * the declared shape.
 */
test("ingestEvent accepts opencode's real permission.asked wire event", async () => {
  const { client } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  bridge.ingestEvent({
    type: "permission.asked",
    properties: {
      id: "per_009c1a56e001TSiW5zVnaYSthc",
      sessionID: FIXTURE_SESSION_ID,
      permission: "bash",
      patterns: ["echo entangle-permission-ok"],
      metadata: { command: "echo entangle-permission-ok" },
      always: ["echo *"],
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  })

  expect(frames).toHaveLength(1)
  expect(frames[0]?.event).toBe("permission.updated")
  expect(frames[0]?.data as PermissionDto).toEqual({
    id: "per_009c1a56e001TSiW5zVnaYSthc",
    sessionID: FIXTURE_SESSION_ID,
    title: "bash",
    metadata: { command: "echo entangle-permission-ok", pattern: "echo entangle-permission-ok" },
  })
})

test("permission.asked without metadata still yields a titled, detailed DTO", async () => {
  const { client } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  bridge.ingestEvent({
    type: "permission.asked",
    properties: {
      id: "per_2",
      sessionID: FIXTURE_SESSION_ID,
      permission: "edit",
      patterns: ["src/**", "ui/**"],
    },
  })

  expect(frames[0]?.data as PermissionDto).toEqual({
    id: "per_2",
    sessionID: FIXTURE_SESSION_ID,
    title: "edit",
    metadata: { pattern: "src/** ui/**" },
  })
})

test("foreign root activity never changes an explicitly selected command target", async () => {
  const { client, calls } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  await bridge.getSession(FIXTURE_SESSION_ID)
  bridge.ingestEvent({
    type: "session.updated",
    properties: { info: { ...DEFAULT_SESSION, id: "ses_newest" } },
  })
  bridge.ingestEvent({
    type: "message.updated",
    properties: { info: { ...FIXTURE_ASSISTANT_MESSAGE, sessionID: "ses_newest" } },
  })
  bridge.ingestEvent({ type: "session.idle", properties: { sessionID: "ses_stale" } })

  await bridge.sendPrompt(FIXTURE_SESSION_ID, { text: "stay in the paired session" })

  expect(calls.some((call) => call.method === "session.list")).toBe(false)
  expect({
    promptSessionID: calls.find((call) => call.method === "session.promptAsync")?.options.path?.id,
    emittedSessions: frames.map((frame) => frame.sessionID),
  }).toEqual({
    promptSessionID: FIXTURE_SESSION_ID,
    emittedSessions: ["ses_newest", "ses_stale"],
  })
})

test("a subagent's child session never becomes the target and never reaches the phone", async () => {
  const { client, calls } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")
  const frames = collect(bridge)

  bridge.ingestEvent({
    type: "message.updated",
    properties: { info: { ...FIXTURE_ASSISTANT_MESSAGE, sessionID: "ses_root" } },
  })
  bridge.ingestEvent({
    type: "session.updated",
    properties: { info: { ...DEFAULT_SESSION, id: "ses_child", parentID: "ses_root" } },
  })
  bridge.ingestEvent({
    type: "message.updated",
    properties: { info: { ...FIXTURE_ASSISTANT_MESSAGE, sessionID: "ses_child" } },
  })
  bridge.ingestEvent({
    type: "session.status",
    properties: { sessionID: "ses_child", status: { type: "busy" } },
  })
  bridge.ingestEvent({ type: "session.idle", properties: { sessionID: "ses_child" } })

  await bridge.abort("ses_root")
  await bridge.sendPrompt("ses_root", { text: "stay on the root session" })

  expect(calls.find((call) => call.method === "session.abort")?.options.path?.id).toBe("ses_root")
  expect(calls.find((call) => call.method === "session.promptAsync")?.options.path?.id).toBe("ses_root")
  expect(frames.map((frame) => frame.event)).toEqual(["message.updated"])
})

test("a child session seen before any root cannot affect an explicit root target", async () => {
  const { client, calls } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")

  bridge.ingestEvent({
    type: "session.updated",
    properties: { info: { ...DEFAULT_SESSION, id: "ses_child", parentID: FIXTURE_SESSION_ID } },
  })
  bridge.ingestEvent({
    type: "message.updated",
    properties: { info: { ...FIXTURE_ASSISTANT_MESSAGE, sessionID: "ses_child" } },
  })

  await bridge.abort(FIXTURE_SESSION_ID)

  expect(calls.some((call) => call.method === "session.list")).toBe(false)
  expect(calls.find((call) => call.method === "session.abort")?.options.path?.id).toBe(FIXTURE_SESSION_ID)
})

test("sendPrompt uses promptAsync and never the blocking prompt endpoint", async () => {
  const { client, calls } = createStub()
  const bridge = new OpencodeBridge(client, "/repo")

  await bridge.sendPrompt(FIXTURE_SESSION_ID, { text: "ship it", agent: "build", model: { providerID: "anthropic", modelID: "claude-opus-5" } })

  const sent = calls.find((call) => call.method === "session.promptAsync")
  expect(sent).toBeDefined()
  expect(calls.every((call) => call.method !== "session.prompt")).toBe(true)
  expect(sent?.options.path?.id).toBe(FIXTURE_SESSION_ID)
  expect(sent?.options.body).toEqual({
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
    parts: [{ type: "text", text: "ship it" }],
  })
  expect(sent?.options.query?.directory).toBe("/repo")
  expect(sent?.options.headers?.["x-opencode-directory"]).toBe("%2Frepo")
})

test("getMessages pages backwards through history with an opaque cursor", async () => {
  const history = Array.from({ length: 130 }, (_, index) => ({
    info: { ...FIXTURE_USER_MESSAGE, id: `msg_${index}` },
    parts: [],
  }))
  const { client } = createStub({ messages: (limit) => history.slice(Math.max(0, history.length - limit)) })
  const bridge = new OpencodeBridge(client, "/repo")

  const first = await bridge.getMessages(FIXTURE_SESSION_ID)
  expect(first.messages).toHaveLength(80)
  expect(first.messages[0]?.info.id).toBe("msg_50")
  expect(first.cursor).toBe("80")

  const second = await bridge.getMessages(FIXTURE_SESSION_ID, first.cursor)
  expect(second.messages).toHaveLength(50)
  expect(second.messages[0]?.info.id).toBe("msg_0")
  expect(second.cursor).toBeUndefined()
})

test("listProviders exposes the provider catalogue and the default model map", async () => {
  const { client } = createStub()

  const providers = await new OpencodeBridge(client, "/repo").listProviders()

  expect(providers.providers.map((provider) => provider.id)).toEqual(["anthropic", "openai"])
  expect(providers.default).toEqual({ anthropic: "claude-opus-5", openai: "gpt-5" })
})

test("getLatestSession selects the newest root and its id scopes permission replies", async () => {
  const { client, calls } = createStub({
    sessions: [
      { ...DEFAULT_SESSION, id: "ses_old", time: { created: 1, updated: 2 } },
      { ...DEFAULT_SESSION, id: "ses_child", parentID: "ses_old", time: { created: 3, updated: 99 } },
      { ...DEFAULT_SESSION, id: "ses_new", time: { created: 4, updated: 10 } },
    ],
    session: { ...DEFAULT_SESSION, id: "ses_new" },
    statuses: { ses_new: { type: "busy" } },
  })
  const bridge = new OpencodeBridge(client, "/repo")

  const session = await bridge.getLatestSession()
  await bridge.respondPermission(session.id, "per_9", { response: "reject" })

  expect(session).toEqual({ id: "ses_new", title: "Entangle bridge wiring", status: { type: "busy" } })
  const reply = calls.find((call) => call.method === "permissions.respond")
  expect(reply?.options.path).toEqual({ id: "ses_new", permissionID: "per_9" })
  expect(reply?.options.body).toEqual({ response: "reject" })
})

test("listRootSessions drops subagent children and orders by recency for the picker", async () => {
  const { client } = createStub({
    sessions: [
      { ...DEFAULT_SESSION, id: "ses_old", title: "Greeting", time: { created: 1, updated: 2 } },
      { ...DEFAULT_SESSION, id: "ses_child", title: "Subagent", parentID: "ses_old", time: { created: 3, updated: 99 } },
      { ...DEFAULT_SESSION, id: "ses_new", title: "Newest", time: { created: 4, updated: 10 } },
    ],
  })

  const sessions = await new OpencodeBridge(client, "/repo").listRootSessions()

  expect(sessions).toEqual([
    { id: "ses_new", title: "Newest", updatedAt: 10 },
    { id: "ses_old", title: "Greeting", updatedAt: 2 },
  ])
})

test("listRootSessions returns empty rather than throwing when the project has no chats", async () => {
  const { client } = createStub({ sessions: [] })

  expect(await new OpencodeBridge(client, "/repo").listRootSessions()).toEqual([])
})

test("FakeBridge fixture history covers all 12 part variants", async () => {
  const fake = new FakeBridge()

  const { messages } = await fake.getMessages(FIXTURE_SESSION_ID)
  const types = messages.flatMap((message) => message.parts.map((part) => part.type))

  expect(messages).toEqual(FIXTURE_MESSAGES)
  expect(new Set(types)).toEqual(new Set(FIXTURE_PART_TYPES))
  expect(FIXTURE_PART_TYPES).toHaveLength(12)
})

test("FakeBridge records prompts, aborts and permission replies", async () => {
  const fake = new FakeBridge()

  await fake.sendPrompt(FIXTURE_SESSION_ID, { text: "hello", agent: "build" })
  await fake.abort(FIXTURE_SESSION_ID)
  await fake.respondPermission(FIXTURE_SESSION_ID, "per_1", { response: "always" })

  expect(fake.sentPrompts).toEqual([{ text: "hello", agent: "build" }])
  expect(fake.aborts).toBe(1)
  expect(fake.permissionReplies).toEqual([{ permissionID: "per_1", reply: { response: "always" } }])

  fake.reset()
  expect(fake.sentPrompts).toEqual([])
  expect(fake.aborts).toBe(0)
})

test("FakeBridge plays scripted events in order and unsubscribes cleanly", async () => {
  const fake = new FakeBridge()
  const frames: SseFrame[] = []
  const unsubscribe = fake.onEvent((frame) => frames.push(frame))

  await fake.play([
    { event: "session.status", data: { sessionID: FIXTURE_SESSION_ID, status: { type: "busy" } }, delayMs: 1 },
    { event: "message.part.updated", data: { part: FIXTURE_ASSISTANT_PARTS[1], delta: "hi" } },
  ])

  expect(frames.map((frame) => frame.event)).toEqual(["session.status", "message.part.updated"])
  expect(frames.map((frame) => frame.id)).toEqual([1, 2])

  unsubscribe()
  expect(fake.listenerCount).toBe(0)
  await fake.play([{ event: "session.idle", data: { sessionID: FIXTURE_SESSION_ID } }])
  expect(frames).toHaveLength(2)
  expect(fake.emitted).toHaveLength(3)
})

test("FakeBridge surfaces injected failures for error-path coverage", async () => {
  const fake = new FakeBridge({ failures: { sendPrompt: new Error("bridge offline") } })

  await expect(fake.sendPrompt(FIXTURE_SESSION_ID, { text: "nope" })).rejects.toThrow("bridge offline")
  expect(fake.sentPrompts).toEqual([])
  expect(await fake.listProviders()).toEqual(FIXTURE_PROVIDERS)
})
