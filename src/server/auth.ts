import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

interface PairingRecord {
  hash: Buffer
  expiresAt: number
  sessionID: string
}

interface SessionRecord {
  csrf: string
  expiresAt: number
  sessionID: string
}

interface RateRecord {
  failures: number[]
  lockedUntil: number
}

export interface AuthenticatedSession { id: string; csrf: string; sessionID: string }
type PairingFailure = "bad-token" | "rate-limited"
type PairingResult =
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; reason: PairingFailure }

const RATE_WINDOW_MS = 60_000
const MAX_FAILURES = 5

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

function cookies(request: Request): Map<string, string> {
  const entries = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((entry) => entry.trim().split("=", 2))
    .filter((entry): entry is [string, string] => entry.length === 2)
  return new Map(entries)
}

export class MobileAuth {
  private readonly pairings = new Map<string, PairingRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly rates = new Map<string, RateRecord>()
  private firstPairing: (() => void) | undefined
  private paired = false

  constructor(
    private readonly pairingTtlMs: number,
    private readonly sessionTtlMs = 30 * 24 * 60 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Runs once, after the first phone pairs. A throwing hook must not fail the pairing. */
  onFirstPairing(callback: () => void): void {
    this.firstPairing = callback
  }

  createPairing(sessionID: string): { token: string; expiresAt: number } {
    this.prune()
    const value = token()
    const expiresAt = this.now() + this.pairingTtlMs
    this.pairings.set(randomUUID(), { hash: hash(value), expiresAt, sessionID })
    return { token: value, expiresAt }
  }

  consumePairing(value: string, sourceIp = "unknown"): PairingResult {
    this.prune()
    if (this.isRateLimited(sourceIp)) return { ok: false, reason: "rate-limited" }
    const supplied = hash(value)
    for (const [id, pairing] of this.pairings) {
      if (pairing.hash.length === supplied.length && timingSafeEqual(pairing.hash, supplied)) {
        this.pairings.delete(id)
        this.rates.delete(sourceIp)
        const session = { id: token(), csrf: token(24), sessionID: pairing.sessionID }
        this.sessions.set(hash(session.id).toString("hex"), {
          csrf: session.csrf,
          expiresAt: this.now() + this.sessionTtlMs,
          sessionID: session.sessionID,
        })
        this.announceFirstPairing()
        return { ok: true, session }
      }
    }
    const rate = this.rates.get(sourceIp) ?? { failures: [], lockedUntil: 0 }
    rate.failures.push(this.now())
    if (rate.failures.length >= MAX_FAILURES) rate.lockedUntil = this.now() + RATE_WINDOW_MS
    this.rates.set(sourceIp, rate)
    return rate.lockedUntil > this.now() ? { ok: false, reason: "rate-limited" } : { ok: false, reason: "bad-token" }
  }

  isRateLimited(sourceIp: string): boolean {
    const rate = this.rates.get(sourceIp)
    return !!rate && rate.lockedUntil > this.now()
  }

  activeSessionIDs(): Set<string> {
    this.prune()
    const ids = new Set<string>()
    for (const record of this.pairings.values()) ids.add(record.sessionID)
    for (const record of this.sessions.values()) ids.add(record.sessionID)
    return ids
  }

  hasActiveSession(sessionID: string): boolean {
    this.prune()
    for (const record of this.pairings.values()) if (record.sessionID === sessionID) return true
    for (const record of this.sessions.values()) if (record.sessionID === sessionID) return true
    return false
  }

  authenticate(request: Request): AuthenticatedSession | undefined {
    this.prune()
    const id = cookies(request).get("entangle_session")
    if (!id) return undefined
    const record = this.sessions.get(hash(id).toString("hex"))
    return record ? { id, csrf: record.csrf, sessionID: record.sessionID } : undefined
  }

  authorizeMutation(request: Request, expectedOrigin: string): AuthenticatedSession | undefined {
    const session = this.authenticate(request)
    if (!session || request.headers.get("origin") !== expectedOrigin) return undefined
    const csrf = request.headers.get("x-entangle-csrf")
    if (!csrf) return undefined
    const expected = hash(session.csrf)
    const supplied = hash(csrf)
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined
    return session
  }

  cookie(sessionId: string, secure: boolean): string {
    return [
      `entangle_session=${sessionId}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ")
  }

  private announceFirstPairing(): void {
    if (this.paired) return
    this.paired = true
    try {
      this.firstPairing?.()
    } catch {
      return
    }
  }

  private prune(): void {
    const time = this.now()
    for (const [id, record] of this.pairings) if (record.expiresAt <= time) this.pairings.delete(id)
    for (const [id, record] of this.sessions) if (record.expiresAt <= time) this.sessions.delete(id)
    for (const [ip, rate] of this.rates) {
      rate.failures = rate.failures.filter((failure) => failure > time - RATE_WINDOW_MS)
      if (rate.lockedUntil <= time && rate.failures.length === 0) this.rates.delete(ip)
    }
  }
}
