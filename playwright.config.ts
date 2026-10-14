import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against a running app and a migrated + seeded backend
// (see docs/SETUP.md → "Automated tests"). Never point them at production.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // The suite runs against the dev server, which compiles on demand and re-renders heavy pages (Dispatch,
  // Maintenance) slowly once the test database has accumulated data: a 5 s assertion wait was flaky there.
  // Waiting longer never hides a failure (an assertion still fails if the state never appears); retries stay 0.
  expect: { timeout: 10_000 },
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Bounded waits: without these a navigation or click lost to a dev-server restart (it restarts itself near its
    // memory threshold after long runs) hangs until the whole test times out — up to 15 minutes — and says nothing
    // about where. Steps that are slow on purpose (creating a demo) pass their own longer timeout.
    navigationTimeout: 120_000,
    actionTimeout: 60_000,
    screenshot: "only-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : undefined,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } } },
  ],
});
