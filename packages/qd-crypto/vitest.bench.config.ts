import { defineConfig } from 'vitest/config';

// `pnpm bench`: slow measurements kept out of the unit-test run.
export default defineConfig({ test: { include: ['bench/**/*.test.ts'], testTimeout: 3_600_000 } });
