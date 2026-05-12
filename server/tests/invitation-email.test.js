import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────
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
  auditLog: vi.fn(),
}));

vi.mock('../utils/email.js', () => ({
  sendProjectInvitationEmail: vi.fn(),
}));

vi.mock('../services/projectService.js', () => ({
  checkMembership: vi.fn(),
  checkOwnership: vi.fn(),
  inviteMember: vi.fn(),
}));

vi.mock('../middleware/errorHandler.js', () => ({
  sendError: vi.fn((res, err) => res.status(err.status || 500).json({ error: err.message })),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAdmin: vi.fn((req, res, next) => next()),
}));

vi.mock('../../shared/texDeps.js', () => ({
  resolveUsedFiles: vi.fn(() => []),
}));

import db from '../db.js';
import * as projectService from '../services/projectService.js';
import { sendProjectInvitationEmail } from '../utils/email.js';
import router from '../routes/projects.js';

// ── Handler extraction ──────────────────────────────────────────────────
function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        // Return the last handler in the stack (after any route-level middleware)
        const handlers = layer.route.stack;
        return handlers[handlers.length - 1].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────
function mockReq(params = {}, body = {}, session = {}) {
  return {
    params,
    body,
    session: { userId: 'user-1', userName: 'Alice', ...session },
    protocol: 'https',
    ip: '127.0.0.1',
    get: vi.fn((header) => {
      if (header === 'host') return 'flowtex.example.com';
      return '';
    }),
    app: { locals: {} },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(function (data) {
      res.body = data;
      return res;
    }),
  };
  return res;
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('POST /:id/members — project invitation email', () => {
  let handler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = getHandler('post', '/:id/members');
    // Default: user is owner
    projectService.checkOwnership.mockResolvedValue({ member: { role: 'owner' } });
  });

  it('sends an invitation email with correct details', async () => {
    const invitation = { id: 'inv-1', role: 'editor' };
    projectService.inviteMember.mockResolvedValue(invitation);
    // Session has userName='Alice', so no DB lookup for inviter name
    // db.get calls: project name, then invitee lookup
    db.get
      .mockResolvedValueOnce({ name: 'My Paper' }) // project name lookup
      .mockResolvedValueOnce({ id: 'user-2' });    // invitee user lookup

    const req = mockReq({ id: 'proj-1' }, { email: 'bob@example.com', role: 'editor' });
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(invitation);
    expect(sendProjectInvitationEmail).toHaveBeenCalledOnce();
    expect(sendProjectInvitationEmail).toHaveBeenCalledWith('bob@example.com', {
      inviterName: 'Alice',
      projectName: 'My Paper',
      baseUrl: 'https://flowtex.example.com',
      inviteUrl: 'https://flowtex.example.com/?invite=inv-1',
    });
  });

  it('uses session userName when available instead of DB lookup', async () => {
    projectService.inviteMember.mockResolvedValue({ id: 'inv-2', role: 'viewer' });
    // Session has userName='SessionAlice', so: project name lookup, then invitee lookup
    db.get
      .mockResolvedValueOnce({ name: 'Research Project' }) // project name
      .mockResolvedValueOnce(null);                         // no invitee user

    const req = mockReq(
      { id: 'proj-2' },
      { email: 'carol@example.com', role: 'viewer' },
      { userName: 'SessionAlice' },
    );
    const res = mockRes();

    await handler(req, res);

    expect(sendProjectInvitationEmail).toHaveBeenCalledWith('carol@example.com', {
      inviterName: 'SessionAlice',
      projectName: 'Research Project',
      baseUrl: 'https://flowtex.example.com',
      inviteUrl: 'https://flowtex.example.com/?invite=inv-2',
    });
  });

  it('still creates invitation even if email send fails', async () => {
    const invitation = { id: 'inv-3', role: 'editor' };
    projectService.inviteMember.mockResolvedValue(invitation);
    sendProjectInvitationEmail.mockRejectedValueOnce(new Error('SMTP connection refused'));
    // Session has userName, so: project name lookup, then invitee lookup
    db.get
      .mockResolvedValueOnce({ name: 'My Paper' })
      .mockResolvedValueOnce(null);

    const req = mockReq({ id: 'proj-1' }, { email: 'dan@example.com', role: 'editor' });
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(invitation);
    expect(sendProjectInvitationEmail).toHaveBeenCalledOnce();
  });

  it('pushes invitation via WebSocket to existing users', async () => {
    const invitation = { id: 'inv-4', role: 'editor' };
    projectService.inviteMember.mockResolvedValue(invitation);
    // Session has userName, so: project name lookup, then invitee lookup
    db.get
      .mockResolvedValueOnce({ name: 'My Paper' }) // project name
      .mockResolvedValueOnce({ id: 'user-99' });   // invitee exists

    const sendToUser = vi.fn();
    const req = mockReq({ id: 'proj-5' }, { email: 'eve@example.com', role: 'editor' });
    req.app.locals.sendToUser = sendToUser;
    const res = mockRes();

    await handler(req, res);

    expect(sendToUser).toHaveBeenCalledWith('user-99', expect.objectContaining({
      type: 'invitation',
      invitation: expect.objectContaining({
        id: 'inv-4',
        project_id: 'proj-5',
        project_name: 'My Paper',
        role: 'editor',
        status: 'pending',
      }),
    }));
  });

  it('rejects invalid email addresses', async () => {
    const req = mockReq({ id: 'proj-1' }, { email: 'not-an-email' });
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid email/i);
    expect(sendProjectInvitationEmail).not.toHaveBeenCalled();
  });

  it('rejects if user is not owner', async () => {
    projectService.checkOwnership.mockResolvedValue({ error: 'Only the owner can do this', status: 403 });
    const req = mockReq({ id: 'proj-1' }, { email: 'bob@example.com', role: 'editor' });
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(sendProjectInvitationEmail).not.toHaveBeenCalled();
  });
});
