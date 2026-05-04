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

// Same property as the test above but with N=5 servers instead of 2: a
// `changes` broadcast from any one instance must fan out via Redis pub/sub
// to clients on all the other N-1 instances. Stresses the pub/sub path
// against more subscribers than a 2-way handshake can prove.
test(`changes broadcast fans out to N server instances via Redis pub/sub (default N=5, override with REDIS_N_INSTANCES)`, async () => {
  test.setTimeout(180_000);
  if (!(await checkRedis())) {
    test.skip(true, `Redis not reachable at ${REDIS_URL}`);
  }

  // Pick N free ports starting at 3010 (clear of the dev server on 3001
  // and the 2-instance test on 3002/3003). N is configurable via env var
  // so you can stress this without editing the file:
  //   REDIS_N_INSTANCES=10 npx playwright test redis-multi-instance
  const PORT_BASE = 3010;
  const N = parseInt(process.env.REDIS_N_INSTANCES || '5', 10);
  const ports = [];
  for (let p = PORT_BASE; ports.length < N && p < PORT_BASE + 50; p++) {
    if (await isPortFree(p)) ports.push(p);
  }
  if (ports.length < N) test.skip(true, `couldn't find ${N} free ports`);

  // One user per instance. Pre-seed all of them as project members.
  const emails = Array.from({ length: N }, (_, i) => `e2e-redis-n${i}@test.local`);
  const users = [];
  for (let i = 0; i < N; i++) users.push(await seedUser(emails[i], `Redis-N User ${i}`));
  const project = await seedProject({
    name: 'Redis N-Instance Project',
    ownerId: users[0].userId,
    members: users.slice(1).map((u) => ({ userId: u.userId, role: 'editor' })),
  });

  const servers = [];
  const sockets = [];
  try {
    // Spin up all N servers in parallel — they all share the same Postgres
    // and Redis. Total cold-start ~3-5s; parallelising keeps the test fast.
    servers.push(...(await Promise.all(ports.map((p) => startServer(p)))));

    // Connect one WS client per instance and wait for each `joined` ack.
    for (let i = 0; i < N; i++) {
      const ws = await connectWs(ports[i], users[i]);
      ws.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
      await waitForMessage(ws, (m) => m.type === 'joined');
      sockets.push(ws);
    }

    // The first user (sender) emits a `changes` payload. The other N-1
    // users (each on a DIFFERENT server instance) must all receive it.
    // Set up the listeners BEFORE the send so we don't miss the broadcast
    // due to a race.
    const senderIdx = 0;
    const payload = {
      type: 'changes',
      fileId: project.fileId,
      changes: [{ from: 0, to: 0, insert: `N-FANOUT-${Date.now()}` }],
    };
    const receivers = sockets
      .map((ws, i) =>
        i === senderIdx
          ? null
          : waitForMessage(ws, (m) => m.type === 'changes' && m.fileId === project.fileId, 10_000),
      )
      .filter(Boolean);

    // Also watch the SENDER's socket: the server should NOT echo a
    // broadcast back to the originator (Redis pub/sub filters via SERVER_ID).
    let senderEcho = false;
    const echoListener = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'changes' && m.fileId === project.fileId) senderEcho = true;
      } catch {}
    };
    sockets[senderIdx].on('message', echoListener);

    sockets[senderIdx].send(JSON.stringify(payload));

    // Every receiver must get the broadcast within 10s.
    const received = await Promise.all(receivers);
    expect(received).toHaveLength(N - 1);
    for (const m of received) {
      expect(m.fileId).toBe(project.fileId);
      expect(m.changes).toEqual(payload.changes);
      expect(m.userId).toBe(users[senderIdx].userId);
    }

    // Give the sender's socket a beat to (not) receive any echo.
    await new Promise((r) => setTimeout(r, 500));
    sockets[senderIdx].removeListener('message', echoListener);
    expect(senderEcho, 'sender should not receive an echo of its own broadcast').toBe(false);
  } finally {
    for (const ws of sockets) try { ws.close(); } catch {}
    for (const s of servers) try { s.kill('SIGTERM'); } catch {}
    await cleanup(emails);
    await close();
  }
});
