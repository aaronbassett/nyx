import { defineConfig } from "@playwright/test";

// Headless smoke test. The wallet flow itself cannot run headless (it needs the
// Lace extension in a real browser) — this only verifies the app boots, renders
// all four steps + the log panel, and degrades gracefully when window.midnight
// is absent.
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "off",
  },
  webServer: {
    command: "./node_modules/.bin/vite --port 5173 --strictPort",
    url: "http://localhost:5173",
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
