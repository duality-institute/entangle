#!/usr/bin/env bun
import { resolve, sep } from "node:path"
import { installEntangle as defaultInstall, type InstallOptions, type InstallResult } from "./install"
import {
  listDescriptors as defaultListDescriptors,
  removeDescriptor as defaultRemoveDescriptor,
} from "./server/descriptor"
import { renderTerminalQr as defaultRenderQr } from "./server/qr"
import { findTailscaleIpv4 as defaultFindTailscaleIpv4 } from "./server/tailscale"
import { canonicalDirectory } from "./shared/canonical-directory"
import type { InstanceDescriptor, SessionSummaryDto } from "./shared/protocol"

export const EXIT_OK = 0
export const EXIT_NO_INSTANCE = 1
export const EXIT_AMBIGUOUS = 2

export const HINT = "Scan with your phone camera. Same Wi-Fi required. Link expires in 5 minutes."
export const REMOTE_HINT = "Scan with your phone camera. Keep Tailscale connected on both devices. Link expires in 5 minutes."

const USAGE = `entangle — pair your phone with a running opencode instance.

Usage:
  entangle install [--config PATH] [--no-global]
  entangle               Choose a chat, then print a scannable QR code.
  entangle --session ID  Pair a specific chat without prompting.
  entangle --remote      Pair remotely through your private Tailscale network.
  entangle --json        Print {"pairingUrl":"..."} and nothing else.
  entangle --list        List the running opencode instances that expose entangle.
  entangle --help        Show this message.

When the project has several chats, entangle asks which one to pair. Piped
output, --json and --session never prompt; they pair the most recently updated
chat unless an id is given. Each pairing is pinned to the chosen chat at QR
creation, so later activity in another chat never changes the phone's target.

Exit codes:
  0  success
  1  operation failed, no instance is running, or it could not be reached
  2  invalid usage, or no chat was selected
`

export interface CliDependencies {
  argv: string[]
  cwd: string
  /** Descriptor directory override; forwarded to listDescriptors/removeDescriptor. */
  instancesRoot?: string
  listDescriptors: (root?: string) => Promise<InstanceDescriptor[]>
  removeDescriptor: (
    descriptor: Pick<InstanceDescriptor, "directory" | "pid">,
    root?: string,
  ) => Promise<void>
  fetch: (url: string, init: RequestInit) => Promise<Response>
  renderQr: (url: string) => Promise<string>
  install: (options: InstallOptions) => Promise<InstallResult>
  findTailscaleIpv4: () => Promise<string | null>
  /** Raw writers — the QR is written verbatim, never indented, wrapped or coloured. */
  write: (text: string) => void
  writeError: (text: string) => void
  /** False for pipes, CI and `--json`, where the picker must never block on stdin. */
  isInteractive: () => boolean
  readLine: () => Promise<string | undefined>
}

interface Flags {
  json: boolean
  list: boolean
  help: boolean
  session?: string
  remote: boolean
  unknown: string[]
}

interface InstallFlags {
  configPath?: string
  installGlobal: boolean
  help: boolean
}

const INSTALL_USAGE = `Usage:
  entangle install [--config PATH] [--no-global]

Options:
  --config PATH  Write to a specific OpenCode config file.
  --no-global    Configure OpenCode without globally installing the CLI.
`

class UsageError extends Error {}

function parseInstallFlags(argv: string[]): InstallFlags {
  const flags: InstallFlags = { installGlobal: true, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--no-global") flags.installGlobal = false
    else if (argument === "--help" || argument === "-h") flags.help = true
    else if (argument === "--config") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new UsageError("--config requires a path")
      flags.configPath = value
      index += 1
    } else if (argument.startsWith("--config=")) {
      const value = argument.slice("--config=".length)
      if (!value) throw new UsageError("--config requires a path")
      flags.configPath = value
    } else {
      throw new UsageError(`Unknown install argument: ${argument}`)
    }
  }
  return flags
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, list: false, help: false, remote: false, unknown: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--json") flags.json = true
    else if (argument === "--list") flags.list = true
    else if (argument === "--remote") flags.remote = true
    else if (argument === "--help" || argument === "-h") flags.help = true
    else if (argument === "--session") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) throw new UsageError("--session requires a chat id")
      flags.session = value
      index += 1
    } else if (argument.startsWith("--session=")) {
      const value = argument.slice("--session=".length)
      if (!value) throw new UsageError("--session requires a chat id")
      flags.session = value
    } else flags.unknown.push(argument)
  }
  return flags
}

