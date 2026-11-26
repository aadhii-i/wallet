import { defineConfig, devices } from '@playwright/test';
import shared from './playwright.shared.config';

// Reuse the bounded local-service lifecycle and CSP/API origin from the shared
// harness. The existing personal-wallet suite also needs the local 31337 RPC.
const servers = Array.isArray(shared.webServer) ? shared.webServer : [];
if (servers.length !== 3) throw new Error('Wallet-mode tests require the shared local test services');

export default defineConfig({
  ...shared,
  testMatch: /(?:^|[\\/])(?:wallet|shared-modes)\.spec\.ts$/,
  timeout: 120_000,
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: servers.map((server, index) =>
    index === 2
      ? {
          ...server,
          env: {
            ...server.env,
            EVM_RPC_31337: process.env.ANVIL_RPC_URL
              ? `anvil=${process.env.ANVIL_RPC_URL}`
              : 'anvil=http://127.0.0.1:8545',
          },
        }
      : server,
  ),
});
