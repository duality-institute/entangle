import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EXIT_AMBIGUOUS,
  EXIT_NO_INSTANCE,
  EXIT_OK,
  HINT,
  displayWidth,
  isAncestorDirectory,
  relativeTime,
  renderPicker,
  runCli,
  selectCandidates,
  type CliDependencies,
} from "../src/cli"
import type { InstallOptions } from "../src/install"
import type { InstanceDescriptor, SessionSummaryDto } from "../src/shared/protocol"

const PAIRING_URL = "http://192.168.1.9:9999/pair?token=FIXTURE"

const temporaryRoots: string[] = []

afterAll(async () => {
  for (const root of temporaryRoots) await rm(root, { force: true, recursive: true }).catch(() => {})
})

function descriptor(overrides: Partial<InstanceDescriptor> = {}): InstanceDescriptor {
  return {
    version: 1,
    pid: 4242,
    directory: "/tmp/entangle-project",
    worktree: "/tmp/entangle-project",
    controlUrl: "http://127.0.0.1:59999",
    controlToken: "control-token-must-never-be-printed",
    updatedAt: 1_786_851_986_322,
    ...overrides,
  }
}

interface Harness {
  code: number
  stdout: string
  stderr: string
  pairingRequests: string[]
  sessionRequests: string[]
  /** `undefined` where the CLI deliberately sent no body, meaning "pin the latest chat". */
  pairedSessionIDs: Array<string | undefined>
  advertisedHosts: Array<string | undefined>
  tailscaleLookups: number
  removed: Array<{ directory: string; pid: number }>
  listCalls: number
  unreadAnswers: number
}

interface HarnessOptions {
  argv?: string[]
  cwd?: string
  descriptors: InstanceDescriptor[] | InstanceDescriptor[][]
  respond?: (url: string, init: RequestInit, attempt: number) => Promise<Response> | Response
  sessions?: SessionSummaryDto[]
  interactive?: boolean
  answers?: string[]
  tailscaleAddress?: string | null
}

async function run(options: HarnessOptions): Promise<Harness> {
  const batches = Array.isArray(options.descriptors[0])
    ? (options.descriptors as InstanceDescriptor[][])
    : [options.descriptors as InstanceDescriptor[]]
  let stdout = ""
  let stderr = ""
  let listCalls = 0
  let attempt = 0
  const pairingRequests: string[] = []
  const sessionRequests: string[] = []
  const pairedSessionIDs: Array<string | undefined> = []
  const advertisedHosts: Array<string | undefined> = []
  let tailscaleLookups = 0
  const removed: Array<{ directory: string; pid: number }> = []
  const answers = [...(options.answers ?? [])]

  const deps: Partial<CliDependencies> = {
    argv: options.argv ?? [],
    cwd: options.cwd ?? "/tmp/entangle-project",
    listDescriptors: async () => batches[Math.min(listCalls++, batches.length - 1)] ?? [],
    removeDescriptor: async (target) => {
      removed.push({ directory: target.directory, pid: target.pid })
    },
    fetch: async (url, init) => {
      attempt += 1
      if (url.endsWith("/sessions")) {
        sessionRequests.push(url)
        if (options.respond) return await options.respond(url, init, attempt)
        return Response.json({ sessions: options.sessions ?? [] })
      }
      pairingRequests.push(url)
      const body = typeof init.body === "string"
        ? JSON.parse(init.body) as { sessionID?: string; advertisedHost?: string }
        : {}
      pairedSessionIDs.push(body.sessionID)
      advertisedHosts.push(body.advertisedHost)
      if (options.respond) return await options.respond(url, init, attempt)
      return Response.json({ pairingUrl: PAIRING_URL, mobileServerListening: true })
    },
    write: (text) => {
      stdout += text
    },
    writeError: (text) => {
      stderr += text
    },
    isInteractive: () => options.interactive ?? false,
    readLine: async () => answers.shift(),
    findTailscaleIpv4: async () => {
      tailscaleLookups++
      return options.tailscaleAddress ?? null
    },
  }
  const code = await runCli(deps)
  return {
    code,
    stdout,
    stderr,
    pairingRequests,
    sessionRequests,
    pairedSessionIDs,
    advertisedHosts,
    tailscaleLookups,
    removed,
    listCalls,
    unreadAnswers: answers.length,
  }
}

