import { realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

/** Resolve symlinks in the existing prefix while preserving a missing suffix. */
export function canonicalDirectory(path: string): string {
  let head = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(head)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(path)
      missing.unshift(basename(head))
      head = parent
    }
  }
}
