// Smoke test: a single user logs in, opens a seeded project, edits the
// document, and we verify the edit reaches the server (re-fetched from DB).
import { test, expect } from 'playwright/test';
import pg from 'pg';
import { seedUser, seedProject, cleanup, close } from './_seed.js';

const EMAIL = 'e2e-smoke@test.local';
let user, project;
let pgPool;

test.beforeAll(async () => {
  user = await seedUser(EMAIL, 'E2E Smoke');
  project = await seedProject({ name: 'E2E Smoke Project', ownerId: user.userId });
  pgPool = new pg.Pool({ database: process.env.PGDATABASE || 'flowtex', max: 1 });
});

test.afterAll(async () => {
  if (pgPool) await pgPool.end();
  await cleanup([EMAIL]);
  await close();
});

test('seeded session → open project → edit → server has new content', async ({ page, context }) => {
  page.on('console', (msg) => console.log(`[dbg-console] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[dbg-pageerror] ${err}`));
  // Inject the pre-seeded session cookie so we skip the login form entirely.
  // This avoids the 20/15min auth rate limiter that would otherwise trip when
  // running the suite repeatedly from one IP.
  await context.addCookies([
    {
      name: '__session',
      value: user.cookieValue,
      url: 'https://localhost:3001',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  // 1. Land directly on the project list
  await page.goto('/');
  await expect(page.getByText('E2E Smoke Project')).toBeVisible({ timeout: 15000 });
  await page.getByText('E2E Smoke Project').click();

  // 3. Editor loads — wait for CodeMirror to mount and show seeded content
  await expect(page.locator('.cm-content')).toContainText('Hello FlowTex', { timeout: 15000 });

  // 4. Insert text. Click into the editor and focus it explicitly — a bare
  // .click() proved unreliable in headless CI (the marker never reached
  // the DB on Chromium runners). Then go to end of doc and type.
  const marker = `MARKER-${Date.now()}`;
  await page.locator('.cm-content').click();
  await page.locator('.cm-content').focus();
  const focused = await page.locator('.cm-content').evaluate((el) => document.activeElement === el || el.contains(document.activeElement));
  console.log(`[dbg] editor focused after click+focus: ${focused}`);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.type(`\n${marker}\n`, { delay: 12 });

  // Client-only check (no server round trip): did typing land in the DOM
  // at all? Splits "Playwright typing/focus didn't work in this env" from
  // "typing worked but the WS sync to the server failed".
  const domTextImmediately = await page.locator('.cm-content').innerText();
  console.log(`[dbg] DOM contains marker immediately after typing: ${domTextImmediately.includes(marker)}`);
  console.log(`[dbg] DOM tail immediately after typing: ${JSON.stringify(domTextImmediately.slice(-60))}`);

  // 5. Wait past the Y.Doc room's debounced snapshot (services/yjsRoom.js,
  // SNAPSHOT_DEBOUNCE_MS=2s — under Y.js this, not the HTTP autosave, is
  // what persists files.content), then verify DB has it. Bumped from 2s →
  // 4s for CI runners, which are noticeably slower than the dev machine.
  await page.waitForTimeout(4000);
  const domTextFinal = await page.locator('.cm-content').innerText();
  console.log(`[dbg] DOM contains marker after 4s wait: ${domTextFinal.includes(marker)}`);
  const r = await pgPool.query('SELECT content FROM files WHERE id = $1', [project.fileId]);
  console.log(`[dbg] DB tail after 4s wait: ${JSON.stringify((r.rows[0].content || '').slice(-60))}`);
  expect(r.rows[0].content).toContain(marker);
});
