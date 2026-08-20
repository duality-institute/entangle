import type {
  Agent,
  AgentDto,
  Bridge,
  ChatMessageDto,
  Message,
  Model,
  Part,
  PermissionReply,
  PromptRequest,
  ProviderDto,
  ProvidersDto,
  SessionInfoDto,
  SseEventType,
  SseFrame,
} from "../../src/shared/protocol"

export const FIXTURE_SESSION_ID = "ses_fixture"
const FIXTURE_USER_MESSAGE_ID = "msg_user_1"
const FIXTURE_ASSISTANT_MESSAGE_ID = "msg_assistant_1"

const partBase = { sessionID: FIXTURE_SESSION_ID, messageID: FIXTURE_ASSISTANT_MESSAGE_ID }

export const FIXTURE_USER_PARTS: Part[] = [
  {
    id: "prt_user_text",
    sessionID: FIXTURE_SESSION_ID,
    messageID: FIXTURE_USER_MESSAGE_ID,
    type: "text",
    text: "Summarise the bridge module and fix the failing test.",
    time: { start: 1_700_000_000_000, end: 1_700_000_000_000 },
  },
]

export const FIXTURE_ASSISTANT_PARTS: Part[] = [
  { ...partBase, id: "prt_step_start", type: "step-start", snapshot: "snap_0" },
  { ...partBase, id: "prt_text", type: "text", text: "Reading the bridge module now.", time: { start: 1_700_000_001_000, end: 1_700_000_002_000 } },
  { ...partBase, id: "prt_reasoning", type: "reasoning", text: "The failure is in the cursor math.", time: { start: 1_700_000_002_000, end: 1_700_000_003_000 } },
  {
    ...partBase,
    id: "prt_file",
    type: "file",
    mime: "text/typescript",
    filename: "bridge.ts",
    url: "file:///repo/src/server/bridge.ts",
    source: {
      type: "file",
      path: "src/server/bridge.ts",
      text: { value: "export class OpencodeBridge {}", start: 0, end: 29 },
    },
  },
  {
    ...partBase,
    id: "prt_tool",
    type: "tool",
    callID: "call_read_1",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "src/server/bridge.ts" },
      output: "export class OpencodeBridge {}",
      title: "src/server/bridge.ts",
      metadata: { lines: 1 },
      time: { start: 1_700_000_003_000, end: 1_700_000_004_000 },
    },
  },
  { ...partBase, id: "prt_agent", type: "agent", name: "build", source: { value: "@build", start: 0, end: 6 } },
  {
    ...partBase,
    id: "prt_subtask",
    type: "subtask",
    prompt: "Find every caller of getMessages.",
    description: "callsite sweep",
    agent: "explore",
  },
  { ...partBase, id: "prt_snapshot", type: "snapshot", snapshot: "snap_1" },
  { ...partBase, id: "prt_patch", type: "patch", hash: "a1b2c3d4", files: ["src/server/bridge.ts"] },
  {
    ...partBase,
    id: "prt_retry",
    type: "retry",
    attempt: 1,
    error: { name: "APIError", data: { message: "429 rate limited", statusCode: 429, isRetryable: true } },
    time: { created: 1_700_000_005_000 },
  },
  { ...partBase, id: "prt_compaction", type: "compaction", auto: true },
  {
    ...partBase,
    id: "prt_step_finish",
    type: "step-finish",
    reason: "stop",
    snapshot: "snap_2",
    cost: 0.0123,
    tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 900, write: 120 } },
  },
]

export const FIXTURE_PART_TYPES = [
  "text", "subtask", "reasoning", "file", "tool", "step-start",
  "step-finish", "snapshot", "patch", "agent", "retry", "compaction",
] as const

export const FIXTURE_USER_MESSAGE: Message = {
  id: FIXTURE_USER_MESSAGE_ID,
  sessionID: FIXTURE_SESSION_ID,
  role: "user",
  time: { created: 1_700_000_000_000 },
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-opus-5" },
}

export const FIXTURE_ASSISTANT_MESSAGE: Message = {
  id: FIXTURE_ASSISTANT_MESSAGE_ID,
  sessionID: FIXTURE_SESSION_ID,
  role: "assistant",
  time: { created: 1_700_000_001_000, completed: 1_700_000_006_000 },
  parentID: FIXTURE_USER_MESSAGE_ID,
  modelID: "claude-opus-5",
  providerID: "anthropic",
  mode: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0.0123,
  tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 900, write: 120 } },
  finish: "stop",
}

