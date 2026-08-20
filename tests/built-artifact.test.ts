import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const project = await mkdtemp("/tmp/entangle-built-")
const state = await mkdtemp("/tmp/entangle-built-state-")
process.env.XDG_STATE_HOME = state
let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  await rm(project, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

test.skipIf(!existsSync("dist/plugin.js"))("built plugin serves the built Vite index", async () => {
  const { EntanglePlugin } = await new Function("path", "return import(path)")("../dist/plugin.js") as {
    EntanglePlugin: (input: unknown, options: unknown) => Promise<{ dispose?: () => Promise<void> }>
  }
  const logs: unknown[] = []
  const session = {
    id: "ses_built",
    title: "Built artifact fixture",
    time: { created: 1, updated: 2 },
  }
  const hooks = await EntanglePlugin({
    client: {
      app: { log: async (call: unknown) => { logs.push(call); return { data: true } } },
      tui: { showToast: async () => ({ data: true }) },
      session: {
        list: async () => ({ data: [session] }),
        get: async () => ({ data: session }),
        status: async () => ({ data: { [session.id]: { type: "idle" } } }),
      },
    },
    project: {}, directory: project, worktree: project,
    serverUrl: new URL("http://127.0.0.1:4096"), experimental_workspace: { register() {} }, $: {},
  } as never, { host: "127.0.0.1", port: 0, pairingTtlMs: 60_000 })
  dispose = hooks.dispose

  const files = await Array.fromAsync(new Bun.Glob("entangle/instances/*.json").scan({ cwd: state }))
  const descriptor = await Bun.file(join(state, files[0]!)).json() as { controlUrl: string; controlToken: string }
  const pairing = await fetch(`${descriptor.controlUrl}/pairing`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.controlToken}` },
  })
  const body = await pairing.json() as { pairingUrl: string }
  const url = new URL(body.pairingUrl)
  url.hostname = "127.0.0.1"
  const response = await fetch(url, { redirect: "manual" })
  const html = await fetch(new URL("/", url), { headers: { cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" } })
  const text = await html.text()
  expect(html.headers.get("content-type")).toContain("text/html")
  expect(text).toContain("<script type=\"module\" crossorigin src=\"./assets/")
  expect(logs.length).toBeGreaterThan(0)
})
