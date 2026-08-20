declare module "*.css";

/**
 * Vite's glob import. Declared by hand rather than via `vite/client` because
 * tsconfig pins `"types": ["bun"]`, and pulling in vite/client would collide
 * with bun's own `ImportMeta`/`ImportMetaEnv` declarations.
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { eager?: boolean },
  ): Record<string, () => Promise<T>>;
}
