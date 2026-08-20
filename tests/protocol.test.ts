import { describe, expect, test } from "bun:test"
import {
  EntangleOptions, InstanceDescriptor, PermissionReply, PromptRequest,
  isSseFrame, isSseReplayGap,
} from "../src/shared/protocol"

describe("shared protocol", () => {
  test("applies options defaults in declaration order", () => {
    expect(JSON.stringify(EntangleOptions.parse({}))).toBe('{"port":0,"host":"0.0.0.0","pairingTtlMs":300000}')
  })
  test("rejects invalid options and request bodies", () => {
    expect(() => EntangleOptions.parse({ port: -1 })).toThrow()
    expect(() => PromptRequest.parse({ text: 42 })).toThrow()
    expect(() => PermissionReply.parse({ response: "later" })).toThrow()
  })
  test("descriptor round-trips through JSON", () => {
    const descriptor = { version: 1 as const, pid: 12, directory: "/tmp", worktree: "/repo", controlUrl: "http://x", controlToken: "secret", updatedAt: 123 }
    expect(InstanceDescriptor.parse(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor)
  })
  test("recognizes SSE frames and replay gaps", () => {
    expect(isSseFrame({ id: 1, sessionID: "ses_1", event: "session.idle", data: {} })).toBe(true)
    expect(isSseFrame({ id: 1, sessionID: "ses_1", event: "unknown", data: {} })).toBe(false)
    expect(isSseReplayGap({ gap: true })).toBe(true)
    expect(isSseReplayGap({ gap: false })).toBe(false)
  })
})