/** True when `directory` is a strict ancestor of `cwd`. */
export function isAncestorDirectory(directory: string, cwd: string): boolean {
  const parent = canonicalDirectory(directory)
  const child = canonicalDirectory(cwd)
  if (parent === child) return false
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Narrowest set of plausible instances: an exact cwd match wins, then ancestors of cwd,
 * then — only when nothing is directory-related — every live instance.
 */
export function selectCandidates(descriptors: InstanceDescriptor[], cwd: string): InstanceDescriptor[] {
  const target = canonicalDirectory(cwd)
  const exact = descriptors.filter((descriptor) => canonicalDirectory(descriptor.directory) === target)
  if (exact.length > 0) return exact
  const ancestors = descriptors.filter((descriptor) => isAncestorDirectory(descriptor.directory, cwd))
  if (ancestors.length > 0) return ancestors
  return descriptors
}

function instanceTable(descriptors: InstanceDescriptor[]): string {
  const rows: Array<[string, string]> = descriptors.map((descriptor) => [String(descriptor.pid), descriptor.directory])
  const header: [string, string] = ["PID", "DIRECTORY"]
  const width = Math.max(header[0].length, ...rows.map(([pid]) => pid.length))
  return [header, ...rows].map(([pid, directory]) => `${pid.padEnd(width)}  ${directory}`).join("\n")
}

const PICKER_LIMIT = 10
const TITLE_LIMIT = 48

/*
 * Terminal columns, not UTF-16 units: CJK and emoji occupy two cells, and
 * combining marks none. Padding by `String.length` misaligns every column to
 * the right of a Korean, Japanese or Chinese chat title.
 */
function charWidth(codePoint: number): number {
  if (
    codePoint === 0x200d ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) return 0
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2
  return 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const character of text) width += charWidth(character.codePointAt(0)!)
  return width
}

function truncateToWidth(text: string, limit: number): string {
  if (displayWidth(text) <= limit) return text
  let width = 0
  let kept = ""
  for (const character of text) {
    const next = width + charWidth(character.codePointAt(0)!)
    if (next > limit - 1) break
    kept += character
    width = next
  }
  return `${kept}…`
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)))
}

export function relativeTime(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function chatLabel(session: SessionSummaryDto): string {
  return truncateToWidth(terminalSafe(session.title) || "Untitled chat", TITLE_LIMIT)
}

export function renderPicker(sessions: SessionSummaryDto[], now: number): string {
  const rows = sessions.map((session, index) => ({
    index: String(index + 1),
    title: chatLabel(session),
    when: relativeTime(session.updatedAt, now),
  }))
  const indexWidth = Math.max(...rows.map((row) => row.index.length))
  const titleWidth = Math.max(...rows.map((row) => displayWidth(row.title)))
  return rows
    .map((row) => `  ${row.index.padStart(indexWidth)}  ${padToWidth(row.title, titleWidth)}  ${row.when}`)
    .join("\n")
}

/*
 * Re-prompts on unparseable input rather than defaulting, so a fat-fingered entry
 * never silently pairs the wrong chat. EOF (piped or closed stdin) cancels instead
 * of looping forever.
 */
async function promptChoice(
  sessions: SessionSummaryDto[],
  deps: CliDependencies,
): Promise<SessionSummaryDto | undefined> {
  deps.write(`\nChats in ${canonicalDirectory(deps.cwd)}:\n\n`)
  deps.write(`${renderPicker(sessions, Date.now())}\n\n`)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    deps.write(`Pair with [1-${sessions.length}]: `)
    const answer = (await deps.readLine())?.trim()
    if (answer === undefined) return undefined
    const choice = Number(answer)
    if (Number.isInteger(choice) && choice >= 1 && choice <= sessions.length) return sessions[choice - 1]
    deps.writeError(`Enter a number between 1 and ${sessions.length}.\n`)
  }
  return undefined
}

