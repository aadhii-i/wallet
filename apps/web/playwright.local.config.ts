import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Local run against the Next dev server on :3000 instead of the static build on
 * :3100. wallet-api's `ALLOWED_ORIGINS` is `http://localhost:3000`, so a browser
 * on any other origin gets its calls blocked by CORS and the wallet only shows
 * "Can't reach …". Use with:
 *
 *   corepack pnpm exec playwright test --config=playwright.local.config.ts
 */
export default defineConfig({
  ...base,
  webServer: undefined,
  use: { ...base.use, baseURL: 'http://localhost:3000' },
});
