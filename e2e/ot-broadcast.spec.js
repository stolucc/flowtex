// OT broadcast correctness — headless WS clients, no browser focus issues.
//
// Two simulated clients connect via WebSocket, both join the same project,
// then one client emits a 'changes' message and we assert the OTHER client
// receives it byte-identically. This is the load-bearing collaboration
// invariant; if the server's broadcast pipeline drops or mangles changes,
// this test catches it deterministically.
//
// We use Playwright's test runner only as a harness — the test itself is
// pure Node.
import { test, expect } from 'playwright/test';
import WebSocket from 'ws';
import { seedUser, seedProject, cleanup, close } from './_seed.js';

const ALICE = 'e2e-ws-alice@test.local';
const BOB = 'e2e-ws-bob@test.local';
let alice, bob, project;

test.beforeAll(async () => {
  alice = await seedUser(ALICE, 'Alice WS');
  bob = await seedUser(BOB, 'Bob WS');
  project = await seedProject({
    name: 'WS Broadcast Project',
    ownerId: alice.userId,
    members: [{ userId: bob.userId, role: 'editor' }],
  });
});

test.afterAll(async () => {
  await cleanup([ALICE, BOB]);
  await close();
});

function connectWs(seededUser) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://localhost:${process.env.PORT || 3001}/ws`, {
      rejectUnauthorized: false,
      headers: { Cookie: `__session=${seededUser.cookieValue}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 8000);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
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
      } catch { /* ignore non-JSON */ }
    };
    ws.on('message', onMsg);
  });
}

test('a "changes" broadcast from one WS client lands byte-identical on the other', async () => {
  const aliceWs = await connectWs(alice);
  const bobWs = await connectWs(bob);

  // Both join the project. Wait for the 'joined' ack on each side.
  aliceWs.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
  bobWs.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
  await Promise.all([
    waitForMessage(aliceWs, (m) => m.type === 'joined'),
    waitForMessage(bobWs, (m) => m.type === 'joined'),
  ]);

  // Alice sends a 'changes' message; Bob should receive it.
  const changeBody = {
    type: 'changes',
    fileId: project.fileId,
    changes: [{ from: 0, to: 0, insert: 'BROADCAST-TEST-PAYLOAD' }],
  };
  const bobReceives = waitForMessage(bobWs, (m) => m.type === 'changes' && m.fileId === project.fileId);
  aliceWs.send(JSON.stringify(changeBody));

  const received = await bobReceives;
  expect(received.fileId).toBe(project.fileId);
  expect(received.changes).toEqual(changeBody.changes);
  expect(received.userId).toBe(alice.userId);

  // Sender should NOT receive an echo of its own broadcast (server should
  // exclude the sender from the room broadcast).
  let echoReceived = false;
  const echoListener = (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'changes' && m.fileId === project.fileId) echoReceived = true;
    } catch {}
  };
  aliceWs.on('message', echoListener);
  await new Promise((r) => setTimeout(r, 500));
  aliceWs.removeListener('message', echoListener);
  expect(echoReceived, 'sender should not receive an echo of its own broadcast').toBe(false);

  aliceWs.close();
  bobWs.close();
});

test('changes referencing a fileId from a different project are dropped (not broadcast)', async () => {
  // Spoof attack: Bob is a member of `project` and joins it, then sends a
  // changes message with a fileId that belongs to a different project. The
  // server's per-connection fileId allowlist should reject the broadcast.
  const otherProject = await seedProject({ name: 'Other Project', ownerId: alice.userId });
  try {
    const aliceWs = await connectWs(alice);
    const bobWs = await connectWs(bob);
    aliceWs.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
    bobWs.send(JSON.stringify({ type: 'join', projectId: project.projectId }));
    await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'joined'),
      waitForMessage(bobWs, (m) => m.type === 'joined'),
    ]);

    // Bob sends a change for `otherProject.fileId` — not in `project`.
    const spoofChange = {
      type: 'changes',
      fileId: otherProject.fileId,
      changes: [{ from: 0, to: 0, insert: 'SPOOFED' }],
    };
    let aliceReceived = null;
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'changes') aliceReceived = m;
      } catch {}
    };
    aliceWs.on('message', onMsg);
    bobWs.send(JSON.stringify(spoofChange));
    await new Promise((r) => setTimeout(r, 500));
    aliceWs.removeListener('message', onMsg);

    expect(aliceReceived, 'fileId-from-different-project broadcast must be dropped').toBeNull();

    aliceWs.close();
    bobWs.close();
  } finally {
    // Project cleanup is implicit when users are deleted (FK cascade)
  }
});
