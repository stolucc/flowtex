// Vitest config used only by Stryker mutation testing. Restricts the
// run to the utility-module unit tests — the React component tests
// can hit timeouts/cost issues under Stryker's per-mutant runs, and
// the focus here is on the pure-logic / security-relevant modules
// listed in stryker.config.json's `mutate` list.
//
// Mirrors the server's vitest.mutation.config.js approach.
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Path alias must mirror vite.config.js so `@shared/...` imports in
  // the unit tests resolve under Stryker's tempDir copy.
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '..', 'shared'),
    },
  },
  test: {
    include: ['src/utils/__tests__/**/*.test.{js,jsx}'],
    environment: 'happy-dom',
  },
});
