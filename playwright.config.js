// Playwright config for FlowTex E2E tests.
// Targets the running dev server at https://localhost:3001 with self-signed cert.
import { defineConfig } from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env so tests can sign session cookies (SESSION_SECRET) and connect to
// Postgres (PGDATABASE etc.) — Playwright doesn't pick this up on its own.
const here = path.dirname(fileURLToPath(import.meta.url));
try {
  const envText = fs.readFileSync(path.join(here, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env optional in CI */ }

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // tests share DB state; serialize to keep teardown sane
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://localhost:3001',
    ignoreHTTPSErrors: true,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
