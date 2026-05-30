// Pins the security-critical behaviour of the unauthenticated
// invitation endpoints added for the unregistered-invitee flow.
// Both endpoints are mounted OUTSIDE requireAuth (callers haven't
// signed in by definition); the safety promises live entirely in
// the handlers, so regressions here are real regressions.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../utils/audit.js', () => ({
  auditLog: vi.fn(() => Promise.resolve()),
}));
vi.mock('../utils/email.js', () => ({
  sendInvitationDeclinedEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock('../middleware/errorHandler.js', () => ({
  sendError: vi.fn((res, err) => res.status(err.status || 500).json({ error: err.message })),
}));

import db from '../db.js';
import { auditLog } from '../utils/audit.js';
import { sendInvitationDeclinedEmail } from '../utils/email.js';
import router from '../routes/publicInvitations.js';

function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        const handlers = layer.route.stack;
        return handlers[handlers.length - 1].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

function mockReq({ params = {}, body = {}, ip = '127.0.0.1', app = {} } = {}) {
  return { params, body, ip, app: { locals: {}, ...app } };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (code) { res.statusCode = code; return res; }),
    json: vi.fn(function (data) { res.body = data; return res; }),
  };
  return res;
}

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

// ── GET /api/invitations/public/:id ─────────────────────────────────────

describe('GET /public/:id — invitation lookup for the AuthPage', () => {
  let handler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = getHandler('get', '/public/:id');
  });

  it('rejects a malformed invitation id with 400', async () => {
    const res = mockRes();
    await handler(mockReq({ params: { id: 'not-a-uuid' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    // No DB lookup attempted on malformed input.
    expect(db.get).not.toHaveBeenCalled();
  });

  it('returns 404 when no invitation matches the id', async () => {
    db.get.mockResolvedValueOnce(null);
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('returns full context (including email) when the recipient is unregistered', async () => {
    db.get
      .mockResolvedValueOnce({
        email: 'newbie@example.com',
        status: 'pending',
        project_name: 'My Paper',
        inviter_name: 'Alice',
      })
      .mockResolvedValueOnce(null); // no account row for that email
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      email: 'newbie@example.com',
      projectName: 'My Paper',
      inviterName: 'Alice',
      status: 'pending',
      hasAccount: false,
    });
  });

  it('HIDES the email when the recipient already has an account (audit L1)', async () => {
    // Already-registered recipients are sent to login mode, which
    // doesn't prefill the email — so there's no reason to return it.
    // Brute-forcing invitation UUIDs to enumerate FlowTex users is
    // (theoretical) blocked at this gate.
    db.get
      .mockResolvedValueOnce({
        email: 'known@example.com',
        status: 'pending',
        project_name: 'My Paper',
        inviter_name: 'Alice',
      })
      .mockResolvedValueOnce({}); // user row exists
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.hasAccount).toBe(true);
    expect(res.body.email).toBeNull();
    // Other fields still come through so the banner can render.
    expect(res.body.projectName).toBe('My Paper');
    expect(res.body.inviterName).toBe('Alice');
  });
});

// ── POST /api/invitations/by-token/decline ──────────────────────────────

describe('POST /by-token/decline — token-gated decline', () => {
  let handler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = getHandler('post', '/by-token/decline');
  });

  it('rejects empty token with 400', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { token: '' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(db.get).not.toHaveBeenCalled();
  });

  it('rejects a 257-byte token (over the cap)', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { token: 'x'.repeat(257) } }), res);
    expect(res.statusCode).toBe(400);
    expect(db.get).not.toHaveBeenCalled();
  });

  it('returns alreadyDeclined when the token does not match (idempotent)', async () => {
    // An attacker probing random tokens (or a mail-scanner retrying
    // a token after the human's first click consumed it) must NOT
    // distinguish "never existed" from "already used".
    db.get.mockResolvedValueOnce(null);
    const res = mockRes();
    await handler(mockReq({ body: { token: 'no-such-token' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyDeclined: true });
    // Crucially: no UPDATE, no audit, no email.
    expect(db.run).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(sendInvitationDeclinedEmail).not.toHaveBeenCalled();
  });

  it('short-circuits when the invitation is already declined', async () => {
    db.get.mockResolvedValueOnce({
      id: 'inv-1',
      project_id: 'proj-1',
      email: 'bob@example.com',
      status: 'declined',
      inviter_id: 'user-1',
    });
    const res = mockRes();
    await handler(mockReq({ body: { token: 'whatever' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyDeclined: true });
    expect(db.run).not.toHaveBeenCalled();
  });

  it('marks declined, NULLs the hash, audits, WS-pushes, and emails the inviter', async () => {
    db.get
      // 1. token lookup
      .mockResolvedValueOnce({
        id: 'inv-9',
        project_id: 'proj-9',
        email: 'bob@example.com',
        status: 'pending',
        inviter_id: 'user-1',
      })
      // 2. inviter + project lookup for the notification email
      .mockResolvedValueOnce({
        email: 'alice@example.com',
        name: 'Alice',
        project_name: 'My Paper',
      });

    const sendToUser = vi.fn();
    const res = mockRes();
    await handler(
      mockReq({ body: { token: 'rawtok' }, app: { locals: { sendToUser } } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // UPDATE that BOTH marks declined AND nulls the hash. Replay
    // protection lives in the NULL, so this MUST hit both columns.
    const updateCall = db.run.mock.calls.find((c) => c[0].includes('UPDATE project_invitations'));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toMatch(/status\s*=\s*'declined'/);
    expect(updateCall[0]).toMatch(/decline_token_hash\s*=\s*NULL/);
    expect(updateCall[1]).toEqual(['inv-9']);

    // Audit row with user_id NULL (decliner is unregistered by
    // definition) and the email captured in detail so the inviter
    // could still see who declined if they audit-log-dive.
    expect(auditLog).toHaveBeenCalledWith(
      null,
      'invitation_declined_via_email',
      expect.objectContaining({
        targetType: 'invitation',
        targetId: 'inv-9',
        ip: '127.0.0.1',
      }),
    );

    // Live WS push to the inviter.
    expect(sendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'invitation-declined', invitationId: 'inv-9' }),
    );

    // I3: email the inviter for the offline case. Fire-and-forget,
    // so we wait a tick for the IIFE to resolve.
    await new Promise((r) => setImmediate(r));
    expect(sendInvitationDeclinedEmail).toHaveBeenCalledWith(
      'alice@example.com',
      expect.objectContaining({
        inviterName: 'Alice',
        declinedEmail: 'bob@example.com',
        projectName: 'My Paper',
      }),
    );
  });

  it('hashes the supplied token (does NOT pass it raw to the SQL lookup)', async () => {
    db.get.mockResolvedValueOnce(null); // doesn't matter; we inspect the call
    await handler(mockReq({ body: { token: 'rawtok' } }), mockRes());
    const [, params] = db.get.mock.calls[0];
    expect(params[0]).not.toBe('rawtok');
    // SHA-256 hex digest = 64 chars.
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