function friendly(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

function terminalSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
}

interface PairingDetails {
  pairingUrl: string
  session?: { id: string; title: string }
}

async function fetchSessions(
  descriptor: InstanceDescriptor,
  request: CliDependencies["fetch"],
): Promise<SessionSummaryDto[]> {
  let response: Response
  try {
    response = await request(`${descriptor.controlUrl}/sessions`, {
      method: "GET",
      headers: { authorization: `Bearer ${descriptor.controlToken}` },
    })
  } catch {
    throw new UnreachableError(`Could not connect to the opencode instance at ${descriptor.directory}.`)
  }
  if (!response.ok) throw new Error(await refusal(response, descriptor, "chat list"))
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error("The opencode instance returned an unreadable chat list.")
  }
  const sessions = (body as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(sessions)) throw new Error("The opencode instance returned a malformed chat list.")
  return sessions.filter(
    (entry): entry is SessionSummaryDto =>
      !!entry && typeof entry === "object" &&
      typeof (entry as SessionSummaryDto).id === "string" &&
      typeof (entry as SessionSummaryDto).title === "string" &&
      typeof (entry as SessionSummaryDto).updatedAt === "number",
  )
}

/** Prefers the server's own explanation so an unknown `--session` id reports why it was rejected. */
async function refusal(response: Response, descriptor: InstanceDescriptor, what: string): Promise<string> {
  const prefix = `The opencode instance at ${descriptor.directory} refused the ${what} request (HTTP ${response.status})`
  try {
    const message = ((await response.json()) as { error?: unknown } | null)?.error
    return typeof message === "string" && message.length > 0 ? `${prefix}: ${message}.` : `${prefix}.`
  } catch {
    return `${prefix}.`
  }
}

/** Requests pairing details. Throws `Error` with a user-safe message; never leaks the control token. */
async function requestPairing(
  descriptor: InstanceDescriptor,
  sessionID: string | undefined,
  advertisedHost: string | undefined,
  request: CliDependencies["fetch"],
): Promise<PairingDetails> {
  const requestBody = {
    ...(sessionID ? { sessionID } : {}),
    ...(advertisedHost ? { advertisedHost } : {}),
  }
  const hasBody = Object.keys(requestBody).length > 0
  let response: Response
  try {
    response = await request(`${descriptor.controlUrl}/pairing`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.controlToken}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(requestBody) } : {}),
    })
  } catch {
    throw new UnreachableError(`Could not connect to the opencode instance at ${descriptor.directory}.`)
  }
  if (!response.ok) throw new Error(await refusal(response, descriptor, "pairing"))
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error("The opencode instance returned an unreadable pairing response.")
  }
  const pairingUrl = (body as { pairingUrl?: unknown } | null)?.pairingUrl
  if (typeof pairingUrl !== "string" || pairingUrl.length === 0) {
    throw new Error("The opencode instance returned a pairing response without a URL.")
  }
  const session = (body as { session?: unknown } | null)?.session
  if (session && typeof session === "object") {
    const candidate = session as { id?: unknown; title?: unknown }
    if (typeof candidate.id === "string" && typeof candidate.title === "string") {
      return { pairingUrl, session: { id: candidate.id, title: candidate.title } }
    }
  }
  return { pairingUrl }
}

/** Marks the "descriptor is stale, sweep it and retry" path. */
class UnreachableError extends Error {}

const NO_INSTANCE = "No running opencode instance found. Start opencode with the entangle plugin enabled."

/*
 * Instances of one project share session storage. The serving process selects
 * and pins the latest root chat when it creates the pairing token.
 */
function mostRecent(candidates: InstanceDescriptor[]): InstanceDescriptor {
  return candidates.reduce((newest, candidate) =>
    candidate.updatedAt > newest.updatedAt ? candidate : newest,
  )
}

