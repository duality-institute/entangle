import { expect, test } from "bun:test"
import { Broadcaster, EventHub, EventLog, sseStream } from "../src/server/events"

async function read(stream: ReadableStream<Uint8Array>, ms = 50): Promise<string> {
  const reader = stream.getReader()
  const chunks: string[] = []
  const timer = setTimeout(() => void reader.cancel(), ms)
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(new TextDecoder().decode(result.value))
  }
  clearTimeout(timer)
  return chunks.join("")
}

test("ids are monotonic", () => {
  const log = new EventLog<string>()
  expect([log.append("a").id, log.append("b").id]).toEqual([1, 2])
})

test("ring evicts at 500", () => {
  const log = new EventLog<number>()
  for (let i = 0; i < 501; i++) log.append(i)
  expect(log.since(0).events[0]?.id).toBe(2)
  expect(log.since(0).events).toHaveLength(500)
})

test("since returns ordered events and empty current", () => {
  const log = new EventLog<string>(); log.append("a"); log.append("b")
  expect(log.since(1).events.map((e) => e.frame)).toEqual(["b"])
  expect(log.since(2)).toEqual({ events: [], gap: false })
})

test("since reports a gap", () => {
  const log = new EventLog<number>(); for (let i = 0; i < 501; i++) log.append(i)
  expect(log.since(0).gap).toBe(true)
})

test("replay gap reaches the wire without an event id", async () => {
  const bus = new Broadcaster<number>(); for (let i = 1; i <= 502; i++) bus.publish(i)
  const output = await read(sseStream(new Request("http://x", { headers: { "Last-Event-ID": "1" } }), bus.log, bus))
  expect(output).toContain('data: {"gap":true}\n\n')
  expect(output).not.toContain('id: 501\ndata: {"gap":true}')
  expect(output.indexOf('data: {"gap":true}')).toBeLessThan(output.indexOf("id: 3\n"))
})

test("in-buffer replay does not emit a gap frame", async () => {
  const bus = new Broadcaster<number>(); [1, 2, 3].forEach((n) => bus.publish(n))
  const output = await read(sseStream(new Request("http://x", { headers: { "Last-Event-ID": "1" } }), bus.log, bus))
  expect(output).not.toContain('{"gap":true}')
})

test("replays from Last-Event-ID header and query parameter", async () => {
  const bus = new Broadcaster<number>(); [1, 2, 3, 4].forEach((n) => bus.publish(n))
  expect(await read(sseStream(new Request("http://x", { headers: { "Last-Event-ID": "2" } }), bus.log, bus))).toContain("id: 3\ndata: 3")
  expect(await read(sseStream(new Request("http://x?lastEventId=2"), bus.log, bus))).toContain("id: 3\ndata: 3")
})

test("reconnect replays exactly missed events", async () => {
  const bus = new Broadcaster<number>(); [1, 2, 3, 4, 5, 6].forEach((n) => bus.publish(n))
  const output = await read(sseStream(new Request("http://x", { headers: { "Last-Event-ID": "3" } }), bus.log, bus))
  expect([...output.matchAll(/id: (\d+)/g)].map((m) => Number(m[1]))).toEqual([4, 5, 6])
})

test("primes the stream without consuming an event id", async () => {
  const bus = new Broadcaster<string>()
  const stream = sseStream(new Request("http://x"), bus.log, bus)
  const reader = stream.getReader()
  try {
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(100).then(() => undefined),
    ])
    expect(first).toBeDefined()
    expect(new TextDecoder().decode(first?.value)).toBe(": open\n\n")
    expect(new TextDecoder().decode(first?.value)).not.toContain("id:")

    bus.publish("first")
    const event = new TextDecoder().decode((await reader.read()).value)
    expect(event).toBe('id: 1\ndata: "first"\n\n')
  } finally {
    await reader.cancel()
  }
})

test("cancel unsubscribes and clears heartbeat timer", async () => {
  const bus = new Broadcaster<number>(); const stream = sseStream(new Request("http://x"), bus.log, bus)
  const reader = stream.getReader(); await reader.cancel(); reader.releaseLock(); bus.publish(1)
  expect(stream.locked).toBe(false)
})

test("multiple subscribers receive every frame", async () => {
  const bus = new Broadcaster<number>(); const a: number[] = []; const b: number[] = []
  const ua = bus.subscribe((e) => a.push(e.frame)); const ub = bus.subscribe((e) => b.push(e.frame))
  ;[1, 2, 3].forEach((n) => bus.publish(n)); ua(); ub()
  expect(a).toEqual([1, 2, 3]); expect(b).toEqual([1, 2, 3])
})

test("event hub keeps replay ids and frames isolated by session", () => {
  const hub = new EventHub<string>()
  hub.publish("ses_a", "a1")
  hub.publish("ses_b", "b1")
  hub.publish("ses_a", "a2")

  expect(hub.channel("ses_a").log.since(0).events.map((entry) => [entry.id, entry.frame])).toEqual([
    [1, "a1"],
    [2, "a2"],
  ])
  expect(hub.channel("ses_b").log.since(0).events.map((entry) => [entry.id, entry.frame])).toEqual([
    [1, "b1"],
  ])
})

test("event hub releases channels without a live binding", () => {
  const hub = new EventHub<string>()
  hub.publish("ses_a", "a1")
  hub.publish("ses_b", "b1")
  hub.publish("ses_expired", "gone")

  hub.retain(new Set(["ses_a", "ses_b"]))

  expect(hub.size).toBe(2)
  expect(hub.channel("ses_a").log.since(0).events.map((entry) => entry.frame)).toEqual(["a1"])
  expect(hub.channel("ses_b").log.since(0).events.map((entry) => entry.frame)).toEqual(["b1"])
})
