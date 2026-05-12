// Vitest config for integration tests. Runs against a real PostgreSQL
// database (the same one in PGDATABASE), but every test is wrapped in
// BEGIN…ROLLBACK so no data persists.
//
// Run with:  npm run test:integration
//
// Differences vs. the unit suite:
//   - Sequential (single fork) so multiple tests don't fight over the
//     shared client.
//   - NODE_ENV=test required so _setSharedClient is allowed.
//   - Longer timeout — real network round-trips to Postgres.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.integration.test.js'],
    setupFiles: ['tests/integration/setup.js'],
    // One worker, one test at a time. Each test holds the shared client.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      DISABLE_HIBP_CHECK: '1',
    },
  },
});
