#!/usr/bin/env bun
/*
 * entangle E2E — the phone half, against a REAL opencode instance and a real LLM.
 *
 * Nothing here is mocked: no FakeBridge, no stubbed EventSource, no seeded
 * transcript. Every assertion that can be checked on the server is checked on
 * the server, because this project has shipped four bugs where one side of a
 * seam looked correct while the seam itself was broken.
 *
 * Playwright is resolved from $E2E_PLAYWRIGHT (an out-of-tree install) so the
 * repo's package.json stays untouched.
 */
import { spawn } from "node:child_process"

const REPO = process.env.E2E_REPO ?? new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const SCRATCH = process.env.E2E_DIR ?? "/tmp/entangle-e2e"
const EVIDENCE = process.env.E2E_EVIDENCE ?? "/tmp/entangle-e2e-evidence"
const REPORT = process.env.E2E_REPORT ?? `${EVIDENCE}/entangle-e2e.txt`
const OC_URL = process.env.E2E_OC_URL ?? "http://127.0.0.1:41777"
const MODEL_ALT = process.env.E2E_MODEL_ALT ?? "deepseek/deepseek-chat"
const PAIRING_URL = process.env.E2E_PAIRING_URL ?? ""
const SESSION_ID = process.env.E2E_SESSION_ID ?? ""
const HEADLESS = process.env.E2E_HEADFUL !== "1"

/*
 * Playwright lives outside the repo, so it has no types here. These are the
 * only members this script touches; keeping them explicit is what lets
 * `bunx tsc --noEmit` stay strict instead of being relaxed for one file.
 */
interface ConsoleMessageLike { type(): string; text(): string }
interface CookieLike { name: string; httpOnly: boolean; sameSite: string }
interface ElementHandleLike { }
interface PageLike {
  on(event: string, handler: (payload: never) => void): void
  goto(url: string, options?: object): Promise<{ status(): number } | null>
  url(): string
  fill(selector: string, value: string): Promise<void>
  click(selector: string): Promise<void>
  textContent(selector: string): Promise<string | null>
  getAttribute(selector: string, name: string): Promise<string | null>
  screenshot(options: { path: string }): Promise<unknown>
  waitForSelector(selector: string, options?: object): Promise<ElementHandleLike | null>
  waitForFunction(fn: () => unknown, arg?: unknown, options?: object): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  evaluate<T>(fn: () => T): Promise<T>
  $$eval<T>(selector: string, fn: (nodes: Element[]) => T): Promise<T>
}
interface ContextLike {
  newPage(): Promise<PageLike>
  cookies(): Promise<CookieLike[]>
  close(): Promise<void>
}
interface BrowserLike { newContext(options: object): Promise<ContextLike>; close(): Promise<void> }
interface PlaywrightLike { chromium: { launch(options: object): Promise<BrowserLike> } }

type JsonRecord = Record<string, unknown>
type OpencodeMessage = { info: JsonRecord; parts: JsonRecord[] }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null
}

function opencodeMessages(value: unknown): OpencodeMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.info) || !Array.isArray(entry.parts)) return []
    return [{ info: entry.info, parts: entry.parts.filter(isRecord) }]
  })
}

const playwrightEntry = process.env.E2E_PLAYWRIGHT
  ?? `${process.env.E2E_TOOLS ?? "/tmp/entangle-e2e-tools"}/node_modules/playwright/index.js`
const { chromium } = (await import(playwrightEntry)) as PlaywrightLike

/* ------------------------------------------------------------- reporting -- */
const lines: string[] = []
let failures = 0
const say = (text: string) => { lines.push(text); console.log(text) }
const step = (text: string) => say(`\n=== ${text} ===`)
const pass = (text: string) => say(`PASS  ${text}`)
const note = (text: string) => say(`NOTE  ${text}`)
const fail = (text: string) => { failures += 1; say(`FAIL  ${text}`) }
const expect = (label: string, expected: unknown, actual: unknown) =>
  expected === actual
    ? pass(`${label} — got ${JSON.stringify(actual)}`)
    : fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

async function flush(): Promise<void> {
  const previous = await Bun.file(REPORT).text().catch(() => "")
  await Bun.write(REPORT, `${previous}${lines.join("\n")}\n`)
  lines.length = 0
}

