/*
 * entangle — message part renderer
 * ------------------------------------------------------------------
 * ONE exhaustive switch over the SDK `Part` union. Every branch renders an
 * element carrying `data-part="<part.type>"`; an unrecognised discriminant
 * falls through to `data-part="unknown"` and prints `[unsupported: x]`.
 *
 * WHY THE FALLBACK IS LOAD-BEARING: opencode ships new part types on its own
 * cadence and the phone renders whatever the bridge relays. A missing branch
 * must degrade to a visible marker — never a crash, never silent blankness
 * (a blank turn is indistinguishable from a hung agent on a phone screen).
 *
 * These components are PRESENTATIONAL: props in, DOM out. No fetching, no
 * global state, and no side effects beyond local expand/collapse.
 */

import { memo, useCallback, useState } from "react";
import type { ReactNode } from "react";

import type { Part } from "../lib/protocol";
import { Markdown } from "./markdown";
import type { StreamTexts } from "./streamBuffer";

/* ----------------------------------------------------------------- util -- */

/** Structural narrowing helper: the SDK union has no runtime type guards. */
type Narrow<T extends Part["type"]> = Extract<Part, { type: T }>;

/**
 * Non-SDK enrichment the store MAY attach to a patch part. The wire `PatchPart`
 * carries only `{hash, files}` — no diff body — so the diff view is optional
 * and the card degrades to a file list when it is absent.
 */
interface PatchDiff {
  diff?: string;
}
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

const INPUT_TITLE_KEYS = [
  "filePath",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
];

/** Best-effort one-liner for a tool call from whatever its input happens to hold. */
function toolTitle(tool: string, input: Record<string, unknown> | undefined): string {
  if (input) {
    for (const key of INPUT_TITLE_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim() !== "") return firstLine(value.trim());
    }
  }
  return tool;
}

