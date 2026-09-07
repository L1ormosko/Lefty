import { defineConfig, devices } from "@playwright/test";

const BROWSER = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    locale: "he-IL",
    launchOptions: {
      executablePath: process.env.CI ? undefined : BROWSER,
      // Software WebGL: the container has no GPU, and the map needs a context.
      args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      // A phone-shaped Chromium rather than the iPhone preset, which would
      // ask for WebKit - the container ships Chromium only.
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
      },
    },
  ],
});
