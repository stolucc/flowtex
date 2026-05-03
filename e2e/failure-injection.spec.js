// Selective failure-injection: scenarios that are safe to run against the
// live dev server. Each test verifies the server degrades gracefully —
// returns a structured error or recovers — rather than hanging, leaking,
// or 500'ing.
//
// Excluded by design (run against staging if you want them):
//   - Kill Postgres mid-edit       (risks user data + breaks running soaks)
//   - Fill the disk                (affects everything else on the host)
//   - Force-OOM the server         (kills your dev session)
//
// Each test brings up a brand-new server instance on a unique port so it
// doesn't share state with the running dev server (PID 59734) or the soak.
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

async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...DOTENV, PORT: String(port), DISABLE_TLS_REDIRECT: '1' };
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: path.join(REPO, 'server'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    let log = '';
    const onLine = (buf) => {
      log += buf.toString();
      if (!ready && log.includes('FlowTex server running on')) {
        ready = true;
        resolve(proc);
      }
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    proc.on('error', reject);
    setTimeout(() => {
      if (!ready) {
        try { proc.kill('SIGTERM'); } catch {}
        reject(new Error(`Server on ${port} didn't start in 45s. Last:\n${log.slice(-1500)}`));
      }
    }, 45000);
  });
}

async function findFreePort(start = 3010) {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port found');
}

test('abrupt WS close — server handles disconnection without erroring', async () => {
  test.setTimeout(120_000);
  const port = await findFreePort();
  const server = await startServer(port);
  const alice = await seedUser('e2e-fi-alice@test.local', 'Alice FI');
  const project = await seedProject({ name: 'FI Test', ownerId: alice.userId });

  try {
    // Open ten WS connections, each joins the project, sends a message,
    // then is destroyed without an orderly close handshake. Server must:
    //   - clean up the room entry for each
    //   - not log an unhandled error
    //   - continue accepting new connections
    const N = 10;
    const sockets = [];
    for (let i = 0; i < N; i++) {
      const ws = new WebSocket(`wss://localhost:${port}/ws`, {
        rejectUnauthorized: false,
        headers: { Cookie: `__session=${alice.cookieValue}`, Origin: `https://localhost:${port}` },
      });
      await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
      ws.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
      sockets.push(ws);
    }
    // Brief settle, then yank.
    await new Promise((r) => setTimeout(r, 300));
    for (const ws of sockets) {
      // _socket.destroy() bypasses the WS close handshake — exactly what a
      // network drop or browser tab kill looks like to the server.
      ws._socket?.destroy();
    }
    // Give the server a moment to process the disconnect events.
    await new Promise((r) => setTimeout(r, 500));

    // Verify the server is still healthy by opening a fresh connection.
    const probe = new WebSocket(`wss://localhost:${port}/ws`, {
      rejectUnauthorized: false,
      headers: { Cookie: `__session=${alice.cookieValue}`, Origin: `https://localhost:${port}` },
    });
    await new Promise((r, j) => { probe.on('open', r); probe.on('error', j); });
    probe.close();
    expect(true).toBe(true); // reaching here means the server survived
  } finally {
    server.kill('SIGTERM');
    await cleanup(['e2e-fi-alice@test.local']);
    await close();
  }
});

test('huge oversized WS payload — server rejects without crashing', async () => {
  test.setTimeout(120_000);
  const port = await findFreePort();
  const server = await startServer(port);
  const alice = await seedUser('e2e-fi-alice2@test.local', 'Alice FI2');
  const project = await seedProject({ name: 'FI Test 2', ownerId: alice.userId });

  try {
    const ws = new WebSocket(`wss://localhost:${port}/ws`, {
      rejectUnauthorized: false,
      headers: { Cookie: `__session=${alice.cookieValue}`, Origin: `https://localhost:${port}` },
    });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
    await new Promise((r) => setTimeout(r, 200));

    // Server's WS maxPayload is 4 MiB. Try to send 8 MiB.
    const big = 'x'.repeat(8 * 1024 * 1024);
    let socketClosed = false;
    ws.on('close', () => { socketClosed = true; });
    try {
      ws.send(JSON.stringify({ type: 'changes', fileId: project.fileId, changes: [{ from: 0, insert: big }] }));
    } catch { /* expected — node ws may throw on send too */ }
    // Wait for the server to enforce the limit.
    await new Promise((r) => setTimeout(r, 500));
    expect(socketClosed, 'oversized payload should cause the server to drop the connection').toBe(true);

    // Server is still alive — open another connection.
    const probe = new WebSocket(`wss://localhost:${port}/ws`, {
      rejectUnauthorized: false,
      headers: { Cookie: `__session=${alice.cookieValue}`, Origin: `https://localhost:${port}` },
    });
    await new Promise((r, j) => { probe.on('open', r); probe.on('error', j); });
    probe.close();
  } finally {
    server.kill('SIGTERM');
    await cleanup(['e2e-fi-alice2@test.local']);
    await close();
  }
});

test('malformed WS message — server stays up', async () => {
  test.setTimeout(120_000);
  const port = await findFreePort();
  const server = await startServer(port);
  const alice = await seedUser('e2e-fi-alice3@test.local', 'Alice FI3');
  const project = await seedProject({ name: 'FI Test 3', ownerId: alice.userId });

  try {
    const ws = new WebSocket(`wss://localhost:${port}/ws`, {
      rejectUnauthorized: false,
      headers: { Cookie: `__session=${alice.cookieValue}`, Origin: `https://localhost:${port}` },
    });
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
    await new Promise((r) => setTimeout(r, 200));

    // Throw garbage at the message handler:
    //   - non-JSON
    //   - JSON without a `type` field
    //   - unknown message type
    //   - cursor with non-numeric coords
    //   - changes with the wrong shape
    const garbage = [
      'this is not json {][',
      JSON.stringify({ no: 'type' }),
      JSON.stringify({ type: 'mystery-message' }),
      JSON.stringify({ type: 'cursor', head: 'not-a-number', anchor: 'also-not', fileId: project.fileId }),
      JSON.stringify({ type: 'changes', fileId: project.fileId, changes: 'should be array' }),
    ];
    for (const msg of garbage) {
      ws.send(msg);
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));

    // Connection should still be open and server still serving.
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(JSON.stringify({
      type: 'cursor',
      head: 0, anchor: 0,
      fileId: project.fileId,
    }));
    // No assertion on the cursor message — the test is "garbage doesn't kill it".
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
  } finally {
    server.kill('SIGTERM');
    await cleanup(['e2e-fi-alice3@test.local']);
    await close();
  }
});
