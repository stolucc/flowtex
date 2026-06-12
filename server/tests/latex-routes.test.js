import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the index service BEFORE importing the router so the route
// receives our vi.fn instead of the real (slow, disk-walking) one.
vi.mock('../services/commandPackageIndex.js', () => ({
  lookupCommandPackage: vi.fn(),
  resetIndexCache: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import * as idx from '../services/commandPackageIndex.js';
import router from '../routes/latex.js';

function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  throw new Error(`No handler for ${method} ${pathPattern}`);
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

function mockReq(overrides = {}) {
  return {
    session: { userId: 'user-1' },
    query: {},
    body: {},
    app: { locals: {} },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/latex/command-package', () => {
  const handler = getHandler('get', '/command-package');

  it('returns { package, source: "index" } when the index resolves a command', async () => {
    idx.lookupCommandPackage.mockResolvedValueOnce('cleveref');
    const req = mockReq({ query: { cmd: 'cref' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.body).toEqual({ package: 'cleveref', source: 'index' });
  });

  it('returns { package: null, source: "unknown" } when not found', async () => {
    idx.lookupCommandPackage.mockResolvedValueOnce(null);
    const req = mockReq({ query: { cmd: 'whatever' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.body).toEqual({ package: null, source: 'unknown' });
  });

  it('returns 400 on missing cmd', async () => {
    const req = mockReq({ query: {} });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(idx.lookupCommandPackage).not.toHaveBeenCalled();
  });

  it('returns 400 on a backslash in cmd (client must strip it before sending)', async () => {
    const req = mockReq({ query: { cmd: '\\cref' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on whitespace or punctuation in cmd', async () => {
    const cases = ['c ref', 'c$ref', 'c{x}', "c'", ''];
    for (const c of cases) {
      const req = mockReq({ query: { cmd: c } });
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(400);
    }
  });

  it('returns 400 on overly long cmd (>64 chars)', async () => {
    const req = mockReq({ query: { cmd: 'a'.repeat(65) } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('accepts ASCII letters + digits + @ + : (LaTeX-internal namespaces allowed)', async () => {
    idx.lookupCommandPackage.mockResolvedValue('somepkg');
    for (const cmd of ['cref', 'Cref', 'cref2', 'foo@bar', 'foo:bar']) {
      const req = mockReq({ query: { cmd } });
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }
  });

  it('returns 500 when the index lookup throws', async () => {
    idx.lookupCommandPackage.mockRejectedValueOnce(new Error('disk gone'));
    const req = mockReq({ query: { cmd: 'cref' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body?.package).toBe(null);
  });

  it('rate-limits at 120 requests per user per minute', async () => {
    idx.lookupCommandPackage.mockResolvedValue('somepkg');
    let lastCode = 200;
    for (let i = 0; i < 125; i++) {
      const req = mockReq({ query: { cmd: 'cref' }, session: { userId: 'burst-user' } });
      const res = mockRes();
      await handler(req, res);
      lastCode = res.statusCode;
      // First 120 should succeed; after that we expect 429s.
      if (i === 119) expect(lastCode).toBe(200);
    }
    expect(lastCode).toBe(429);
  });
});

describe('POST /api/latex/command-package/reindex', () => {
  const handler = getHandler('post', '/command-package/reindex');

  it('returns 401 when not authenticated', async () => {
    const req = mockReq({ session: null });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(idx.resetIndexCache).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin user', async () => {
    const req = mockReq({
      session: { userId: 'normal-user' },
      app: {
        locals: { dbCheckAdmin: vi.fn().mockResolvedValue({ is_admin: false }) },
      },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(idx.resetIndexCache).not.toHaveBeenCalled();
  });

  it('resets the cache for an admin user', async () => {
    const req = mockReq({
      session: { userId: 'admin-1' },
      app: {
        locals: { dbCheckAdmin: vi.fn().mockResolvedValue({ is_admin: true }) },
      },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(idx.resetIndexCache).toHaveBeenCalled();
  });
});
