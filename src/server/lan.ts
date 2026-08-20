import { networkInterfaces } from "node:os"
import type { NetworkInterfaceInfo } from "node:os"

export function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number)
  return octets[0] === 10
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

export function isIpv4Address(address: string): boolean {
  const octets = address.split(".")
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false
    const value = Number(octet)
    return value >= 0 && value <= 255
  })
}

export function isDefaultTailscaleIpv4(address: string): boolean {
  if (!isIpv4Address(address)) return false
  const [first, second] = address.split(".").map(Number)
  return first === 100 && second! >= 64 && second! <= 127
}

export function interfacePriority(name: string, address: string): number {
  const virtual = /^(awdl|bridge|docker|llw|tap|tailscale|tun|utun|veth|virbr|vmnet|vboxnet)/i.test(name)
  if (name === "en0") return 500
  if (/^(wl|wlan|wifi)/i.test(name)) return 400
  if (/^en\d+$/i.test(name)) return 350
  if (/^(enp|eno|eth)/i.test(name)) return 300
  if (virtual) return 0
  return isPrivateIpv4(address) ? 200 : 100
}

type GetNetworkInterfaces = () => NodeJS.Dict<NetworkInterfaceInfo[]>

export function firstLanAddress(getNetworkInterfaces: GetNetworkInterfaces = networkInterfaces): string | null {
  const candidates = Object.entries(getNetworkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
      .map((entry) => ({ name, address: entry.address, priority: interfacePriority(name, entry.address) }))
      .filter((candidate) => candidate.priority > 0),
  )
  candidates.sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name) || left.address.localeCompare(right.address))
  return candidates[0]?.address ?? null
}

export function firstTailscaleAddress(getNetworkInterfaces: GetNetworkInterfaces = networkInterfaces): string | null {
  const candidates = Object.entries(getNetworkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && isDefaultTailscaleIpv4(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  )
  candidates.sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address))
  return candidates[0]?.address ?? null
}
