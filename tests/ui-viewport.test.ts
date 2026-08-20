import { expect, test } from "bun:test"
import { keyboardInset } from "../ui/src/hooks/useKeyboardInset"

test("keyboard inset reserves only the layout area still obscured after Safari pans", () => {
  expect(keyboardInset({ height: 430, offsetTop: 0, scale: 1 }, 844, true)).toBe(414)
  expect(keyboardInset({ height: 430, offsetTop: 250, scale: 1 }, 844, true)).toBe(164)
  expect(keyboardInset({ height: 430, offsetTop: 414, scale: 1 }, 844, true)).toBe(0)
})

test("keyboard inset does not double-compensate when the layout viewport already resized", () => {
  expect(keyboardInset({ height: 430, offsetTop: 0, scale: 1 }, 430, true)).toBe(0)
})

test("keyboard inset ignores non-keyboard viewport changes", () => {
  expect(keyboardInset({ height: 430, offsetTop: 0, scale: 1 }, 844, false)).toBe(0)
  expect(keyboardInset({ height: 430, offsetTop: 0, scale: 1.2 }, 844, true)).toBe(0)
  expect(keyboardInset(undefined, 844, true)).toBe(0)
})

test("keyboard inset clamps transient negative viewport offsets", () => {
  expect(keyboardInset({ height: 430, offsetTop: -20, scale: 1 }, 844, true)).toBe(414)
})
