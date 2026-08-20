import QRCode from "qrcode"

interface PairingUrlOptions {
  host: string
  port: number
  token: string
}

export function buildPairingUrl({ host, port, token }: PairingUrlOptions): string {
  return `http://${host}:${port}/pair?token=${token}`
}

export async function renderTerminalQr(url: string): Promise<string> {
  const qr = await QRCode.toString(url, { type: "terminal", small: true })
  return qr.replace(/\x1b\[[0-9;]*m/g, "")
}