describe("instance selection", () => {
  test("isAncestorDirectory is strict and path-segment aware", () => {
    expect(isAncestorDirectory("/tmp/proj", "/tmp/proj/src")).toBe(true)
    expect(isAncestorDirectory("/tmp/proj", "/tmp/proj")).toBe(false)
    expect(isAncestorDirectory("/tmp/proj", "/tmp/project-other")).toBe(false)
    expect(isAncestorDirectory("/tmp/proj/src", "/tmp/proj")).toBe(false)
  })

  test("an exact cwd match beats an ancestor match", () => {
    const exact = descriptor({ directory: "/tmp/proj/src", pid: 2 })
    const ancestor = descriptor({ directory: "/tmp/proj", pid: 1 })
    expect(selectCandidates([ancestor, exact], "/tmp/proj/src")).toEqual([exact])
  })

  test("a symlinked descriptor directory still matches the real cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "entangle-cli-link-"))
    temporaryRoots.push(root)
    const real = join(root, "real-project")
    const link = join(root, "linked-project")
    await mkdtemp(join(root, "real-project"))
    await rm(real, { force: true, recursive: true }).catch(() => {})
    await Bun.write(join(real, ".keep"), "")
    await symlink(real, link)

    const viaLink = descriptor({ directory: link, worktree: link })
    expect(selectCandidates([viaLink], real)).toEqual([viaLink])
    expect(isAncestorDirectory(link, join(real, "src"))).toBe(true)
  })
})

