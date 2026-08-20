import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import {
  PACKAGE_NAME,
  defaultConfigPath,
  installEntangle,
} from "../src/install"

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "entangle-install-"))
  roots.push(root)
  return root
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe("Entangle installer", () => {
  test("chooses JSONC, then JSON, and defaults to a new JSONC config", async () => {
    const root = await temporaryRoot()
    expect(await defaultConfigPath(root)).toBe(join(root, "opencode.jsonc"))

    await writeFile(join(root, "opencode.json"), "{}\n")
    expect(await defaultConfigPath(root)).toBe(join(root, "opencode.json"))

    await writeFile(join(root, "opencode.jsonc"), "{}\n")
    expect(await defaultConfigPath(root)).toBe(join(root, "opencode.jsonc"))
  })

  test("adds Entangle without removing comments, settings, or other plugins", async () => {
    const root = await temporaryRoot()
    const configPath = join(root, "opencode.jsonc")
    await writeFile(configPath, `{
  // keep this comment
  "theme": "system",
  "plugin": ["other-plugin"]
}
`)

    const result = await installEntangle(
      { configPath, installGlobal: false },
      { runCommand: async () => { throw new Error("global install must not run") } },
    )

    const text = await readFile(configPath, "utf8")
    const config = parse(text) as { theme: string; plugin: unknown[] }
    expect(result).toEqual({ configPath, configChanged: true, globalInstalled: false })
    expect(text).toContain("// keep this comment")
    expect(config.theme).toBe("system")
    expect(config.plugin).toEqual(["other-plugin", PACKAGE_NAME])
  })

  test("recognizes both string and tuple registrations without rewriting", async () => {
    for (const plugin of [PACKAGE_NAME, [PACKAGE_NAME, { port: 41778 }]]) {
      const root = await temporaryRoot()
      const configPath = join(root, "opencode.json")
      const original = `${JSON.stringify({ plugin: [plugin] }, null, 2)}\n`
      await writeFile(configPath, original)

      const result = await installEntangle({ configPath, installGlobal: false })

      expect(result.configChanged).toBe(false)
      expect(await readFile(configPath, "utf8")).toBe(original)
    }
  })

  test("rejects malformed config instead of overwriting it", async () => {
    const root = await temporaryRoot()
    const invalidJson = join(root, "invalid.jsonc")
    const invalidPlugin = join(root, "invalid-plugin.jsonc")
    await writeFile(invalidJson, "{ nope")
    await writeFile(invalidPlugin, '{ "plugin": "not-an-array" }')

    await expect(installEntangle({ configPath: invalidJson, installGlobal: false })).rejects.toThrow(
      "not valid JSON or JSONC",
    )
    await expect(installEntangle({ configPath: invalidPlugin, installGlobal: false })).rejects.toThrow(
      'field "plugin" must be an array',
    )
  })

  test("global install uses Bun and clears only Entangle cache entries", async () => {
    const root = await temporaryRoot()
    const cache = join(root, "cache")
    const configPath = join(root, "config", "opencode.jsonc")
    const packageScope = join(cache, "packages", "@dualityinstitute")
    const cachedPackage = join(packageScope, "entangle@0.1.0")
    const cachedLink = join(cache, "node_modules", "@dualityinstitute", "entangle")
    const unrelated = join(packageScope, "clone-ai@0.2.26")
    await mkdir(cachedPackage, { recursive: true })
    await mkdir(cachedLink, { recursive: true })
    await mkdir(unrelated, { recursive: true })
    const commands: string[][] = []

    const result = await installEntangle(
      { configPath },
      {
        cacheDirectory: cache,
        runCommand: async (command) => {
          commands.push(command)
          return 0
        },
      },
    )

    expect(commands).toEqual([["bun", "add", "--global", PACKAGE_NAME]])
    expect(result.globalInstalled).toBe(true)
    expect(await exists(cachedPackage)).toBe(false)
    expect(await exists(cachedLink)).toBe(false)
    expect(await exists(unrelated)).toBe(true)
  })

  test("a failed global install does not create or edit configuration", async () => {
    const root = await temporaryRoot()
    const configPath = join(root, "opencode.jsonc")

    await expect(installEntangle(
      { configPath },
      { runCommand: async () => 1 },
    )).rejects.toThrow("failed to install")
    expect(await exists(configPath)).toBe(false)
  })
})