function resolveDependencies(overrides: Partial<CliDependencies>): CliDependencies {
  return {
    argv: overrides.argv ?? process.argv.slice(2),
    cwd: overrides.cwd ?? process.cwd(),
    instancesRoot: overrides.instancesRoot,
    listDescriptors: overrides.listDescriptors ?? defaultListDescriptors,
    removeDescriptor: overrides.removeDescriptor ?? defaultRemoveDescriptor,
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
    renderQr: overrides.renderQr ?? defaultRenderQr,
    install: overrides.install ?? defaultInstall,
    findTailscaleIpv4: overrides.findTailscaleIpv4 ?? defaultFindTailscaleIpv4,
    write: overrides.write ?? ((text) => process.stdout.write(text)),
    writeError: overrides.writeError ?? ((text) => process.stderr.write(text)),
    isInteractive: overrides.isInteractive ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true),
    readLine: overrides.readLine ?? defaultReadLine,
  }
}

async function defaultReadLine(): Promise<string | undefined> {
  for await (const line of console) return line
  return undefined
}

async function runInstall(argv: string[], deps: CliDependencies): Promise<number> {
  let flags: InstallFlags
  try {
    flags = parseInstallFlags(argv)
  } catch (error) {
    deps.writeError(`${friendly(error)}\n\n${INSTALL_USAGE}`)
    return EXIT_AMBIGUOUS
  }
  if (flags.help) {
    deps.write(INSTALL_USAGE)
    return EXIT_OK
  }
  try {
    const result = await deps.install({
      configPath: flags.configPath ? resolve(deps.cwd, flags.configPath) : undefined,
      installGlobal: flags.installGlobal,
    })
    if (result.globalInstalled) deps.write("Installed the entangle command globally.\n")
    deps.write(
      result.configChanged
        ? `Added @dualityinstitute/entangle to ${result.configPath}.\n`
        : `Entangle is already configured in ${result.configPath}.\n`,
    )
    deps.write("Restart OpenCode, then run entangle from the same project directory.\n")
    return EXIT_OK
  } catch (error) {
    deps.writeError(`Could not install entangle: ${friendly(error)}\n`)
    return EXIT_NO_INSTANCE
  }
}

