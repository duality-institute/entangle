import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ControlServer, UnknownSessionError, type ControlServerOptions } from "../src/server/control"
import {
  descriptorFileName,
  descriptorPath,
  isAlive,
  listDescriptors,
  writeDescriptor,
} from "../src/server/descriptor"
import { InstanceDescriptor } from "../src/shared/protocol"

const FIXTURE_URL = "http://192.168.1.9:9999/pair?token=FIXTURE"
const FIXTURE_SESSION = { id: "ses_control", title: "Control fixture" }
const FIXTURE_SESSIONS = [
  { id: "ses_control", title: "Control fixture", updatedAt: 2 },
  { id: "ses_older", title: "Older chat", updatedAt: 1 },
]
const DIRECTORY = "/tmp/entangle-project"

const started: ControlServer[] = []

afterEach(async () => {
  while (started.length > 0) await started.pop()?.stop()
})

async function temporaryRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "entangle-control-"))
}

async function start(overrides: Partial<ControlServerOptions> = {}) {
  const root = overrides.instancesDir ?? (await temporaryRoot())
  let pairings = 0
  let mobileRunning = false
  const requested: Array<{ sessionID?: string; advertisedHost?: string }> = []
  const server = new ControlServer({
    directory: DIRECTORY,
    worktree: DIRECTORY,
    requestPairing: (sessionID, advertisedHost) => {
      pairings++
      requested.push({
        ...(sessionID ? { sessionID } : {}),
        ...(advertisedHost ? { advertisedHost } : {}),
      })
      mobileRunning = true
      return { pairingUrl: FIXTURE_URL, session: FIXTURE_SESSION }
    },
    listSessions: () => FIXTURE_SESSIONS,
    isMobileRunning: () => mobileRunning,
    ...overrides,
    instancesDir: root,
  })
  started.push(server)
  await server.start()
  const path = descriptorPath(overrides.directory ?? DIRECTORY, process.pid, root)
  const descriptor = InstanceDescriptor.parse(JSON.parse(await readFile(path, "utf8")))
  return { server, root, path, descriptor, pairings: () => pairings, requested }
}

async function deadPid(): Promise<number> {
  const process_ = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" })
  await process_.exited
  return process_.pid
}

describe("ControlServer", () => {
  test("binds to loopback only and publishes its url in the descriptor", async () => {
    const { server, descriptor } = await start()
    expect(server.url).toStartWith("http://127.0.0.1:")
    expect(descriptor.controlUrl).toBe(server.url)
    expect(descriptor.version).toBe(1)
    expect(descriptor.pid).toBe(process.pid)
    expect(descriptor.controlToken.length).toBeGreaterThanOrEqual(32)
  })

  test("rejects requests with no Authorization header", async () => {
    const { server, pairings } = await start()
    const response = await fetch(`${server.url}/pairing`, { method: "POST" })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "unauthorized" })
    expect(pairings()).toBe(0)
  })

  test("rejects a wrong bearer token of any length", async () => {
    const { server, descriptor, pairings } = await start()
    for (const bad of ["x", `${descriptor.controlToken}x`, descriptor.controlToken.slice(0, -1), "a".repeat(4096)]) {
      const response = await fetch(`${server.url}/pairing`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bad}` },
      })
      expect(response.status).toBe(401)
    }
    const info = await fetch(`${server.url}/info`, { headers: { Authorization: "Basic hunter2" } })
    expect(info.status).toBe(401)
    expect(pairings()).toBe(0)
  })

  test("POST /pairing invokes the callback and returns the pairing url with no QR payload", async () => {
    const { server, descriptor, pairings } = await start()
    const response = await fetch(`${server.url}/pairing`, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.controlToken}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({
      pairingUrl: FIXTURE_URL,
      mobileServerListening: true,
      session: FIXTURE_SESSION,
    })
    expect(pairings()).toBe(1)
    expect(JSON.stringify(body)).not.toContain("█")
  })

  test("GET /sessions lists the project's chats and stays behind the bearer token", async () => {
    const { server, descriptor } = await start()
    const anonymous = await fetch(`${server.url}/sessions`)
    const response = await fetch(`${server.url}/sessions`, {
      headers: { Authorization: `Bearer ${descriptor.controlToken}` },
    })

    expect(anonymous.status).toBe(401)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessions: FIXTURE_SESSIONS })
  })

  test("GET /sessions rejects non-GET methods", async () => {
    const { server, descriptor } = await start()
    const response = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.controlToken}` },
    })

    expect(response.status).toBe(405)
  })

  test("chosen session and Tailscale host values reach requestPairing", async () => {
    const { server, descriptor, requested } = await start()
    const headers = { Authorization: `Bearer ${descriptor.controlToken}` }
    await fetch(`${server.url}/pairing`, { method: "POST", headers })
    await fetch(`${server.url}/pairing`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sessionID: "ses_older" }),
    })
    await fetch(`${server.url}/pairing`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sessionID: "ses_older", advertisedHost: "100.80.1.2" }),
    })

    expect(requested).toEqual([
      {},
      { sessionID: "ses_older" },
      { sessionID: "ses_older", advertisedHost: "100.80.1.2" },
    ])
  })

  test("a malformed pairing body is refused instead of falling back to the latest chat", async () => {
    const { server, descriptor, requested } = await start()
    const headers = {
      Authorization: `Bearer ${descriptor.controlToken}`,
      "content-type": "application/json",
    }
    for (const body of [
      "{",
      "[]",
      '{"sessionID":""}',
      '{"sessionID":42}',
      '{"advertisedHost":"not-an-ip"}',
      '{"advertisedHost":"100.80.1.999"}',
      '"ses_older"',
    ]) {
      const response = await fetch(`${server.url}/pairing`, { method: "POST", headers, body })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "invalid pairing request body" })
    }

    expect(requested).toEqual([])
  })

  test("an unknown chat is reported as a bad request, not a server error", async () => {
    const { server, descriptor } = await start({
      requestPairing: () => {
        throw new UnknownSessionError("ses_ghost is not a chat in this project")
      },
    })
    const response = await fetch(`${server.url}/pairing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${descriptor.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionID: "ses_ghost" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "ses_ghost is not a chat in this project" })
  })

  test("an unexpected pairing failure is still a 500", async () => {
    const { server, descriptor } = await start({
      requestPairing: () => {
        throw new Error("mobile server refused to start")
      },
    })
    const response = await fetch(`${server.url}/pairing`, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.controlToken}` },
    })

    expect(response.status).toBe(500)
  })

  test("GET /info reports pid, directory and lazily-started mobile state", async () => {
    const { server, descriptor } = await start()
    const headers = { Authorization: `Bearer ${descriptor.controlToken}` }
    expect(await (await fetch(`${server.url}/info`, { headers })).json()).toEqual({
      pid: process.pid,
      directory: DIRECTORY,
      worktree: DIRECTORY,
      mobileRunning: false,
    })
    await fetch(`${server.url}/pairing`, { method: "POST", headers })
    expect(await (await fetch(`${server.url}/info`, { headers })).json()).toMatchObject({ mobileRunning: true })
    expect((await fetch(`${server.url}/nope`, { headers })).status).toBe(404)
    expect((await fetch(`${server.url}/pairing`, { headers })).status).toBe(405)
  })

  test("stop() shuts the listener down and removes the descriptor", async () => {
    const { server, root, path } = await start()
    const url = server.url
    await server.stop()
    started.length = 0
    expect(await Bun.file(path).exists()).toBe(false)
    expect(await readdir(root)).toEqual([])
    await expect(fetch(`${url}/info`)).rejects.toThrow()
  })
})

