import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Resolved from this file so `vite build --config ui/vite.config.ts`
  // behaves identically no matter which directory it is invoked from.
  root: uiRoot,
  // Relative base: the bundle is served from the LAN server at an unknown
  // mount path, so every asset URL must be relative to index.html.
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(uiRoot, "../dist/ui"),
    // outDir lives outside `root`, so Vite refuses to clean it unless we opt in.
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
