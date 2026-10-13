import { defineConfig } from "vitest/config";

export default defineConfig({
  // Keep Vitest's cache inside the project (gitignored) rather than node_modules.
  cacheDir: ".vitest-cache",
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
