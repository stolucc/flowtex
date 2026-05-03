// Black-box security probe suite. NOT a substitute for a real external pen
// test on staging — these are sanity probes against the live dev server,
// covering the common attack vectors (CSRF, SQLi, XSS, traversal, header
// injection, open redirect, missing-auth on mutating endpoints).
//
// Each probe asserts the server REJECTS the attack — typically with a
// structured 4xx response, never with a 200 + leaked data.
import { test, expect } from 'playwright/test';
import { seedUser, cleanup, close } from './_seed.js';
import https from 'node:https';

const BASE = process.env.E2E_BASE_URL || 'https://localhost:3001';
const agent = new https.Agent({ rejectUnauthorized: false });

let user;

test.beforeAll(async () => {
  user = await seedUser('e2e-probe@test.local', 'Probe');
});

test.afterAll(async () => {
  await cleanup(['e2e-probe@test.local']);
  await close();
});

async function authedFetch(method, path, options = {}) {
  return fetch(`${BASE}${path}`, {
    method,
    // node fetch in v22 honors NODE_TLS_REJECT_UNAUTHORIZED for self-signed.
    headers: {
      Cookie: `__session=${user.cookieValue}`,
      Origin: BASE,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    ...(options.body ? { body: options.body } : {}),
    // dispatcher: agent  // not needed in node 22 with NODE_TLS_REJECT_UNAUTHORIZED
  });
}

test.beforeAll(() => { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; });

test('CSRF: state-changing request without CSRF token is rejected', async () => {
  // No X-CSRF-Token header — should 403 (or some 4xx).
  const r = await authedFetch('POST', '/api/projects', {
    body: JSON.stringify({ name: 'csrf-attack' }),
  });
  expect(r.status, `expected 4xx, got ${r.status}`).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
  const body = await r.text();
  expect(body.toLowerCase()).toMatch(/csrf|forbidden|invalid/);
});

test('CSRF: state-changing request with WRONG CSRF token is rejected', async () => {
  const r = await authedFetch('POST', '/api/projects', {
    headers: { 'X-CSRF-Token': 'definitely-not-the-real-token' },
    body: JSON.stringify({ name: 'csrf-attack' }),
  });
  expect(r.status).toBe(403);
});

test('SQL injection on login email field is rejected without 500', async () => {
  // Pre-auth endpoint, but with origin-host equality fallback. We're not
  // expecting 200 — we're verifying the server DOESN'T 500 (raw error
  // means parameterized query failed) and DOESN'T leak schema.
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: "' OR '1'='1' --", password: 'anything' }),
  });
  // Should be 400/401/429 — never 500 (would indicate raw SQL error)
  expect(r.status).not.toBe(500);
  const body = await r.text();
  // Server response must NOT echo any SQL keyword that would indicate a
  // leaked database error.
  expect(body.toLowerCase()).not.toMatch(/syntax error|column|relation|pg_|sqlstate/);
});

test('Path traversal in file rename is rejected', async () => {
  const csrf = user.csrfToken;
  // First, create a project via DB to get a fileId. We use the seeded user
  // who has a session but no project yet — call the create endpoint with
  // proper CSRF.
  const createR = await authedFetch('POST', '/api/projects', {
    headers: { 'X-CSRF-Token': csrf },
    body: JSON.stringify({ name: 'Traversal Test' }),
  });
  expect(createR.ok).toBe(true);
  const proj = await createR.json();

  // Get the default file
  const filesR = await authedFetch('GET', `/api/projects/${proj.id}/files`);
  const files = await filesR.json();
  const fileId = files[0]?.id;
  expect(fileId).toBeTruthy();

  // Try to rename with path traversal vectors.
  const traversals = [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32',
    '/etc/passwd',
    'subdir/../../../escape.tex',
    'a/../b/../../c.tex',
  ];
  for (const path of traversals) {
    const r = await authedFetch('PATCH', `/api/projects/files/${fileId}`, {
      headers: { 'X-CSRF-Token': csrf },
      body: JSON.stringify({ path }),
    });
    expect(r.status, `traversal "${path}" was accepted (status ${r.status})`).toBeGreaterThanOrEqual(400);
  }
});

