// Vitest config used only by Stryker mutation testing. Excludes the
// integration tests that need a live Postgres — Stryker runs against
// pure-logic / mocked-DB tests so each mutation kill verdict is fast and
// reproducible without Docker. The default `npm test` still runs the full
// suite (incl. integration) via Vitest's own resolution.
import { defineConfig } from 'vitest/config';

// Disable the HIBP password-check network call (same as `npm test`) — the
// authService tests would otherwise fail in the dry-run with "password has
// appeared in known data breaches" and abort the whole mutation run.
process.env.DISABLE_HIBP_CHECK = '1';

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
