/*
 * entangle — composer
 * ------------------------------------------------------------------
 * Sticky bottom bar: a textarea that grows 1 -> 6 rows and a send button.
 *
 * KEYBOARD CONTRACT: on a touch device Enter inserts a NEWLINE and sending is
 * button-only. Phone keyboards put Return where the thumb lands, so an
 * Enter-sends binding fires half-written prompts constantly. Desktop (fine
 * pointer) keeps the familiar Enter-sends / Shift+Enter-newline pair, and
 * Cmd/Ctrl+Enter sends everywhere as a universal escape hatch.
 *
 * Presentational: no fetch, no store. The text lives here (it is pure input
 * state that nothing outside the bar reads) and leaves through `onSend`.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import "../styles/controls.css";

/** Hard cap from the spec: the bar must never eat more than 6 rows of screen. */
const MAX_ROWS = 6;

interface ComposerProps {
  /** Fires with the trimmed text. The field is cleared by the composer. */
  onSend: (text: string) => void;
  /** Unpaired, or a permission is pending: the whole bar is inert. */
  disabled?: boolean;
  /** Keep drafting available, but block submission until the connection is live. */
  submitDisabled?: boolean;
  placeholder?: string;
  /** Chip rail slot — agent chip, model chip, abort button. */
  children?: ReactNode;
  /** Optional caption under the input (token counts, model hints). */
  hint?: ReactNode;
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4.6 11.3 19 5.2c.8-.3 1.6.5 1.3 1.3l-6.1 14.4c-.3.8-1.5.8-1.8-.1L11 15.6a1 1 0 0 0-.6-.6l-5.2-1.4c-.9-.3-.9-1.5-.1-1.8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** True when the primary pointer is a finger — the phone case. */
function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
}

export default function Composer({
  onSend,
  disabled = false,
  submitDisabled = false,
  placeholder = "Message your agent…",
  children,
  hint,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");
  const [coarse, setCoarse] = useState(isCoarsePointer);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /*
   * Auto-grow. The row ceiling is derived from the LIVE computed line-height
   * and vertical padding rather than a magic pixel max-height, so it stays
   * correct if the type scale is retuned or the user bumps their font size.
   */
  const resize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const styles = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const chrome =
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom) +
      Number.parseFloat(styles.borderTopWidth) +
      Number.parseFloat(styles.borderBottomWidth);
    const max = lineHeight * MAX_ROWS + chrome;
    // app.css ships a static `max-height` fallback for the no-JS/initial paint;
    // the measured ceiling must override it or 6 rows would be clipped to ~5.
    el.style.maxHeight = `${max}px`;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, []);

  useLayoutEffect(resize, [resize, text]);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled || submitDisabled) return;
    onSend(trimmed);
    setText("");
  }, [disabled, onSend, submitDisabled, text]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        send();
        return;
      }
      // Touch: never send on Enter. Desktop: Enter sends, Shift+Enter newlines.
      if (coarse || event.shiftKey || event.altKey) return;
      event.preventDefault();
      send();
    },
    [coarse, send],
  );

  const canSend = !disabled && !submitDisabled && text.trim().length > 0;

  return (
    <footer
      className="composer"
      data-testid="composer"
      data-disabled={disabled || submitDisabled ? "true" : "false"}
    >
      {children ? <div className="composer__meta">{children}</div> : null}

      <div className="composer__row">
        <textarea
          ref={inputRef}
          className="composer__input"
          data-testid="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          disabled={disabled}
          enterKeyHint={coarse ? "enter" : "send"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="composer__send"
          data-testid="send-button"
          aria-label="Send message"
          disabled={!canSend}
          onClick={send}
        >
          <SendIcon />
        </button>
      </div>

      {hint ? <div className="composer__hint">{hint}</div> : null}
    </footer>
  );
}
