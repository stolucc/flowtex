// Chat end-to-end: WS broadcast + REST history.
//
// Two seeded users in a shared project. Both connect via WebSocket. When
// one sends a `chat` message, BOTH receive the broadcast (chat is fan-out
// to everyone in the room — including the sender, since the user expects
// their own message to appear in the list). The message also persists to
// `chat_messages` and is later returned by GET /api/chat/:projectId in
// chronological order.
//
// Also covers: empty messages are dropped, oversized messages are
// truncated server-side at 5000 chars, and non-members can't read history.
import { test, expect } from 'playwright/test';
import WebSocket from 'ws';
import { seedUser, seedProject, cleanup, close } from './_seed.js';

const ALICE = 'e2e-chat-alice@test.local';
const BOB = 'e2e-chat-bob@test.local';
const STRANGER = 'e2e-chat-stranger@test.local';

const BASE = process.env.E2E_BASE_URL || `https://localhost:${process.env.PORT || 3001}`;

let alice, bob, stranger, project;

test.beforeAll(async () => {
  alice = await seedUser(ALICE, 'Alice Chat');
  bob = await seedUser(BOB, 'Bob Chat');
  stranger = await seedUser(STRANGER, 'Stranger Chat');
  project = await seedProject({
    name: 'Chat Test Project',
    ownerId: alice.userId,
    members: [{ userId: bob.userId, role: 'editor' }],
    // Note: stranger is NOT added to the project — they should be denied.
  });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});

test.afterAll(async () => {
  await cleanup([ALICE, BOB, STRANGER]);
  await close();
});

function connectWs(seededUser) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, {
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
      } catch {}
    };
    ws.on('message', onMsg);
  });
}

async function joinProject(ws, projectId) {
  ws.send(JSON.stringify({ type: 'join', projectId }));
  return waitForMessage(ws, (m) => m.type === 'joined');
}

test('chat: a message from one client broadcasts to all clients in the project room', async () => {
  const aliceWs = await connectWs(alice);
  const bobWs = await connectWs(bob);
  try {
    await Promise.all([joinProject(aliceWs, project.projectId), joinProject(bobWs, project.projectId)]);

    const text = `Hello from Alice — ${Date.now()}`;
    const aliceReceives = waitForMessage(aliceWs, (m) => m.type === 'chat' && m.text === text);
    const bobReceives = waitForMessage(bobWs, (m) => m.type === 'chat' && m.text === text);
    aliceWs.send(JSON.stringify({ type: 'chat', text }));
    const [aliceMsg, bobMsg] = await Promise.all([aliceReceives, bobReceives]);

    // Both receivers see the same shape, with sender's identity attached
    // server-side (clients can't spoof userId/userName).
    for (const m of [aliceMsg, bobMsg]) {
      expect(m.text).toBe(text);
      expect(m.userId).toBe(alice.userId);
      expect(m.userName).toBe('Alice Chat');
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.created_at).toBe('string');
    }
  } finally {
    aliceWs.close();
    bobWs.close();
  }
});

test('chat: empty / whitespace-only messages are dropped server-side', async () => {
  const aliceWs = await connectWs(alice);
  const bobWs = await connectWs(bob);
  try {
    await Promise.all([joinProject(aliceWs, project.projectId), joinProject(bobWs, project.projectId)]);

    let bobReceived = null;
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'chat') bobReceived = m;
      } catch {}
    };
    bobWs.on('message', onMsg);

    aliceWs.send(JSON.stringify({ type: 'chat', text: '' }));
    aliceWs.send(JSON.stringify({ type: 'chat', text: '   \n\t  ' }));
    aliceWs.send(JSON.stringify({ type: 'chat' })); // missing text

    await new Promise((r) => setTimeout(r, 600));
    bobWs.removeListener('message', onMsg);
    expect(bobReceived, 'empty/whitespace chat must not broadcast').toBeNull();
  } finally {
    aliceWs.close();
    bobWs.close();
  }
});

test('chat: oversized messages are truncated to 5000 chars before persist + broadcast', async () => {
  const aliceWs = await connectWs(alice);
  const bobWs = await connectWs(bob);
  try {
    await Promise.all([joinProject(aliceWs, project.projectId), joinProject(bobWs, project.projectId)]);

    const huge = 'A'.repeat(7000);
    const bobReceives = waitForMessage(bobWs, (m) => m.type === 'chat' && m.text.startsWith('A'));
    aliceWs.send(JSON.stringify({ type: 'chat', text: huge }));

    const got = await bobReceives;
    expect(got.text.length).toBe(5000);
    expect(got.text).toBe('A'.repeat(5000));
  } finally {
    aliceWs.close();
    bobWs.close();
  }
});

test('chat: GET /api/chat/:projectId returns history in chronological order', async () => {
  // Seed three messages via WS, then fetch history. Use unique markers so
  // we can pick our messages out of any leftover history from earlier tests.
  const aliceWs = await connectWs(alice);
  const bobWs = await connectWs(bob);
  try {
    await Promise.all([joinProject(aliceWs, project.projectId), joinProject(bobWs, project.projectId)]);

    const stamp = Date.now();
    const m1 = `chat-history-1-${stamp}`;
    const m2 = `chat-history-2-${stamp}`;
    const m3 = `chat-history-3-${stamp}`;

    // Wait for each broadcast to land before sending the next, so the DB
    // ordering is unambiguous (created_at has ms resolution; rapid-fire
    // sends could otherwise tie).
    const wait = (ws, text) => waitForMessage(ws, (m) => m.type === 'chat' && m.text === text);
    aliceWs.send(JSON.stringify({ type: 'chat', text: m1 }));
    await wait(bobWs, m1);
    bobWs.send(JSON.stringify({ type: 'chat', text: m2 }));
    await wait(aliceWs, m2);
    aliceWs.send(JSON.stringify({ type: 'chat', text: m3 }));
    await wait(bobWs, m3);

    const r = await fetch(`${BASE}/api/chat/${project.projectId}`, {
      headers: { Cookie: `__session=${alice.cookieValue}` },
    });
    expect(r.ok).toBe(true);
    const body = await r.json();
    const messages = Array.isArray(body) ? body : body.messages;
    const ours = messages.filter((m) => m.text === m1 || m.text === m2 || m.text === m3);
    expect(ours.map((m) => m.text)).toEqual([m1, m2, m3]);
    expect(ours[0].userName).toBe('Alice Chat');
    expect(ours[1].userName).toBe('Bob Chat');
    expect(ours[2].userName).toBe('Alice Chat');
  } finally {
    aliceWs.close();
    bobWs.close();
  }
});

test('chat: non-member is blocked from reading history (403)', async () => {
  const r = await fetch(`${BASE}/api/chat/${project.projectId}`, {
    headers: { Cookie: `__session=${stranger.cookieValue}` },
  });
  expect(r.status).toBe(403);
});

test('chat: history endpoint requires a valid UUID (rejects garbage)', async () => {
  const r = await fetch(`${BASE}/api/chat/not-a-uuid`, {
    headers: { Cookie: `__session=${alice.cookieValue}` },
  });
  expect(r.status).toBe(400);
});

test('chat: history endpoint requires authentication', async () => {
  const r = await fetch(`${BASE}/api/chat/${project.projectId}`);
  expect([401, 403]).toContain(r.status);
});
