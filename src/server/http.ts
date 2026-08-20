import type { Bridge, EntangleOptions, SessionInfoDto, SseFrame } from "../shared/protocol"
import { PermissionReply, PromptRequest } from "../shared/protocol"
import type { MobileAuth } from "./auth"
import { EventHub, sseStream } from "./events"
import { firstLanAddress } from "./lan"

export type MobileEvent = Pick<SseFrame, "sessionID" | "event" | "data">

interface MobileServerDependencies {
  bridge: Bridge
  auth: MobileAuth
  events: EventHub<MobileEvent>
  options?: Partial<EntangleOptions>
  reportError?: (message: string, error: unknown) => void
}

const PAGE_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } })
}

function extension(path: string): string {
  const index = path.lastIndexOf(".")
  return index < 0 ? "" : path.slice(index).toLowerCase()
}

function safeAsset(pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const asset = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "")
  if (!asset || asset.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined
  return asset
}

export class MobileServer {
  private server: ReturnType<typeof Bun.serve> | undefined
  private unsubscribeBridge: (() => void) | undefined
  private readonly host: string
  private readonly requestedPort: number
  private lanAddress: string | null = null
  private readonly additionalHosts = new Set<string>()

  constructor(private readonly dependencies: MobileServerDependencies) {
    this.host = dependencies.options?.host ?? "0.0.0.0"
    this.requestedPort = dependencies.options?.port ?? 0
  }

  get listening(): boolean {
    return this.server !== undefined
  }

  get origin(): string {
    return this.originFor()
  }

  originFor(advertisedHost?: string): string {
    if (!this.server) return ""
    if (advertisedHost) this.additionalHosts.add(advertisedHost)
    return `http://${advertisedHost ?? this.advertisedHost()}:${this.server.port}`
  }

  async start(): Promise<void> {
    if (this.server) return
    this.lanAddress = firstLanAddress()
    this.server = Bun.serve({
      hostname: this.host,
      port: this.requestedPort,
      idleTimeout: 0,
      development: false,
      fetch: async (request, server) => {
        try {
          return await this.handle(request, server.requestIP(request)?.address ?? "unknown")
        } catch (error) {
          return this.internalError(error)
        }
      },
      error: (error) => this.internalError(error),
    })
    this.unsubscribeBridge = this.dependencies.bridge.onEvent((frame) => {
      if (!this.dependencies.auth.hasActiveSession(frame.sessionID)) return
      // Bridge ids are deliberately discarded. EventLog owns the replay/wire sequence.
      this.dependencies.events.publish(frame.sessionID, {
        sessionID: frame.sessionID,
        event: frame.event,
        data: frame.data,
      })
    })
  }

  async stop(): Promise<void> {
    this.unsubscribeBridge?.()
    this.unsubscribeBridge = undefined
    await this.server?.stop(true)
    this.server = undefined
    this.additionalHosts.clear()
  }

  private advertisedHost(): string {
    return this.lanAddress ?? this.host
  }

  private actualPort(): number {
    const port = this.server?.port
    if (port === undefined) throw new Error("Mobile server is not listening")
    return port
  }

  private allowedHost(host: string | null): boolean {
    if (!this.server || !host) return false
    const port = this.actualPort()
    const allowed = new Set([this.host, this.lanAddress, "127.0.0.1", "localhost", ...this.additionalHosts]
      .filter((value): value is string => value !== null)
      .map((value) => `${value.toLowerCase()}:${port}`))
    return allowed.has(host.toLowerCase())
  }

  private async handle(request: Request, sourceIp: string): Promise<Response> {
    if (!this.allowedHost(request.headers.get("host"))) return json({ error: "forbidden host" }, 403)

    const url = new URL(request.url)
    if (url.pathname === "/pair" && request.method === "GET") return this.pair(url, sourceIp)

    if (url.pathname.startsWith("/api/")) return this.api(request, url)
    if (request.method !== "GET") return json({ error: "not found" }, 404)
    return this.staticAsset(url.pathname)
  }

