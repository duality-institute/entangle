import { networkInterfaces } from "node:os"
import type { NetworkInterfaceInfo } from "node:os"
import { firstTailscaleAddress, isIpv4Address } from "./lan"

const COMMAND_TIMEOUT_MS = 3_000

export type TailscaleCommandRunner = (command: string[]) => Promise<string | undefined>

export interface TailscaleDiscoveryDependencies {
  runCommand?: TailscaleCommandRunner
  getNetworkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  platform?: NodeJS.Platform
}

async function runCommand(command: string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, TAILSCALE_BE_CLI: "1" },
    })
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS)
    try {
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ])
      return exitCode === 0 ? stdout : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}

function ipv4FromOutput(output: string | undefined): string | undefined {
  return output?.split(/\s+/).find(isIpv4Address)
}

export async function findTailscaleIpv4(
  dependencies: TailscaleDiscoveryDependencies = {},
): Promise<string | null> {
  const run = dependencies.runCommand ?? runCommand
  const commands = [["tailscale", "ip", "--4"]]
  if ((dependencies.platform ?? process.platform) === "darwin") {
    commands.push(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "ip", "--4"])
  }
  for (const command of commands) {
    const address = ipv4FromOutput(await run(command))
    if (address) return address
  }
  return firstTailscaleAddress(dependencies.getNetworkInterfaces ?? networkInterfaces)
}
