import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────
// db.transaction calls our handler with a `tx` object that exposes the same
// shape as `db` itself, so we drive both through the same mocked fns.
const mockTx = {
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
};

vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    transaction: vi.fn(async (fn) => fn(mockTx)),
  },
  getWriteStats: vi.fn(() => ({ writes: 0, mutationRows: 0 })),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/audit.js', () => ({
  // The handler chains .catch() on the auditLog call — return a real
  // resolved Promise so that .catch is a function.
  auditLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('../utils/email.js', () => ({
  resetTransporter: vi.fn(),
  sendEmail: vi.fn(),
  sendAccountDeletedEmail: vi.fn(),
}));

vi.mock('../utils/crypto.js', () => ({
  encrypt: vi.fn((v) => v),
}));

vi.mock('../services/authService.js', () => ({
  adminDeleteUser: vi.fn(),
}));

vi.mock('../compiler.js', () => ({
  compileMetrics: { totalCompiles: 0 },
}));

vi.mock('../middleware/errorHandler.js', () => ({
  sendError: vi.fn((res, err) => res.status(err.status || 500).json({ error: err.message })),
}));

import { auditLog } from '../utils/audit.js';
import router from '../routes/admin.js';

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

function mockReq({ params = {}, body = {}, session = {} } = {}) {
  return {
    params,
    body,
    session: { userId: 'admin-1', ...session },
    ip: '127.0.0.1',
  };
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

describe('PATCH /users/:userId/admin', () => {
  let handler;
  const TARGET = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    handler = getHandler('patch', '/users/:userId/admin');
  });

  it('rejects malformed user id', async () => {
    const res = mockRes();
    await handler(mockReq({ params: { userId: 'not-a-uuid' }, body: { isAdmin: true } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid user id/i);
  });

  it('rejects body without a boolean isAdmin', async () => {
    const res = mockRes();
    await handler(mockReq({ params: { userId: TARGET }, body: { isAdmin: 'yes' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/must be a boolean/i);
  });

  it('refuses to let an admin toggle their own row', async () => {
    const SELF = '22222222-2222-2222-2222-222222222222';
    const res = mockRes();
    await handler(
      mockReq({ params: { userId: SELF }, body: { isAdmin: false }, session: { userId: SELF } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/your own/i);
  });

  it('returns 404 when the target user does not exist', async () => {
    mockTx.get.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await handler(mockReq({ params: { userId: TARGET }, body: { isAdmin: true } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('promotes a regular user — updates row and writes an audit entry', async () => {
    mockTx.get.mockResolvedValueOnce({
      id: TARGET, email: 'them@example.com', name: 'Them', is_admin: false,
    });
    const res = mockRes();
    await handler(mockReq({ params: { userId: TARGET }, body: { isAdmin: true } }), res);
    expect(mockTx.run).toHaveBeenCalledWith(
      'UPDATE users SET is_admin = $1 WHERE id = $2',
      [true, TARGET],
    );
    expect(auditLog).toHaveBeenCalledWith(
      'admin-1', 'admin_granted',
      expect.objectContaining({ targetType: 'user', targetId: TARGET }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, isAdmin: true });
  });

  it('demotes an admin when there are other admins', async () => {
    mockTx.get
      .mockResolvedValueOnce({ id: TARGET, email: 'them@example.com', name: 'Them', is_admin: true })
      .mockResolvedValueOnce({ n: 2 }); // 2 admins → demotion is safe
    const res = mockRes();
    await handler(mockReq({ params: { userId: TARGET }, body: { isAdmin: false } }), res);
    expect(mockTx.run).toHaveBeenCalledWith(
      'UPDATE users SET is_admin = $1 WHERE id = $2',
      [false, TARGET],
    );
    expect(auditLog).toHaveBeenCalledWith(
      'admin-1', 'admin_revoked',
      expect.any(Object),
    );
    expect(res.statusCode).toBe(200);
  });

  it('refuses to demote the LAST admin', async () => {
    mockTx.get
      .mockResolvedValueOnce({ id: TARGET, email: 'them@example.com', name: 'Them', is_admin: true })
      .mockResolvedValueOnce({ n: 1 }); // only 1 admin left
    const res = mockRes();
    await handler(mockReq({ params: { userId: TARGET }, body: { isAdmin: false } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/last admin/i);
    expect(mockTx.run).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('returns ok without auditing for a no-op (already in desired state)', async () => {
    mockTx.get.mockResolvedValueOnce({
      id: TARGET, email: 'them@example.com', name: 'Them', is_admin: true,
    });
    const res = mockRes();
    await handler(mockReq({ params: { userId: TARGET }, body: { isAdmin: true } }), res);
    expect(mockTx.run).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, isAdmin: true });
  });
});
