interface EventRecord<T> {
  id: number
  frame: T
}

interface SinceResult<T> {
  events: EventRecord<T>[]
  gap: boolean
}

const HEARTBEAT_FRAME = 'data: {"heartbeat":true}\n\n'

export class EventLog<T> {
  private readonly buffer: EventRecord<T>[] = []
  private nextId = 1

  append(frame: T): EventRecord<T> {
    const event = { id: this.nextId++, frame }
    this.buffer.push(event)
    if (this.buffer.length > 500) this.buffer.shift()
    return event
  }

  get currentId(): number {
    return this.nextId - 1
  }

  since(id: number): SinceResult<T> {
    if (id >= this.currentId) return { events: [], gap: false }
    const first = this.buffer[0]
    const gap = first !== undefined && id < first.id - 1
    return { events: this.buffer.filter((event) => event.id > id), gap }
  }
}

export class Broadcaster<T> {
  private readonly listeners = new Set<(event: EventRecord<T>) => void>()

  constructor(public readonly log = new EventLog<T>()) {}

  subscribe(listener: (event: EventRecord<T>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(frame: T): EventRecord<T> {
    const event = this.log.append(frame)
    for (const listener of this.listeners) listener(event)
    return event
  }
}

export class EventHub<T> {
  private readonly channels = new Map<string, Broadcaster<T>>()

  get size(): number {
    return this.channels.size
  }

  channel(key: string): Broadcaster<T> {
    let channel = this.channels.get(key)
    if (channel === undefined) {
      channel = new Broadcaster<T>()
      this.channels.set(key, channel)
    }
    return channel
  }

  publish(key: string, frame: T): EventRecord<T> {
    return this.channel(key).publish(frame)
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.channels.keys()) {
      if (!keys.has(key)) this.channels.delete(key)
    }
  }
}

function replayId(request: Request): number | undefined {
  const value = request.headers.get("Last-Event-ID") ?? new URL(request.url).searchParams.get("lastEventId")
  if (value === null) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined
}

export function sseStream<T>(request: Request, log: EventLog<T>, broadcaster: Broadcaster<T>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let unsubscribe = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": open\n\n"))
      const send = (event: EventRecord<T>) => {
        if (!closed) controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.frame)}\n\n`))
      }
      unsubscribe = broadcaster.subscribe(send)
      const id = replayId(request)
      if (id !== undefined) {
        const replay = log.since(id)
        if (replay.gap) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ gap: true })}\n\n`))
        for (const event of replay.events) send(event)
      }
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(HEARTBEAT_FRAME))
      }, 10_000)
    },
    cancel() {
      closed = true
      unsubscribe()
      if (heartbeat !== undefined) clearInterval(heartbeat)
    },
  })
  return stream
}
