import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL } from "./e2e/setup/test-database";

/**
 * Browser suite for LEADRO. `npm run test:e2e` builds the app, starts it against the throw-away
 * `leadro_test` database, seeds fresh tenants (e2e/setup) and drives Chromium through the main
 * sign-in and access flows. Nothing is read from or written to the development database.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Generated per run and inherited by the web server, globalSetup and workers (all are children
// of this process). It encrypts the MFA seed the seed script stores, and is never persisted.
process.env.LEADRO_ENCRYPTION_KEY = randomBytes(32).toString("base64");
// The seed script and the app both read DATABASE_URL: point both at the test database.
process.env.DATABASE_URL = E2E_DATABASE_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/setup/global-setup.ts",
  // Specs share one seeded tenant and one lockout target; run them one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  // Traces are off by default (they can capture typed passwords); override with `--trace on`.
  use: {
    baseURL: BASE_URL,
    trace: "off",
    launchOptions: {
      // The container ships its own Chromium; the pinned Playwright build would look elsewhere.
      executablePath: process.env.E2E_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
      args: ["--no-sandbox"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], locale: "en-US" } }],
  webServer: {
    command: `npm run build && npx next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 420_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      LEADRO_ENCRYPTION_KEY: process.env.LEADRO_ENCRYPTION_KEY,
      LEADRO_TRUSTED_PROXY_HOPS: "0",
    },
  },
});
