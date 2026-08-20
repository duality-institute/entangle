/*
 * entangle — status pill
 * ------------------------------------------------------------------
 * Renders `AppState.sessionStatus` (+ `AppState.error`) into the header pill
 * Colour, soft fill and the busy pulse all follow from
 * `data-status`, so this component only decides WHICH of the four words applies.
 *
 * The error message is hidden behind a tap rather than printed inline: model
 * and tool errors are frequently multi-line stack-ish text, and letting one
 * push the transcript off a 390px screen is worse than one extra tap.
 */

import { useEffect, useState } from "react";

import type { SessionStatus } from "../lib/protocol";
import "../styles/controls.css";

type StatusKind = "idle" | "busy" | "retry" | "error";

interface StatusPillProps {
  /** `sessionStatus` from the store. */
  status: SessionStatus;
  /** `error` from the store. Present => the pill shows the error state. */
  error?: string;
  /** Denominator for "retrying n/m". Omitted renders just "retrying n". */
  retryLimit?: number;
}

function statusKind(status: SessionStatus, error?: string): StatusKind {
  if (error) return "error";
  if (status.type === "retry") return "retry";
  if (status.type === "busy") return "busy";
  return "idle";
}

function statusLabel(status: SessionStatus, error?: string, retryLimit?: number): string {
  const kind = statusKind(status, error);
  if (kind === "error") return "error";
  if (kind === "retry" && status.type === "retry") {
    return retryLimit
      ? `retrying ${status.attempt}/${retryLimit}`
      : `retrying ${status.attempt}`;
  }
  return kind;
}

export default function StatusPill({ status, error, retryLimit }: StatusPillProps) {
  const kind = statusKind(status, error);
  const label = statusLabel(status, error, retryLimit);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!error) setRevealed(false);
  }, [error]);

  if (kind === "error") {
    return (
      <div className="status-pill-group">
        <button
          type="button"
          className="status-pill"
          data-status="error"
          data-testid="status-pill"
          aria-expanded={revealed}
          aria-label={revealed ? "Hide error details" : "Show error details"}
          onClick={() => setRevealed((value) => !value)}
        >
          <span className="status-pill__dot" aria-hidden="true" />
          {label}
        </button>
        {revealed ? (
          <div className="status-error" data-testid="status-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <span
      className="status-pill"
      data-status={kind}
      data-testid="status-pill"
      role="status"
      aria-live="polite"
    >
      <span className="status-pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
