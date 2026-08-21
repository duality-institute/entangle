import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import Composer from "../ui/src/components/Composer"

test("reconnecting blocks submit without disabling the textarea that owns mobile focus", () => {
  const markup = renderToStaticMarkup(
    <Composer onSend={() => {}} submitDisabled />,
  )

  const textarea = markup.match(/<textarea\b[^>]*data-testid="composer-input"[^>]*>/)?.[0]
  expect(markup).toContain('data-disabled="true"')
  expect(textarea).toBeDefined()
  expect(textarea).not.toContain(" disabled")
})
