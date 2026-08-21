import { afterEach, describe, expect, test } from "bun:test"
import { MobileAuth } from "../src/server/auth"
import { EventHub } from "../src/server/events"
import { MobileServer, type MobileEvent } from "../src/server/http"
import type { StateDto } from "../ui/src/lib/api"
import { FakeBridge, FIXTURE_AGENT_DTOS, FIXTURE_MESSAGES, FIXTURE_PROVIDERS, FIXTURE_SESSION } from "./fixtures/fake-bridge"

const servers: MobileServer[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop()
})

function loopbackOrigin(server: MobileServer): string {
  const url = new URL(server.origin)
  url.hostname = "127.0.0.1"
  return url.origin
}

async function fixture() {
  const bridge = new FakeBridge()
  const auth = new MobileAuth(60_000)
  const events = new EventHub<MobileEvent>()
  const server = new MobileServer({
    bridge,
    auth,
    events,
    options: { host: "127.0.0.1", port: 0 },
    reportError: () => {},
  })
  servers.push(server)
  await server.start()
  const pairing = auth.createPairing(FIXTURE_SESSION.id)
  return { server, bridge, auth, events, base: loopbackOrigin(server), token: pairing.token }
}

async function paired() {
  const context = await fixture()
  const response = await fetch(`${context.base}/pair?token=${context.token}`, { redirect: "manual" })
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
  const stateResponse = await fetch(`${context.base}/api/state`, { headers: { cookie } })
  const state = await stateResponse.json() as { csrf: string }
  return { ...context, cookie, csrf: state.csrf }
}

function mutationHeaders(base: string, cookie: string, csrf: string): Record<string, string> {
  return {
    cookie,
    origin: base,
    "x-entangle-csrf": csrf,
    "x-entangle-session": FIXTURE_SESSION.id,
    "content-type": "application/json",
  }
}

