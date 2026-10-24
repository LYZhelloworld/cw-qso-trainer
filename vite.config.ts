import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tauri serves the built assets over its own protocol, not from the site root.
  // Relative URLs keep the same bundle working in the browser preview and in the
  // desktop shell.
  base: "./",
  // Keep Vitest's cache inside the project (gitignored) rather than node_modules.
  cacheDir: ".vitest-cache",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  server: {
    // `tauri dev` waits for this exact port. Failing loudly beats opening the
    // window against a different one.
    port: 5173,
    strictPort: true,
  },
  // Do not wipe the terminal: `tauri dev` prints the Rust build output under it.
  clearScreen: false,
});
