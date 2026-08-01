import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = resolve(__dirname, "dist");

/**
 * Playwright configuration for Lechyy extension smoke tests.
 *
 * We load the built extension via --load-extension so the content script runs
 * on every page. The fixture HTML files live in e2e/ and are served from the
 * project root during tests.
 *
 * IMPORTANT: Chromium extensions only load in *headed* mode. Playwright's
 * default is headless, so this config forces headless: false. Run with
 * `npx playwright test --headed` (or rely on the CI display).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    headless: false,
    launchOptions: {
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
      ],
    },
  },
  projects: [
    {
      name: "chromium-extension",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
