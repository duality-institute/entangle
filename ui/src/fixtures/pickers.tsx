/*
 * entangle — fixture: agent + model pickers and the composer
 * ------------------------------------------------------------------
 * Reachable at `?fixture=pickers` (registry resolves by filename — no edit to
 * dev.tsx or main.tsx).
 *
 * The agent list deliberately INCLUDES a subagent ("explore"). The server
 * already filters `mode === "subagent"`, so this fixture exists to prove the UI
 * does not resurrect one: the popup must show exactly three rows.
 *
 * Every selection and every send is appended to `window.__entangleLog` AND
 * mirrored into a `<pre data-testid="send-log">` so Playwright can assert the
 * prompt payload without evaluating private component state.
 */

import { useCallback, useState, type CSSProperties } from "react";

import type { ModelRef } from "../lib/appState";
import type { AgentDto, ProviderDto } from "../lib/protocol";
import AgentPicker from "../components/AgentPicker";
import Composer from "../components/Composer";
import ModelPicker from "../components/ModelPicker";
import StatusPill from "../components/StatusPill";
import { useKeyboardInset } from "../hooks/useKeyboardInset";

declare global {
  interface Window {
    __entangleLog?: unknown[];
  }
}

const AGENTS: AgentDto[] = [
  {
    name: "build",
    mode: "primary",
    builtIn: true,
    description: "Full read/write agent. Edits files, runs commands, ships code.",
    color: "var(--agent-1)",
  },
  {
    name: "plan",
    mode: "primary",
    builtIn: true,
    description: "Read-only planning agent. Investigates and proposes, never writes.",
    color: "var(--agent-3)",
  },
  {
    name: "omni",
    mode: "all",
    builtIn: false,
    description: "Custom agent wired to the house toolchain.",
  },
  {
    name: "explore",
    mode: "subagent",
    builtIn: true,
    description: "MUST NOT APPEAR — subagents are not promptable.",
  },
];

function model(providerID: string, id: string, name: string) {
  return {
    id,
    providerID,
    name,
    api: { id, url: "", npm: "" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200_000, output: 64_000 },
    status: "active" as const,
    options: {},
    headers: {},
  };
}

function provider(id: string, name: string, models: ReturnType<typeof model>[]): ProviderDto {
  return {
    id,
    name,
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((m) => [m.id, m])),
  };
}

const PROVIDERS: ProviderDto[] = [
  provider("anthropic", "Anthropic", [model("anthropic", "claude-x", "Claude X")]),
  provider("openai", "OpenAI", [model("openai", "gpt-x", "GPT-X")]),
];

const LOG_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-muted)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

export default function PickersFixture() {
  useKeyboardInset();

  const [nextAgent, setNextAgent] = useState<string | undefined>("build");
  const [nextModel, setNextModel] = useState<ModelRef | undefined>(undefined);
  const [log, setLog] = useState<string[]>([]);

  const record = useCallback((entry: unknown) => {
    const list = (window.__entangleLog ??= []);
    list.push(entry);
    setLog((previous) => [...previous, JSON.stringify(entry)]);
  }, []);

  const onAgent = useCallback(
    (agent: string) => {
      setNextAgent(agent);
      record({ kind: "agent", agent });
    },
    [record],
  );

  const onModel = useCallback(
    (model: ModelRef) => {
      setNextModel(model);
      record({ kind: "model", model });
    },
    [record],
  );

  const onSend = useCallback(
    (text: string) => {
      record({ kind: "send", text, agent: nextAgent, model: nextModel });
    },
    [nextAgent, nextModel, record],
  );

  return (
    <div className="app-shell" data-fixture="pickers">
      <header className="app-header" data-testid="app-header">
        <div className="app-header__brand">
          <span className="rings rings--sm" aria-hidden="true" />
          <div className="app-header__titles">
            <span className="app-header__name">entangle</span>
            <span className="app-header__meta">pickers fixture</span>
          </div>
        </div>
        <StatusPill status={{ type: "idle" }} />
      </header>

      <main className="transcript" data-testid="transcript" aria-label="Conversation">
        <pre data-testid="send-log" style={LOG_STYLE}>
          {log.join("\n")}
        </pre>
      </main>

      <Composer onSend={onSend}>
        <AgentPicker agents={AGENTS} value={nextAgent} onChange={onAgent} />
        <ModelPicker providers={PROVIDERS} value={nextModel} onChange={onModel} />
      </Composer>
    </div>
  );
}