describe("entangle (default command)", () => {
  test("exact cwd match pairs and prints the QR, the URL and the hint", async () => {
    const result = await run({
      cwd: "/tmp/entangle-project",
      descriptors: [descriptor({ directory: "/tmp/entangle-project" }), descriptor({ directory: "/elsewhere", pid: 77 })],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairingRequests).toEqual(["http://127.0.0.1:59999/pairing"])
    expect(result.stdout.startsWith("\n")).toBe(true)
    expect(result.stdout).toContain("█")
    expect(result.stdout).toContain(PAIRING_URL)
    expect(result.stdout.trimEnd().endsWith(HINT)).toBe(true)
    expect(result.stdout).not.toContain("control-token-must-never-be-printed")
    expect(result.stderr).toBe("")
  })

  test("prints the session pinned into the pairing token", async () => {
    const result = await run({
      descriptors: [descriptor()],
      respond: () => Response.json({
        pairingUrl: PAIRING_URL,
        mobileServerListening: true,
        session: { id: "ses_pinned", title: "Pinned conversation" },
      }),
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain("Session: Pinned conversation")
  })

  test("strips terminal control characters from the pinned session title", async () => {
    const result = await run({
      descriptors: [descriptor()],
      respond: () => Response.json({
        pairingUrl: PAIRING_URL,
        mobileServerListening: true,
        session: { id: "ses_pinned", title: "safe\n\u001b]0;owned\u0007 title" },
      }),
    })

    expect(result.stdout).toContain("Session: safe ]0;owned title")
    expect(result.stdout).not.toContain("\u001b")
    expect(result.stdout).not.toContain("\u0007")
  })

  test("sends the control token as a bearer header and never prints it", async () => {
    const seen: Array<string | null> = []
    const result = await run({
      descriptors: [descriptor()],
      respond: (_url, init) => {
        seen.push(new Headers(init.headers).get("authorization"))
        return Response.json({ pairingUrl: PAIRING_URL, mobileServerListening: true })
      },
    })

    expect(seen).toEqual(["Bearer control-token-must-never-be-printed"])
    expect(result.code).toBe(EXIT_OK)
    expect(`${result.stdout}${result.stderr}`).not.toContain("control-token-must-never-be-printed")
  })

  test("an ancestor directory match is used when cwd is a subdirectory", async () => {
    const result = await run({
      cwd: "/tmp/entangle-project/packages/ui/src",
      descriptors: [descriptor({ directory: "/tmp/entangle-project" })],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairingRequests).toHaveLength(1)
    expect(result.stdout).toContain(PAIRING_URL)
  })

  test("several matching instances pair with the most recently updated one, never prompting", async () => {
    const result = await run({
      cwd: "/tmp/entangle-project",
      descriptors: [
        descriptor({ pid: 101, controlUrl: "http://127.0.0.1:50101", updatedAt: 1_786_851_000_000 }),
        descriptor({ pid: 202, controlUrl: "http://127.0.0.1:50202", updatedAt: 1_786_851_999_999 }),
      ],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairingRequests).toEqual(["http://127.0.0.1:50202/pairing"])
    expect(result.stdout).toContain(PAIRING_URL)
  })

  test("pairing with one of several instances explains that the choice is only the connection", async () => {
    const result = await run({
      cwd: "/tmp/entangle-project",
      descriptors: [descriptor({ pid: 101 }), descriptor({ pid: 202 })],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).toContain("share the same chats")
    expect(result.stdout).toContain(PAIRING_URL)
  })

  test("a single matching instance pairs without any explanatory note", async () => {
    const result = await run({ descriptors: [descriptor()] })

    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).toBe("")
  })

  test("--json pairs with the most recent instance and keeps stdout machine-readable", async () => {
    const result = await run({
      argv: ["--json"],
      descriptors: [
        descriptor({ pid: 101, controlUrl: "http://127.0.0.1:50101", updatedAt: 1_786_851_000_000 }),
        descriptor({ pid: 202, controlUrl: "http://127.0.0.1:50202", updatedAt: 1_786_851_999_999 }),
      ],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairingRequests).toEqual(["http://127.0.0.1:50202/pairing"])
    expect(result.stdout).toBe(`{"pairingUrl":"${PAIRING_URL}"}\n`)
    expect(result.stderr).toBe("")
  })

  test("zero instances exits 1 with the start-opencode message", async () => {
    const result = await run({ descriptors: [] })

    expect(result.code).toBe(EXIT_NO_INSTANCE)
    expect(result.stderr).toBe(
      "No running opencode instance found. Start opencode with the entangle plugin enabled.\n",
    )
    expect(result.stdout).toBe("")
  })

  test("a stale descriptor is swept and the pairing is retried once against the live instance", async () => {
    const stale = descriptor({ directory: "/tmp/entangle-project", pid: 9001, controlUrl: "http://127.0.0.1:1" })
    const live = descriptor({ directory: "/tmp/entangle-project", pid: 9002, controlUrl: "http://127.0.0.1:2" })
    const result = await run({
      cwd: "/tmp/entangle-project",
      descriptors: [[stale], [live]],
      respond: (url) => {
        if (url.startsWith("http://127.0.0.1:1")) throw new Error("connect ECONNREFUSED 127.0.0.1:1")
        return Response.json({ pairingUrl: PAIRING_URL, mobileServerListening: true })
      },
    })

    expect(result.removed).toEqual([{ directory: "/tmp/entangle-project", pid: 9001 }])
    expect(result.pairingRequests).toEqual(["http://127.0.0.1:1/pairing", "http://127.0.0.1:2/pairing"])
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain(PAIRING_URL)
  })

  test("an unreachable instance with no replacement exits 1 without a stack trace", async () => {
    const result = await run({
      descriptors: [[descriptor({ pid: 9001 })], []],
      respond: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:59999")
      },
    })

    expect(result.code).toBe(EXIT_NO_INSTANCE)
    expect(result.removed).toEqual([{ directory: "/tmp/entangle-project", pid: 9001 }])
    expect(result.stderr).toContain("no longer reachable")
    expect(result.stderr).not.toContain("ECONNREFUSED")
    expect(result.stderr).not.toMatch(/\n\s+at .+:\d+/)
    expect(result.stdout).toBe("")
  })

  test("a non-2xx pairing response is reported without a retry loop", async () => {
    const result = await run({
      descriptors: [descriptor()],
      respond: () => Response.json({ error: "unauthorized" }, { status: 401 }),
    })

    expect(result.code).toBe(EXIT_NO_INSTANCE)
    expect(result.pairingRequests).toHaveLength(1)
    expect(result.stderr).toContain("HTTP 401")
  })
})

describe("entangle --list / --help", () => {
  test("--list prints a pid + directory table and exits 0 without pairing", async () => {
    const result = await run({
      argv: ["--list"],
      descriptors: [descriptor({ directory: "/tmp/alpha", pid: 101 }), descriptor({ directory: "/tmp/beta", pid: 2 })],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairingRequests).toEqual([])
    expect(result.stdout.split("\n")[0]).toBe("PID  DIRECTORY")
    expect(result.stdout).toContain("101  /tmp/alpha")
    expect(result.stdout).toContain("2    /tmp/beta")
    expect(result.stdout).not.toContain("control-token-must-never-be-printed")
  })

  test("--list with no instances still exits 0", async () => {
    const result = await run({ argv: ["--list"], descriptors: [] })

    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toBe("No running opencode instances.\n")
  })

  test("--help prints usage and exits 0 without touching descriptors", async () => {
    const result = await run({ argv: ["--help"], descriptors: [] })

    expect(result.code).toBe(EXIT_OK)
    expect(result.listCalls).toBe(0)
    expect(result.stdout).toContain("Usage:")
    expect(result.stdout).toContain("entangle --json")
    expect(result.stdout).toContain("entangle --remote")
  })

  test("an unknown flag exits 2 with usage on stderr", async () => {
    const result = await run({ argv: ["--tunnel"], descriptors: [descriptor()] })

    expect(result.code).toBe(EXIT_AMBIGUOUS)
    expect(result.stderr).toContain("Unknown argument: --tunnel")
    expect(result.stdout).toBe("")
  })
})


describe("entangle install", () => {
  test("routes no-global and a relative config path to the installer", async () => {
    let received: InstallOptions | undefined
    let stdout = ""
    let descriptorReads = 0
    const code = await runCli({
      argv: ["install", "--no-global", "--config", "config/opencode.jsonc"],
      cwd: "/tmp/project",
      install: async (options) => {
        received = options
        return {
          configPath: options.configPath!,
          configChanged: true,
          globalInstalled: false,
        }
      },
      listDescriptors: async () => {
        descriptorReads += 1
        return []
      },
      write: (value) => { stdout += value },
    })

    expect(code).toBe(EXIT_OK)
    expect(received).toEqual({
      configPath: "/tmp/project/config/opencode.jsonc",
      installGlobal: false,
    })
    expect(descriptorReads).toBe(0)
    expect(stdout).toContain("Added @dualityinstitute/entangle")
    expect(stdout).not.toContain("globally")
  })

  test("reports an existing global installation and never reads descriptors", async () => {
    let stdout = ""
    const code = await runCli({
      argv: ["install"],
      install: async (options) => ({
        configPath: "/home/user/.config/opencode/opencode.jsonc",
        configChanged: false,
        globalInstalled: options.installGlobal ?? true,
      }),
      listDescriptors: async () => { throw new Error("must not read descriptors") },
      write: (value) => { stdout += value },
    })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain("Installed the entangle command globally")
    expect(stdout).toContain("already configured")
  })

  test("install help and argument errors do not invoke the installer", async () => {
    let calls = 0
    const install = async () => {
      calls += 1
      throw new Error("must not run")
    }
    let help = ""
    const helpCode = await runCli({
      argv: ["install", "--help"],
      install,
      write: (value) => { help += value },
    })
    let error = ""
    const errorCode = await runCli({
      argv: ["install", "--config"],
      install,
      writeError: (value) => { error += value },
    })

    expect(helpCode).toBe(EXIT_OK)
    expect(help).toContain("--no-global")
    expect(errorCode).toBe(EXIT_AMBIGUOUS)
    expect(error).toContain("--config requires a path")
    expect(calls).toBe(0)
  })

  test("installer failures return exit 1 without a stack trace", async () => {
    let stderr = ""
    const code = await runCli({
      argv: ["install"],
      install: async () => { throw new Error("global package install failed") },
      writeError: (value) => { stderr += value },
    })

    expect(code).toBe(EXIT_NO_INSTANCE)
    expect(stderr).toBe("Could not install entangle: global package install failed\n")
    expect(stderr).not.toContain(" at ")
  })
})

const NOW = 1_786_851_986_322
const CHATS: SessionSummaryDto[] = [
  { id: "ses_newest", title: "Redesign the picker", updatedAt: NOW },
  { id: "ses_middle", title: "Fix typing inbox bug", updatedAt: NOW - 3_600_000 },
  { id: "ses_oldest", title: "Greeting", updatedAt: NOW - 172_800_000 },
]

describe("relativeTime", () => {
  test("degrades from seconds to days without ever rendering a negative age", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now")
    expect(relativeTime(NOW - 59_000, NOW)).toBe("just now")
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1m ago")
    expect(relativeTime(NOW - 3_600_000, NOW)).toBe("1h ago")
    expect(relativeTime(NOW - 172_800_000, NOW)).toBe("2d ago")
    expect(relativeTime(NOW + 5_000, NOW)).toBe("just now")
  })
})

describe("renderPicker", () => {
  test("aligns titles into a column and strips control characters from them", () => {
    const rendered = renderPicker(
      [{ id: "ses_a", title: "Danger\u0007\nzone", updatedAt: NOW }, ...CHATS.slice(0, 2)],
      NOW,
    )
    const lines = rendered.split("\n")

    expect(lines[0]).toBe("  1  Danger zone           just now")
    expect(lines[1]).toBe("  2  Redesign the picker   just now")
    expect(lines[2]).toBe("  3  Fix typing inbox bug  1h ago")
    expect(rendered).not.toContain("\u0007")
  })

  test("truncates a long title instead of breaking the column layout", () => {
    const rendered = renderPicker([{ id: "ses_a", title: "x".repeat(120), updatedAt: NOW }], NOW)

    expect(rendered).toContain("…")
    expect(rendered.split("\n")[0]!.length).toBeLessThan(80)
  })

  test("falls back to a placeholder rather than rendering an empty title cell", () => {
    expect(renderPicker([{ id: "ses_a", title: "   ", updatedAt: NOW }], NOW)).toContain("Untitled chat")
  })

  test("displayWidth counts terminal cells rather than UTF-16 units", () => {
    expect(displayWidth("abc")).toBe(3)
    expect(displayWidth("한글")).toBe(4)
    expect(displayWidth("日本語")).toBe(6)
    expect(displayWidth("ｆｕｌｌ")).toBe(8)
    expect(displayWidth("e\u0301")).toBe(1)
    expect("한글".length).toBe(2)
  })

  test("a CJK title leaves the time column aligned with ascii rows", () => {
    const lines = renderPicker(
      [
        { id: "ses_a", title: "Redesign the picker", updatedAt: NOW },
        { id: "ses_b", title: "한글로 된 대화 제목", updatedAt: NOW },
        { id: "ses_c", title: "日本語のタイトル", updatedAt: NOW },
      ],
      NOW,
    ).split("\n")

    expect(lines.every((line) => line.endsWith("just now"))).toBe(true)
    expect(new Set(lines.map(displayWidth)).size).toBe(1)
  })

  test("a long CJK title is truncated by cell width so it cannot overflow the column", () => {
    const rendered = renderPicker([{ id: "ses_a", title: "한".repeat(80), updatedAt: NOW }], NOW)

    expect(rendered).toContain("…")
    expect(displayWidth(rendered)).toBeLessThanOrEqual(64)
  })
})

describe("chat picker", () => {
  test("pins the chosen chat and never lists chats on the phone's behalf", async () => {
    const result = await run({
      descriptors: [descriptor()],
      sessions: CHATS,
      interactive: true,
      answers: ["2"],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.sessionRequests).toEqual(["http://127.0.0.1:59999/sessions"])
    expect(result.pairedSessionIDs).toEqual(["ses_middle"])
    expect(result.stdout).toContain("Redesign the picker")
    expect(result.stdout).toContain("Fix typing inbox bug")
  })

  test("a single chat pairs straight through without prompting", async () => {
    const result = await run({
      descriptors: [descriptor()],
      sessions: CHATS.slice(0, 1),
      interactive: true,
      answers: ["1"],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairedSessionIDs).toEqual([undefined])
    expect(result.stdout).not.toContain("Pair with")
    expect(result.unreadAnswers).toBe(1)
  })

  test("a rejected entry re-prompts instead of silently pairing the wrong chat", async () => {
    const result = await run({
      descriptors: [descriptor()],
      sessions: CHATS,
      interactive: true,
      answers: ["nonsense", "9", "3"],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairedSessionIDs).toEqual(["ses_oldest"])
    expect(result.stderr).toContain("Enter a number between 1 and 3.")
  })

  test("giving up after repeated bad entries cancels rather than pairing anything", async () => {
    const result = await run({
      descriptors: [descriptor()],
      sessions: CHATS,
      interactive: true,
      answers: ["a", "b", "c"],
    })

    expect(result.code).toBe(EXIT_AMBIGUOUS)
    expect(result.pairingRequests).toEqual([])
    expect(result.stderr).toContain("No chat selected.")
  })

  test("closed stdin cancels without looping forever", async () => {
    const result = await run({
      descriptors: [descriptor()],
      sessions: CHATS,
      interactive: true,
      answers: [],
    })

    expect(result.code).toBe(EXIT_AMBIGUOUS)
    expect(result.pairingRequests).toEqual([])
  })

  test("only the ten most recent chats are offered", async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `ses_${index}`,
      title: `Chat ${index}`,
      updatedAt: NOW - index * 60_000,
    }))
    const result = await run({
      descriptors: [descriptor()],
      sessions: many,
      interactive: true,
      answers: ["10"],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.pairedSessionIDs).toEqual(["ses_9"])
    expect(result.stdout).toContain("Chat 9")
    expect(result.stdout).not.toContain("Chat 10")
    expect(result.stdout).toContain("Pair with [1-10]: ")
  })

  test("a non-interactive terminal pairs the latest chat without reading stdin", async () => {
    const result = await run({
      descriptors: [descriptor()],
      sessions: CHATS,
      interactive: false,
      answers: ["2"],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.sessionRequests).toEqual([])
    expect(result.pairedSessionIDs).toEqual([undefined])
    expect(result.unreadAnswers).toBe(1)
  })

  test("--json never prompts even on an interactive terminal", async () => {
    const result = await run({
      argv: ["--json"],
      descriptors: [descriptor()],
      sessions: CHATS,
      interactive: true,
      answers: ["2"],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.sessionRequests).toEqual([])
    expect(result.pairedSessionIDs).toEqual([undefined])
    expect(result.stdout).toBe(`{"pairingUrl":"${PAIRING_URL}"}\n`)
  })

  test("--session pins the given chat without listing or prompting", async () => {
    const result = await run({
      argv: ["--session", "ses_middle"],
      descriptors: [descriptor()],
      sessions: CHATS,
      interactive: true,
      answers: ["2"],
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.sessionRequests).toEqual([])
    expect(result.pairedSessionIDs).toEqual(["ses_middle"])
    expect(result.unreadAnswers).toBe(1)
  })

  test("--remote advertises the tailnet address and prints a tailnet-specific hint", async () => {
    const result = await run({
      argv: ["--remote"],
      descriptors: [descriptor()],
      tailscaleAddress: "100.80.1.2",
      respond: (_url, init) => {
        const body = JSON.parse(String(init.body)) as { advertisedHost: string }
        return Response.json({ pairingUrl: `http://${body.advertisedHost}:41778/pair?token=FIXTURE` })
      },
    })

    expect(result.code).toBe(EXIT_OK)
    expect(result.advertisedHosts).toEqual(["100.80.1.2"])
    expect(result.tailscaleLookups).toBe(1)
    expect(result.stdout).toContain("http://100.80.1.2:41778/pair?token=FIXTURE")
    expect(result.stdout).toContain("Keep Tailscale connected on both devices")
    expect(result.stdout).not.toContain("Same Wi-Fi required")
  })

  test("--remote fails before pairing when this computer is not connected", async () => {
    const result = await run({
      argv: ["--remote"],
      descriptors: [descriptor()],
      tailscaleAddress: null,
    })

    expect(result.code).toBe(EXIT_NO_INSTANCE)
    expect(result.pairingRequests).toEqual([])
    expect(result.stderr).toContain("No active Tailscale IPv4 address found")
  })

  test("normal LAN pairing never probes Tailscale", async () => {
    const result = await run({ descriptors: [descriptor()], tailscaleAddress: "100.80.1.2" })

    expect(result.code).toBe(EXIT_OK)
    expect(result.tailscaleLookups).toBe(0)
    expect(result.advertisedHosts).toEqual([undefined])
    expect(result.stdout).toContain("Same Wi-Fi required")
  })

  test("--session=value is accepted and a bare --session is rejected", async () => {
    const inline = await run({
      argv: ["--session=ses_oldest"],
      descriptors: [descriptor()],
    })
    const bare = await run({ argv: ["--session"], descriptors: [descriptor()] })

    expect(inline.code).toBe(EXIT_OK)
    expect(inline.pairedSessionIDs).toEqual(["ses_oldest"])
    expect(bare.code).toBe(EXIT_AMBIGUOUS)
    expect(bare.stderr).toContain("--session requires a chat id")
    expect(bare.pairingRequests).toEqual([])
  })

  test("a chat the server rejects reports the server's own reason", async () => {
    const result = await run({
      argv: ["--session", "ses_from_another_repo"],
      descriptors: [descriptor()],
      respond: () => Response.json({ error: "ses_from_another_repo is not a chat in this project" }, { status: 400 }),
    })

    expect(result.code).toBe(EXIT_NO_INSTANCE)
    expect(result.stderr).toContain("is not a chat in this project")
    expect(result.stderr).toContain("HTTP 400")
    expect(result.stdout).not.toContain(PAIRING_URL)
  })

  test("an unreachable instance is swept before the chat list is offered", async () => {
    const stale = descriptor({ pid: 9001, controlUrl: "http://127.0.0.1:1" })
    const live = descriptor({ pid: 9002, controlUrl: "http://127.0.0.1:2" })
    const result = await run({
      descriptors: [[stale], [live]],
      sessions: CHATS,
      interactive: true,
      answers: ["1"],
      respond: (url) => {
        if (url.startsWith("http://127.0.0.1:1")) throw new Error("connect ECONNREFUSED 127.0.0.1:1")
        if (url.endsWith("/sessions")) return Response.json({ sessions: CHATS })
        return Response.json({ pairingUrl: PAIRING_URL, mobileServerListening: true })
      },
    })

    expect(result.removed).toEqual([{ directory: "/tmp/entangle-project", pid: 9001 }])
    expect(result.code).toBe(EXIT_OK)
    expect(result.pairedSessionIDs).toEqual(["ses_newest"])
    expect(result.pairingRequests).toEqual(["http://127.0.0.1:2/pairing"])
  })

  test("a malformed chat list is refused rather than silently pairing the latest chat", async () => {
    const result = await run({
      descriptors: [descriptor()],
      interactive: true,
      answers: ["1"],
      respond: (url) =>
        url.endsWith("/sessions")
          ? Response.json({ sessions: "not-an-array" })
          : Response.json({ pairingUrl: PAIRING_URL, mobileServerListening: true }),
    })

    expect(result.code).toBe(EXIT_NO_INSTANCE)
    expect(result.pairingRequests).toEqual([])
    expect(result.stderr).toContain("malformed chat list")
  })
})
