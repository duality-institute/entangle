import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { InstanceDescriptor } from "../shared/protocol"

const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** `$XDG_STATE_HOME/entangle/instances`, falling back to `~/.local/state/entangle/instances`. */
export function instancesDirectory(): string {
  const configured = process.env.XDG_STATE_HOME?.trim()
  const root = configured && configured.length > 0 ? configured : join(homedir(), ".local", "state")
  return join(root, "entangle", "instances")
}

/** Descriptor file name: `<sha256(directory)[0..16]>-<pid>.json`. */
export function descriptorFileName(directory: string, pid: number): string {
  return `${createHash("sha256").update(directory).digest("hex").slice(0, 16)}-${pid}.json`
}

export function descriptorPath(directory: string, pid: number, root = instancesDirectory()): string {
  return join(root, descriptorFileName(directory, pid))
}

/** Atomic write: temp file (0600) in the same directory, then rename over the target. */
export async function writeDescriptor(descriptor: InstanceDescriptor, root = instancesDirectory()): Promise<string> {
  const parsed = InstanceDescriptor.parse(descriptor)
  await mkdir(root, { recursive: true, mode: DIR_MODE })
  await chmod(root, DIR_MODE)
  const target = descriptorPath(parsed.directory, parsed.pid, root)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: FILE_MODE })
  await chmod(temporary, FILE_MODE)
  await rename(temporary, target)
  return target
}

export async function removeDescriptor(
  descriptor: Pick<InstanceDescriptor, "directory" | "pid">,
  root = instancesDirectory(),
): Promise<void> {
  await rm(descriptorPath(descriptor.directory, descriptor.pid, root), { force: true })
}

/** True when the pid still exists. `EPERM` means it exists but is owned by somebody else. */
export function isAlive(descriptor: Pick<InstanceDescriptor, "pid">): boolean {
  if (!Number.isInteger(descriptor.pid) || descriptor.pid <= 0) return false
  try {
    process.kill(descriptor.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Every descriptor whose process is still alive, newest first.
 * Dead-pid descriptors are deleted; unreadable ones are quarantined as `<name>.corrupt`.
 */
export async function listDescriptors(root = instancesDirectory()): Promise<InstanceDescriptor[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const descriptors = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => load(join(root, name))),
  )
  return descriptors
    .filter((descriptor): descriptor is InstanceDescriptor => descriptor !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

async function load(path: string): Promise<InstanceDescriptor | undefined> {
  let parsed: ReturnType<typeof InstanceDescriptor.safeParse>
  try {
    parsed = InstanceDescriptor.safeParse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    await quarantine(path)
    return undefined
  }
  if (!parsed.success) {
    await quarantine(path)
    return undefined
  }
  if (!isAlive(parsed.data)) {
    await rm(path, { force: true })
    return undefined
  }
  return parsed.data
}

async function quarantine(path: string): Promise<void> {
  try {
    await rename(path, `${path}.corrupt`)
  } catch {
    await rm(path, { force: true }).catch(() => {})
  }
}
