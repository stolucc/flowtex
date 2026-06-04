import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// X2 (audit round 9) + A2 (self-audit follow-up): POST
// /api/projects/:id/members must
//   (a) refuse with 503 in production when APP_URL is unset (so the
//       fallback can't expose the invitation link's host to a spoofed
//       Host header), and
//   (b) check APP_URL BEFORE calling inviteMember -- otherwise every
//       503 retry burns a slot against the per-project membership cap
//       (orphan invitation rows).

vi.mock('../db.js', () => ({
  default: { get: vi.fn(), all: vi.fn(), run: vi.fn() },
}));

vi.mock('../services/projectService.js', async () => {
  const actual = await vi.importActual('../services/projectService.js');
  return {
    ...actual,
    inviteMember: vi.fn(),
    checkOwnership: vi.fn().mockResolvedValue({ member: { role: 'owner' } }),
  };
});

vi.mock('../utils/email.js', () => ({
  sendProjectInvitationEmail: vi.fn().mockResolvedValue(undefined),
  sendUnregisteredInvitationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/audit.js', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('multer', () => {
  const upload = { single: () => (req, _res, next) => next() };
  const multer = vi.fn(() => upload);
  multer.memoryStorage = vi.fn(() => ({}));
  return { default: multer };
});

import { inviteMember } from '../services/projectService.js';
import router from '../routes/projects.js';

function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

function mockReq(body = {}, params = { id: 'proj-1' }) {
  return {
    params,
    body,
    session: { userId: 'owner-1', userName: 'Owner' },
    protocol: 'http',
    get: (h) => (h === 'host' ? 'attacker.example.com' : ''),
    app: { locals: {} },
    ip: '127.0.0.1',
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (c) { res.statusCode = c; return res; }),
    json: vi.fn(function (d) { res.body = d; return res; }),
  };
  return res;
}

const ORIGINAL_ENV = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL };

describe('POST /:id/members — X2 + A2 APP_URL guard', () => {
  const handler = getHandler('post', '/:id/members');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
    if (ORIGINAL_ENV.APP_URL == null) delete process.env.APP_URL;
    else process.env.APP_URL = ORIGINAL_ENV.APP_URL;
  });

  it('X2 — returns 503 in production when APP_URL is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;

    const res = mockRes();
    await handler(mockReq({ email: 'invitee@example.com', role: 'editor' }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body.error).toMatch(/APP_URL/i);
  });

  it('A2 — APP_URL check fires BEFORE inviteMember (no orphan row)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;

    await handler(mockReq({ email: 'invitee@example.com', role: 'editor' }), mockRes());

    // inviteMember must NOT have been called -- otherwise every retry
    // in a misconfigured prod silently consumes a membership-cap slot.
    expect(inviteMember).not.toHaveBeenCalled();
  });

  it('dev/test falls back to req.protocol + Host (local flows keep working)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.APP_URL;
    inviteMember.mockResolvedValueOnce({
      id: 'inv-1',
      email: 'invitee@example.com',
      recipientHasAccount: true,
      declineToken: null,
    });

    const res = mockRes();
    await handler(mockReq({ email: 'invitee@example.com', role: 'editor' }), res);

    // No 503; inviteMember was called.
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(inviteMember).toHaveBeenCalled();
  });

  it('production with APP_URL set proceeds normally', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'https://flowtex.example.com';
    inviteMember.mockResolvedValueOnce({
      id: 'inv-1',
      email: 'invitee@example.com',
      recipientHasAccount: true,
      declineToken: null,
    });

    const res = mockRes();
    await handler(mockReq({ email: 'invitee@example.com', role: 'editor' }), res);

    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(inviteMember).toHaveBeenCalled();
  });
});
