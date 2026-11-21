import { defineConfig } from "vitest/config";
import path from "node:path";

// Integration tests run against the real `leadro_test` database (never `leadro`).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://leadro:leadro@127.0.0.1:5432/leadro_test";

// globalSetup runs in the main process, so the variables must be set here as well as in test.env.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;

export default defineConfig({
  // tsconfig uses `jsx: preserve` for Next; Vitest needs the automatic React runtime for .tsx tests.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // Component tests opt into jsdom per file with `// @vitest-environment jsdom`; the default
    // stays `node` so DB integration tests are unaffected.
    include: ["tests/**/*.test.ts", "src/components/**/*.test.tsx"],
    setupFiles: ["tests/setup-dom.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    globalSetup: ["tests/global-setup.ts"],
    env: { DATABASE_URL: TEST_DATABASE_URL, TEST_DATABASE_URL },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
