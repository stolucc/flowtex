// End-to-end compile: create a project, compile its default LaTeX file,
// and verify a real PDF comes back from /api/compile/:projectId/pdf.
//
// Skips gracefully when `latexmk`/`pdflatex` aren't on the server's PATH
// (e.g. CI without TeX Live). Locally, a TeX Live install lights this up
// and exercises the full compile pipeline end-to-end.
import { test, expect } from 'playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { seedUser, cleanup, close } from './_seed.js';

const exec = promisify(execFile);
const BASE = process.env.E2E_BASE_URL || `https://localhost:${process.env.PORT || 3001}`;

let user;

test.beforeAll(async () => {
  user = await seedUser('e2e-compile@test.local', 'Compile Test');
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});

test.afterAll(async () => {
  await cleanup(['e2e-compile@test.local']);
  await close();
});

async function texAvailable() {
  // The compile route shells out to `latexmk` (driving pdflatex). Both
  // need to be on the server-process PATH. Test runs in the same OS, so
  // checking here approximates what the server will see.
  try {
    await exec('latexmk', ['-v'], { timeout: 3000 });
    await exec('pdflatex', ['-v'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function authedFetch(method, path, options = {}) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      Cookie: `__session=${user.cookieValue}`,
      Origin: BASE,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-CSRF-Token': user.csrfToken,
      ...(options.headers || {}),
    },
    ...(options.body ? { body: options.body } : {}),
  });
}

test('compile: create project → compile → PDF is produced and fetchable', async () => {
  if (!(await texAvailable())) {
    test.skip(true, 'latexmk/pdflatex not on PATH — install TeX Live to run this test');
  }
  test.setTimeout(120_000); // a cold latexmk run can take 30-60s

  // 1. Create a fresh project. The seed helper bootstrapped the admin gate
  // and the user; here we exercise the real REST endpoint with proper CSRF.
  const createR = await authedFetch('POST', '/api/projects', {
    body: JSON.stringify({ name: `Compile Smoke ${Date.now()}` }),
  });
  expect(createR.ok, `project create failed: ${createR.status}`).toBe(true);
  const project = await createR.json();
  expect(project.id).toBeTruthy();

  // 2. The project comes with a default main.tex containing a minimal
  // \documentclass{article} document. Verify it's there before compiling
  // — if it isn't we'd hit a confusing "no such file" later.
  const filesR = await authedFetch('GET', `/api/projects/${project.id}/files`);
  expect(filesR.ok).toBe(true);
  const files = await filesR.json();
  const main = files.find((f) => f.path === 'main.tex');
  expect(main, 'expected default main.tex on a fresh project').toBeTruthy();
  expect(main.content).toMatch(/\\documentclass/);

  // 3. Compile via the synchronous endpoint. Returns { success, log }.
  const compileR = await authedFetch('POST', `/api/compile/${project.id}`, {
    body: JSON.stringify({}),
  });
  const compileBody = await compileR.json();
  if (!compileR.ok || !compileBody.success) {
    // Surface the latex log so a real failure (e.g. missing class) is debuggable.
    throw new Error(`compile failed (status ${compileR.status}): ${compileBody.log?.slice(0, 800) || compileBody.error}`);
  }
  expect(compileBody.success).toBe(true);
  // The latexmk log should mention pdfTeX in any successful run.
  expect(compileBody.log).toMatch(/pdfTeX|pdflatex|Output written/i);

  // 4. Fetch the produced PDF. Server returns it from /api/compile/:id/pdf
  // with a content-type of application/pdf and a non-trivial body.
  const pdfR = await authedFetch('GET', `/api/compile/${project.id}/pdf`);
  expect(pdfR.ok, `pdf fetch returned ${pdfR.status}`).toBe(true);
  expect(pdfR.headers.get('content-type')).toMatch(/application\/pdf/);
  const pdfBytes = new Uint8Array(await pdfR.arrayBuffer());
  // PDFs start with the 4-byte magic "%PDF".
  expect(pdfBytes.length).toBeGreaterThan(1024);
  expect(String.fromCharCode(...pdfBytes.slice(0, 4))).toBe('%PDF');

  // 5. Cleanup: delete the project so it doesn't clutter the dev DB.
  const delR = await authedFetch('DELETE', `/api/projects/${project.id}`);
  expect([200, 204]).toContain(delR.status);
});

test('compile: non-member cannot trigger a compile on someone else\'s project', async () => {
  if (!(await texAvailable())) {
    test.skip(true, 'latexmk/pdflatex not on PATH — install TeX Live to run this test');
  }
  // Create a victim user with their own project; the probe user (who has
  // no membership in it) tries to compile and should be rejected.
  const victim = await seedUser('e2e-compile-victim@test.local', 'Compile Victim');
  try {
    const createR = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__session=${victim.cookieValue}`,
        'X-CSRF-Token': victim.csrfToken,
        Origin: BASE,
      },
      body: JSON.stringify({ name: 'Victim project for compile probe' }),
    });
    const victimProj = await createR.json();

    const r = await authedFetch('POST', `/api/compile/${victimProj.id}`, { body: JSON.stringify({}) });
    expect([401, 403, 404]).toContain(r.status);
  } finally {
    await cleanup(['e2e-compile-victim@test.local']);
  }
});
