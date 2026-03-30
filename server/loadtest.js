import http from 'http';
import { WebSocket } from 'ws';
import db from './db.js';

const BASE = 'http://localhost:3001';
const WS_URL = 'ws://localhost:3001/ws';
const NUM_USERS = parseInt(process.argv[2] || '100');
const CONCURRENT_BATCH = 50;
const COMPILE_BATCH = 100; // concurrent compilations at a time
const EMSE_PROJECT_ID = '6c09cf5d-1a63-46fa-9b2f-6a9c6b5d66aa';

const stats = {
  registrations: { ok: 0, fail: 0, times: [] },
  logins: { ok: 0, fail: 0, times: [] },
  addMember: { ok: 0, fail: 0, times: [] },
  projectList: { ok: 0, fail: 0, times: [] },
  compile: { ok: 0, fail: 0, times: [] },
  ws: { ok: 0, fail: 0, times: [] },
};

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const start = Date.now();
    const req = http.request(url, { method, headers }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - start;
        const rawBody = Buffer.concat(chunks).toString();
        let json;
        try {
          json = JSON.parse(rawBody);
        } catch {
          json = rawBody;
        }
        const setCookie = res.headers['set-cookie'];
        let sessionCookie = cookie;
        let csrfToken = null;
        if (setCookie) {
          for (const c of setCookie) {
            const sidMatch = c.match(/(connect\.sid=[^;]+)/);
            if (sidMatch) sessionCookie = sidMatch[1];
            const csrfMatch = c.match(/csrf-token=([^;]+)/);
            if (csrfMatch) csrfToken = csrfMatch[1];
          }
        }
        resolve({ status: res.statusCode, json, cookie: sessionCookie, csrfToken, elapsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

function requestWithCsrf(method, path, body, cookie, csrfToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) {
      headers['Cookie'] = cookie + (csrfToken ? `; csrf-token=${csrfToken}` : '');
    }
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const start = Date.now();
    const req = http.request(url, { method, headers }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - start;
        const rawBody = Buffer.concat(chunks).toString();
        let json;
        try {
          json = JSON.parse(rawBody);
        } catch {
          json = rawBody;
        }
        const setCookie = res.headers['set-cookie'];
        let sessionCookie = cookie;
        let newCsrf = csrfToken;
        if (setCookie) {
          for (const c of setCookie) {
            const sidMatch = c.match(/(connect\.sid=[^;]+)/);
            if (sidMatch) sessionCookie = sidMatch[1];
            const csrfMatch = c.match(/csrf-token=([^;]+)/);
            if (csrfMatch) newCsrf = csrfMatch[1];
          }
        }
        resolve({ status: res.statusCode, json, cookie: sessionCookie, csrfToken: newCsrf, elapsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function printStats(label, s) {
  if (s.times.length === 0) return;
  const avg = (s.times.reduce((a, b) => a + b, 0) / s.times.length).toFixed(0);
  const p50 = percentile(s.times, 50);
  const p95 = percentile(s.times, 95);
  const p99 = percentile(s.times, 99);
  const min = Math.min(...s.times);
  const max = Math.max(...s.times);
  console.log(
    `  ${label.padEnd(16)} ok=${String(s.ok).padStart(5)} fail=${String(s.fail).padStart(5)}  avg=${String(avg).padStart(5)}ms  p50=${String(p50).padStart(5)}ms  p95=${String(p95).padStart(5)}ms  p99=${String(p99).padStart(5)}ms  min=${String(min).padStart(5)}ms  max=${String(max).padStart(5)}ms`,
  );
}

async function runBatch(items, batchSize, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i % (batchSize * 4) === 0 && i > 0) {
      process.stdout.write(`  ...${i}/${items.length}\r`);
    }
  }
}

async function main() {
  console.log(`\n=== FlowTex Load Test: ${NUM_USERS} users ===`);
  console.log(`  Target project: EMSE 2 (${EMSE_PROJECT_ID})\n`);
  const startTotal = Date.now();

  // Verify the target project exists
  const targetProject = await db.get('SELECT id, name, main_file FROM projects WHERE id = $1', [EMSE_PROJECT_ID]);
  if (!targetProject) {
    console.error(`  ERROR: Project ${EMSE_PROJECT_ID} not found!`);
    process.exit(1);
  }
  console.log(`  Target: "${targetProject.name}" (main: ${targetProject.main_file})`);

  // Generate user data
  const users = Array.from({ length: NUM_USERS }, (_, i) => ({
    email: `loadtest${i}@test.com`,
    name: `LoadUser ${i}`,
    password: `TestPass${i}!Aa1`,
    cookie: null,
    csrfToken: null,
    userId: null,
  }));

  // Phase 1: Register all users
  console.log('Phase 1: Registering users...');
  const regStart = Date.now();
  await runBatch(users, CONCURRENT_BATCH, async (user) => {
    try {
      const res = await request('POST', '/api/auth/register', {
        email: user.email,
        name: user.name,
        password: user.password,
      });
      if (res.status === 200) {
        stats.registrations.ok++;
        user.cookie = res.cookie;
        user.csrfToken = res.csrfToken;
        user.userId = res.json?.id;
      } else {
        stats.registrations.fail++;
      }
      stats.registrations.times.push(res.elapsed);
    } catch (e) {
      stats.registrations.fail++;
    }
  });
  console.log(
    `  Done in ${((Date.now() - regStart) / 1000).toFixed(1)}s — ${stats.registrations.ok} ok, ${stats.registrations.fail} fail`,
  );

  // Phase 2: Logout and login all users
  console.log('Phase 2: Logging in users...');
  const loginStart = Date.now();
  await runBatch(users, CONCURRENT_BATCH, async (user) => {
    try {
      if (user.cookie) {
        await requestWithCsrf('POST', '/api/auth/logout', {}, user.cookie, user.csrfToken);
      }
      const res = await request('POST', '/api/auth/login', {
        email: user.email,
        password: user.password,
      });
      if (res.status === 200 && res.json?.id) {
        stats.logins.ok++;
        user.cookie = res.cookie;
        user.csrfToken = res.csrfToken;
        user.userId = res.json.id;
      } else {
        stats.logins.fail++;
      }
      stats.logins.times.push(res.elapsed);
    } catch (e) {
      stats.logins.fail++;
    }
  });
  console.log(
    `  Done in ${((Date.now() - loginStart) / 1000).toFixed(1)}s — ${stats.logins.ok} ok, ${stats.logins.fail} fail`,
  );

  // Phase 3: Add all users as members of EMSE 2 project (direct DB insert)
  console.log('Phase 3: Adding users as members of EMSE 2...');
  const memberStart = Date.now();
  for (const user of users) {
    if (!user.userId) {
      stats.addMember.fail++;
      continue;
    }
    try {
      const start = Date.now();
      await db.run(
        'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [EMSE_PROJECT_ID, user.userId, 'editor'],
      );
      stats.addMember.ok++;
      stats.addMember.times.push(Date.now() - start);
    } catch (e) {
      stats.addMember.fail++;
    }
  }
  console.log(
    `  Done in ${((Date.now() - memberStart) / 1000).toFixed(1)}s — ${stats.addMember.ok} ok, ${stats.addMember.fail} fail`,
  );

  // Phase 4: List projects (all users concurrently)
  console.log('Phase 4: Listing projects...');
  const listStart = Date.now();
  await runBatch(users, CONCURRENT_BATCH * 2, async (user) => {
    if (!user.cookie) {
      stats.projectList.fail++;
      return;
    }
    try {
      const res = await requestWithCsrf('GET', '/api/projects', null, user.cookie, user.csrfToken);
      if (res.status === 200) {
        stats.projectList.ok++;
      } else {
        stats.projectList.fail++;
      }
      stats.projectList.times.push(res.elapsed);
    } catch (e) {
      stats.projectList.fail++;
    }
  });
  console.log(
    `  Done in ${((Date.now() - listStart) / 1000).toFixed(1)}s — ${stats.projectList.ok} ok, ${stats.projectList.fail} fail`,
  );

  // Phase 5: All 1000 users compile the EMSE 2 project
  console.log(`Phase 5: Compiling EMSE 2 (${NUM_USERS} users, ${COMPILE_BATCH} concurrent)...`);
  const compileStart = Date.now();
  const compileUsers = users.filter((u) => u.cookie);
  let compileProgress = 0;
  await runBatch(compileUsers, COMPILE_BATCH, async (user) => {
    try {
      const res = await requestWithCsrf('POST', `/api/compile/${EMSE_PROJECT_ID}`, {}, user.cookie, user.csrfToken);
      if (res.status === 200 && res.json?.success) {
        stats.compile.ok++;
      } else {
        stats.compile.fail++;
      }
      stats.compile.times.push(res.elapsed);
    } catch (e) {
      stats.compile.fail++;
    }
    compileProgress++;
    if (compileProgress % 50 === 0) {
      process.stdout.write(`  ...${compileProgress}/${compileUsers.length}\r`);
    }
  });
  console.log(
    `  Done in ${((Date.now() - compileStart) / 1000).toFixed(1)}s — ${stats.compile.ok} ok, ${stats.compile.fail} fail`,
  );

  // Phase 6: WebSocket connections (200 users join EMSE 2)
  console.log('Phase 6: WebSocket connections (200 users)...');
  const wsStart = Date.now();
  const wsUsers = users.filter((u) => u.cookie).slice(0, 200);
  const wsSockets = [];
  await runBatch(wsUsers, 50, async (user) => {
    try {
      const start = Date.now();
      const ws = await new Promise((resolve, reject) => {
        const s = new WebSocket(WS_URL, { headers: { Cookie: user.cookie } });
        const timer = setTimeout(() => {
          s.terminate();
          reject(new Error('ws timeout'));
        }, 10000);
        s.on('open', () => {
          clearTimeout(timer);
          resolve(s);
        });
        s.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      ws.send(JSON.stringify({ type: 'join', projectId: EMSE_PROJECT_ID }));
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), 3000);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'joined' || msg.type === 'presence') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      stats.ws.ok++;
      stats.ws.times.push(Date.now() - start);
      wsSockets.push(ws);
    } catch (e) {
      stats.ws.fail++;
    }
  });
  console.log(`  Done in ${((Date.now() - wsStart) / 1000).toFixed(1)}s — ${stats.ws.ok} ok, ${stats.ws.fail} fail`);

  // Cleanup: close WS connections
  for (const ws of wsSockets) ws.close();

  // Results
  const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
  console.log(`\n=== Results (${totalTime}s total) ===\n`);
  printStats('Register', stats.registrations);
  printStats('Login', stats.logins);
  printStats('Add Member', stats.addMember);
  printStats('Project List', stats.projectList);
  printStats('Compile', stats.compile);
  printStats('WebSocket', stats.ws);

  const totalOk = Object.values(stats).reduce((s, v) => s + v.ok, 0);
  const totalFail = Object.values(stats).reduce((s, v) => s + v.fail, 0);
  console.log(
    `\n  Total: ${totalOk} ok, ${totalFail} failed (${((totalFail / (totalOk + totalFail)) * 100).toFixed(1)}% error rate)\n`,
  );

  // Cleanup: delete test users (this also removes them from project_members)
  console.log('Cleaning up test users...');
  let cleaned = 0;
  await runBatch(users, CONCURRENT_BATCH, async (user) => {
    if (!user.cookie) return;
    try {
      await requestWithCsrf(
        'POST',
        '/api/auth/delete-account',
        { password: user.password },
        user.cookie,
        user.csrfToken,
      );
      cleaned++;
    } catch {}
  });
  console.log(`  Cleaned up ${cleaned} users.\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
