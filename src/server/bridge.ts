import type { OpencodeClient } from "@opencode-ai/sdk"
import {
  SseEvents,
  type AgentDto,
  type Bridge,
  type ChatMessageDto,
  type PermissionDto,
  type PermissionReply,
  type PromptRequest,
  type ProvidersDto,
  type SessionInfoDto,
  type SessionSummaryDto,
  type SseEventType,
  type SseFrame,
} from "../shared/protocol"

const PAGE_SIZE = 80

type Properties = Record<string, unknown>

function isRecord(value: unknown): value is Properties {
  return typeof value === "object" && value !== null
}

function dataOrThrow<T>(result: { data?: T; error?: unknown }): T {
  if (result.data !== undefined) return result.data
  throw new Error(`opencode request failed: ${JSON.stringify(result.error)}`)
}

function ensureOk(result: { error?: unknown }): void {
  if (result.error !== undefined) throw new Error(`opencode request failed: ${JSON.stringify(result.error)}`)
}

function sessionIdOf(type: SseEventType, properties: Properties): string | undefined {
  const carrier = type === "message.updated"
    ? properties.info
    : type === "message.part.updated"
      ? properties.part
      : properties
  if (!isRecord(carrier)) return undefined
  return typeof carrier.sessionID === "string" ? carrier.sessionID : undefined
}

/*
 * opencode 1.18.18 EMITS `permission.asked`, while its own SDK type definitions
 * declare `permission.updated` (types.gen.d.ts:384 EventPermissionUpdated). The
 * types are stale relative to the shipped binary, so listening for the declared
 * name drops every real permission request: the phone never shows the sheet and
 * the agent stays wedged. The wire vocabulary the phone sees is entangle's, not
 * opencode's, so the rename is absorbed here.
 */
const EVENT_ALIASES: Record<string, SseEventType> = {
  "permission.asked": "permission.updated",
}

/*
 * `compaction`, `title` and `summary` are primary-mode agents opencode runs for
 * itself and flags `hidden: true`. The SDK's `Agent` type predates the flag.
 */
function isHiddenAgent(agent: unknown): boolean {
  return isRecord(agent) && agent.hidden === true
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value !== "") return value
  return ""
}

/*
 * The runtime payload is `{id, sessionID, permission, patterns, metadata,
 * always, tool}` — no `title`, and `patterns` is plural. The declared
 * `Permission` has `title`/`type`/`pattern`. Read both so the sheet has a
 * heading and a detail line under either shape.
 */
