// CSP / security-headers verification. The server generates a per-request
// nonce, advertises it in the `Content-Security-Policy` response header, and
// injects the same nonce into the served HTML's `<script>` tags. This spec
// verifies the round-trip end-to-end (header ↔ HTML ↔ browser enforcement),
// so a future regression that breaks the nonce pipeline — accidentally
// adding `'unsafe-inline'`, dropping the nonce middleware, returning a
// stale cached HTML — gets caught.
//
// Pairs with security-probes.spec.js (which covers attack-shaped probes
// like CSRF/XSS/SQLi/traversal); this one is the configuration-correctness
// half.
import { test, expect } from 'playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://localhost:3001';

test.beforeAll(() => { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; });

// Pull the nonce out of a CSP header. Header looks like
// `... script-src 'self' 'nonce-AbCd1234==' ; ...`. We don't want to be
// strict about ordering or whitespace — just locate the directive.
function nonceFromCsp(csp) {
  const m = csp.match(/script-src[^;]*'nonce-([^']+)'/i);
  return m ? m[1] : null;
}

test('CSP header is present on the SPA root with a nonce directive', async () => {
  const r = await fetch(`${BASE}/`);
  expect(r.status, 'SPA root should serve 200').toBe(200);
  const csp = r.headers.get('content-security-policy');
  expect(csp, 'CSP header must be set on the SPA root').toBeTruthy();
  expect(csp).toMatch(/script-src[^;]*'self'/i);
  expect(csp).toMatch(/script-src[^;]*'nonce-/i);
  expect(csp).toMatch(/frame-ancestors[^;]*'none'/i);
  expect(csp).toMatch(/object-src/i);
  // No `'unsafe-inline'` on script-src — defeats the entire nonce mechanism.
  // (`'unsafe-inline'` IS allowed on style-src; we explicitly opt into that.)
  const scriptSrc = csp.split(';').find((d) => /^\s*script-src/i.test(d)) || '';
  expect(scriptSrc, 'script-src must not allow unsafe-inline').not.toMatch(/'unsafe-inline'/);
  expect(scriptSrc, 'script-src must not allow unsafe-eval').not.toMatch(/'unsafe-eval'/);
});

test('CSP nonce in the header matches the nonce on every served <script>', async () => {
  const r = await fetch(`${BASE}/`);
  const csp = r.headers.get('content-security-policy') || '';
  const headerNonce = nonceFromCsp(csp);
  expect(headerNonce, 'header should declare a nonce').toBeTruthy();
  const html = await r.text();
  // Every <script> must carry nonce="…" matching the header. Vite's
  // production output emits the SPA's entrypoint as one or more
  // <script type="module" src="…">s; the SPA fallback templater rewrites
  // them to add the nonce. If any script tag misses the nonce attribute,
  // the browser will block it and the SPA won't boot.
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  expect(scriptTags.length, 'served HTML should contain at least one <script>').toBeGreaterThan(0);
  for (const tag of scriptTags) {
    expect(tag, `tag missing nonce attribute: ${tag}`).toMatch(/\bnonce="/);
    const m = tag.match(/\bnonce="([^"]+)"/);
    expect(m && m[1], `tag has empty nonce: ${tag}`).toBeTruthy();
    expect(m[1], `tag nonce does not match header nonce`).toBe(headerNonce);
  }
});

test('CSP nonce changes per request', async () => {
  const a = await fetch(`${BASE}/`);
  const b = await fetch(`${BASE}/`);
  const na = nonceFromCsp(a.headers.get('content-security-policy') || '');
  const nb = nonceFromCsp(b.headers.get('content-security-policy') || '');
  expect(na).toBeTruthy();
  expect(nb).toBeTruthy();
  expect(na, 'two consecutive requests must yield different nonces').not.toBe(nb);
});

test('SPA boots in a real browser under CSP (no nonce regression)', async ({ page }) => {
  // The headless browser will block any script that violates CSP and emit a
  // `securitypolicyviolation` event. We collect them; if anything from the
  // SPA's own bundle is blocked, it shows up here and the test fails.
  const violations = [];
  await page.addInitScript(() => {
    window.__cspViolations__ = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations__.push({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        sample: e.sample,
      });
    });
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  // Wait for the SPA to actually render something — if its entrypoint
  // script were blocked, the body would stay empty.
  await page.waitForSelector('body *', { timeout: 10_000 });
  const collected = await page.evaluate(() => window.__cspViolations__ || []);
  for (const v of collected) violations.push(v);
  expect(violations, `SPA must boot with no CSP violations: ${JSON.stringify(violations)}`).toEqual([]);
});

test('Inline scripts without the page nonce are blocked by CSP', async ({ page }) => {
  // Navigate first so we have a document context.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  // Inject a raw <script> with the WRONG nonce. The browser must block it
  // (CSP enforces that nonce-tagged inline scripts only run when the nonce
  // matches the page's nonce). We assert via a sentinel: the malicious
  // script tries to set window.__attackerRan__ = true — under correct CSP
  // it never runs and the sentinel stays undefined.
  const blocked = await page.evaluate(() => {
    return new Promise((resolve) => {
      let violationFired = false;
      const onV = () => { violationFired = true; };
      document.addEventListener('securitypolicyviolation', onV, { once: true });
      const s = document.createElement('script');
      s.setAttribute('nonce', 'definitely-not-the-real-nonce');
      s.textContent = 'window.__attackerRan__ = true;';
      document.head.appendChild(s);
      // Give the browser a tick to emit the violation event.
      setTimeout(() => {
        document.removeEventListener('securitypolicyviolation', onV);
        resolve({ ran: !!window.__attackerRan__, violationFired });
      }, 50);
    });
  });
  expect(blocked.ran, 'inline script with wrong nonce must NOT execute').toBe(false);
  expect(blocked.violationFired, 'browser should emit a CSP violation for the bad nonce').toBe(true);
});

test('Other defensive headers are set', async () => {
  const r = await fetch(`${BASE}/`);
  // helmet sets these; the test pins them against accidental removal.
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('x-frame-options')).toBeTruthy(); // SAMEORIGIN or DENY
  expect(r.headers.get('referrer-policy')).toBeTruthy();
  expect(r.headers.get('permissions-policy'), 'Permissions-Policy explicitly set').toMatch(/camera=\(\)/);
});
