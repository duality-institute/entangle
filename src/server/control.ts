import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { InstanceDescriptor, SessionSummaryDto } from "../shared/protocol"
import { instancesDirectory, removeDescriptor, writeDescriptor } from "./descriptor"
import { isIpv4Address } from "./lan"

/** What the plugin hands back after lazily starting the mobile server and minting a pairing token. */
interface ControlPairing {
  pairingUrl: string
  expiresAt?: number
  session: { id: string; title: string }
}

/** Raised when the caller asks to pin a chat that is not a root session of this project. */
export class UnknownSessionError extends Error {}

export interface ControlServerOptions {
  /** Directory the opencode instance was launched in — the descriptor key. */
  directory: string
  worktree: string
  /** Lazy-starts the MobileServer if needed, then mints a fresh single-use pairing token. */
  requestPairing: (sessionID?: string, advertisedHost?: string) => Promise<ControlPairing> | ControlPairing
  listSessions: () => Promise<SessionSummaryDto[]> | SessionSummaryDto[]
  isMobileRunning?: () => boolean
  /** Test seam; defaults to `$XDG_STATE_HOME/entangle/instances`. */
  instancesDir?: string
}

interface PairingResponse {
  pairingUrl: string
  mobileServerListening: boolean
  session: { id: string; title: string }
  expiresAt?: number
}

interface InfoResponse {
  pid: number
  directory: string
  worktree: string
  mobileRunning: boolean
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

/** Constant-time compare of two arbitrary-length strings (hash first, never compare raw). */
function secureEqual(left: string, right: string): boolean {
  const a = digest(left)
  const b = digest(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

type PairingBody = { ok: true; sessionID?: string; advertisedHost?: string } | { ok: false }

/*
 * An absent body means "no preference — pin the latest chat", preserving the
 * pre-picker contract. A body that is present but malformed is rejected rather
 * than silently falling back, so a caller never gets a chat it did not ask for.
 */
async function requestedPairing(request: Request): Promise<PairingBody> {
  const raw = await request.text().catch(() => "")
  if (raw.trim().length === 0) return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false }
  const value = (parsed as { sessionID?: unknown }).sessionID
  const advertisedHost = (parsed as { advertisedHost?: unknown }).advertisedHost
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) return { ok: false }
  if (advertisedHost !== undefined && (typeof advertisedHost !== "string" || !isIpv4Address(advertisedHost))) {
    return { ok: false }
  }
  return {
    ok: true,
    ...(typeof value === "string" ? { sessionID: value } : {}),
    ...(typeof advertisedHost === "string" ? { advertisedHost } : {}),
  }
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  const [scheme, ...rest] = header.split(" ")
  if (scheme?.toLowerCase() !== "bearer") return undefined
  const value = rest.join(" ").trim()
  return value.length > 0 ? value : undefined
}

/**
 * Localhost-only IPC surface for the standalone `entangle` CLI.
 * Never bound to anything but 127.0.0.1 — the LAN-facing server is a separate component.
 */
export class ControlServer {
  private server: ReturnType<typeof Bun.serve> | undefined
  private readonly token = randomBytes(32).toString("base64url")
  private readonly root: string

  constructor(private readonly options: ControlServerOptions) {
    this.root = options.instancesDir ?? instancesDirectory()
  }

  get url(): string {
    return this.server ? `http://127.0.0.1:${this.server.port}` : ""
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    })
    await writeDescriptor(this.descriptor(), this.root)
  }

  async stop(): Promise<void> {
    await this.server?.stop(true)
    this.server = undefined
    await removeDescriptor({ directory: this.options.directory, pid: process.pid }, this.root)
  }

  private descriptor(): InstanceDescriptor {
    return {
      version: 1,
      pid: process.pid,
      directory: this.options.directory,
      worktree: this.options.worktree,
      controlUrl: this.url,
      controlToken: this.token,
      updatedAt: Date.now(),
    }
  }

  private async handle(request: Request): Promise<Response> {
    const supplied = bearer(request)
    if (!supplied || !secureEqual(supplied, this.token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    const { pathname } = new URL(request.url)
    if (pathname === "/pairing") {
      if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 })
      const body = await requestedPairing(request)
      if (!body.ok) return Response.json({ error: "invalid pairing request body" }, { status: 400 })
      return this.pair(body.sessionID, body.advertisedHost)
    }
    if (pathname === "/sessions") {
      if (request.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })
      return this.sessions()
    }
    if (pathname === "/info") {
      if (request.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })
      return Response.json(this.info())
    }
    return Response.json({ error: "not found" }, { status: 404 })
  }

  private async sessions(): Promise<Response> {
    try {
      return Response.json({ sessions: await this.options.listSessions() })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
    }
  }

  private async pair(sessionID?: string, advertisedHost?: string): Promise<Response> {
    let pairing: ControlPairing
    try {
      pairing = await this.options.requestPairing(sessionID, advertisedHost)
    } catch (error) {
      const status = error instanceof UnknownSessionError ? 400 : 500
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
    }
    const body: PairingResponse = {
      pairingUrl: pairing.pairingUrl,
      mobileServerListening: this.options.isMobileRunning?.() ?? true,
      session: pairing.session,
    }
    if (pairing.expiresAt !== undefined) body.expiresAt = pairing.expiresAt
    return Response.json(body)
  }

  private info(): InfoResponse {
    return {
      pid: process.pid,
      directory: this.options.directory,
      worktree: this.options.worktree,
      mobileRunning: this.options.isMobileRunning?.() ?? false,
    }
  }
}
