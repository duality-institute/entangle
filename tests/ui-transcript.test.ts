import { expect, test } from "bun:test"
import { createViewportRepinner } from "../ui/src/lib/viewportPin"

test("viewport re-pinning keeps pace with every keyboard animation frame", () => {
  let nextFrame = 1
  const pending = new Map<number, () => void>()
  const scrolls: number[] = []
  const repinning: boolean[] = []

  const controller = createViewportRepinner({
    isPinned: () => true,
    setRepinning: (active) => repinning.push(active),
    scrollToBottom: () => scrolls.push(scrolls.length + 1),
    requestFrame: (callback) => {
      const id = nextFrame
      nextFrame += 1
      pending.set(id, callback)
      return id
    },
    cancelFrame: (frame) => {
      pending.delete(frame)
    },
  })

  const runFrame = (): void => {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const callback of callbacks) callback()
  }

  controller.signal()
  runFrame()
  controller.signal()
  runFrame()
  controller.signal()
  runFrame()

  expect(scrolls).toEqual([1, 2, 3])
  expect(repinning.at(-1)).toBe(true)

  runFrame()
  expect(scrolls).toEqual([1, 2, 3, 4])
  expect(repinning.at(-1)).toBe(false)

  controller.stop()
  expect(pending.size).toBe(0)
})
