import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * e2e/*.spec.ts belongs to Playwright (`pnpm e2e`, see playwright.config.ts with
 * testDir './e2e'). Without this scope, `vitest run` sweeps those specs with
 * vitest's default glob and fails at collection, because Playwright's
 * test.describe/test.skip cannot run under vitest.
 */
export default defineConfig({
  // The app tsconfig uses Next's `jsx: "preserve"`, which Vite cannot parse.
  // Tests render a few client components with react-dom/server, so compile JSX
  // with the automatic runtime instead.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.{test,spec}.{ts,tsx}'] },
});
