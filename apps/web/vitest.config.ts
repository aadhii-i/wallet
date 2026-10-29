import { defineConfig } from 'vitest/config';

/**
 * e2e/*.spec.ts belongs to Playwright (`pnpm e2e`, see playwright.config.ts with
 * testDir './e2e'). Without this scope, `vitest run` sweeps those specs with
 * vitest's default glob and fails at collection, because Playwright's
 * test.describe/test.skip cannot run under vitest.
 */
export default defineConfig({ test: { include: ['src/**/*.{test,spec}.{ts,tsx}'] } });
