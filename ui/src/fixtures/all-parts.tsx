/*
 * entangle — fixture: every part variant
 * ------------------------------------------------------------------
 * Renders one turn containing ALL 12 SDK `Part` discriminants (all four tool
 * states) plus a deliberately bogus part that must land on the `unknown`
 * fallback, then a second turn that streams so the caret/shimmer are visible.
 *
 * The part literals mirror `tests/fixtures/fake-bridge.ts` so server
 * tests and UI screenshots describe the same conversation. They are COPIED
 * rather than imported: `tests/` pulls in zod through `src/shared/protocol`,
 * and a dev fixture must not drag a runtime dependency into `dist/ui`.
 * The protocol import below is type-only and therefore fully erased.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessageDto, Part } from "../../../src/shared/protocol";
import { Transcript } from "../components/Transcript";
import { createStreamBuffer, useStreamBuffer } from "../components/streamBuffer";

const SESSION = "ses_fixture";
const USER_ID = "msg_user_1";
const ASSISTANT_ID = "msg_assistant_1";
const STREAM_ID = "msg_assistant_2";
const STREAM_PART_ID = "prt_stream_text";

const base = { sessionID: SESSION, messageID: ASSISTANT_ID };

const SAMPLE_DIFF = `--- a/src/server/bridge.ts
+++ b/src/server/bridge.ts
@@ -18,7 +18,9 @@ export class OpencodeBridge {
   async messages(sessionID: string) {
-    const res = await this.client.session.messages({ path: { id: sessionID } })
-    return res.data ?? []
+    const res = await this.client.session.messages({ path: { id: sessionID } })
+    if (!res.data) throw new Error("bridge: empty message list")
+    return res.data
   }
`;

const SAMPLE_TODOS = [
  { content: "Trace the live todo payload", status: "completed", priority: "high" },
  { content: "Render structured tasks instead of JSON", status: "in_progress", priority: "high" },
  { content: "Check narrow-phone wrapping", status: "pending", priority: "medium" },
  { content: "Remove the legacy raw view", status: "cancelled", priority: "low" },
];

const USER_PARTS: Part[] = [
  {
    id: "prt_user_text",
    sessionID: SESSION,
    messageID: USER_ID,
    type: "text",
    text: "Summarise the bridge module and fix the failing test.",
    time: { start: 1_700_000_000_000, end: 1_700_000_000_000 },
  },
];

const ASSISTANT_PARTS: Part[] = [
  { ...base, id: "prt_step_start", type: "step-start", snapshot: "snap_0" },
  {
    ...base,
    id: "prt_agent",
    type: "agent",
    name: "build",
    source: { value: "@build", start: 0, end: 6 },
  },
  {
    ...base,
    id: "prt_text",
    type: "text",
    text: [
      "## Bridge review",
      "",
      "Reading `src/server/bridge.ts` now — the cursor math in `messages()` is the",
      "suspect. Three things stand out:",
      "",
      "- `res.data` is assumed non-null but the SDK types it optional",
      "- the replay cursor is **off by one** after a reconnect",
      "- see [the SSE notes](https://example.com/sse) for the ordering rule",
      "",
      "```ts",
      "const res = await this.client.session.messages({ path: { id } })",
      "if (!res.data) throw new Error('bridge: empty message list')",
      "```",
      "",
      "> Fix lands in the patch below.",
    ].join("\n"),
    time: { start: 1_700_000_001_000, end: 1_700_000_002_000 },
  },
  {
    ...base,
    id: "prt_reasoning",
    type: "reasoning",
    text: "The failure is in the cursor math: `since(id)` returns the gap flag but the caller drops it, so the client never learns it missed events.",
    time: { start: 1_700_000_002_000 },
  },
  {
    ...base,
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
    ...base,
    id: "prt_tool_completed",
    type: "tool",
    callID: "call_read_1",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "src/server/bridge.ts" },
      output:
        "export class OpencodeBridge {\n  constructor(private client: OpencodeClient) {}\n\n  async messages(sessionID: string) {\n    const res = await this.client.session.messages({ path: { id: sessionID } })\n    return res.data ?? []\n  }\n}",
      title: "src/server/bridge.ts",
      metadata: { lines: 8 },
      time: { start: 1_700_000_003_000, end: 1_700_000_004_000 },
    },
  },
  {
    ...base,
    id: "prt_tool_running",
    type: "tool",
    callID: "call_bash_1",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "bun test tests/server/bridge.test.ts" },
      title: "bun test tests/server/bridge.test.ts",
      time: { start: 1_700_000_004_000 },
    },
  },
  {
    ...base,
    id: "prt_tool_todowrite",
    type: "tool",
    callID: "call_todowrite_1",
    tool: "todowrite",
    state: {
      status: "completed",
      input: { todos: SAMPLE_TODOS },
      output: JSON.stringify(SAMPLE_TODOS),
      title: "4 todos",
      metadata: { todos: SAMPLE_TODOS, truncated: false },
      time: { start: 1_700_000_004_100, end: 1_700_000_004_200 },
    },
  },
  {
    ...base,
    id: "prt_tool_pending",
    type: "tool",
    callID: "call_edit_1",
    tool: "edit",
    state: {
      status: "pending",
      input: { filePath: "src/server/bridge.ts", oldString: "res.data ?? []" },
      raw: '{"filePath":"src/server/bridge.ts"}',
    },
  },
  {
    ...base,
    id: "prt_tool_error",
    type: "tool",
    callID: "call_grep_1",
    tool: "grep",
    state: {
      status: "error",
      input: { pattern: "getMessages\\(" },
      error: "grep: no matches for pattern getMessages\\( in src/**\nexit code 1",
      time: { start: 1_700_000_004_500, end: 1_700_000_004_800 },
    },
  },
  {
    ...base,
    id: "prt_subtask",
    type: "subtask",
    prompt: "Find every caller of getMessages and report the file:line of each.",
    description: "callsite sweep",
    agent: "explore",
  },
  { ...base, id: "prt_snapshot", type: "snapshot", snapshot: "snap_1c0ffee0" },
  {
    ...base,
    id: "prt_tool_patch",
    type: "tool",
    callID: "call_patch_1",
    tool: "apply_patch",
    state: {
      status: "completed",
      input: { patchText: "*** Begin Patch" },
      output: "Success. Updated src/server/bridge.ts",
      title: "Success",
      metadata: {
        diff: SAMPLE_DIFF,
        files: [
          {
            filePath: "/repo/src/server/bridge.ts",
            relativePath: "src/server/bridge.ts",
            type: "update",
            patch: SAMPLE_DIFF,
            additions: 3,
            deletions: 2,
          },
        ],
      },
      time: { start: 1_700_000_004_900, end: 1_700_000_005_000 },
    },
  },
  {
    ...base,
    id: "prt_patch",
    type: "patch",
    hash: "a1b2c3d4",
    files: ["src/server/bridge.ts"],
  },
  {
    ...base,
    id: "prt_retry",
    type: "retry",
    attempt: 1,
    error: {
      name: "APIError",
      data: { message: "429 rate limited", statusCode: 429, isRetryable: true },
    },
    time: { created: 1_700_000_005_000 },
  },
  { ...base, id: "prt_compaction", type: "compaction", auto: true },
  {
    ...base,
    id: "prt_step_finish",
    type: "step-finish",
    reason: "stop",
    snapshot: "snap_2",
    cost: 0.0123,
    tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 900, write: 120 } },
  },
  // Not a member of the SDK union — MUST land on the `unknown` fallback.
  { ...base, id: "prt_bogus", type: "quantum-foam" } as unknown as Part,
];

const STREAM_TEXT = [
  "Applying the fix and re-running the suite:",
  "",
  "```sh",
  "bun test tests/server/bridge.test.ts",
  "```",
].join("\n");

const MESSAGES: ChatMessageDto[] = [
  {
    info: {
      id: USER_ID,
      sessionID: SESSION,
      role: "user",
      time: { created: 1_700_000_000_000 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    },
    parts: USER_PARTS,
  },
  {
    info: {
      id: ASSISTANT_ID,
      sessionID: SESSION,
      role: "assistant",
      time: { created: 1_700_000_001_000, completed: 1_700_000_006_000 },
      parentID: USER_ID,
      modelID: "claude-opus-5",
      providerID: "anthropic",
      mode: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0.0123,
      tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 900, write: 120 } },
      finish: "stop",
    },
    parts: ASSISTANT_PARTS,
  },
  {
    info: {
      id: STREAM_ID,
      sessionID: SESSION,
      role: "assistant",
      time: { created: 1_700_000_007_000 },
      parentID: USER_ID,
      modelID: "claude-opus-5",
      providerID: "anthropic",
      mode: "explore",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: STREAM_PART_ID,
        sessionID: SESSION,
        messageID: STREAM_ID,
        type: "text",
        text: "",
        time: { start: 1_700_000_007_000 },
      },
    ],
  },
];

export default function AllPartsFixture() {
  const buffer = useMemo(() => createStreamBuffer(), []);
  const streamTexts = useStreamBuffer(buffer);
  const [done, setDone] = useState(false);
  const cursor = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      if (cursor.current >= STREAM_TEXT.length) {
        clearInterval(timer);
        buffer.flush();
        setDone(true);
        return;
      }
      cursor.current += 3;
      buffer.set(STREAM_PART_ID, STREAM_TEXT.slice(0, cursor.current));
    }, 16);
    return () => clearInterval(timer);
  }, [buffer]);

  return (
    <div className="app-shell">
      <header className="app-header" data-testid="app-header">
        <div className="app-header__brand">
          <span className="rings rings--sm" aria-hidden="true" />
          <div className="app-header__titles">
            <span className="app-header__name">entangle</span>
            <span className="app-header__meta">fixture · all parts</span>
          </div>
        </div>
        <span className="status-pill" data-status={done ? "idle" : "busy"} data-testid="status-pill" role="status">
          <span className="status-pill__dot" aria-hidden="true" />
          {done ? "Idle" : "Busy"}
        </span>
      </header>

      <Transcript
        messages={MESSAGES}
        streamTexts={streamTexts}
        streamingPartID={done ? undefined : STREAM_PART_ID}
      />

      {done ? <span data-testid="fixture-ready" hidden /> : null}
    </div>
  );
}
