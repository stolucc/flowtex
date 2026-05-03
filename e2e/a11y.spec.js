// Accessibility audit using axe-core. Runs the same axe rules ChromeDevTools
// Lighthouse uses, on the two screens most users actually see: the auth page
// and the editor (with a project loaded).
//
// We surface SERIOUS and CRITICAL violations as test failures and assert
// they're empty. Lower-severity issues (minor / moderate) are reported but
// don't fail the build — they're worth fixing but not blockers.
import { test, expect } from 'playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { seedUser, seedProject, cleanup, close } from './_seed.js';

let alice;

test.beforeAll(async () => {
  alice = await seedUser('e2e-a11y@test.local', 'A11Y Test');
  // We seed a project but don't need to reference it after creation — the
  // editor test finds it by name in the project list.
  await seedProject({ name: 'A11Y Project', ownerId: alice.userId });
});

test.afterAll(async () => {
  await cleanup(['e2e-a11y@test.local']);
  await close();
});

function summarize(violations) {
  const grouped = {};
  for (const v of violations) {
    grouped[v.impact] = grouped[v.impact] || [];
    grouped[v.impact].push(`${v.id} (${v.nodes.length} elements): ${v.help}`);
  }
  const lines = [];
  for (const sev of ['critical', 'serious', 'moderate', 'minor']) {
    if (grouped[sev]) {
      lines.push(`  [${sev}]`);
      for (const l of grouped[sev]) lines.push(`    - ${l}`);
    }
  }
  return lines.join('\n');
}

test('auth page — no critical/serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Email').waitFor({ timeout: 5000 });

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');

  if (results.violations.length > 0) {
    console.log(`\n[a11y auth-page] ${results.violations.length} violations:\n${summarize(results.violations)}\n`);
  }

  expect(blocking, `${blocking.length} critical/serious a11y violations on auth page`).toEqual([]);
});

test('editor — no critical/serious accessibility violations on project view', async ({ page, context }) => {
  await context.addCookies([
    {
      name: '__session',
      value: alice.cookieValue,
      url: 'https://localhost:3001',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.goto('/');
  await page.getByText('A11Y Project').waitFor({ timeout: 15000 });
  await page.getByText('A11Y Project').click();
  await page.locator('.cm-content').waitFor({ timeout: 15000 });
  // Give the editor a moment to fully mount + render decorations.
  await page.waitForTimeout(500);

  const results = await new AxeBuilder({ page })
    // Exclude the CodeMirror content surface — it's a contenteditable editor
    // with its own ARIA role; axe routinely flags `aria-input-field-name` and
    // similar on every CM6 deployment regardless of how it's configured. Not
    // actionable from our code.
    .exclude('.cm-editor')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');

  if (results.violations.length > 0) {
    console.log(`\n[a11y editor] ${results.violations.length} violations:\n${summarize(results.violations)}\n`);
  }

  expect(blocking, `${blocking.length} critical/serious a11y violations on editor view`).toEqual([]);
});
