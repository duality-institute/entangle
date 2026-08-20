import { z } from "zod"
import type {
  Agent,
  Message,
  Part,
  Provider,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk"

export type { Agent, Message, Model, Part, Provider, SessionStatus } from "@opencode-ai/sdk"

export const EntangleOptions = z.object({
  port: z.number().int().min(0).max(65535).default(0),
  host: z.string().default("0.0.0.0"),
  pairingTtlMs: z.number().int().positive().default(300_000),
})
export type EntangleOptions = z.infer<typeof EntangleOptions>

export const InstanceDescriptor = z.object({
  version: z.literal(1),
  pid: z.number().int().nonnegative(),
  directory: z.string(),
  worktree: z.string(),
  controlUrl: z.string(),
  controlToken: z.string(),
  updatedAt: z.number(),
})
export type InstanceDescriptor = z.infer<typeof InstanceDescriptor>

export type SessionInfoDto = Pick<Session, "id" | "title"> & { status: SessionStatus }
export type ChatMessageDto = { info: Message; parts: Part[] }
export type MessagesPageDto = { sessionID: string; messages: ChatMessageDto[]; cursor?: string }

/**
 * One row of the CLI pairing picker. Deliberately absent from `Bridge`: the phone
 * must never gain a vocabulary for enumerating chats, only for driving its pinned one.
 */
export type SessionSummaryDto = Pick<Session, "id" | "title"> & { updatedAt: number }

export const PromptRequest = z.object({
  text: z.string(),
  agent: z.string().optional(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
})
export type PromptRequest = z.infer<typeof PromptRequest>

export type AgentDto = Pick<Agent, "name" | "mode" | "builtIn"> &
  Partial<Pick<Agent, "description" | "color">>
export type ProviderDto = Provider

/** `default` maps providerID -> modelID; the picker needs it when history is empty. */
export type ProvidersDto = { providers: ProviderDto[]; default: Record<string, string> }

export type PermissionDto = {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
}

export const PermissionReply = z.object({
  response: z.enum(["once", "always", "reject"]),
})
export type PermissionReply = z.infer<typeof PermissionReply>

export type SseEventType =
  | "message.updated"
  | "message.part.updated"
  | "session.status"
  | "session.idle"
  | "session.error"
  | "permission.updated"
  | "permission.replied"
  | "session.compacted"

export type SseFrame = {
  id: number
  sessionID: string
  event: SseEventType
  data: unknown
}
export type SseReplayGap = { gap: true }

export function isSseFrame(value: unknown): value is SseFrame {
  if (!value || typeof value !== "object") return false
  const frame = value as Record<string, unknown>
  return typeof frame.id === "number" && Number.isInteger(frame.id) &&
    typeof frame.sessionID === "string" && frame.sessionID !== "" &&
    typeof frame.event === "string" && SseEvents.has(frame.event as SseEventType) && "data" in frame
}

export function isSseReplayGap(value: unknown): value is SseReplayGap {
  return !!value && typeof value === "object" && (value as { gap?: unknown }).gap === true
}

export const SseEvents = new Set<SseEventType>([
  "message.updated", "message.part.updated", "session.status", "session.idle",
  "session.error", "permission.updated", "permission.replied", "session.compacted",
])

export interface Bridge {
  getSession(sessionID: string): Promise<SessionInfoDto>
  getMessages(sessionID: string, cursor?: string): Promise<MessagesPageDto>
  sendPrompt(sessionID: string, req: PromptRequest): Promise<void>
  abort(sessionID: string): Promise<void>
  listAgents(): Promise<AgentDto[]>
  listProviders(): Promise<ProvidersDto>
  respondPermission(sessionID: string, id: string, reply: PermissionReply): Promise<void>
  currentAgentModel(sessionID: string): Promise<{ agent?: string; model?: { providerID: string; modelID: string } }>
  onEvent(cb: (frame: SseFrame) => void): () => void
}
