import { describe, expect, test } from "bun:test"
import { MobileAuth } from "../src/server/auth"

const SESSION_ID = "ses_auth_fixture"
const request = (cookie: string, headers: Record<string, string> = {}) => new Request("http://entangle.test/", { headers: { cookie, ...headers } })

describe("MobileAuth", () => {
  test("pairing token is single-use", () => {
    const auth = new MobileAuth(1000)
    const pairing = auth.createPairing(SESSION_ID)
    expect(auth.consumePairing(pairing.token, "1.2.3.4").ok).toBe(true)
    expect(auth.consumePairing(pairing.token, "1.2.3.4")).toEqual({ ok: false, reason: "bad-token" })
  })

  test("pairing and authenticated cookie retain one immutable OpenCode session", () => {
    const auth = new MobileAuth(1000)
    const result = auth.consumePairing(auth.createPairing("ses_pinned").token, "a")
    if (!result.ok) throw new Error("pairing failed")

    expect(result.session.sessionID).toBe("ses_pinned")
    expect(auth.authenticate(request(auth.cookie(result.session.id, false)))?.sessionID).toBe("ses_pinned")
  })

  test("pairing token expires at TTL", () => {
    let now = 100
    const auth = new MobileAuth(50, 1000, () => now)
    const pairing = auth.createPairing(SESSION_ID)
    now = 151
    expect(auth.consumePairing(pairing.token, "a")).toEqual({ ok: false, reason: "bad-token" })
  })

  test("active session ids include live pairings and authenticated phones only", () => {
    let now = 100
    const auth = new MobileAuth(50, 1000, () => now)
    const paired = auth.createPairing("ses_phone")
    auth.createPairing("ses_unscanned")
    expect(auth.consumePairing(paired.token, "a").ok).toBe(true)
    expect(auth.activeSessionIDs()).toEqual(new Set(["ses_phone", "ses_unscanned"]))
    expect(auth.hasActiveSession("ses_unscanned")).toBe(true)

    now = 151
    expect(auth.activeSessionIDs()).toEqual(new Set(["ses_phone"]))
    expect(auth.hasActiveSession("ses_unscanned")).toBe(false)
  })

  test("onFirstPairing fires once, only on success, and a throwing hook still pairs", () => {
    const auth = new MobileAuth(1000)
    let calls = 0
    auth.onFirstPairing(() => {
      calls += 1
      throw new Error("toast unavailable")
    })

    expect(auth.consumePairing("wrong", "a").ok).toBe(false)
    expect(calls).toBe(0)
    expect(auth.consumePairing(auth.createPairing(SESSION_ID).token, "a").ok).toBe(true)
    expect(auth.consumePairing(auth.createPairing(SESSION_ID).token, "a").ok).toBe(true)
    expect(calls).toBe(1)
  })

  test("wrong token is rejected", () => {
    const auth = new MobileAuth(1000)
    auth.createPairing(SESSION_ID)
    expect(auth.consumePairing("wrong", "a")).toEqual({ ok: false, reason: "bad-token" })
  })

  test("rate limiting locks an IP after five failures", () => {
    const auth = new MobileAuth(1000)
    for (let i = 0; i < 5; i++) auth.consumePairing(`wrong-${i}`, "a")
    expect(auth.isRateLimited("a")).toBe(true)
    expect(auth.consumePairing("wrong-again", "a")).toEqual({ ok: false, reason: "rate-limited" })
  })

  test("rate lockout blocks a valid token", () => {
    const auth = new MobileAuth(1000)
    const pairing = auth.createPairing(SESSION_ID)
    for (let i = 0; i < 5; i++) auth.consumePairing(`wrong-${i}`, "a")
    expect(auth.consumePairing(pairing.token, "a")).toEqual({ ok: false, reason: "rate-limited" })
  })

  test("rate lockout resets after sixty seconds", () => {
    let now = 0
    const auth = new MobileAuth(100_000, 1000, () => now)
    const pairing = auth.createPairing(SESSION_ID)
    for (let i = 0; i < 5; i++) auth.consumePairing(`wrong-${i}`, "a")
    now = 60_000
    expect(auth.isRateLimited("a")).toBe(false)
    expect(auth.consumePairing(pairing.token, "a").ok).toBe(true)
  })

  test("successful pair resets the failure counter", () => {
    const auth = new MobileAuth(1000)
    auth.consumePairing("wrong", "a")
    const pairing = auth.createPairing(SESSION_ID)
    expect(auth.consumePairing(pairing.token, "a").ok).toBe(true)
    for (let i = 0; i < 4; i++) auth.consumePairing(`wrong-${i}`, "a")
    expect(auth.isRateLimited("a")).toBe(false)
  })

  test("CSRF mismatch is rejected", () => {
    const auth = new MobileAuth(1000)
    const result = auth.consumePairing(auth.createPairing(SESSION_ID).token, "a")
    if (!result.ok) throw new Error("pairing failed")
    const cookie = auth.cookie(result.session.id, false)
    expect(auth.authorizeMutation(request(cookie, { origin: "http://expected", "x-entangle-csrf": "wrong" }), "http://expected")).toBeUndefined()
  })

  test("cookie has exact entangle flags", () => {
    const auth = new MobileAuth(1000, 120_000)
    expect(auth.cookie("session", false)).toBe("entangle_session=session; Path=/; HttpOnly; SameSite=Strict; Max-Age=120")
  })
})
