import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  reporter: "list",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: "http://127.0.0.1:3100",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Chicago",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-430",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 430, height: 932 },
      },
    },
  ],
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 3100",
    env: { ...process.env, WORKOUT_TEST_BYPASS: "1" },
    url: "http://127.0.0.1:3100/gallery",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
