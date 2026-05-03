// Multi-instance / Redis horizontal-scaling test.
//
// Spins up TWO server instances (ports 3002 + 3003) backed by the same
// Postgres + the same local Redis. WS clients connect to different instances,
// join the same project, and we assert a `changes` broadcast from instance A
// reaches a client on instance B (impossible without Redis pub/sub).
//
// Skipped automatically when REDIS_URL is unreachable.
import { test, expect } from 'playwright/test';
import WebSocket from 'ws';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedUser, seedProject, cleanup, close } from './_seed.js';

const REPO = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const SERVER_ENTRY = path.join(REPO, 'server', 'index.js');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

async function checkRedis() {
  const Redis = (await import('ioredis')).default;
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try { await r.connect(); await r.ping(); await r.quit(); return true; }
  catch { return false; }
}

// Read .env ourselves so we can merge it under our PORT/REDIS_URL overrides.
// Node's `--env-file` was overriding the spawn-injected env in this version,
// putting both spawned servers on the same port as the dev server (3001).
function loadDotenv() {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}
const DOTENV = loadDotenv();

function startServer(port) {
  return new Promise((resolve, reject) => {
    // Merge order matters: real process.env first, then .env values, then OUR
    // overrides last so port + REDIS_URL win over .env's PORT=3001.
    const env = {
      ...process.env,
      ...DOTENV,
      PORT: String(port),
      REDIS_URL,
      DISABLE_TLS_REDIRECT: '1',
    };
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: path.join(REPO, 'server'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    let lastOutput = '';
    const log = fs.createWriteStream(`/tmp/flowtex-server-${port}.log`);
    const onLine = (buf) => {
      const s = buf.toString();
      lastOutput += s;
      log.write(s);
      if (!ready && s.includes('FlowTex server running on')) {
        ready = true;
        resolve(proc);
      }
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!ready) reject(new Error(`Server on port ${port} exited early with code ${code}. Last output:\n${lastOutput.slice(-2000)}`));
    });
    setTimeout(() => {
      if (!ready) {
        try { proc.kill('SIGTERM'); } catch {}
        reject(new Error(`Server on port ${port} did not become ready in 45s. Last output:\n${lastOutput.slice(-2000)}`));
      }
    }, 45000);
  });
}

function connectWs(port, seededUser) {
  return new Promise((resolve, reject) => {
    // The spawned server uses the same `server/certs/` HTTPS bundle as the
    // dev server, so we connect over wss://.
    const ws = new WebSocket(`wss://localhost:${port}/ws`, {
      rejectUnauthorized: false,
      headers: {
        Cookie: `__session=${seededUser.cookieValue}`,
        Origin: `https://localhost:${port}`,
      },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 8000);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error('No matching WS message within ' + timeoutMs + 'ms'));
    }, timeoutMs);
    const onMsg = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeListener('message', onMsg);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', onMsg);
  });
}

test('changes broadcast crosses server instances via Redis pub/sub', async () => {
  test.setTimeout(120_000); // two server starts + DB seeding + test
  // Pre-flight checks
  if (!(await checkRedis())) {
    test.skip(true, `Redis not reachable at ${REDIS_URL}`);
  }
  const portA = 3002;
  const portB = 3003;
  if (!(await isPortFree(portA)) || !(await isPortFree(portB))) {
    test.skip(true, `port ${portA} or ${portB} in use`);
  }

  // Seed users + a shared project before bringing up the servers.
  const alice = await seedUser('e2e-redis-alice@test.local', 'Alice Redis');
  const bob = await seedUser('e2e-redis-bob@test.local', 'Bob Redis');
  const project = await seedProject({
    name: 'Redis Multi-Instance Project',
    ownerId: alice.userId,
    members: [{ userId: bob.userId, role: 'editor' }],
  });

  // Bring up two server instances pointed at the same DB + Redis.
  let serverA, serverB;
  try {
    [serverA, serverB] = await Promise.all([startServer(portA), startServer(portB)]);

    // Alice connects to A, Bob to B.
    const aliceWs = await connectWs(portA, alice);
    const bobWs = await connectWs(portB, bob);

    aliceWs.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
    bobWs.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
    await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'joined'),
      waitForMessage(bobWs, (m) => m.type === 'joined'),
    ]);

    // Alice (on instance A) emits a `changes` message; Bob (on instance B)
    // receives it ONLY because Redis pub/sub fans out across instances.
    const payload = {
      type: 'changes',
      fileId: project.fileId,
      changes: [{ from: 0, to: 0, insert: 'CROSS-INSTANCE-BROADCAST' }],
    };
    const bobReceives = waitForMessage(bobWs, (m) => m.type === 'changes' && m.fileId === project.fileId);
    aliceWs.send(JSON.stringify(payload));

    const received = await bobReceives;
    expect(received.fileId).toBe(project.fileId);
    expect(received.changes).toEqual(payload.changes);
    expect(received.userId).toBe(alice.userId);

    aliceWs.close();
    bobWs.close();
  } finally {
    if (serverA) serverA.kill('SIGTERM');
    if (serverB) serverB.kill('SIGTERM');
    await cleanup(['e2e-redis-alice@test.local', 'e2e-redis-bob@test.local']);
    await close();
  }
});