function pretty(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

function fileName(pathLike: string): string {
  const clean = pathLike.split(/[?#]/, 1)[0] ?? pathLike;
  const tail = clean.split("/").filter(Boolean).pop();
  return tail && tail !== "" ? decodeURIComponent(tail) : clean;
}

function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/* ---------------------------------------------------------------- atoms -- */

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="part__chevron" data-open={open ? "true" : undefined} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const TOOL_ICON: Record<string, ReactNode> = {
  pending: (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2.4" />
    </svg>
  ),
  running: (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.25" />
      <path d="M7 1.75A5.25 5.25 0 0 1 12.25 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  completed: (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7.4 5.8 10 11 3.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 3.2v4.4M7 10.4v.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
};

const TOOL_LABEL: Record<string, string> = {
  pending: "Queued",
  running: "Running",
  completed: "Done",
  error: "Failed",
};

/** Marker row used by step-start / step-finish / snapshot / compaction. */
function Divider({ type, label, testid }: { type: string; label: string; testid?: string }) {
  return (
    <div className="part part--divider" data-part={type} data-testid={testid}>
      <span className="part__rule" aria-hidden="true" />
      <span className="part__rule-label">{label}</span>
      <span className="part__rule" aria-hidden="true" />
    </div>
  );
}

/* ------------------------------------------------------------ reasoning -- */

function ReasoningPartView({ part, text, active }: { part: Narrow<"reasoning">; text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <div className="part part--reasoning" data-part="reasoning" data-active={active ? "true" : undefined}>
      <button className="part__head" type="button" onClick={toggle} aria-expanded={open}>
        <Chevron open={open} />
        <span className="part__label" data-shimmer={active ? "true" : undefined}>
          {active ? "Thinking…" : "Thought"}
        </span>
        {!open && text !== "" ? <span className="part__peek">{firstLine(text)}</span> : null}
      </button>
      {open ? (
        <div className="part__body part__body--reasoning" data-testid="reasoning-output">
          <Markdown text={text} streaming={active} />
        </div>
      ) : null}
      <span hidden>{part.id}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- tool -- */

function ToolPartView({ part }: { part: Narrow<"tool"> }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const state = part.state;
  const status = state.status;

  const title =
    state.status === "completed"
      ? state.title || toolTitle(part.tool, state.input)
      : state.status === "error"
        ? firstLine(state.error)
        : state.status === "running"
          ? state.title || toolTitle(part.tool, state.input)
          : toolTitle(part.tool, state.input);

  const output =
    state.status === "completed"
      ? state.output
      : state.status === "error"
        ? state.error
        : pretty(state.input);

  return (
    <div className="part part--tool" data-part="tool" data-status={status}>
      <button className="part__head" type="button" onClick={toggle} aria-expanded={open}>
        <Chevron open={open} />
        <span className="tool__icon" data-status={status} aria-hidden="true">
          {TOOL_ICON[status]}
        </span>
        <span className="tool__name">{part.tool}</span>
        <span className="tool__title">{title}</span>
        <span className="tool__status">{TOOL_LABEL[status]}</span>
      </button>
      {open ? (
        <pre className="part__body part__body--output" data-testid="tool-output">
          {output === "" ? "(no output)" : output}
        </pre>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- patch -- */

function PatchPartView({ part }: { part: Narrow<"patch"> & PatchDiff }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const diff = part.diff ?? "";
  const { additions, deletions } = countDiff(diff);
  const label = part.files.length === 1 ? fileName(part.files[0] ?? "") : `${part.files.length} files`;

  return (
    <div className="part part--patch" data-part="patch">
      <button className="part__head" type="button" onClick={toggle} aria-expanded={open}>
        <Chevron open={open} />
        <span className="part__label">Patch</span>
        <span className="patch__file">{label}</span>
        <span className="patch__stat patch__stat--add">+{additions}</span>
        <span className="patch__stat patch__stat--del">−{deletions}</span>
      </button>
      {open ? (
        <div className="part__body part__body--output" data-testid="patch-diff">
          {diff === "" ? (
            <div className="patch__files">
              {part.files.map((file) => (
                <div className="patch__row" key={file}>
                  {file}
                </div>
              ))}
            </div>
          ) : (
            diff.split("\n").map((line, index) => (
              <div
                className="patch__line"
                data-sign={line.startsWith("+++") || line.startsWith("---") ? "meta" : line[0] === "+" ? "add" : line[0] === "-" ? "del" : line[0] === "@" ? "hunk" : undefined}
                key={index}
              >
                {line === "" ? " " : line}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- dispatch -- */

interface MessagePartProps {
  part: Part;
  /** Live text for this part, published by the rAF stream buffer. */
  streamText?: string;
  /** True while tokens are still arriving for this part. */
  streaming?: boolean;
}

function MessagePartImpl({ part, streamText, streaming = false }: MessagePartProps) {
  switch (part.type) {
    case "text": {
      const text = streamText ?? part.text;
      if (text.trim() === "" && !streaming) return null;
      return (
        <div className="part part--text" data-part="text">
          <Markdown text={text} streaming={streaming} />
        </div>
      );
    }

    case "reasoning": {
      const text = streamText ?? part.text;
      return <ReasoningPartView part={part} text={text} active={streaming || part.time.end === undefined} />;
    }

    case "tool":
      return <ToolPartView part={part} />;

    case "file": {
      const name = part.filename ?? fileName(part.url);
      return (
        <div className="part part--file" data-part="file">
          <span className="chip chip--file">
            <svg className="chip__icon" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3.5 1.75h4L10.5 4.75v7.5h-7z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <path d="M7.5 1.75v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className="chip__text">{name}</span>
            <span className="chip__meta">{part.mime}</span>
          </span>
        </div>
      );
    }

    case "patch":
      return <PatchPartView part={part} />;

    case "step-start":
      return <Divider type="step-start" label="step" />;

    case "step-finish": {
      const total = part.tokens.input + part.tokens.output;
      return <Divider type="step-finish" label={`step end · ${total.toLocaleString()} tok · ${part.reason}`} />;
    }

    case "snapshot":
      return (
        <div className="part part--snapshot" data-part="snapshot">
          <span className="part__marker">snapshot {part.snapshot.slice(0, 8)}</span>
        </div>
      );

    case "compaction":
      return <Divider type="compaction" label={part.auto ? "context compacted" : "context compacted manually"} />;

    case "agent":
      return (
        <div className="part part--agent" data-part="agent">
          <span className="chip chip--agent">
            <span className="chip__arrow" aria-hidden="true">
              agent →
            </span>
            <span className="chip__text">{part.name}</span>
          </span>
        </div>
      );

    case "subtask":
      return (
        <div className="part part--subtask" data-part="subtask">
          <div className="subtask__card">
            <span className="subtask__head">
              <span className="chip__arrow" aria-hidden="true">
                subtask →
              </span>
              <span className="subtask__agent">{part.agent}</span>
            </span>
            <span className="subtask__desc">{part.description}</span>
            <span className="subtask__prompt">{firstLine(part.prompt)}</span>
          </div>
        </div>
      );

    case "retry": {
      const message = part.error?.data?.message ?? "retrying";
      return (
        <div className="part part--retry" data-part="retry" role="status">
          <span className="chip chip--retry">
            <span className="chip__dot" aria-hidden="true" />
            <span className="chip__text">retrying… attempt {part.attempt}</span>
            <span className="chip__meta">{firstLine(message)}</span>
          </span>
        </div>
      );
    }

    default: {
      // No SDK branch matched: surface it rather than dropping the turn.
      const unknown = part as { type?: unknown };
      return (
        <div className="part part--unknown" data-part="unknown">
          <span className="part__marker">[unsupported: {String(unknown.type ?? "undefined")}]</span>
        </div>
      );
    }
  }
}

/** Memoised: a token append must not re-render sibling parts. */
const MessagePart = memo(MessagePartImpl);

interface MessagePartsProps {
  parts: Part[];
  /** Live text keyed by part id, from `useStreamBuffer()`. */
  streamTexts?: StreamTexts;
  /** The single part currently receiving tokens, if any. */
  streamingPartID?: string;
}

/** Renders a message's parts in wire order. */
export function MessageParts({ parts, streamTexts, streamingPartID }: MessagePartsProps) {
  return (
    <>
      {parts.map((part) => (
        <MessagePart
          key={part.id}
          part={part}
          streamText={streamTexts?.[part.id]}
          streaming={streamingPartID === part.id}
        />
      ))}
    </>
  );
}
