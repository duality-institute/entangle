/*
 * entangle — agent picker
 * ------------------------------------------------------------------
 * TUI Tab semantics: picking an agent changes the agent for the NEXT prompt
 * only. There is deliberately no "set default agent" concept — the desktop TUI
 * has none either, and inventing one here would make the phone and the terminal
 * disagree about what `agent` a session is on.
 *
 * Subagents are filtered out. The server already strips `mode === "subagent"`,
 * so this is belt-and-braces: a subagent is not addressable as a primary
 * prompt target, and offering one would send a prompt that can never run.
 */

import { useCallback, useMemo, useState, type CSSProperties } from "react";

import type { AgentDto } from "../lib/protocol";
import PickerModal, { Caret, CheckMark } from "./PickerModal";
import "../styles/controls.css";

/** Round-robin fallbacks when an agent declares no colour of its own. */
const AGENT_SLOTS = [
  "var(--agent-1)",
  "var(--agent-2)",
  "var(--agent-3)",
  "var(--agent-4)",
  "var(--agent-5)",
  "var(--agent-6)",
] as const;

interface AgentPickerProps {
  agents: AgentDto[];
  /** `nextAgent` from the store: the agent the next prompt will use. */
  value?: string;
  onChange: (agent: string) => void;
  disabled?: boolean;
}

/**
 * Falls back to a slot derived from the NAME, not the list index: a name hash
 * keeps an agent's colour stable when the roster changes, and index order made
 * a colourless agent collide with the explicit colour of its neighbour.
 */
function agentColor(agent: AgentDto | undefined): string {
  if (agent?.color) return agent.color;
  const name = agent?.name ?? "";
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_SLOTS[hash % AGENT_SLOTS.length];
}

export default function AgentPicker({ agents, value, onChange, disabled = false }: AgentPickerProps) {
  const [open, setOpen] = useState(false);

  const selectable = useMemo(() => agents.filter((a) => a.mode !== "subagent"), [agents]);
  const active = useMemo(() => selectable.find((a) => a.name === value), [selectable, value]);
  const label = active?.name ?? value ?? "agent";
  const color = agentColor(active);
  const close = useCallback(() => setOpen(false), []);

  const choose = useCallback(
    (name: string) => {
      onChange(name);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <>
      <button
        type="button"
        className="chip chip--agent"
        data-testid="agent-chip"
        data-agent={label}
        style={{ "--chip-color": color } as CSSProperties}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Agent for next message: ${label}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span className="chip__dot" aria-hidden="true" />
        <span className="chip__label">{label}</span>
        <span className="chip__caret" aria-hidden="true">
          <Caret />
        </span>
      </button>

      <PickerModal
        open={open}
        testId="agent-modal"
        title="Choose agent"
        onClose={close}
      >
        <div className="sheet__body" role="radiogroup" aria-label="Agents">
          {selectable.length === 0 ? (
            <p className="sheet__empty">No agents available.</p>
          ) : (
            selectable.map((agent) => {
              const checked = agent.name === value;
              return (
                <button
                  key={agent.name}
                  type="button"
                  className="sheet-option sheet-option--agent"
                  data-testid="agent-option"
                  data-agent={agent.name}
                  style={{ "--chip-color": agentColor(agent) } as CSSProperties}
                  role="radio"
                  aria-checked={checked}
                  onClick={() => choose(agent.name)}
                >
                  <span className="sheet-option__text">
                    <span className="sheet-option__name">{agent.name}</span>
                    {agent.description ? (
                      <span className="sheet-option__desc">{agent.description}</span>
                    ) : null}
                  </span>
                  {agent.builtIn ? <span className="sheet-option__meta">built-in</span> : null}
                  <span className="sheet-option__mark" aria-hidden="true">
                    {checked ? <CheckMark /> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PickerModal>
    </>
  );
}
