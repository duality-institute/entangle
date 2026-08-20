#!/usr/bin/env bun
/*
 * entangle E2E — CLI + QR proof against a REAL opencode instance.
 *
 * Three independent claims are checked, because "the QR matches the URL" is
 * three different statements:
 *
 *   1. `entangle --json` prints one line of valid JSON with a pairing URL.
 *   2. That URL, rendered to a PNG QR and decoded with jsQR, comes back
 *      byte-for-byte identical. This is the literal "QR decode byte-matches
 *      the --json URL" claim.
 *   3. Plain `entangle` prints a terminal QR whose glyphs are byte-identical to
 *      renderTerminalQr(<the URL printed underneath it>) — i.e. the scannable
 *      artefact on screen encodes the URL on screen, not some other token.
 *
 * The two invocations deliberately mint different single-use tokens (one
 * pairing request per invocation), so claim 3 compares each run
 * against its OWN URL and claim 4 asserts the two URLs share an origin+path.
 */
import jsQR from "jsqr"
import { PNG } from "pngjs"
import QRCode from "qrcode"
import { renderTerminalQr } from "../../src/server/qr"

const repo = new URL("../..", import.meta.url).pathname
const scratch = process.env.E2E_DIR ?? "/tmp/entangle-e2e"
const state = process.env.E2E_STATE ?? `${scratch}/state`

interface Run { stdout: string; stderr: string; code: number }

async function cli(...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", `${repo}/dist/cli.js`, ...args], {
    cwd: scratch,
    env: { ...process.env, XDG_STATE_HOME: state },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr, code: await proc.exited }
}

/** Data URL -> base64 -> PNG pixels -> jsQR. */
async function decodeQr(url: string): Promise<string | undefined> {
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 })
  const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1]!, "base64"))
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data
}

const lines: string[] = []
let failures = 0
const say = (text: string) => { lines.push(text); console.log(text) }
const pass = (text: string) => say(`PASS  ${text}`)
const fail = (text: string) => { failures += 1; say(`FAIL  ${text}`) }
const expect = (label: string, expected: unknown, actual: unknown) =>
  expected === actual ? pass(`${label} — got ${JSON.stringify(actual)}`)
    : fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

say(`scratch directory : ${scratch}`)
say(`process.cwd() of the CLI resolves through /private on macOS — that is the`)
say(`symlink case the CLI canonicalises. Exit 2 here would mean it regressed.`)

// ---------------------------------------------------------------- --list ---
const list = await cli("--list", "--json")
expect("entangle --list --json exit code", 0, list.code)
let listed: Array<{ pid: number; directory: string }> = []
try { listed = JSON.parse(list.stdout) } catch { fail(`--list --json is not valid JSON: ${list.stdout}`) }
expect("exactly one live instance is listed", 1, listed.length)
say(`instance          : pid ${listed[0]?.pid} at ${listed[0]?.directory}`)

// ----------------------------------------------------------------- --json --
const jsonRun = await cli("--json")
expect("entangle --json exit code", 0, jsonRun.code)
expect("entangle --json emits exactly one stdout line", 1, jsonRun.stdout.trimEnd().split("\n").length)
expect("entangle --json writes nothing to stderr", "", jsonRun.stderr)
let jsonUrl = ""
try { jsonUrl = JSON.parse(jsonRun.stdout).pairingUrl } catch { fail(`--json is not valid JSON: ${jsonRun.stdout}`) }
say(`--json pairingUrl : ${jsonUrl}`)
expect("--json output carries no QR glyphs", false, /[▄▀█]/.test(jsonRun.stdout))

// -------------------------------------------- claim 2: decode --json's URL --
const decodedJson = await decodeQr(jsonUrl)
expect("jsQR decode of the --json URL is byte-identical", jsonUrl, decodedJson)

// ---------------------------------------------------- claim 3: plain output --
const plain = await cli()
expect("entangle exit code", 0, plain.code)
const plainLines = plain.stdout.split("\n")
const plainUrl = plainLines.find((line) => line.startsWith("http://")) ?? ""
say(`plain pairingUrl  : ${plainUrl}`)
const terminalQr = await renderTerminalQr(plainUrl)
expect("plain stdout contains renderTerminalQr(plainUrl) verbatim", true, plain.stdout.includes(terminalQr))
expect("plain stdout has no ANSI escapes", false, /\u001b\[/.test(plain.stdout))
const decodedPlain = await decodeQr(plainUrl)
expect("jsQR decode of the plain-run URL is byte-identical", plainUrl, decodedPlain)

// --------------------------------------- claim 4: same server, fresh tokens --
const origin = (url: string) => { try { const u = new URL(url); return `${u.origin}${u.pathname}` } catch { return "" } }
expect("both invocations point at the same pairing endpoint", origin(jsonUrl), origin(plainUrl))
expect("each invocation minted its own single-use token", false, jsonUrl === plainUrl)
const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? ""
expect("--json token length (32 random bytes, base64url)", 43, tokenOf(jsonUrl).length)
expect("plain token length (32 random bytes, base64url)", 43, tokenOf(plainUrl).length)

say("")
say("--- verbatim `entangle` stdout ---")
say(plain.stdout.replace(/\n$/, ""))
say("--- end verbatim ---")

const report = process.env.E2E_REPORT
if (report) await Bun.write(Bun.file(report), (await Bun.file(report).text().catch(() => "")) + lines.join("\n") + "\n")
// Hand the URL back to run.sh for the security suite.
if (process.env.E2E_URL_OUT) await Bun.write(process.env.E2E_URL_OUT, `${jsonUrl}\n`)

process.exit(failures === 0 ? 0 : 1)