export const FIXTURE_MESSAGES: ChatMessageDto[] = [
  { info: FIXTURE_USER_MESSAGE, parts: FIXTURE_USER_PARTS },
  { info: FIXTURE_ASSISTANT_MESSAGE, parts: FIXTURE_ASSISTANT_PARTS },
]

export const FIXTURE_SESSION: SessionInfoDto = {
  id: FIXTURE_SESSION_ID,
  title: "Entangle bridge wiring",
  status: { type: "idle" },
}

function fixtureAgent(name: string, mode: Agent["mode"], builtIn: boolean, description: string, color?: string): Agent {
  return {
    name,
    mode,
    builtIn,
    description,
    ...(color !== undefined ? { color } : {}),
    permission: { edit: "ask", bash: { "*": "ask" } },
    tools: { read: true, write: true },
    options: {},
  }
}

export const FIXTURE_AGENTS: Agent[] = [
  fixtureAgent("build", "primary", true, "Default coding agent", "#7ee7c7"),
  fixtureAgent("plan", "primary", true, "Read-only planning agent", "#f5c26b"),
  fixtureAgent("explore", "subagent", true, "Codebase exploration subagent"),
  fixtureAgent("librarian", "subagent", false, "Docs lookup subagent"),
  fixtureAgent("review", "all", false, "Review agent usable either way", "#a78bfa"),
]

export const FIXTURE_AGENT_DTOS: AgentDto[] = [
  { name: "build", mode: "primary", builtIn: true, description: "Default coding agent", color: "#7ee7c7" },
  { name: "plan", mode: "primary", builtIn: true, description: "Read-only planning agent", color: "#f5c26b" },
  { name: "review", mode: "all", builtIn: false, description: "Review agent usable either way", color: "#a78bfa" },
]

function fixtureModel(providerID: string, id: string, name: string): Model {
  return {
    id,
    providerID,
    name,
    api: { id, url: `https://api.${providerID}.test/v1`, npm: `@ai-sdk/${providerID}` },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200_000, output: 64_000 },
    status: "active",
    options: {},
    headers: {},
  }
}

const FIXTURE_PROVIDER_LIST: ProviderDto[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    source: "env",
    env: ["ANTHROPIC_API_KEY"],
    options: {},
    models: {
      "claude-opus-5": fixtureModel("anthropic", "claude-opus-5", "Claude Opus 5"),
      "claude-sonnet-4-5": fixtureModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    source: "env",
    env: ["OPENAI_API_KEY"],
    options: {},
    models: { "gpt-5": fixtureModel("openai", "gpt-5", "GPT-5") },
  },
]

export const FIXTURE_PROVIDERS: ProvidersDto = {
  providers: FIXTURE_PROVIDER_LIST,
  default: { anthropic: "claude-opus-5", openai: "gpt-5" },
}

type ScriptedEvent = { event: SseEventType; data: unknown; delayMs?: number }

export const FIXTURE_SCRIPT: ScriptedEvent[] = [
  { event: "session.status", data: { sessionID: FIXTURE_SESSION_ID, status: { type: "busy" } } },
  { event: "message.updated", data: { info: FIXTURE_ASSISTANT_MESSAGE } },
  { event: "message.part.updated", data: { part: FIXTURE_ASSISTANT_PARTS[1], delta: "Reading the " } },
  { event: "message.part.updated", data: { part: FIXTURE_ASSISTANT_PARTS[1], delta: "bridge module now." } },
  {
    event: "permission.updated",
    data: {
      id: "per_1",
      sessionID: FIXTURE_SESSION_ID,
      title: "Run `bun test`",
      metadata: { command: "bun test" },
    },
  },
  { event: "permission.replied", data: { sessionID: FIXTURE_SESSION_ID, permissionID: "per_1", response: "once" } },
  { event: "session.idle", data: { sessionID: FIXTURE_SESSION_ID } },
  { event: "session.status", data: { sessionID: FIXTURE_SESSION_ID, status: { type: "idle" } } },
]

type FakeBridgeMethod =
  | "getSession" | "getMessages" | "sendPrompt" | "abort"
  | "listAgents" | "listProviders" | "respondPermission" | "currentAgentModel"

type FakeBridgeOptions = {
  session?: SessionInfoDto
  messages?: ChatMessageDto[]
  agents?: AgentDto[]
  providers?: ProvidersDto
  agentModel?: { agent?: string; model?: { providerID: string; modelID: string } }
  script?: ScriptedEvent[]
  pageSize?: number
  failures?: Partial<Record<FakeBridgeMethod, Error>>
}