/* ----------------------------------------------------- server-side oracle -- */
function sh(command: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Reads opencode's OWN message records for the session. UI state is not proof:
 * the picker can show `plan` while the prompt goes out with the old agent.
 */
async function lastUserMessage(): Promise<{ agent?: string; providerID?: string; modelID?: string; text?: string }> {
  const encoded = encodeURIComponent(SCRATCH)
  const response = await fetch(`${OC_URL}/session/${SESSION_ID}/message?directory=${encoded}&limit=200`, {
    headers: { "x-opencode-directory": encoded },
  })
  const page = opencodeMessages(await response.json())
  for (let index = page.length - 1; index >= 0; index -= 1) {
    const entry = page[index]
    if (entry?.info.role !== "user") continue
    const model = isRecord(entry.info.model) ? entry.info.model : undefined
    const text = entry.parts.find((part) => part.type === "text")?.text
    return {
      agent: typeof entry.info.agent === "string" ? entry.info.agent : undefined,
      providerID: typeof model?.providerID === "string" ? model.providerID : undefined,
      modelID: typeof model?.modelID === "string" ? model.modelID : undefined,
      text: typeof text === "string" ? text : undefined,
    }
  }
  return {}
}

/**
 * opencode's `/session/status` only lists sessions that are NOT idle, so an
 * absent entry is the authoritative "idle". Returns ms until that happens, or
 * -1 if it never did inside the budget window.
 */
async function sessionIdleAfter(since: number, budgetMs = 8_000): Promise<number> {
  const encoded = encodeURIComponent(SCRATCH)
  while (Date.now() - since < budgetMs) {
    const response = await fetch(`${OC_URL}/session/status?directory=${encoded}`, {
      headers: { "x-opencode-directory": encoded },
    })
    const statuses = (await response.json()) as Record<string, { type: string }>
    if ((statuses[SESSION_ID]?.type ?? "idle") === "idle") return Date.now() - since
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return -1
}

async function leftBusyAfter(since: number, budgetMs = 8_000): Promise<number> {
  while (Date.now() - since < budgetMs) {
    if ((await page.getAttribute('[data-testid="status-pill"]', "data-status")) !== "busy") {
      return Date.now() - since
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return -1
}

async function assistantTextSince(count: number): Promise<string> {
  const encoded = encodeURIComponent(SCRATCH)
  const response = await fetch(`${OC_URL}/session/${SESSION_ID}/message?directory=${encoded}&limit=200`, {
    headers: { "x-opencode-directory": encoded },
  })
  const page = opencodeMessages(await response.json())
  return page.slice(count)
    .filter((entry) => entry.info.role === "assistant")
    .flatMap((entry) => entry.parts
      .filter((part) => part.type === "text")
      .map((part) => typeof part.text === "string" ? part.text : ""))
    .join("\n")
}

/* ------------------------------------------------------------------ main -- */
if (!PAIRING_URL || !SESSION_ID) {
  console.error("E2E_PAIRING_URL and E2E_SESSION_ID are required")
  process.exit(2)
}

const browser = await chromium.launch({ headless: HEADLESS })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
})
const page = await context.newPage()
const consoleErrors: string[] = []
page.on("console", (message: ConsoleMessageLike) => {
  if (message.type() === "error") consoleErrors.push(message.text())
})
page.on("pageerror", (error: Error) => consoleErrors.push(`pageerror: ${error.message}`))

const shot = (name: string) => page.screenshot({ path: `${EVIDENCE}/entangle-${name}.png` })
const send = async (text: string) => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.click('[data-testid="send-button"]')
}
const waitStatus = async (want: string, timeout: number) => {
  await page.waitForSelector(`[data-testid="status-pill"][data-status="${want}"]`, { timeout })
}

try {
  /* ---------------------------------------------------------------- pair -- */
  step("4a. pairing — phone viewport 390x844 @3x, touch")
  say(`pairing url: ${PAIRING_URL}`)
  const response = await page.goto(PAIRING_URL, { waitUntil: "domcontentloaded" })
  expect("landing status after the 303 redirect", 200, response?.status())
  expect("redirected to the app root", "/", new URL(page.url()).pathname)
  await page.waitForSelector('[data-testid="app-shell"][data-connection="live"]', { timeout: 30_000 })
  pass("connection reached `live` (SSE open, state+messages+agents+providers hydrated)")
  const cookies = await context.cookies()
  const session = cookies.find((cookie: CookieLike) => cookie.name === "entangle_session")
  expect("entangle_session cookie is HttpOnly", true, session?.httpOnly)
  expect("entangle_session cookie is SameSite=Strict", "Strict", session?.sameSite)
  expect("no horizontal overflow at 390px", 390, await page.evaluate(() => document.documentElement.scrollWidth))
  const focusLayout = await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
    const composer = document.querySelector<HTMLElement>('[data-testid="composer"]')
    const meta = document.querySelector<HTMLElement>('.composer__meta')
    const row = document.querySelector<HTMLElement>('.composer__row')
    const send = document.querySelector<HTMLElement>('[data-testid="send-button"]')
    if (!input || !composer || !meta || !row || !send) return null
    input.focus()
    const composerRect = composer.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const inputRect = input.getBoundingClientRect()
    const sendRect = send.getBoundingClientRect()
    const expandedHit = [
      [sendRect.left - 1, sendRect.top + sendRect.height / 2],
      [sendRect.right + 1, sendRect.top + sendRect.height / 2],
      [sendRect.left + sendRect.width / 2, sendRect.top - 1],
      [sendRect.left + sendRect.width / 2, sendRect.bottom + 1],
    ].every(([x, y]) => document.elementFromPoint(x, y) === send)
    const result = {
      composerHeight: Math.round(composerRect.height),
      rowHeight: Math.round(rowRect.height),
      sendSize: Math.round(sendRect.width),
      centered: Math.abs(
        inputRect.top + inputRect.height / 2 - (rowRect.top + rowRect.height / 2),
      ) < 0.5,
      metaDisplay: getComputedStyle(meta).display,
      expandedHit,
    }
    input.blur()
    return { ...result, restoredMetaDisplay: getComputedStyle(meta).display }
  })
  expect("focused composer hides the picker rail", "none", focusLayout?.metaDisplay)
  expect("focused composer is compact", 55, focusLayout?.composerHeight)
  expect("focused input row is compact", 46, focusLayout?.rowHeight)
  expect("textarea is vertically centered", true, focusLayout?.centered)
  expect("visible send control is 40px", 40, focusLayout?.sendSize)
  expect("send control retains a 44px hit region", true, focusLayout?.expandedHit)
  expect("picker rail returns after blur", "flex", focusLayout?.restoredMetaDisplay)
  await shot("paired")

  /* --------------------------------------------------------------- prompt -- */
  step("4b. streaming reply from the real model")
  const before = await (async () => {
    const encoded = encodeURIComponent(SCRATCH)
    const r = await fetch(`${OC_URL}/session/${SESSION_ID}/message?directory=${encoded}&limit=200`, {
      headers: { "x-opencode-directory": encoded },
    })
    return ((await r.json()) as unknown[]).length
  })()
  await send("reply with exactly: pong")
  await waitStatus("busy", 20_000)
  pass("status pill went busy — the 204/202 fire-and-forget send reached the bridge")
  await shot("streaming")
  await page.waitForFunction(
    () => /pong/i.test(document.querySelectorAll('[data-testid="message-assistant"]')[
      document.querySelectorAll('[data-testid="message-assistant"]').length - 1
    ]?.textContent ?? ""),
    undefined,
    { timeout: 90_000 },
  )
  pass("the streamed assistant reply containing `pong` rendered on the phone")
  await waitStatus("idle", 60_000)
  const serverText = await assistantTextSince(before)
  expect("opencode's own record of the reply contains `pong`", true, /pong/i.test(serverText))

  /* --------------------------------------------------------- agent switch -- */
  step("4c. agent switch — verified in opencode's message records")
  await page.click('[data-testid="agent-chip"]')
  await page.waitForSelector('[data-testid="agent-modal"]', { timeout: 10_000 })
  await shot("agent")
  const agentOptions = await page.$$eval('[data-testid="agent-option"]', (nodes: Element[]) =>
    nodes.map((node: Element) => node.getAttribute("data-agent") ?? ""))
  say(`agents offered: ${agentOptions.join(", ")}`)
  expect("`plan` is offered by the picker", true, agentOptions.includes("plan"))
  await page.click('[data-testid="agent-option"][data-agent="plan"]')
  await page.waitForSelector('[data-testid="agent-modal"]', { state: "hidden", timeout: 10_000 })
  expect("agent chip now reads plan", "plan", await page.getAttribute('[data-testid="agent-chip"]', "data-agent"))
  await send("say ok")
  await waitStatus("busy", 20_000)
  await waitStatus("idle", 90_000)
  const afterAgent = await lastUserMessage()
  say(`server record: ${JSON.stringify(afterAgent)}`)
  expect("SERVER-SIDE: last user message .info.agent", "plan", afterAgent.agent)

  /* --------------------------------------------------------- model switch -- */
  step("4d. model switch — verified in opencode's message records")
  const [wantProvider, wantModel] = MODEL_ALT.split("/")
  await page.click('[data-testid="model-chip"]')
  await page.waitForSelector('[data-testid="model-modal"]', { timeout: 10_000 })
  await page.click(`[data-testid="model-option"][data-model="${MODEL_ALT}"]`)
  await page.waitForSelector('[data-testid="model-modal"]', { state: "hidden", timeout: 10_000 })
  expect("model chip now reads the new model", MODEL_ALT,
    await page.getAttribute('[data-testid="model-chip"]', "data-model"))
  await send("say ok")
  await waitStatus("busy", 20_000)
  await waitStatus("idle", 90_000)
  const afterModel = await lastUserMessage()
  say(`server record: ${JSON.stringify(afterModel)}`)
  expect("SERVER-SIDE: last user message .info.model.providerID", wantProvider, afterModel.providerID)
  expect("SERVER-SIDE: last user message .info.model.modelID", wantModel, afterModel.modelID)

  /* ---------------------------------------------------------------- abort -- */
  step("4e. abort — a running turn must return to idle within 3s")
  await send("Count from 1 to 400. One number per line. No other text at all.")
  await waitStatus("busy", 20_000)
  await page.waitForTimeout(1_500)
  const abortStart = Date.now()
  await page.click('[data-testid="abort-button"]')
  const [idleMs, offBusyMs] = await Promise.all([sessionIdleAfter(abortStart), leftBusyAfter(abortStart)])
  say(`abort -> opencode reports the session idle in ${idleMs}ms; phone leaves busy in ${offBusyMs}ms`)
  if (idleMs >= 0 && idleMs <= 3_000)
    pass(`SERVER-SIDE: /session/status stopped listing the session as busy ${idleMs}ms after the tap`)
  else fail(`SERVER-SIDE: session was still busy after ${idleMs}ms, budget is 3000ms`)
  if (offBusyMs >= 0 && offBusyMs <= 3_000) pass(`the phone left the busy state in ${offBusyMs}ms`)
  else fail(`the phone was still busy after ${offBusyMs}ms, budget is 3000ms`)
  const restingStatus = await page.getAttribute('[data-testid="status-pill"]', "data-status")
  const banner = await page.textContent('[data-testid="error-banner"]').catch(() => null)
  say(`resting pill: data-status=${restingStatus}  banner=${JSON.stringify(banner)}`)
  note("an aborted turn resolves as opencode's MessageAbortedError, so the pill")
  note("rests on `error` with App.tsx's describeError() mapping it to \"the turn")
  note("was stopped\" — deliberate (App.tsx:61), not a hung session.")
  expect("abort is surfaced as a stopped turn, not a raw stack trace", true,
    (banner ?? "").includes("the turn was stopped"))
  await page.click('[data-testid="error-dismiss"]')
  await waitStatus("idle", 10_000)
  pass("dismissing the banner returns the pill to idle")

  /* ----------------------------------------------------------- permission -- */
  step("5. permission — scratch opencode.json sets {\"bash\": \"ask\"}")
  await page.click('[data-testid="agent-chip"]')
  await page.waitForSelector('[data-testid="agent-modal"]', { timeout: 10_000 })
  const toolAgent = agentOptions.find((name: string) => name !== "" && name !== "plan") ?? "plan"
  await page.click(`[data-testid="agent-option"][data-agent="${toolAgent}"]`)
  await page.waitForSelector('[data-testid="agent-modal"]', { state: "hidden", timeout: 10_000 })
  say(`permission prompt runs under agent: ${toolAgent}`)
  await send("Use the bash tool right now to run exactly this command and nothing else: echo entangle-permission-ok")
  const modal = await page.waitForSelector('[data-testid="permission-modal"]', { timeout: 120_000 }).catch(() => null)
  if (!modal) {
    fail("no permission popup appeared within 120s — the model never called bash")
  } else {
    pass("permission popup appeared on the phone")
    await shot("permission")
    expect("composer is disabled while a permission is pending", "true",
      await page.getAttribute('[data-testid="composer"]', "data-disabled"))
    const actionRow = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLElement>(".permission__button")]
      const boxes = buttons.map((button) => button.getBoundingClientRect())
      return {
        count: buttons.length,
        rows: new Set(boxes.map((box) => Math.round(box.top))).size,
        minHeight: Math.round(Math.min(...boxes.map((box) => box.height))),
        clipped: buttons.some((button) => button.scrollWidth > button.clientWidth + 1),
      }
    })
    expect("all three permission actions render", 3, actionRow.count)
    expect("permission actions share one row", 1, actionRow.rows)
    expect("permission actions keep a 44px touch height", true, actionRow.minHeight >= 44)
    expect("permission action labels are not clipped", false, actionRow.clipped)
    const modalText = (await page.textContent('[data-testid="permission-modal"]')) ?? ""
    say(`popup title: ${modalText.slice(0, 160).replace(/\s+/g, " ").trim()}`)
    await page.click('[data-testid="perm-once"]')
    await page.waitForSelector('[data-testid="permission-modal"]', { state: "hidden", timeout: 15_000 })
    pass("`Allow once` dismissed the popup")
    await waitStatus("idle", 120_000)
    const transcript = (await page.textContent('[data-testid="transcript"]')) ?? ""
    expect("the approved command's output reached the phone transcript", true,
      transcript.includes("entangle-permission-ok"))
  }

  /* ------------------------------------------------------------ lifecycle -- */
  step("6. lifecycle — SIGINT, sweep, restart (delegated to lifecycle.sh)")
  await flush()
  const lifecycle = await sh("bash", [`${REPO}/tests/e2e/lifecycle.sh`])
  process.stdout.write(lifecycle.stdout)
  if (lifecycle.stderr.trim()) process.stderr.write(lifecycle.stderr)
  if (lifecycle.code !== 0) fail(`lifecycle.sh exited ${lifecycle.code}`)
  else pass("lifecycle.sh completed")

  step("7. the phone reacts to the restart")
  const result = JSON.parse(await Bun.file(`${SCRATCH}/lifecycle.json`).text())
  say(`lifecycle: ${JSON.stringify(result)}`)
  const unpaired = await page.waitForSelector('[data-testid="unpaired"]', { timeout: 90_000 }).catch(() => null)
  if (unpaired) {
    pass("phone reached the unpaired screen (stale in-memory session rejected with 401)")
    await shot("unpaired")
    const navigations = await page.evaluate(() => performance.getEntriesByType("navigation").length)
    expect("no reload loop — exactly one navigation for the whole run", 1, navigations)
  } else {
    fail("phone never showed the unpaired screen after the restart")
    await shot("unpaired")
  }

  step("console hygiene")
  const ignorable = consoleErrors.filter((text) => !/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_INCOMPLETE|net::/i.test(text))
  say(`console errors: ${consoleErrors.length} total, ${ignorable.length} unrelated to the deliberate shutdown`)
  for (const text of ignorable) say(`  ${text}`)
  expect("no console errors beyond the deliberate server shutdown", 0, ignorable.length)
} catch (error) {
  fail(`unhandled: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
  await shot("failure").catch(() => {})
} finally {
  await flush()
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}

note(`browser failures: ${failures}`)
await flush()
process.exit(failures === 0 ? 0 : 1)
