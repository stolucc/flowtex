// Verifies the WS reconnect echo-filter: after a brief network outage,
// typing in the editor must not duplicate characters. Without the fix, the
// server's broadcast of post-reconnect edits would bounce back to the same
// browser tab via the zombie clientEntry of the old (still-in-room) socket,
// and applyRemoteChanges would re-apply the user's own keystrokes.
//
// The fix: every outgoing `changes`/`cursor` frame is stamped with the tab's
// originId, the server preserves it, and the client drops echoes whose
// originId matches its own (see useWebSocket.js).
import { test, expect } from 'playwright/test';
import { seedUser, seedProject, cleanup, close } from './_seed.js';

const EMAIL = 'e2e-reconnect@test.local';
let user;

test.beforeAll(async () => {
  user = await seedUser(EMAIL, 'E2E Reconnect');
  await seedProject({ name: 'E2E Reconnect Project', ownerId: user.userId });
});

test.afterAll(async () => {
  await cleanup([EMAIL]);
  await close();
});

test('no duplicate characters after a WS disconnect/reconnect', async ({ page, context }) => {
  // Skip the login form by injecting the seeded session cookie.
  await context.addCookies([
    {
      name: '__session',
      value: user.cookieValue,
      url: 'https://localhost:3001',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  await page.goto('/');
  await expect(page.getByText('E2E Reconnect Project')).toBeVisible({ timeout: 15000 });
  await page.getByText('E2E Reconnect Project').click();
  await expect(page.locator('.cm-content')).toContainText('Hello FlowTex', { timeout: 15000 });

  // Type a unique marker at end of doc — this MUST appear exactly once.
  const beforeMarker = `BEFORE${Date.now()}`;
  const endKey = process.platform === 'darwin' ? 'Meta+End' : 'Control+End';
  await page.locator('.cm-content').click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press(endKey);
  await page.keyboard.type(`\n${beforeMarker}\n`, { delay: 12 });
  await page.waitForTimeout(1500); // debounced save (~1s) + WS round-trip

  const contentBefore = await page.locator('.cm-content').textContent();
  expect(contentBefore.match(new RegExp(beforeMarker, 'g')) || []).toHaveLength(1);

  // Simulate the laptop-sleep network drop. The server's old ws stays in the
  // room until its 30s heartbeat fires; reconnecting quickly creates the
  // exact zombie-clientEntry scenario the originId filter is meant to defuse.
  await context.setOffline(true);
  await page.waitForTimeout(2500);
  await context.setOffline(false);
  // Give the client time to detect the close, reconnect, and re-join.
  await page.waitForTimeout(4000);

  // Type a second marker AFTER reconnect — without the fix, this duplicates.
  const afterMarker = `AFTER${Date.now()}`;
  await page.locator('.cm-content').click();
  await page.locator('.cm-content').focus();
  await page.keyboard.press(endKey);
  await page.keyboard.type(`\n${afterMarker}\n`, { delay: 12 });
  await page.waitForTimeout(2500);

  const contentAfter = await page.locator('.cm-content').textContent();
  // The whole reason for this test: each marker must occur EXACTLY ONCE in
  // the rendered editor view, regardless of the reconnect storm in between.
  expect(contentAfter.match(new RegExp(beforeMarker, 'g')) || []).toHaveLength(1);
  expect(contentAfter.match(new RegExp(afterMarker, 'g')) || []).toHaveLength(1);
});
