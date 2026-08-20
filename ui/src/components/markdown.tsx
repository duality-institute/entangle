/*
 * entangle — streaming-safe markdown renderer
 * ------------------------------------------------------------------
 * WHY HAND-ROLLED: the chat renderer must render *incomplete* markdown that
 * arrives token by token. A half-typed ```ts fence has to paint as a code
 * block BEFORE its closing fence exists, and the classic remark/rehype chain
 * is much larger and would blow the bundle budget
 * and treats an unclosed fence as a paragraph until it closes.
 *
 * This parser is block-first and forgiving:
 *   - an unterminated fence closes implicitly at end-of-input (`closed:false`)
 *   - an unterminated inline marker (`**`, `` ` ``) stays literal text
 *   - output is React elements only — never dangerouslySetInnerHTML — so
 *     untrusted model output cannot inject markup.
 *
 * Supported: fenced code, ATX headings, ul/ol lists, blockquotes, thematic
 * breaks, paragraphs; inline code, strong, emphasis, strikethrough, links and
 * bare autolinks. Deliberately NOT supported (v1 scope): tables, html, images,
 * footnotes, math, mermaid.
 */

import { memo, useMemo } from "react";
import type { ReactNode } from "react";

type MdBlock =
  | { kind: "code"; lang: string; code: string; closed: boolean }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "para"; text: string };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const UL_ITEM = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_ITEM = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;

/** Parse a (possibly truncated) markdown document into block nodes. */
function parseMarkdown(source: string): MdBlock[] {
  const lines = source.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const lang = fence[2] ?? "";
      const body: string[] = [];
      let closed = false;
      i += 1;
      for (; i < lines.length; i += 1) {
        const candidate = lines[i] ?? "";
        const trimmed = candidate.trim();
        const sameChar = trimmed.startsWith(marker[0] ?? "`");
        if (sameChar && trimmed.length >= marker.length && /^(`+|~+)$/.test(trimmed)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(candidate);
      }
      blocks.push({ kind: "code", lang, code: body.join("\n"), closed });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const collected: string[] = [quote[1] ?? ""];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i] ?? "");
        if (!next) break;
        collected.push(next[1] ?? "");
        i += 1;
      }
      blocks.push({ kind: "quote", text: collected.join("\n") });
      continue;
    }

    const ul = UL_ITEM.exec(line);
    const ol = OL_ITEM.exec(line);
    if (ul || ol) {
      const ordered = !ul;
      const start = ol ? Number.parseInt(ol[1] ?? "1", 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const nextUl = UL_ITEM.exec(current);
        const nextOl = OL_ITEM.exec(current);
        if (ordered ? !nextOl : !nextUl) break;
        items.push((ordered ? nextOl?.[2] : nextUl?.[1]) ?? "");
        i += 1;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        current.trim() === "" ||
        FENCE_OPEN.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        QUOTE.test(current) ||
        UL_ITEM.test(current) ||
        OL_ITEM.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      i += 1;
    }
    blocks.push({ kind: "para", text: paragraph.join("\n") });
  }

  return blocks;
}

/* --------------------------------------------------------------- inline -- */

// NOTE: `_underscore_` emphasis is deliberately NOT supported — identifiers
// like `__init__` and `snake_case_name` appear constantly in agent output and
// would emphasise at random. Asterisks only.
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|\*([^*\n]+?)\*|~~([\s\S]+?)~~|\[([^\]\n]*)\]\(([^()\s]*)\)|(\bhttps?:\/\/[^\s<>()[\]]+)/g;

const SAFE_HREF = /^(https?:|mailto:)/i;

/** Render inline markdown to React nodes. `depth` guards pathological nesting. */
function renderInline(text: string, depth = 0): ReactNode[] {
  const nodes: ReactNode[] = [];
  if (text === "") return nodes;
  if (depth > 3) {
    nodes.push(text);
    return nodes;
  }

  INLINE.lastIndex = 0;
  let cursor = 0;
  let key = 0;
  let match = INLINE.exec(text);

  while (match) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const [, , codeText, strong, em, strike, linkText, linkHref, autolink] = match;

    if (codeText !== undefined) {
      nodes.push(
        <code className="md-code" key={key}>
          {codeText.replace(/^ | $/g, "")}
        </code>,
      );
    } else if (strong !== undefined) {
      nodes.push(<strong key={key}>{renderInline(strong, depth + 1)}</strong>);
    } else if (em !== undefined) {
      nodes.push(<em key={key}>{renderInline(em, depth + 1)}</em>);
    } else if (strike !== undefined) {
      nodes.push(<del key={key}>{renderInline(strike, depth + 1)}</del>);
    } else if (linkHref !== undefined) {
      nodes.push(
        SAFE_HREF.test(linkHref) ? (
          <a className="md-link" href={linkHref} target="_blank" rel="noreferrer noopener" key={key}>
            {renderInline(linkText ?? linkHref, depth + 1)}
          </a>
        ) : (
          <span key={key}>{`[${linkText ?? ""}](${linkHref})`}</span>
        ),
      );
    } else if (autolink !== undefined) {
      nodes.push(
        <a className="md-link" href={autolink} target="_blank" rel="noreferrer noopener" key={key}>
          {autolink}
        </a>,
      );
    }

    key += 1;
    cursor = match.index + match[0].length;
    INLINE.lastIndex = cursor;
    match = INLINE.exec(text);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/* ---------------------------------------------------------------- block -- */

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case "code":
      return (
        <pre className="md-pre" data-lang={block.lang || undefined} data-open={block.closed ? undefined : "true"}>
          {block.lang ? <span className="md-pre__lang">{block.lang}</span> : null}
          <code>{block.code}</code>
        </pre>
      );
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const Tag = `h${level}` as "h1";
      return (
        <Tag className="md-heading" data-level={level}>
          {renderInline(block.text)}
        </Tag>
      );
    }
    case "list":
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "quote":
      return <blockquote className="md-quote">{renderInline(block.text)}</blockquote>;
    case "rule":
      return <hr className="md-rule" />;
    case "para":
      return <p className="md-para">{renderInline(block.text)}</p>;
  }
}

interface MarkdownProps {
  text: string;
  /** Adds a caret affordance to the final block while tokens are still arriving. */
  streaming?: boolean;
}

function MarkdownImpl({ text, streaming = false }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md" data-streaming={streaming ? "true" : undefined}>
      {blocks.map((block, index) => (
        <Block block={block} key={index} />
      ))}
    </div>
  );
}

/** Memoised so a token append only re-parses the part that actually changed. */
export const Markdown = memo(MarkdownImpl);
