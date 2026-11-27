import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { defineConfig, devices } from '@playwright/test';

/**
 * Multi-user shared-wallet E2E: the production static build + a real wallet-api
 * (in-memory store). No route mocking — every participant is its own browser
 * context with its own IndexedDB device key, i.e. its own backend user.
 * Build the web app with NEXT_PUBLIC_ENABLE_SHARED_WALLETS=true first. Run: `make e2e-shared`.
 */
// QD_E2E_API_PORT lets the suite run while another API occupies :8080; the web
// build must then point at it (NEXT_PUBLIC_API_URL=http://localhost:<port>).
const API_PORT = process.env.QD_E2E_API_PORT ?? '8080';
// A dedicated Anvil (never the one on :8545) for on-chain execution; the API's
// relayer pays gas with Anvil's public test account #1 (development only).
const ANVIL_PORT = process.env.QD_E2E_ANVIL_PORT ?? '8547';
const ANVIL_BIN = process.env.ANVIL_BIN ?? (existsSync(`${homedir()}/.foundry/bin/anvil`) ? `${homedir()}/.foundry/bin/anvil` : 'anvil');
const ANVIL_RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
process.env.QD_E2E_ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /shared-(wallet|signing|modes)\.spec\.ts/,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Sepolia's chain ID makes Anvil apply Sepolia's hardfork (Amsterdam), where one
      // matrix-expansion transaction costs ~33M gas. Anvil's default 30M block gas limit
      // cannot hold it (real Sepolia's is far higher), so give it a Sepolia-sized block.
      // --block-time: like Sepolia, blocks keep coming. The API scans non-local chains 2 blocks
      // behind the head, so an on-demand Anvil would never show the newest transaction.
      command: `${ANVIL_BIN} --port ${ANVIL_PORT} --chain-id 11155111 --gas-limit 60000000 --block-time 1 --silent`,
      port: Number(ANVIL_PORT),
      reuseExistingServer: false,
    },
    {
      command: 'node scripts/serve-static.mjs',
      env: { PORT: '3100', NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` }, // CSP connect-src
      url: 'http://localhost:3100',
      reuseExistingServer: false,
    },
    {
      // DEV_CREDENTIAL_RATE_BURST: six fresh device registrations from one IP exceed the
      // default per-IP credential burst; the override is development-only.
      command: 'go run ./cmd/wallet-api',
      cwd: '../../services/wallet-api',
      env: {
        HTTP_ADDR: `:${API_PORT}`,
        METRICS_ADDR: `:${Number(API_PORT) + 1010}`,
        CGO_ENABLED: '0',
        APP_ENV: 'development',
        STORE: 'memory',
        COOKIE_SECURE: 'false',
        DEV_CREDENTIAL_RATE_BURST: '200',
        ENABLE_SHARED_WALLETS: 'true',
        ALLOWED_ORIGINS: 'http://localhost:3100',
        PRICE_PROVIDER: 'static',
        EVM_RPC_11155111: `anvil=http://127.0.0.1:${ANVIL_PORT}`,
        RELAYER_PRIVATE_KEY_11155111: ANVIL_RELAYER_KEY,
      },
      url: `http://localhost:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