describe("instance descriptors", () => {
  test("descriptor is keyed by hash(directory)+pid and written 0600 inside a 0700 directory", async () => {
    const { root, path, descriptor } = await start()
    expect(path).toBe(join(root, descriptorFileName(DIRECTORY, process.pid)))
    expect(descriptorFileName(DIRECTORY, process.pid)).toMatch(/^[0-9a-f]{16}-\d+\.json$/)
    expect(descriptorFileName(DIRECTORY, 1)).not.toBe(descriptorFileName("/other", 1))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect(descriptor.directory).toBe(DIRECTORY)
  })

  test("listDescriptors deletes descriptors whose pid is dead", async () => {
    const root = await temporaryRoot()
    const { server } = await start({ instancesDir: root })
    const stale: InstanceDescriptor = {
      version: 1,
      pid: await deadPid(),
      directory: "/tmp/gone",
      worktree: "/tmp/gone",
      controlUrl: "http://127.0.0.1:1",
      controlToken: "stale",
      updatedAt: Date.now() - 10_000,
    }
    const stalePath = await writeDescriptor(stale, root)
    expect(await Bun.file(stalePath).exists()).toBe(true)
    expect(isAlive(stale)).toBe(false)
    expect(isAlive({ pid: process.pid })).toBe(true)

    const live = await listDescriptors(root)
    expect(live.map((entry) => entry.directory)).toEqual([DIRECTORY])
    expect(live[0]?.controlUrl).toBe(server.url)
    expect(await Bun.file(stalePath).exists()).toBe(false)
  })

  test("listDescriptors quarantines malformed files instead of throwing", async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, "truncated.json"), "{\"version\":1,\"pid\":")
    await writeFile(join(root, "wrong-shape.json"), JSON.stringify({ version: 2, pid: process.pid }))
    const { descriptor } = await start({ instancesDir: root })
    expect((await listDescriptors(root)).map((entry) => entry.controlToken)).toEqual([descriptor.controlToken])
    const remaining = (await readdir(root)).sort()
    expect(remaining).toContain("truncated.json.corrupt")
    expect(remaining).toContain("wrong-shape.json.corrupt")
    expect(await listDescriptors(join(root, "missing"))).toEqual([])
  })

  test("descriptorPath and writeDescriptor round-trip through the zod schema", async () => {
    const root = await temporaryRoot()
    const descriptor: InstanceDescriptor = {
      version: 1,
      pid: process.pid,
      directory: "/repo/main",
      worktree: "/repo/worktrees/feature",
      controlUrl: "http://127.0.0.1:5555",
      controlToken: "token-value",
      updatedAt: 1700000000000,
    }
    const path = await writeDescriptor(descriptor, root)
    expect(path).toBe(descriptorPath("/repo/main", process.pid, root))
    expect(InstanceDescriptor.parse(JSON.parse(await readFile(path, "utf8")))).toEqual(descriptor)
    await writeDescriptor({ ...descriptor, updatedAt: 1700000000001 }, root)
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect((await listDescriptors(root))[0]?.updatedAt).toBe(1700000000001)
  })
})
