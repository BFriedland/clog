import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.*/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        // .d.ts declarations have no executable lines.
        "src/**/*.d.ts",
        // Pure type / interface declarations have no executable lines.
        "src/adapters/adapter.ts",
        "src/models/warnings.ts",
        "src/search/types.ts",
        // Subprocess entry points — covered by e2e spawn tests, not instrumented.
        "src/index.ts",
        "src/mcp/server.ts",
        // Optional-dep wrappers; the real packages aren't imported in unit tests.
        "src/search/embeddings/transformers.ts",
        "src/search/vectorstores/vectra.ts",
      ],
    },
  },
});
