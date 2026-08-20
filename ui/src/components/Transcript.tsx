/*
 * entangle — transcript
 * ------------------------------------------------------------------
 * The scrolling conversation. Presentational and prop-driven.
 *
 * SCROLL CONTRACT: the view stays pinned to the bottom while new tokens land,
 * but the instant the reader scrolls up we STOP yanking them back — the pin is
 * released and a "jump to latest" pill appears instead. Auto-scrolling a reader
 * away from the line they are reading is the single most hated behaviour in a
 * streaming chat UI, so the pin is a state, never an unconditional effect.
 *
 * The scroll effect uses `useEffect` (not layout effect) deliberately: the rAF
 * stream buffer already coalesces token bursts to one publish per frame, so one
 * post-paint scroll write per frame is exactly the right cadence and keeps the
 * main thread free of synchronous layout thrash.
 */

import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

import type { ChatMessageDto } from "../lib/protocol";
import { createViewportRepinner } from "../lib/viewportPin";
import { MessageParts } from "./MessageParts";
import type { StreamTexts } from "./streamBuffer";

/** Distance from the bottom (px) still considered "pinned". One thumb-flick of slop. */
const PIN_SLOP = 56;

const AGENT_SLOTS = 6;

/** Stable name -> colour slot. Same agent keeps the same colour across turns. */
function agentSlot(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return (hash % AGENT_SLOTS) + 1;
}

function messageAgent(message: ChatMessageDto): string {
  const info = message.info;
  return info.role === "user" ? info.agent : info.mode;
}

/* -------------------------------------------------------------- message -- */

interface MessageGroupProps {
  message: ChatMessageDto;
  streamTexts?: StreamTexts;
  streamingPartID?: string;
}

function MessageGroupImpl({ message, streamTexts, streamingPartID }: MessageGroupProps) {
  const role = message.info.role;
  const agent = messageAgent(message);
  const style = useMemo(
    () => ({ "--agent-color": `var(--agent-${agentSlot(agent)})` }) as React.CSSProperties,
    [agent],
  );

  return (
    <article
      className="msg"
      data-role={role}
      data-message-id={message.info.id}
      data-testid={`message-${role}`}
      style={style}
    >
      {role === "assistant" ? (
        <header className="msg__meta">
          <span className="msg__agent">{agent}</span>
        </header>
      ) : null}
      <div className="msg__body">
        <MessageParts
          parts={message.parts}
          streamTexts={streamTexts}
          streamingPartID={streamingPartID}
        />
      </div>
    </article>
  );
}

const MessageGroup = memo(MessageGroupImpl);

/* ----------------------------------------------------------- transcript -- */

interface TranscriptProps {
  messages: ChatMessageDto[];
  /** Live text keyed by part id, from `useStreamBuffer()`. */
  streamTexts?: StreamTexts;
  /** The single part currently receiving tokens, if any. */
  streamingPartID?: string;
  /** Rendered in place of the list when there are no messages. */
  empty?: ReactNode;
}

function assignRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as { current: HTMLElement | null }).current = node;
}

/**
 * The scroll port is forwarded so App can attach the older-history listener without reaching into the DOM. The
 * component still drives its own pinning through the same node.
 */
export const Transcript = forwardRef<HTMLElement, TranscriptProps>(function Transcript(
  { messages, streamTexts, streamingPartID, empty },
  forwardedRef,
) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(true);
  const repinning = useRef(false);
  const [pinned, setPinned] = useState(true);

  const attachScrollPort = useCallback(
    (node: HTMLElement | null) => {
      scrollRef.current = node;
      assignRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    // A viewport resize emits scroll events with the OLD offset against the NEW
    // port height; honouring them would unpin a reader who never scrolled.
    if (!node || repinning.current) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const next = distance <= PIN_SLOP;
    // Ref first: the effect below reads it without waiting for a re-render.
    if (pinnedRef.current !== next) {
      pinnedRef.current = next;
      setPinned(next);
    }
  }, []);

  const jump = useCallback(() => {
    pinnedRef.current = true;
    setPinned(true);
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  // Re-pin on every content change, but ONLY while the reader has not scrolled up.
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom("auto");
  }, [messages, streamTexts, scrollToBottom]);

  useEffect(() => {
    const controller = createViewportRepinner({
      isPinned: () => pinnedRef.current,
      setRepinning: (active) => {
        repinning.current = active;
      },
      scrollToBottom: () => scrollToBottom("auto"),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (frame) => window.cancelAnimationFrame(frame),
    });

    // The keyboard coordinator owns viewport events. Re-pin only after they
    // produce a real change in this scroll port's layout.
    const observer = new ResizeObserver(controller.signal);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => {
      observer.disconnect();
      controller.stop();
    };
  }, [scrollToBottom]);

  const isEmpty = messages.length === 0;

  return (
    <div className="transcript-wrap">
      <main
        className="transcript"
        data-testid="transcript"
        aria-label="Conversation"
        ref={attachScrollPort}
        onScroll={handleScroll}
      >
        {isEmpty ? empty : null}
        {messages.map((message) => (
          <MessageGroup
            key={message.info.id}
            message={message}
            streamTexts={streamTexts}
            streamingPartID={streamingPartID}
          />
        ))}
      </main>

      {!pinned && !isEmpty ? (
        <button className="jump-pill" type="button" onClick={jump} data-testid="jump-to-latest">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 2.5v7M3 6.5 6 9.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
});
