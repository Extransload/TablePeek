import { defineConfig } from "vitest/config";

// Unit tests for the modules that need no page: parsers, SQL splitting and
// generation, chart and pivot sums. They run in Node; the app's Vite plugins
// (React, the Tern themes) aren't needed for them.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