  private pair(url: URL, sourceIp: string): Response {
    const result = this.dependencies.auth.consumePairing(url.searchParams.get("token") ?? "", sourceIp)
    if (!result.ok) {
      return json({ error: result.reason }, result.reason === "rate-limited" ? 429 : 401)
    }
    this.dependencies.events.retain(this.dependencies.auth.activeSessionIDs())
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": this.dependencies.auth.cookie(result.session.id, url.protocol === "https:"),
        "Referrer-Policy": "no-referrer",
      },
    })
  }

  private async api(request: Request, url: URL): Promise<Response> {
    this.dependencies.events.retain(this.dependencies.auth.activeSessionIDs())
    const session = this.dependencies.auth.authenticate(request)
    if (!session) return json({ error: "pairing required" }, 401)

    if (request.method === "GET") {
      if (url.pathname === "/api/state") {
        let info: SessionInfoDto
        try {
          info = await this.dependencies.bridge.getSession(session.sessionID)
        } catch {
          return json({ error: "paired chat is no longer available; scan a fresh QR code" }, 410)
        }
        const current = await this.dependencies.bridge.currentAgentModel(session.sessionID)
        const lastEventId = this.dependencies.events.channel(session.sessionID).log.currentId
        return json({ csrf: session.csrf, session: info, ...current, lastEventId })
      }
      if (url.pathname === "/api/messages") {
        return json(await this.dependencies.bridge.getMessages(
          session.sessionID,
          url.searchParams.get("cursor") ?? undefined,
        ))
      }
      if (url.pathname === "/api/agents") return json(await this.dependencies.bridge.listAgents())
      if (url.pathname === "/api/providers") return json(await this.dependencies.bridge.listProviders())
      if (url.pathname === "/api/events") {
        const channel = this.dependencies.events.channel(session.sessionID)
        return new Response(sseStream(request, channel.log, channel), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        })
      }
      return json({ error: "not found" }, 404)
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
    const authorized = this.dependencies.auth.authorizeMutation(request, url.origin)
    if (!authorized) return json({ error: "forbidden" }, 403)
    if (request.headers.get("x-entangle-session") !== authorized.sessionID) {
      return json({ error: "session binding changed; reload before retrying" }, 409)
    }

    if (url.pathname === "/api/prompt") {
      const body = await this.validatedBody(request, PromptRequest)
      if (body instanceof Response) return body
      await this.dependencies.bridge.sendPrompt(authorized.sessionID, body)
      return json({ accepted: true }, 202)
    }
    if (url.pathname === "/api/abort") {
      // "nothing was running" is a success and must never fail; a bridge that
      // truly failed must not share its response, or stop dies silently.
      try {
        const info = await this.dependencies.bridge.getSession(authorized.sessionID)
        if (info.status.type === "idle") return json({ aborted: false })
      } catch (error) {
        return this.operationError("abort", error)
      }
      try {
        await this.dependencies.bridge.abort(authorized.sessionID)
      } catch (error) {
        return this.operationError("abort", error)
      }
      return json({ aborted: true })
    }
    const permission = url.pathname.match(/^\/api\/permissions\/([^/]+)$/)
    if (permission) {
      const body = await this.validatedBody(request, PermissionReply)
      if (body instanceof Response) return body
      await this.dependencies.bridge.respondPermission(
        authorized.sessionID,
        decodeURIComponent(permission[1]!),
        body,
      )
      return json({ ok: true })
    }
    return json({ error: "not found" }, 404)
  }

  private operationError(operation: string, error: unknown): Response {
    this.reportError(`Entangle ${operation} failed`, error)
    return json({ error: `${operation} failed` }, 502)
  }

  private internalError(error: unknown): Response {
    this.reportError("Entangle mobile server request failed", error)
    return json({ error: "internal server error" }, 500)
  }

  private reportError(message: string, error: unknown): void {
    if (this.dependencies.reportError) this.dependencies.reportError(message, error)
    else console.error(message, error)
  }

  private async validatedBody<T>(request: Request, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T | Response> {
    let value: unknown
    try {
      value = await request.json()
    } catch {
      return json({ error: "invalid request" }, 400)
    }
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : json({ error: "invalid request" }, 400)
  }

  private async staticAsset(pathname: string): Promise<Response> {
    const asset = safeAsset(pathname)
    if (!asset) return json({ error: "not found" }, 404)
    const encodedAsset = asset.split("/").map(encodeURIComponent).join("/")
    const candidates = [
      new URL(`./ui/${encodedAsset}`, import.meta.url),
      new URL(`../../dist/ui/${encodedAsset}`, import.meta.url),
    ]
    for (const candidate of candidates) {
      const file = Bun.file(candidate)
      if (!await file.exists()) continue
      const contentType = CONTENT_TYPES[extension(asset)] ?? (file.type || "application/octet-stream")
      const headers: Record<string, string> = { "Content-Type": contentType }
      if (extension(asset) === ".html") Object.assign(headers, PAGE_SECURITY_HEADERS)
      return new Response(file, { headers })
    }
    const headers = pathname === "/" ? { ...PAGE_SECURITY_HEADERS } : undefined
    return new Response(`UI asset not found: ${asset}. Run bun run build:ui.`, { status: 404, headers })
  }
}
