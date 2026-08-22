import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { Part } from "../src/shared/protocol"
import { MessageParts } from "../ui/src/components/MessageParts"

const base = { sessionID: "ses_1", messageID: "msg_1" }

test("completed apply_patch metadata supplies the patch row additions and deletions", () => {
  const parts: Part[] = [
    {
      ...base,
      id: "prt_tool",
      type: "tool",
      callID: "call_patch",
      tool: "apply_patch",
      state: {
        status: "completed",
        input: { patchText: "*** Begin Patch" },
        output: "Success",
        title: "Success",
        metadata: {
          diff: "combined diff",
          files: [
            { filePath: "/repo/ui/App.tsx", relativePath: "ui/App.tsx", additions: 11, deletions: 4 },
            { filePath: "/repo/ui/Composer.tsx", relativePath: "ui/Composer.tsx", additions: 2, deletions: 1 },
          ],
        },
        time: { start: 1, end: 2 },
      },
    },
    {
      ...base,
      id: "prt_patch",
      type: "patch",
      hash: "abc123",
      files: ["/repo/ui/Composer.tsx", "/repo/ui/App.tsx"],
    },
  ]

  const markup = renderToStaticMarkup(<MessageParts parts={parts} />)

  expect(markup).toContain('patch__stat patch__stat--add">+13</span>')
  expect(markup).toContain('patch__stat patch__stat--del">−5</span>')
  expect(markup).not.toContain('patch__stat patch__stat--add">+0</span>')
})

test("todowrite renders structured input as a status-aware list instead of JSON", () => {
  const todos = [
    { content: "Trace the runtime payload", status: "completed", priority: "high" },
    { content: "Render a readable checklist", status: "in_progress", priority: "medium" },
    { content: "Verify the mobile layout", status: "pending", priority: "low" },
  ]
  const parts: Part[] = [
    {
      ...base,
      id: "prt_todowrite",
      type: "tool",
      callID: "call_todowrite",
      tool: "todowrite",
      state: {
        status: "completed",
        input: { todos },
        output: JSON.stringify(todos),
        title: "3 todos",
        metadata: { todos, truncated: false },
        time: { start: 1, end: 2 },
      },
    },
  ]

  const markup = renderToStaticMarkup(<MessageParts parts={parts} />)

  expect(markup).toContain('data-testid="todo-list"')
  expect(markup).toContain('data-status="completed" data-priority="high"')
  expect(markup).toContain("Trace the runtime payload")
  expect(markup).toContain('data-status="in_progress" data-priority="medium"')
  expect(markup).toContain("Render a readable checklist")
  expect(markup).not.toContain('&quot;content&quot;')
})

test("todoread renders a todo array from completed output", () => {
  const todos = [
    { content: "Keep the generic fallback", status: "pending", priority: "high" },
    { content: "Remove stale work", status: "cancelled", priority: "low" },
  ]
  const parts: Part[] = [
    {
      ...base,
      id: "prt_todoread",
      type: "tool",
      callID: "call_todoread",
      tool: "todoread",
      state: {
        status: "completed",
        input: {},
        output: JSON.stringify(todos),
        title: "2 todos",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
  ]

  const markup = renderToStaticMarkup(<MessageParts parts={parts} />)

  expect(markup).toContain('data-testid="todo-list"')
  expect(markup).toContain("Keep the generic fallback")
  expect(markup).toContain('data-status="cancelled" data-priority="low"')
  expect(markup).not.toContain('&quot;status&quot;')
})