describe("MobileServer", () => {
  test("starts, serves index, and stops idempotently", async () => {
    const bridge = new FakeBridge()
    const auth = new MobileAuth(60_000)
    const events = new EventHub<MobileEvent>()
    const server = new MobileServer({ bridge, auth, events, options: { host: "127.0.0.1" } })
    servers.push(server)
    expect(server.listening).toBe(false)
    await server.start()
    expect(server.listening).toBe(true)
    const response = await fetch(loopbackOrigin(server))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    await server.stop()
    await server.stop()
    servers.length = 0
    expect(server.listening).toBe(false)
  })

  test("pairs once with an HttpOnly cookie and a 303 redirect", async () => {
    const { base, token } = await fixture()
    const response = await fetch(`${base}/pair?token=${token}`, { redirect: "manual" })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/")
    expect(response.headers.get("set-cookie")).toContain("entangle_session=")
    expect(response.headers.get("set-cookie")).toContain("HttpOnly")
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict")
  })

  test("GET /api/state returns session, selection, and csrf", async () => {
    const { base, cookie, bridge } = await paired()
    bridge.emit("session.idle", { sessionID: FIXTURE_SESSION.id })
    const response = await fetch(`${base}/api/state`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = await response.json() as StateDto & Record<string, unknown>
    expect(body).toEqual({
      session: FIXTURE_SESSION,
      csrf: expect.any(String),
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      lastEventId: 1,
    })
    expect(body.csrf.length).toBeGreaterThan(0)
    expect(typeof body.lastEventId).toBe("number")
    expect(body.session).toMatchObject({ id: FIXTURE_SESSION.id, title: FIXTURE_SESSION.title, status: FIXTURE_SESSION.status })
    expect(body).not.toHaveProperty("sessionID")
    expect(body).not.toHaveProperty("title")
    expect(body).not.toHaveProperty("status")
  })

  test("GET /api/state returns bounded JSON when the pinned chat is unavailable", async () => {
    const context = await fixture()
    const paired = await fetch(`${context.base}/pair?token=${context.token}`, { redirect: "manual" })
    const cookie = paired.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
    context.bridge.failures = { getSession: new Error("opencode source and path must stay private") }

    const response = await fetch(`${context.base}/api/state`, { headers: { cookie } })

    expect(response.status).toBe(410)
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8")
    expect(await response.json()).toEqual({ error: "paired chat is no longer available; scan a fresh QR code" })
  })

  test("GET /api/messages forwards the cursor", async () => {
    const { base, cookie, bridge } = await paired()
    const response = await fetch(`${base}/api/messages?cursor=1`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionID: FIXTURE_SESSION.id, messages: [FIXTURE_MESSAGES[0]] })
    expect(bridge.requestedCursors).toEqual(["1"])
    expect(bridge.messageSessionIDs).toEqual([FIXTURE_SESSION.id])
  })

  test("GET /api/agents and /api/providers return bridge data", async () => {
    const { base, cookie } = await paired()
    expect(await (await fetch(`${base}/api/agents`, { headers: { cookie } })).json()).toEqual(FIXTURE_AGENT_DTOS)
    expect(await (await fetch(`${base}/api/providers`, { headers: { cookie } })).json()).toEqual(FIXTURE_PROVIDERS)
  })

  test("POST /api/prompt validates and records a prompt", async () => {
    const { base, cookie, csrf, bridge } = await paired()
    const prompt = { text: "hello", agent: "plan", model: { providerID: "openai", modelID: "gpt-5" } }
    const response = await fetch(`${base}/api/prompt`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify(prompt),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: true })
    expect(bridge.sentPrompts).toEqual([prompt])
    expect(bridge.promptSessionIDs).toEqual([FIXTURE_SESSION.id])
  })

  test("bridge mutation failures return bounded JSON without internal details", async () => {
    const { base, cookie, csrf, bridge } = await paired()
    bridge.failures = { sendPrompt: new Error("private source path /Users/example/project") }

    const response = await fetch(`${base}/api/prompt`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify({ text: "fail safely" }),
    })

    expect(response.status).toBe(500)
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8")
    expect(await response.json()).toEqual({ error: "internal server error" })
  })

  test("POST /api/prompt rejects a stale browser session assertion", async () => {
    const { base, cookie, csrf, bridge } = await paired()
    const headers = mutationHeaders(base, cookie, csrf)
    headers["x-entangle-session"] = "ses_other"

    const response = await fetch(`${base}/api/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "must not cross sessions" }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "session binding changed; reload before retrying" })
    expect(bridge.sentPrompts).toEqual([])
  })

  test("two paired browsers keep independent command targets", async () => {
    const context = await fixture()
    const secondPairing = context.auth.createPairing("ses_other")
    const pair = async (token: string) => {
      const response = await fetch(`${context.base}/pair?token=${token}`, { redirect: "manual" })
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
      const state = await (await fetch(`${context.base}/api/state`, { headers: { cookie } })).json() as {
        csrf: string
        session: { id: string }
      }
      return { cookie, state }
    }
    const first = await pair(context.token)
    const second = await pair(secondPairing.token)

    const send = async (target: string, cookie: string, csrf: string) => {
      const headers = mutationHeaders(context.base, cookie, csrf)
      headers["x-entangle-session"] = target
      return fetch(`${context.base}/api/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: target }),
      })
    }

    expect(first.state.session.id).toBe(FIXTURE_SESSION.id)
    expect(second.state.session.id).toBe("ses_other")
    expect((await send(FIXTURE_SESSION.id, first.cookie, first.state.csrf)).status).toBe(202)
    expect((await send("ses_other", second.cookie, second.state.csrf)).status).toBe(202)
    expect(context.bridge.promptSessionIDs).toEqual([FIXTURE_SESSION.id, "ses_other"])
  })

  test("POST /api/abort deterministically reports idle and active sessions", async () => {
    const { base, cookie, csrf, bridge } = await paired()
    const options = { method: "POST", headers: mutationHeaders(base, cookie, csrf) }
    const idle = await fetch(`${base}/api/abort`, options)
    expect(await idle.json()).toEqual({ aborted: false })
    bridge.session = { ...bridge.session, status: { type: "busy" } }
    const active = await fetch(`${base}/api/abort`, options)
    expect(active.status).toBe(200)
    expect(await active.json()).toEqual({ aborted: true })
    expect(bridge.aborts).toBe(1)
    expect(bridge.abortSessionIDs).toEqual([FIXTURE_SESSION.id])
  })

  test("POST /api/abort surfaces a real bridge failure instead of reporting idle", async () => {
    const { base, cookie, csrf, bridge } = await paired()
    const options = { method: "POST", headers: mutationHeaders(base, cookie, csrf) }
    bridge.session = { ...bridge.session, status: { type: "busy" } }
    bridge.failures = { abort: new Error("opencode request failed") }

    const failed = await fetch(`${base}/api/abort`, options)

    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: "abort failed" })
    expect(bridge.aborts).toBe(0)
  })

  test("POST /api/abort surfaces a failing status lookup rather than swallowing it", async () => {
    const { base, cookie, csrf, bridge } = await paired()
    bridge.failures = { getSession: new Error("bridge offline") }

    const failed = await fetch(`${base}/api/abort`, { method: "POST", headers: mutationHeaders(base, cookie, csrf) })

    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: "abort failed" })
  })

  test("POST /api/permissions/:id validates and records the reply", async () => {
    const { base, cookie, csrf, bridge } = await paired()
    const response = await fetch(`${base}/api/permissions/per%201`, {
      method: "POST",
      headers: mutationHeaders(base, cookie, csrf),
      body: JSON.stringify({ response: "once" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(bridge.permissionReplies).toEqual([{ permissionID: "per 1", reply: { response: "once" } }])
    expect(bridge.permissionSessionIDs).toEqual([FIXTURE_SESSION.id])
  })

  test("GET /api/events flushes immediately then uses EventLog ids", async () => {
    const { base, cookie, bridge } = await paired()
    const started = performance.now()
    const response = await fetch(`${base}/api/events`, { headers: { cookie } })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const priming = new TextDecoder().decode((await reader.read()).value)
    expect(priming).toBe(": open\n\n")
    expect(priming).not.toContain("id:")
    bridge.emit("session.idle", { sessionID: FIXTURE_SESSION.id })
    const event = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(event).toBe(`id: 1\ndata: {"sessionID":"${FIXTURE_SESSION.id}","event":"session.idle","data":{"sessionID":"${FIXTURE_SESSION.id}"}}\n\n`)
    expect(event).not.toContain('"id":')
  })

  test("live events and replay stay inside the authenticated session", async () => {
    const { base, cookie, bridge, events } = await paired()
    const first = await fetch(`${base}/api/events`, { headers: { cookie } })
    const firstReader = first.body!.getReader()
    expect(new TextDecoder().decode((await firstReader.read()).value)).toBe(": open\n\n")

    bridge.emit("session.status", { sessionID: "ses_other", status: { type: "busy" } }, "ses_other")
    bridge.emit("session.status", { sessionID: FIXTURE_SESSION.id, status: { type: "busy" } })
    const ownLiveEvent = new TextDecoder().decode((await firstReader.read()).value)
    await firstReader.cancel()

    expect(ownLiveEvent).toContain(`"sessionID":"${FIXTURE_SESSION.id}"`)
    expect(ownLiveEvent).not.toContain("ses_other")

    bridge.emit("session.idle", { sessionID: "ses_other" }, "ses_other")
    bridge.emit("session.idle", { sessionID: FIXTURE_SESSION.id })
    const replay = await fetch(`${base}/api/events?lastEventId=1`, { headers: { cookie } })
    const replayReader = replay.body!.getReader()
    const ownReplay = new TextDecoder().decode((await replayReader.read()).value)
    await replayReader.cancel()

    expect(ownReplay).toStartWith(": open\n\n")
    expect(ownReplay).toContain("id: 2")
    expect(ownReplay).toContain(`"sessionID":"${FIXTURE_SESSION.id}"`)
    expect(ownReplay).not.toContain("ses_other")
    expect(events.size).toBe(1)
  })

  test("GET /api/events emits observable heartbeats without consuming event ids", async () => {
    const { base, cookie, events } = await paired()
    const response = await fetch(`${base}/api/events`, { headers: { cookie } })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": open\n\n")

    const connectedAt = performance.now()
    const chunks: string[] = []
    const heartbeat = 'data: {"heartbeat":true}\n\n'
    let ended = false
    const timer = setTimeout(() => void reader.cancel(), 22_000)
    while (chunks.filter((chunk) => chunk === heartbeat).length < 2) {
      const result = await reader.read()
      if (result.done) {
        ended = true
        break
      }
      chunks.push(new TextDecoder().decode(result.value))
    }
    clearTimeout(timer)
    if (!ended) await reader.cancel()

    expect(ended).toBe(false)
    expect(chunks.filter((chunk) => chunk === heartbeat)).toHaveLength(2)
    expect(chunks.some((chunk) => chunk.includes("id:"))).toBe(false)
    expect(events.channel(FIXTURE_SESSION.id).log.currentId).toBe(0)
    expect(performance.now() - connectedAt).toBeGreaterThan(19_500)
  }, 25_000)

  test("rejects an API request without a session cookie", async () => {
    const { base } = await fixture()
    expect((await fetch(`${base}/api/state`)).status).toBe(401)
  })

  test("rejects an unallowlisted Host before routing", async () => {
    const { base } = await fixture()
    const response = await fetch(base, { headers: { Host: "evil.example" } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "forbidden host" })
  })

  test("an advertised Tailscale host passes pairing, cookie auth, and CSRF checks", async () => {
    const { server, base, token, bridge } = await fixture()
    const tailnetOrigin = server.originFor("100.80.1.2")
    const host = new URL(tailnetOrigin).host
    const pairing = await fetch(`${base}/pair?token=${token}`, {
      redirect: "manual",
      headers: { Host: host },
    })
    const cookie = pairing.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
    const stateResponse = await fetch(`${base}/api/state`, { headers: { Host: host, cookie } })
    const state = await stateResponse.json() as { csrf: string }
    const prompt = await fetch(`${base}/api/prompt`, {
      method: "POST",
      headers: { Host: host, ...mutationHeaders(tailnetOrigin, cookie, state.csrf) },
      body: JSON.stringify({ text: "from the tailnet" }),
    })

    expect(pairing.status).toBe(303)
    expect(stateResponse.status).toBe(200)
    expect(prompt.status).toBe(202)
    expect(bridge.sentPrompts.at(-1)?.text).toBe("from the tailnet")
  })

  test("rejects a mutation without Origin and csrf", async () => {
    const { base, cookie } = await paired()
    const response = await fetch(`${base}/api/prompt`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    })
    expect(response.status).toBe(403)
  })

  test("rejects replay of a consumed pairing token", async () => {
    const { base, token } = await fixture()
    expect((await fetch(`${base}/pair?token=${token}`, { redirect: "manual" })).status).toBe(303)
    expect((await fetch(`${base}/pair?token=${token}`, { redirect: "manual" })).status).toBe(401)
  })

  test("rate limits pairing failures and blocks a fresh valid token", async () => {
    const { base, auth } = await fixture()
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await fetch(`${base}/pair?token=wrong-${attempt}`, { redirect: "manual" })).status).toBe(401)
    }
    expect((await fetch(`${base}/pair?token=wrong-5`, { redirect: "manual" })).status).toBe(429)
    const fresh = auth.createPairing(FIXTURE_SESSION.id)
    expect((await fetch(`${base}/pair?token=${fresh.token}`, { redirect: "manual" })).status).toBe(429)
  })

  test("rejects malformed prompt and permission bodies", async () => {
    const { base, cookie, csrf } = await paired()
    const headers = mutationHeaders(base, cookie, csrf)
    expect((await fetch(`${base}/api/prompt`, { method: "POST", headers, body: "{}" })).status).toBe(400)
    expect((await fetch(`${base}/api/permissions/p1`, { method: "POST", headers, body: '{"response":"yes"}' })).status).toBe(400)
  })
})
