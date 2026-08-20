import { describe, expect, test } from "bun:test"
import type { NetworkInterfaceInfo } from "node:os"
import { findTailscaleIpv4 } from "../src/server/tailscale"

function address(value: string): NetworkInterfaceInfo {
  return {
    address: value,
    cidr: `${value}/24`,
    family: "IPv4",
    internal: false,
    mac: "00:00:00:00:00:00",
    netmask: "255.255.255.0",
  }
}

describe("Tailscale address discovery", () => {
  test("uses the official CLI result first, including a custom tailnet IP pool", async () => {
    const commands: string[][] = []
    const result = await findTailscaleIpv4({
      platform: "linux",
      runCommand: async (command) => {
        commands.push(command)
        return "10.42.0.7\n"
      },
      getNetworkInterfaces: () => ({ tailscale0: [address("100.80.1.2")] }),
    })

    expect(result).toBe("10.42.0.7")
    expect(commands).toEqual([["tailscale", "ip", "--4"]])
  })

  test("tries the bundled macOS CLI when tailscale is not on PATH", async () => {
    const commands: string[][] = []
    const result = await findTailscaleIpv4({
      platform: "darwin",
      runCommand: async (command) => {
        commands.push(command)
        return command[0]?.startsWith("/Applications/") ? "100.91.2.3\n" : undefined
      },
      getNetworkInterfaces: () => ({}),
    })

    expect(result).toBe("100.91.2.3")
    expect(commands).toHaveLength(2)
  })

  test("falls back to the standard Tailscale interface range and returns null when absent", async () => {
    const found = await findTailscaleIpv4({
      platform: "linux",
      runCommand: async () => undefined,
      getNetworkInterfaces: () => ({ en0: [address("192.168.1.10")], tailscale0: [address("100.70.0.4")] }),
    })
    const missing = await findTailscaleIpv4({
      platform: "linux",
      runCommand: async () => "not connected",
      getNetworkInterfaces: () => ({ en0: [address("192.168.1.10")] }),
    })

    expect(found).toBe("100.70.0.4")
    expect(missing).toBeNull()
  })
})
