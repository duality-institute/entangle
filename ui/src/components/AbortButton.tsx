/*
 * entangle — abort button
 * ------------------------------------------------------------------
 * Only exists while a turn is in flight (busy or retry). Rendering it at idle
 * would put a live-looking stop control next to a session that has nothing to
 * stop, and every tap would be a wasted round trip.
 *
 * The "stopping…" state is OPTIMISTIC: abort travels to the desktop, into
 * opencode and back out as an SSE status frame, which on a phone over Wi-Fi is
 * long enough for a user to conclude the tap missed and tap again. The button
 * disables itself immediately and only unlatches when the real status leaves
 * busy/retry.
 *
 * A FAILED abort leaves the turn running, so that status change never comes and
 * the latch would strand the only control that can stop it. The owner releases
 * it through `rearmToken`; this component stays presentational and never learns
 * why the stop failed.
 */

import { useCallback, useEffect, useState } from "react";

import type { SessionStatus } from "../lib/protocol";
import "../styles/controls.css";

interface AbortButtonProps {
  /** `sessionStatus` from the store. */
  status: SessionStatus;
  onAbort: () => void;
  /**
   * Bump to release the optimistic latch after a failed stop. A counter, not a
   * boolean: two failures in a row must each re-arm, and a flag would collapse
   * them into one (same reason `refetchToken` is a number).
   */
  rearmToken?: number;
  label?: string;
}

export default function AbortButton({
  status,
  onAbort,
  rearmToken = 0,
  label = "Stop",
}: AbortButtonProps) {
  const active = status.type === "busy" || status.type === "retry";
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!active) setStopping(false);
  }, [active]);

  useEffect(() => {
    if (rearmToken > 0) setStopping(false);
  }, [rearmToken]);

  const onClick = useCallback(() => {
    setStopping(true);
    onAbort();
  }, [onAbort]);

  if (!active) return null;

  return (
    <button
      type="button"
      className="abort-button"
      data-testid="abort-button"
      data-stopping={stopping ? "true" : "false"}
      aria-label={stopping ? "Stopping" : "Stop the current turn"}
      disabled={stopping}
      onClick={onClick}
    >
      <span className="abort-button__glyph" aria-hidden="true" />
      {stopping ? "stopping…" : label}
    </button>
  );
}
