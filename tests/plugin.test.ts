import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EntanglePlugin } from "../src/plugin"
import { descriptorPath, listDescriptors } from "../src/server/descriptor"

type RecordedCall = { body?: Record<string, unknown> }

interface StubClient {
  client: PluginInput["client"]
  logs: RecordedCall[]
  toasts: RecordedCall[]
}

interface PluginFixture extends StubClient {
  hooks: Hooks
  projectDirectory: string
  stateDirectory: string
  instancesRoot: string
}

const PLUGIN_SESSION = {
  id: "ses_1",
  title: "Plugin fixture",
  parentID: undefined,
  time: { created: 1, updated: 2 },
}

const active: PluginFixture[] = []
const originalStateHome = process.env.XDG_STATE_HOME

afterEach(async () => {
  while (active.length > 0) {
    const fixture = active.pop()!
    await fixture.hooks.dispose?.()
    await rm(fixture.projectDirectory, { recursive: true, force: true })
    await rm(fixture.stateDirectory, { recursive: true, force: true })
  }
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = originalStateHome
})

function stubClient(toastRejects = false): StubClient {
  const logs: RecordedCall[] = []
  const toasts: RecordedCall[] = []
  const client = {
    app: {
      log: async (call: RecordedCall) => {
        logs.push(call)
        return { data: true }
      },
      agents: async () => ({ data: [] }),
    },
    session: {
      list: async () => ({ data: [PLUGIN_SESSION] }),
      get: async () => ({ data: PLUGIN_SESSION }),
      status: async () => ({ data: { [PLUGIN_SESSION.id]: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
    },
    config: {
      providers: async () => ({ data: { providers: [], default: {} } }),
    },
    tui: {
      showToast: async (call: RecordedCall) => {
        toasts.push(call)
        if (toastRejects) throw new Error("TUI unavailable")
        return { data: true }
      },
    },
  } as unknown as PluginInput["client"]
  return { client, logs, toasts }
}

function pluginInput(client: PluginInput["client"], directory: string): PluginInput {
  return {
    client,
    project: {} as PluginInput["project"],
    directory,
    worktree: directory,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"],
  }
}

async function startPlugin(toastRejects = false): Promise<PluginFixture> {
  const projectDirectory = await mkdtemp("/tmp/entangle-plugin-project-")
  const stateDirectory = await mkdtemp(join(tmpdir(), "entangle-plugin-state-"))
  process.env.XDG_STATE_HOME = stateDirectory
  const stub = stubClient(toastRejects)
  const hooks = await EntanglePlugin(pluginInput(stub.client, projectDirectory), {
    host: "127.0.0.1",
    port: 0,
    pairingTtlMs: 60_000,
  })
  const fixture = {
    ...stub,
    hooks,
    projectDirectory,
    stateDirectory,
    instancesRoot: join(stateDirectory, "entangle", "instances"),
  }
  active.push(fixture)
  return fixture
}

async function descriptorFor(fixture: PluginFixture) {
  const descriptors = await listDescriptors(fixture.instancesRoot)
  expect(descriptors).toHaveLength(1)
  return descriptors[0]!
}

async function requestPairing(fixture: PluginFixture) {
  const descriptor = await descriptorFor(fixture)
  const response = await fetch(`${descriptor.controlUrl}/pairing`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.controlToken}` },
  })
  expect(response.status).toBe(200)
  const body = await response.json() as {
    pairingUrl: string
    mobileServerListening: boolean
    expiresAt: number
    session: { id: string; title: string }
  }
  const localUrl = new URL(body.pairingUrl)
  localUrl.hostname = "127.0.0.1"
  return { descriptor, body, localUrl }
}

async function pairPhone(fixture: PluginFixture) {
  const pairing = await requestPairing(fixture)
  const response = await fetch(pairing.localUrl, { redirect: "manual" })
  expect(response.status).toBe(303)
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
  return { ...pairing, cookie }
}

async function connectionRefused(url: string | URL): Promise<boolean> {
  try {
    await fetch(url)
    return false
  } catch {
    return true
  }
}

describe("EntanglePlugin lifecycle", () => {
  test("starts the control server eagerly, writes a canonical descriptor, and leaves mobile stopped", async () => {
    const fixture = await startPlugin()
    const descriptor = await descriptorFor(fixture)

    expect(descriptor.directory).toBe(realpathSync.native(fixture.projectDirectory))
    expect(await Bun.file(descriptorPath(descriptor.directory, descriptor.pid, fixture.instancesRoot)).exists()).toBe(true)
    const response = await fetch(`${descriptor.controlUrl}/info`, {
      headers: { authorization: `Bearer ${descriptor.controlToken}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mobileRunning: false, directory: descriptor.directory })
    expect(fixture.logs.some((call) => call.body?.level === "info")).toBe(true)
  })

  test("POST /pairing lazy-starts mobile and toast failure cannot break successful consumption", async () => {
    const fixture = await startPlugin(true)
    const { body, localUrl } = await requestPairing(fixture)

    expect(body.mobileServerListening).toBe(true)
    expect(body.pairingUrl).toContain("/pair?token=")
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    expect(body.session).toEqual({ id: PLUGIN_SESSION.id, title: PLUGIN_SESSION.title })
    expect((await fetch(new URL("/api/state", localUrl))).status).toBe(401)
    expect((await fetch(localUrl, { redirect: "manual" })).status).toBe(303)
    await Bun.sleep(0)
    expect(fixture.toasts).toEqual([{
      body: {
        title: "Entangle",
        message: "Phone connected.",
        variant: "success",
        duration: 5_000,
      },
    }])
  })

  test("forwards a synthetic event to an authenticated SSE client with only EventLog's id", async () => {
    const fixture = await startPlugin()
    const { localUrl, cookie } = await pairPhone(fixture)
    const eventsUrl = new URL("/api/events", localUrl)
    const response = await fetch(eventsUrl, { headers: { cookie } })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": open\n\n")

    await fixture.hooks.event?.({
      event: {
        type: "message.updated",
        properties: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant" } },
      } as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
    })

    const chunk = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    expect(chunk).toBe('id: 1\ndata: {"sessionID":"ses_1","event":"message.updated","data":{"info":{"id":"msg_1","sessionID":"ses_1","role":"assistant"}}}\n\n')
    expect(chunk).not.toContain('"id":1,"event"')
  })

  test("GET /sessions offers the project's chats to the CLI picker", async () => {
    const fixture = await startPlugin()
    const descriptor = await descriptorFor(fixture)

    const response = await fetch(`${descriptor.controlUrl}/sessions`, {
      headers: { authorization: `Bearer ${descriptor.controlToken}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessions: [{ id: PLUGIN_SESSION.id, title: PLUGIN_SESSION.title, updatedAt: PLUGIN_SESSION.time.updated }],
    })
  })

  test("a chosen chat and Tailscale host are pinned into the pairing URL", async () => {
    const fixture = await startPlugin()
    const descriptor = await descriptorFor(fixture)

    const response = await fetch(`${descriptor.controlUrl}/pairing`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionID: PLUGIN_SESSION.id, advertisedHost: "100.80.1.2" }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { pairingUrl: string; session: { id: string } }
    expect(body.session.id).toBe(PLUGIN_SESSION.id)
    expect(new URL(body.pairingUrl).hostname).toBe("100.80.1.2")
  })

  /*
   * The stubbed `session.get` resolves any id, mimicking an opencode that does not
   * scope reads by project. Without the allowlist check the plugin would answer 200
   * and silently pin its own chat, so this asserts the rejection rather than the
   * response body alone.
   */
  test("a chat id outside this project is rejected instead of resolving to a local chat", async () => {
    const fixture = await startPlugin()
    const descriptor = await descriptorFor(fixture)

    const response = await fetch(`${descriptor.controlUrl}/pairing`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionID: "ses_from_another_repo" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "ses_from_another_repo is not a chat in this project",
    })
  })

  test("dispose closes both real ports and removes the descriptor from disk", async () => {
    const fixture = await startPlugin()
    const { descriptor, localUrl } = await requestPairing(fixture)
    const path = descriptorPath(descriptor.directory, descriptor.pid, fixture.instancesRoot)

    await fixture.hooks.dispose?.()

    expect(await Bun.file(path).exists()).toBe(false)
    expect(await connectionRefused(descriptor.controlUrl)).toBe(true)
    expect(await connectionRefused(new URL("/", localUrl))).toBe(true)
  })

  test("an initialization failure resolves to empty hooks and logs the error", async () => {
    const projectDirectory = await mkdtemp("/tmp/entangle-plugin-invalid-")
    const stub = stubClient()

    const initialization = EntanglePlugin(
      pluginInput(stub.client, projectDirectory),
      { port: -1 },
    )
    const hooks = await initialization

    expect(hooks).toEqual({})
    expect(stub.logs.some((call) => call.body?.level === "error")).toBe(true)
    await rm(projectDirectory, { recursive: true, force: true })
  })
})
