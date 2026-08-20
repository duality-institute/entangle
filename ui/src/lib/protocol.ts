/*
 * Browser-safe protocol surface. Types are erased re-exports; runtime guards are
 * mirrored here so importing them does not pull Zod into the mobile bundle.
 * `tests/ui-connection.test.ts` verifies parity with the server guards.
 */

import type { SseEventType, SseFrame, SseReplayGap } from "../../../src/shared/protocol";

export type {
  AgentDto,
  ChatMessageDto,
  MessagesPageDto,
  Message,
  Part,
  PermissionDto,
  PermissionReply,
  PromptRequest,
  ProviderDto,
  ProvidersDto,
  SessionInfoDto,
  SessionStatus,
  SseEventType,
  SseFrame,
  SseReplayGap,
} from "../../../src/shared/protocol";

const SSE_EVENTS: ReadonlySet<string> = new Set<SseEventType>([
  "message.updated",
  "message.part.updated",
  "session.status",
  "session.idle",
  "session.error",
  "permission.updated",
  "permission.replied",
  "session.compacted",
]);

export function isSseFrame(value: unknown): value is SseFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame.id === "number" &&
    Number.isInteger(frame.id) &&
    typeof frame.sessionID === "string" &&
    frame.sessionID !== "" &&
    typeof frame.event === "string" &&
    SSE_EVENTS.has(frame.event) &&
    "data" in frame
  );
}

export function isSseReplayGap(value: unknown): value is SseReplayGap {
  return !!value && typeof value === "object" && (value as { gap?: unknown }).gap === true;
}
