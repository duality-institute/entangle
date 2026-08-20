/*
 * entangle — fixture: sustained token stream
 * ------------------------------------------------------------------
 * Emits EXACTLY 500 tokens at ~80 tok/s (12ms apart, ≈6.2s total) through the
 * rAF stream buffer. Tokens 120..419 sit inside an OPEN ```ts fence, so for
 * ~3.6 seconds the renderer is asked to paint a code block whose closing fence
 * does not exist yet — the exact condition remark/rehype gets wrong and the
 * reason `markdown.tsx` is hand-rolled.
 *
 * This is the perf harness too: with the rAF buffer in place a PerformanceObserver
 * on `longtask` must record ZERO entries over the whole run.
 *
 * Signals for the driver:
 *   [data-testid="stream-open-fence"]  present while the fence is unclosed
 *   [data-testid="stream-done"]        appended after the final token settles
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessageDto, Part } from "../../../src/shared/protocol";
import { Transcript } from "../components/Transcript";
import { createStreamBuffer, useStreamBuffer } from "../components/streamBuffer";

const SESSION = "ses_stream";
const USER_ID = "msg_user_stream";
const ASSISTANT_ID = "msg_assistant_stream";
const PART_ID = "prt_stream";

const TOKEN_COUNT = 500;
const TOKENS_PER_SECOND = 80;
const TICK_MS = Math.round(1000 / TOKENS_PER_SECOND);

const FENCE_OPEN_AT = 120;
const FENCE_CLOSE_AT = 420;

const PROSE = [
  "The", "replay", "cursor", "advances", "only", "after", "the", "frame", "is", "flushed,",
  "so", "a", "reconnect", "never", "re-sends", "an", "event", "the", "client", "already",
  "acknowledged.", "Each", "token", "below", "arrives", "independently", "and", "the", "buffer",
  "coalesces", "them", "into", "one", "paint", "per", "frame.",
];

const CODE = [
  "export", "async", "function", "replay(cursor:", "number)", "{\n",
  "  const", "gap", "=", "log.since(cursor)\n",
  "  if", "(gap.missed)", "yield", '{ gap: true }\n',
  "  for", "(const", "event", "of", "gap.events)", "{\n",
  "    yield", "encode(event)\n",
  "  }\n",
  "}\n\n",
];

/** Deterministic 500-token script with an open fence across tokens 120..419. */
function buildTokens(): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < TOKEN_COUNT; index += 1) {
    if (index === FENCE_OPEN_AT) {
      tokens.push("\n\n```ts\n");
    } else if (index === FENCE_CLOSE_AT) {
      tokens.push("\n```\n\n");
    } else if (index > FENCE_OPEN_AT && index < FENCE_CLOSE_AT) {
      tokens.push(CODE[(index - FENCE_OPEN_AT - 1) % CODE.length] ?? " ");
      const emitted = tokens[tokens.length - 1] ?? "";
      if (!emitted.endsWith("\n")) tokens[tokens.length - 1] = `${emitted} `;
    } else {
      const word = PROSE[index % PROSE.length] ?? "token";
      tokens.push(`${word} `);
    }
  }
  return tokens;
}

const TOKENS = buildTokens();

const PART: Part = {
  id: PART_ID,
  sessionID: SESSION,
  messageID: ASSISTANT_ID,
  type: "text",
  text: "",
  time: { start: 1_700_000_000_000 },
};

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
    parts: [
      {
        id: "prt_stream_user",
        sessionID: SESSION,
        messageID: USER_ID,
        type: "text",
        text: "Walk me through the replay cursor and show the code.",
        time: { start: 1_700_000_000_000 },
      },
    ],
  },
  {
    info: {
      id: ASSISTANT_ID,
      sessionID: SESSION,
      role: "assistant",
      time: { created: 1_700_000_000_500 },
      parentID: USER_ID,
      modelID: "claude-opus-5",
      providerID: "anthropic",
      mode: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [PART],
  },
];

export default function StreamFixture() {
  const buffer = useMemo(() => createStreamBuffer(), []);
  const streamTexts = useStreamBuffer(buffer);
  const [done, setDone] = useState(false);
  const cursor = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      const index = cursor.current;
      if (index >= TOKENS.length) {
        clearInterval(timer);
        buffer.flush();
        setDone(true);
        return;
      }
      cursor.current = index + 1;
      buffer.append(PART_ID, TOKENS[index] ?? "");
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [buffer]);

  const text = streamTexts[PART_ID] ?? "";
  const fenceOpen = !done && text.includes("```ts") && !/```ts[\s\S]*\n```/.test(text);

  return (
    <div className="app-shell" data-stream-state={done ? "done" : fenceOpen ? "fence-open" : "streaming"}>
      <header className="app-header" data-testid="app-header">
        <div className="app-header__brand">
          <span className="rings rings--sm" aria-hidden="true" />
          <div className="app-header__titles">
            <span className="app-header__name">entangle</span>
            <span className="app-header__meta">fixture · stream</span>
          </div>
        </div>
        <span className="status-pill" data-status={done ? "idle" : "busy"} data-testid="status-pill" role="status">
          <span className="status-pill__dot" aria-hidden="true" />
          {done ? "Idle" : "Streaming"}
        </span>
      </header>

      <Transcript messages={MESSAGES} streamTexts={streamTexts} streamingPartID={done ? undefined : PART_ID} />

      {fenceOpen ? <span data-testid="stream-open-fence" hidden /> : null}
      {done ? <span data-testid="stream-done" hidden /> : null}
    </div>
  );
}
