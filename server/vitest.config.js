// Default vitest config (unit tests, mocked). The integration suite has
// its own config at tests/integration/vitest.config.js and is run via
// `npm run test:integration`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['tests/integration/**', 'node_modules/**'],
  },
});
