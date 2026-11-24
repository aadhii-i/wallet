import { defineConfig, devices } from '@playwright/test';

process.env.QD_BITCOIN_E2E = '1';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'bitcoin-change.spec.ts',
  timeout: 120000,
  workers: 1,
  expect: { timeout: 20000 },
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3102', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'go run ./cmd/wallet-api',
      cwd: '../../services/wallet-api',
      url: 'http://localhost:8183/healthz',
      reuseExistingServer: false,
      env: {
        APP_ENV: 'development',
        STORE: 'memory',
        HTTP_ADDR: '127.0.0.1:8183',
        METRICS_ADDR: '127.0.0.1:9193',
        COOKIE_SECURE: 'false',
        ALLOWED_ORIGINS: 'http://localhost:3102',
        PRICE_PROVIDER: 'static',
        ENABLE_LOCAL_NETWORKS: 'true',
        DEV_CREDENTIAL_RATE_BURST: '200',
      },
    },
    {
      command: 'node scripts/serve-static.mjs',
      url: 'http://localhost:3102',
      reuseExistingServer: false,
      env: { PORT: '3102', NEXT_PUBLIC_API_URL: 'http://localhost:8183' },
    },
  ],
});