function deliveredCount(cursor: string | undefined): number {
  const parsed = Number(cursor)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class FakeBridge implements Bridge {
  readonly sentPrompts: PromptRequest[] = []
  readonly promptSessionIDs: string[] = []
  readonly permissionReplies: { permissionID: string; reply: PermissionReply }[] = []
  readonly permissionSessionIDs: string[] = []
  readonly requestedCursors: (string | undefined)[] = []
  readonly messageSessionIDs: string[] = []
  readonly abortSessionIDs: string[] = []
  readonly emitted: SseFrame[] = []
  aborts = 0

  session: SessionInfoDto
  messages: ChatMessageDto[]
  agents: AgentDto[]
  providers: ProvidersDto
  agentModel: { agent?: string; model?: { providerID: string; modelID: string } }
  script: ScriptedEvent[]
  failures: Partial<Record<FakeBridgeMethod, Error>>

  private readonly listeners = new Set<(frame: SseFrame) => void>()
  private readonly pageSize: number
  private nextEventId = 1

  constructor(options: FakeBridgeOptions = {}) {
    this.session = options.session ?? FIXTURE_SESSION
    this.messages = options.messages ?? [...FIXTURE_MESSAGES]
    this.agents = options.agents ?? [...FIXTURE_AGENT_DTOS]
    this.providers = options.providers ?? FIXTURE_PROVIDERS
    this.agentModel = options.agentModel ?? { agent: "build", model: { providerID: "anthropic", modelID: "claude-opus-5" } }
    this.script = options.script ?? [...FIXTURE_SCRIPT]
    this.pageSize = options.pageSize ?? 80
    this.failures = options.failures ?? {}
  }

  private guard(method: FakeBridgeMethod): void {
    const failure = this.failures[method]
    if (failure !== undefined) throw failure
  }

  async getLatestSession(): Promise<SessionInfoDto> {
    this.guard("getSession")
    return this.session
  }

  async getSession(sessionID: string): Promise<SessionInfoDto> {
    this.guard("getSession")
    return { ...this.session, id: sessionID }
  }

  async getMessages(sessionID: string, cursor?: string): Promise<{ sessionID: string; messages: ChatMessageDto[]; cursor?: string }> {
    this.guard("getMessages")
    this.messageSessionIDs.push(sessionID)
    this.requestedCursors.push(cursor)
    const delivered = deliveredCount(cursor)
    const end = Math.max(0, this.messages.length - delivered)
    const start = Math.max(0, end - this.pageSize)
    const messages = this.messages.slice(start, end)
    return start > 0
      ? { sessionID, messages, cursor: String(delivered + messages.length) }
      : { sessionID, messages }
  }

  async sendPrompt(sessionID: string, request: PromptRequest): Promise<void> {
    this.guard("sendPrompt")
    this.promptSessionIDs.push(sessionID)
    this.sentPrompts.push(request)
  }

  async abort(sessionID: string): Promise<void> {
    this.guard("abort")
    this.abortSessionIDs.push(sessionID)
    this.aborts += 1
  }

  async listAgents(): Promise<AgentDto[]> {
    this.guard("listAgents")
    return this.agents
  }

  async listProviders(): Promise<ProvidersDto> {
    this.guard("listProviders")
    return this.providers
  }

  async respondPermission(sessionID: string, permissionID: string, reply: PermissionReply): Promise<void> {
    this.guard("respondPermission")
    this.permissionSessionIDs.push(sessionID)
    this.permissionReplies.push({ permissionID, reply })
  }

  async currentAgentModel(_sessionID: string): Promise<{ agent?: string; model?: { providerID: string; modelID: string } }> {
    this.guard("currentAgentModel")
    return this.agentModel
  }

  onEvent(callback: (frame: SseFrame) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  emit(event: SseEventType, data: unknown, sessionID = FIXTURE_SESSION_ID): SseFrame {
    const frame: SseFrame = { id: this.nextEventId, sessionID, event, data }
    this.nextEventId += 1
    this.emitted.push(frame)
    for (const listener of this.listeners) listener(frame)
    return frame
  }

  async play(script: ScriptedEvent[] = this.script): Promise<SseFrame[]> {
    const frames: SseFrame[] = []
    for (const step of script) {
      if (step.delayMs !== undefined && step.delayMs > 0) await wait(step.delayMs)
      frames.push(this.emit(step.event, step.data))
    }
    return frames
  }

  reset(): void {
    this.sentPrompts.length = 0
    this.promptSessionIDs.length = 0
    this.permissionReplies.length = 0
    this.permissionSessionIDs.length = 0
    this.requestedCursors.length = 0
    this.messageSessionIDs.length = 0
    this.abortSessionIDs.length = 0
    this.emitted.length = 0
    this.aborts = 0
    this.failures = {}
  }
}
