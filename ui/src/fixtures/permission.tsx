/*
 * entangle — fixture: permission + abort lifecycle
 * ------------------------------------------------------------------
 * Reachable at `?fixture=permission`. Scripts the sequence a phone-only user
 * actually hits: idle -> busy -> a tool asks for approval.
 *
 * `.app-shell[data-phase]` is the queryable clock, like the stream fixture's
 * `data-stream-state`: Playwright waits on the attribute instead of sleeping,
 * so the assertions cannot race the timers.
 */

import { useCallback, useEffect, useState, type CSSProperties } from "react";

import type { PermissionDto, SessionStatus } from "../lib/protocol";
import AbortButton from "../components/AbortButton";
import Composer from "../components/Composer";
import PermissionSheet, { type PermissionResponse } from "../components/PermissionSheet";
import StatusPill from "../components/StatusPill";

type Phase = "idle" | "busy" | "permission";

const IDLE_MS = 1_000;
const BUSY_MS = 1_500;

const PERMISSION: PermissionDto = {
  id: "perm_fixture_1",
  sessionID: "ses_fixture",
  title: "Run a shell command in /Users/you/projects/entangle",
  metadata: { command: "bun test && bunx tsc --noEmit" },
};

const LOG_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-muted)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

export default function PermissionFixture() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const toBusy = setTimeout(() => setPhase("busy"), IDLE_MS);
    const toPermission = setTimeout(() => setPhase("permission"), IDLE_MS + BUSY_MS);
    return () => {
      clearTimeout(toBusy);
      clearTimeout(toPermission);
    };
  }, []);

  const record = useCallback((entry: unknown) => {
    const list = (window.__entangleLog ??= []);
    list.push(entry);
    setLog((previous) => [...previous, JSON.stringify(entry)]);
  }, []);

  const onRespond = useCallback(
    (response: PermissionResponse) => {
      record({ response });
      setPhase("busy");
    },
    [record],
  );

  const onAbort = useCallback(() => {
    record({ kind: "abort" });
    setTimeout(() => setPhase("idle"), 400);
  }, [record]);

  const pending = phase === "permission";
  const status: SessionStatus = phase === "idle" ? { type: "idle" } : { type: "busy" };

  return (
    <div className="app-shell" data-fixture="permission" data-phase={phase}>
      <header className="app-header" data-testid="app-header">
        <div className="app-header__brand">
          <span className="rings rings--sm" aria-hidden="true" />
          <div className="app-header__titles">
            <span className="app-header__name">entangle</span>
            <span className="app-header__meta">permission fixture</span>
          </div>
        </div>
        <StatusPill status={status} />
      </header>

      <main className="transcript" data-testid="transcript" aria-label="Conversation">
        <pre data-testid="permission-log" style={LOG_STYLE}>
          {log.join("\n")}
        </pre>
      </main>

      <Composer onSend={(text) => record({ kind: "send", text })} disabled={pending}>
        <span className="composer__meta-spacer" />
        <AbortButton status={status} onAbort={onAbort} />
      </Composer>

      <PermissionSheet permission={pending ? PERMISSION : undefined} onRespond={onRespond} />
    </div>
  );
}
