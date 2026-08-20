import { describe, expect, test } from "bun:test"
import type { NetworkInterfaceInfo } from "node:os"
import {
  firstLanAddress,
  firstTailscaleAddress,
  interfacePriority,
  isDefaultTailscaleIpv4,
  isIpv4Address,
  isPrivateIpv4,
} from "../src/server/lan"

function address(value: string, internal = false): NetworkInterfaceInfo {
  return {
    address: value,
    cidr: `${value}/24`,
    family: "IPv4",
    internal,
    mac: "00:00:00:00:00:00",
    netmask: "255.255.255.0",
  }
}

const interfaces = (value: NodeJS.Dict<NetworkInterfaceInfo[]>) => () => value

describe("LAN address detection", () => {
  test("prefers en0 and wifi over ethernet", () => {
    expect(firstLanAddress(interfaces({ eth0: [address("192.168.1.20")], wifi0: [address("192.168.1.30")] }))).toBe("192.168.1.30")
    expect(firstLanAddress(interfaces({ eth0: [address("192.168.1.20")], en0: [address("192.168.1.40")] }))).toBe("192.168.1.40")
  })

  test("skips internal loopback addresses", () => {
    expect(firstLanAddress(interfaces({ lo0: [address("127.0.0.1", true)], en0: [address("192.168.1.40")] }))).toBe("192.168.1.40")
  })

  test("skips link-local addresses", () => {
    expect(firstLanAddress(interfaces({ en0: [address("169.254.1.2")], eth0: [address("192.168.1.20")] }))).toBe("192.168.1.20")
  })

  test("deprioritizes utun, tailscale, and docker interfaces", () => {
    expect(interfacePriority("utun4", "10.0.0.2")).toBe(0)
    expect(interfacePriority("tailscale0", "100.64.0.2")).toBe(0)
    expect(interfacePriority("docker0", "172.17.0.1")).toBe(0)
    expect(firstLanAddress(interfaces({ docker0: [address("172.17.0.1")], tailscale0: [address("100.64.0.2")], en0: [address("192.168.1.40")] }))).toBe("192.168.1.40")
  })

  test("returns null when only virtual or internal interfaces exist", () => {
    expect(firstLanAddress(interfaces({ lo0: [address("127.0.0.1", true)], utun4: [address("10.0.0.2")], docker0: [address("172.17.0.1")] }))).toBeNull()
  })

  test("recognizes RFC1918 IPv4 ranges", () => {
    expect(isPrivateIpv4("10.1.2.3")).toBe(true)
    expect(isPrivateIpv4("172.16.2.3")).toBe(true)
    expect(isPrivateIpv4("192.168.2.3")).toBe(true)
    expect(isPrivateIpv4("172.32.2.3")).toBe(false)
  })

  test("recognizes IPv4 syntax and Tailscale's default CGNAT range", () => {
    expect(isIpv4Address("100.64.0.1")).toBe(true)
    expect(isIpv4Address("100.127.255.255")).toBe(true)
    expect(isIpv4Address("100.128.0.1")).toBe(true)
    expect(isIpv4Address("100.64.0.999")).toBe(false)
    expect(isIpv4Address("not-an-ip")).toBe(false)
    expect(isDefaultTailscaleIpv4("100.64.0.1")).toBe(true)
    expect(isDefaultTailscaleIpv4("100.127.255.255")).toBe(true)
    expect(isDefaultTailscaleIpv4("100.128.0.1")).toBe(false)
  })

  test("finds a Tailscale address separately without changing LAN preference", () => {
    const values = interfaces({
      en0: [address("192.168.1.40")],
      utun4: [address("100.80.1.2")],
    })
    expect(firstLanAddress(values)).toBe("192.168.1.40")
    expect(firstTailscaleAddress(values)).toBe("100.80.1.2")
  })
})
