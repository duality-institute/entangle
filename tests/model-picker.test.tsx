import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import AgentPicker from "../ui/src/components/AgentPicker"
import ModelPicker from "../ui/src/components/ModelPicker"
import PermissionSheet from "../ui/src/components/PermissionSheet"
import PickerModal from "../ui/src/components/PickerModal"
import { FIXTURE_AGENT_DTOS, FIXTURE_PROVIDERS } from "./fixtures/fake-bridge"

test("model picker opens a plain app dialog instead of a native or roll-up control", () => {
  const markup = renderToStaticMarkup(
    <ModelPicker
      providers={FIXTURE_PROVIDERS.providers}
      onChange={() => {}}
    />,
  )

  expect(markup).toContain("<button")
  expect(markup).toContain('data-testid="model-chip"')
  expect(markup).toContain('aria-haspopup="dialog"')
  expect(markup).not.toContain("<select")
})

test("agent picker also uses a dialog trigger", () => {
  const markup = renderToStaticMarkup(
    <AgentPicker agents={FIXTURE_AGENT_DTOS} onChange={() => {}} />,
  )

  expect(markup).toContain("<button")
  expect(markup).toContain('data-testid="agent-chip"')
  expect(markup).toContain('aria-haspopup="dialog"')
})

test("picker modal renders immediately without roll-up affordances", () => {
  const markup = renderToStaticMarkup(
    <PickerModal open title="Choose model" testId="model-modal" onClose={() => {}}>
      <button type="button">GPT-X</button>
    </PickerModal>,
  )

  expect(markup).toContain('role="dialog"')
  expect(markup).toContain('data-testid="model-modal"')
  expect(markup).not.toContain("sheet__grip")
  expect(markup).not.toContain("data-open")
})

test("permission prompt uses a blocking centered popup instead of a sheet", () => {
  const markup = renderToStaticMarkup(
    <PermissionSheet
      permission={{
        id: "perm_1",
        sessionID: "ses_1",
        title: "Run a shell command",
        metadata: { command: "bun test" },
      }}
      onRespond={() => {}}
    />,
  )

  expect(markup).toContain('data-testid="permission-modal"')
  expect(markup).toContain('class="picker-modal"')
  expect(markup).toContain('data-testid="perm-once"')
  expect(markup).toContain('data-testid="perm-always"')
  expect(markup).toContain('data-testid="perm-reject"')
  expect(markup).not.toContain("sheet-layer")
  expect(markup).not.toContain("sheet__grip")
  expect(markup).not.toContain(">Close<")
})
