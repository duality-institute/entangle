import { describe, expect, test } from "bun:test"
import jsQR from "jsqr"
import { PNG } from "pngjs"
import QRCode from "qrcode"
import { buildPairingUrl, renderTerminalQr } from "../src/server/qr"

describe("QR pairing", () => {
  test("constructs the exact pairing URL", () => {
    expect(buildPairingUrl({ host: "192.168.50.100", port: 52341, token: "abc" }))
      .toBe("http://192.168.50.100:52341/pair?token=abc")
  })

  test("terminal output has no ANSI color escapes", async () => {
    const qr = await renderTerminalQr("http://192.168.1.2:4242/pair?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    expect(/\x1b\[[34]/.test(qr)).toBe(false)
  })

  test("decode round-trip preserves a production-length URL", async () => {
    const url = buildPairingUrl({
      host: "192.168.50.100",
      port: 52341,
      token: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno",
    })
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 })
    const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"))
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
    expect(decoded?.data).toBe(url)
  })
})