/** Runs the CLI and returns the process exit code. Never throws, never prints a stack trace. */
export async function runCli(overrides: Partial<CliDependencies> = {}): Promise<number> {
  const deps = resolveDependencies(overrides)
  if (deps.argv[0] === "install") return runInstall(deps.argv.slice(1), deps)
  let flags: Flags
  try {
    flags = parseFlags(deps.argv)
  } catch (error) {
    deps.writeError(`${friendly(error)}\n\n${USAGE}`)
    return EXIT_AMBIGUOUS
  }

  if (flags.help) {
    deps.write(USAGE)
    return EXIT_OK
  }
  if (flags.unknown.length > 0) {
    deps.writeError(`Unknown argument: ${flags.unknown[0]}\n\n${USAGE}`)
    return EXIT_AMBIGUOUS
  }

  let descriptors: InstanceDescriptor[]
  try {
    descriptors = await deps.listDescriptors(deps.instancesRoot)
  } catch (error) {
    deps.writeError(`Could not read the entangle instance directory: ${friendly(error)}\n`)
    return EXIT_NO_INSTANCE
  }

  if (flags.list) {
    if (flags.json) {
      deps.write(
        `${JSON.stringify(
          descriptors.map(({ pid, directory, worktree, updatedAt }) => ({
            pid,
            directory,
            worktree,
            updatedAt,
          })),
        )}\n`,
      )
      return EXIT_OK
    }
    deps.write(descriptors.length === 0 ? "No running opencode instances.\n" : `${instanceTable(descriptors)}\n`)
    return EXIT_OK
  }

  if (descriptors.length === 0) {
    deps.writeError(`${NO_INSTANCE}\n`)
    return EXIT_NO_INSTANCE
  }

  const candidates = selectCandidates(descriptors, deps.cwd)
  let instance = mostRecent(candidates)
  if (candidates.length > 1 && !flags.json) {
    deps.writeError(
      `${candidates.length} opencode instances match ${canonicalDirectory(deps.cwd)}; using pid ${instance.pid}.\n` +
        "Instances of a project share the same chats, so this only picks the connection.\n",
    )
  }

  let sessionID = flags.session
  let advertisedHost: string | undefined
  if (flags.remote) {
    advertisedHost = await deps.findTailscaleIpv4() ?? undefined
    if (!advertisedHost) {
      deps.writeError(
        "No active Tailscale IPv4 address found. Connect this computer to Tailscale and try again.\n",
      )
      return EXIT_NO_INSTANCE
    }
  }
  if (sessionID === undefined && !flags.json && deps.isInteractive()) {
    const listed = await withSweep(instance, deps, (descriptor) => fetchSessions(descriptor, deps.fetch))
    if (listed === undefined) return EXIT_NO_INSTANCE
    instance = listed.descriptor
    if (listed.value.length > 1) {
      const picked = await promptChoice(listed.value.slice(0, PICKER_LIMIT), deps)
      if (picked === undefined) {
        deps.writeError("No chat selected.\n")
        return EXIT_AMBIGUOUS
      }
      sessionID = picked.id
    }
  }

  const paired = await withSweep(instance, deps, (descriptor) =>
    requestPairing(descriptor, sessionID, advertisedHost, deps.fetch),
  )
  if (paired === undefined) return EXIT_NO_INSTANCE
  const pairing = paired.value

  if (flags.json) {
    deps.write(`${JSON.stringify({ pairingUrl: pairing.pairingUrl })}\n`)
    return EXIT_OK
  }

  let qr: string
  const hint = flags.remote ? REMOTE_HINT : HINT
  try {
    qr = await deps.renderQr(pairing.pairingUrl)
  } catch {
    deps.writeError("Could not render the pairing QR code.\n")
    deps.write(`\n${pairing.pairingUrl}\n${hint}\n`)
    return EXIT_NO_INSTANCE
  }
  deps.write("\n")
  deps.write(qr.endsWith("\n") ? qr : `${qr}\n`)
  if (pairing.session) deps.write(`Session: ${terminalSafe(pairing.session.title) || "Untitled chat"}\n`)
  deps.write(`${pairing.pairingUrl}\n`)
  deps.write(`${hint}\n`)
  return EXIT_OK
}

/**
 * Runs `operation` against the chosen instance. If the instance turns out to be dead,
 * removes its stale descriptor, re-discovers once, and retries exactly once — reporting
 * which instance actually served the call so a later step reuses the same one.
 */
async function withSweep<T>(
  instance: InstanceDescriptor,
  deps: CliDependencies,
  operation: (descriptor: InstanceDescriptor) => Promise<T>,
): Promise<{ descriptor: InstanceDescriptor; value: T } | undefined> {
  try {
    return { descriptor: instance, value: await operation(instance) }
  } catch (error) {
    if (!(error instanceof UnreachableError)) {
      deps.writeError(`${friendly(error)}\n`)
      return undefined
    }
  }
  await deps.removeDescriptor({ directory: instance.directory, pid: instance.pid }, deps.instancesRoot).catch(() => {})
  let descriptors: InstanceDescriptor[] = []
  try {
    descriptors = await deps.listDescriptors(deps.instancesRoot)
  } catch {
    descriptors = []
  }
  const candidates = selectCandidates(
    descriptors.filter((entry) => entry.pid !== instance.pid || entry.directory !== instance.directory),
    deps.cwd,
  )
  if (candidates.length > 0) {
    const retry = mostRecent(candidates)
    try {
      return { descriptor: retry, value: await operation(retry) }
    } catch (error) {
      if (!(error instanceof UnreachableError)) {
        deps.writeError(`${friendly(error)}\n`)
        return undefined
      }
    }
  }
  deps.writeError(
    `The opencode instance at ${instance.directory} is no longer reachable, so its stale record was removed.\n` +
      `${NO_INSTANCE}\n`,
  )
  return undefined
}

if (import.meta.main) {
  process.exitCode = await runCli()
}