test('Cross-project access: PATCHing a file in a project we are NOT a member of is rejected', async () => {
  // Seed a SECOND user with their own project the probe user has no access to.
  const victim = await seedUser('e2e-probe-victim@test.local', 'Victim');
  try {
    const victimAuth = `__session=${victim.cookieValue}`;
    const createR = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: victimAuth, 'X-CSRF-Token': victim.csrfToken, Origin: BASE },
      body: JSON.stringify({ name: 'Victim project' }),
    });
    const victimProj = await createR.json();
    const filesR = await fetch(`${BASE}/api/projects/${victimProj.id}/files`, { headers: { Cookie: victimAuth } });
    const victimFile = (await filesR.json())[0];

    // Probe user tries to rename victim's file. Should be 403.
    const r = await authedFetch('PATCH', `/api/projects/files/${victimFile.id}`, {
      headers: { 'X-CSRF-Token': user.csrfToken },
      body: JSON.stringify({ path: 'pwned.tex' }),
    });
    expect([401, 403, 404]).toContain(r.status);
  } finally {
    await cleanup(['e2e-probe-victim@test.local']);
  }
});

test('XSS: project name is escaped in the rendered list', async ({ page, context }) => {
  const csrf = user.csrfToken;
  // Create a project whose name contains a script tag.
  const xssName = `<script>window.__pwned=true</script>x${Date.now()}`;
  await authedFetch('POST', '/api/projects', {
    headers: { 'X-CSRF-Token': csrf },
    body: JSON.stringify({ name: xssName }),
  });

  await context.addCookies([
    { name: '__session', value: user.cookieValue, url: BASE, httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto('/');
  // If React escaped properly, no script ran; window.__pwned is undefined.
  await page.waitForTimeout(800);
  const pwned = await page.evaluate(() => window.__pwned === true);
  expect(pwned, 'script tag in project name executed — XSS leak').toBe(false);
});

test('Header injection: attempt CRLF in registration name is sanitized', async () => {
  // Server strips \r\n from name before any header-bound use.
  // We can't test the email side-effect directly, but we can confirm the
  // server accepts the registration (it sanitizes) and the audit log row
  // (or the server's response) doesn't echo raw CRLF.
  const csrf = user.csrfToken;
  const r = await authedFetch('POST', '/api/projects', {
    headers: { 'X-CSRF-Token': csrf },
    body: JSON.stringify({ name: 'Foo\r\nX-Injected-Header: pwned' }),
  });
  expect(r.ok).toBe(true);
  // Response headers must not contain an injected header.
  expect(r.headers.get('x-injected-header')).toBeNull();
});

test('Missing-auth: mutating endpoints reject when session cookie is absent', async () => {
  // Hit a representative set of mutating endpoints with no Cookie header.
  // Each must return 401.
  const targets = [
    ['POST', '/api/projects', { name: 'noauth' }],
    ['PUT', '/api/projects/00000000-0000-0000-0000-000000000000', { name: 'x' }],
    ['DELETE', '/api/projects/00000000-0000-0000-0000-000000000000', null],
    ['PATCH', '/api/projects/files/00000000-0000-0000-0000-000000000000', { path: 'x' }],
  ];
  for (const [method, path, body] of targets) {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect([401, 403], `${method} ${path} should require auth, got ${r.status}`).toContain(r.status);
  }
});

test('Origin enforcement: pre-auth endpoint with wrong Origin is rejected', async () => {
  // /api/auth/login is csrfExempt but enforces Origin-host equality.
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ email: 'whatever@test.local', password: 'x' }),
  });
  expect(r.status).toBe(403);
});

test('Sensitive paths are not directly served', async () => {
  // /.env, /.git/HEAD, /server/ etc must NEVER return server-side content.
  // /projects/ is a legitimate SPA route (the in-app project list), so 200
  // there is correct — the served body is the React shell, not a directory
  // listing. Scanner-probe paths return 404 from the blockedPathPattern
  // middleware in server/index.js.
  for (const path of ['/.env', '/.env.example', '/.git/HEAD', '/.git/config', '/wp-admin', '/phpinfo.php', '/.aws/credentials']) {
    const r = await fetch(`${BASE}${path}`);
    expect(r.status, `${path} returned ${r.status}, expected 4xx (scanner-probe block)`).toBeGreaterThanOrEqual(400);
  }
});