function toPermissionDto(properties: Properties): PermissionDto {
  const patterns = properties.patterns ?? properties.pattern
  const metadata: Properties = isRecord(properties.metadata) ? { ...properties.metadata } : {}
  if (metadata.pattern === undefined && patterns !== undefined) {
    metadata.pattern = Array.isArray(patterns) ? patterns.join(" ") : patterns
  }
  return {
    id: firstString(properties.id),
    sessionID: firstString(properties.sessionID),
    title: firstString(properties.title, properties.permission, properties.type),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

function normalize(type: SseEventType, properties: Properties): unknown {
  if (type === "message.part.updated") {
    return typeof properties.delta === "string"
      ? { part: properties.part, delta: properties.delta }
      : { part: properties.part }
  }
  if (type === "permission.updated") return toPermissionDto(properties)
  return properties
}

function parseCursor(cursor: string | undefined): number {
  const parsed = Number(cursor)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

export class OpencodeBridge implements Bridge {
  private readonly listeners = new Set<(frame: SseFrame) => void>()
  /*
   * Pairing selects ROOT sessions only. A subagent's child session emits the
   * same events as a root one, so record lineage before filtering the event
   * vocabulary and never expose known children to a phone stream.
   */
  private readonly childSessionIDs = new Set<string>()
  private nextEventId = 1

  constructor(private readonly client: OpencodeClient, private readonly directory: string) {}

  private ctx<Q extends Properties>(query?: Q) {
    return {
      query: { directory: this.directory, ...(query ?? ({} as Q)) },
      headers: { "x-opencode-directory": encodeURIComponent(this.directory) },
    }
  }

  async listRootSessions(): Promise<SessionSummaryDto[]> {
    const sessions = dataOrThrow(await this.client.session.list({ ...this.ctx() }))
    return [...sessions]
      .filter((session) => session.parentID === undefined)
      .sort((a, b) => b.time.updated - a.time.updated)
      .map((session) => ({ id: session.id, title: session.title, updatedAt: session.time.updated }))
  }

  private async latestSessionId(): Promise<string> {
    const [latest] = await this.listRootSessions()
    if (latest === undefined) throw new Error("no opencode session to attach to")
    return latest.id
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    void Promise.resolve(
      this.client.app.log({ body: { service: "entangle", level, message }, ...this.ctx() }),
    ).catch(() => {})
  }

  async getLatestSession(): Promise<SessionInfoDto> {
    return this.getSession(await this.latestSessionId())
  }

  async getSession(sessionID: string): Promise<SessionInfoDto> {
    const session = dataOrThrow(await this.client.session.get({ path: { id: sessionID }, ...this.ctx() }))
    const statuses = dataOrThrow(await this.client.session.status({ ...this.ctx() }))
    return { id: session.id, title: session.title, status: statuses[sessionID] ?? { type: "idle" } }
  }

  async getMessages(sessionID: string, cursor?: string): Promise<{ sessionID: string; messages: ChatMessageDto[]; cursor?: string }> {
    const delivered = parseCursor(cursor)
    const limit = delivered + PAGE_SIZE
    const page = dataOrThrow(
      await this.client.session.messages({ path: { id: sessionID }, ...this.ctx({ limit }) }),
    )
    const older = page.slice(0, Math.max(0, page.length - delivered))
    const messages: ChatMessageDto[] = older.map((entry) => ({ info: entry.info, parts: entry.parts }))
    return page.length >= limit
      ? { sessionID, messages, cursor: String(page.length) }
      : { sessionID, messages }
  }

  async sendPrompt(sessionID: string, request: PromptRequest): Promise<void> {
    ensureOk(await this.client.session.promptAsync({
      path: { id: sessionID },
      body: {
        ...(request.agent !== undefined ? { agent: request.agent } : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
        parts: [{ type: "text", text: request.text }],
      },
      ...this.ctx(),
    }))
  }

  async abort(sessionID: string): Promise<void> {
    ensureOk(await this.client.session.abort({ path: { id: sessionID }, ...this.ctx() }))
  }

  async listAgents(): Promise<AgentDto[]> {
    const agents = dataOrThrow(await this.client.app.agents({ ...this.ctx() }))
    return agents
      .filter((agent) => agent.mode !== "subagent" && !isHiddenAgent(agent))
      .map((agent) => ({
        name: agent.name,
        mode: agent.mode,
        builtIn: agent.builtIn,
        ...(agent.description !== undefined ? { description: agent.description } : {}),
        ...(agent.color !== undefined ? { color: agent.color } : {}),
      }))
  }

  async listProviders(): Promise<ProvidersDto> {
    const result = dataOrThrow(await this.client.config.providers({ ...this.ctx() }))
    return { providers: result.providers, default: result.default }
  }

  async respondPermission(sessionID: string, permissionID: string, reply: PermissionReply): Promise<void> {
    ensureOk(await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { response: reply.response },
      ...this.ctx(),
    }))
  }

  async currentAgentModel(sessionID: string): Promise<{ agent?: string; model?: { providerID: string; modelID: string } }> {
    const page = dataOrThrow(
      await this.client.session.messages({ path: { id: sessionID }, ...this.ctx({ limit: PAGE_SIZE }) }),
    )
    for (let index = page.length - 1; index >= 0; index -= 1) {
      const info = page[index]?.info
      if (info === undefined || info.role !== "user") continue
      return { agent: info.agent, model: info.model }
    }
    return {}
  }

  onEvent(callback: (frame: SseFrame) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  ingestEvent(event: unknown): void {
    if (!isRecord(event)) return
    const type = event.type
    if (typeof type !== "string") return
    const properties = isRecord(event.properties) ? event.properties : {}
    this.recordLineage(type, properties)
    const aliased = EVENT_ALIASES[type] ?? type
    if (!SseEvents.has(aliased as SseEventType)) return
    const eventType = aliased as SseEventType
    const sessionID = sessionIdOf(eventType, properties)

    if (sessionID === undefined || this.childSessionIDs.has(sessionID)) return
    this.emit(sessionID, eventType, normalize(eventType, properties))
  }

  private recordLineage(type: string, properties: Properties): void {
    if (!type.startsWith("session.")) return
    const session = isRecord(properties.info) ? properties.info : properties
    if (typeof session.id === "string" && typeof session.parentID === "string") {
      this.childSessionIDs.add(session.id)
    }
  }

  private emit(sessionID: string, event: SseEventType, data: unknown): void {
    const frame: SseFrame = { id: this.nextEventId, sessionID, event, data }
    this.nextEventId += 1
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch (error) {
        this.log("error", `entangle event listener failed: ${String(error)}`)
      }
    }
  }
}
