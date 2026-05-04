// Vitest config used only by Stryker mutation testing. Excludes the
// integration tests that need a live Postgres — Stryker runs against
// pure-logic / mocked-DB tests so each mutation kill verdict is fast and
// reproducible without Docker. The default `npm test` still runs the full
// suite (incl. integration) via Vitest's own resolution.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: [
      'node_modules/**',
      'tests/tracked-changes-integration.test.js',
      'tests/load-test.js',
    ],
  },
});
