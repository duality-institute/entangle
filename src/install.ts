import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

export const PACKAGE_NAME = "@dualityinstitute/entangle"

export interface InstallOptions {
  configPath?: string
  installGlobal?: boolean
}

export interface InstallResult {
  configPath: string
  configChanged: boolean
  globalInstalled: boolean
}

export type CommandRunner = (command: string[]) => Promise<number>

export interface InstallDependencies {
  configDirectory?: string
  cacheDirectory?: string
  runCommand?: CommandRunner
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function globalConfigDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

function openCodeCacheDirectory(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode")
}

export async function defaultConfigPath(directory = globalConfigDirectory()): Promise<string> {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(directory, name)
    try {
      await access(path)
      return path
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return join(directory, "opencode.jsonc")
}

export async function clearOpenCodePluginCache(
  cacheDirectory = openCodeCacheDirectory(),
): Promise<void> {
  const scope = join(cacheDirectory, "packages", "@dualityinstitute")
  let entries: string[] = []
  try {
    entries = await readdir(scope)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await Promise.all([
    ...entries
      .filter((name) => name === "entangle" || name.startsWith("entangle@"))
      .map((name) => rm(join(scope, name), { recursive: true, force: true })),
    rm(join(cacheDirectory, "node_modules", "@dualityinstitute", "entangle"), {
      recursive: true,
      force: true,
    }),
  ])
}

async function runCommand(command: string[]): Promise<number> {
  const child = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

function pluginEntries(text: string): unknown[] {
  const errors: ParseError[] = []
  const config = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OpenCode config is not valid JSON or JSONC")
  }
  const plugin = (config as Record<string, unknown>).plugin
  if (plugin === undefined) return []
  if (!Array.isArray(plugin)) throw new Error('OpenCode config field "plugin" must be an array')
  return plugin
}

function hasPlugin(entries: unknown[]): boolean {
  return entries.some(
    (entry) => entry === PACKAGE_NAME || (Array.isArray(entry) && entry[0] === PACKAGE_NAME),
  )
}

export async function installEntangle(
  options: InstallOptions = {},
  dependencies: InstallDependencies = {},
): Promise<InstallResult> {
  const installGlobal = options.installGlobal ?? true
  if (installGlobal) {
    const command = ["bun", "add", "--global", PACKAGE_NAME]
    const exitCode = await (dependencies.runCommand ?? runCommand)(command)
    if (exitCode !== 0) throw new Error(`failed to install ${PACKAGE_NAME} globally`)
    await clearOpenCodePluginCache(dependencies.cacheDirectory)
  }

  const configPath = options.configPath ?? await defaultConfigPath(dependencies.configDirectory)
  let text = "{}\n"
  try {
    text = await readFile(configPath, "utf8")
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const entries = pluginEntries(text)
  const configChanged = !hasPlugin(entries)
  if (configChanged) {
    const edits = modify(text, ["plugin"], [...entries, PACKAGE_NAME], {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })
    text = applyEdits(text, edits)
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, text)
  }

  return { configPath, configChanged, globalInstalled: installGlobal }
}
