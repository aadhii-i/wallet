import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the production static build + a local Anvil node (spec §27.1).
 * Prereqs: `pnpm build` in apps/web and Anvil on 127.0.0.1:8545 (`make anvil`).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node scripts/serve-static.mjs',
    env: { PORT: '3100' },
    url: 'http://localhost:3100',
    reuseExistingServer: true,
  },
});
