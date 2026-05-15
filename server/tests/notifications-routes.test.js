import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
}));

import db from '../db.js';
import router from '../routes/notifications.js';

function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        return layer.route.stack[0].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

function mockReq(params = {}, session = {}) {
  return {
    params,
    session: { userId: 'user-1', ...session },
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
    json: vi.fn(function (body) {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe('GET /api/notifications/mentions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns recent mentions for the current user', async () => {
    const rows = [
      {
        id: 'm1',
        comment_id: 'c1',
        reply_id: null,
        project_id: 'p1',
        snippet: 'hi @Me',
        created_at: '2026-05-15T00:00:00Z',
        seen_at: null,
        mentioner_name: 'Bob',
        project_name: 'Demo',
        file_id: 'f1',
        file_path: 'main.tex',
      },
    ];
    db.all.mockResolvedValueOnce(rows);

    const handler = getHandler('get', '/mentions');
    const res = mockRes();
    await handler(mockReq(), res);

    expect(db.all).toHaveBeenCalledOnce();
    const [, params] = db.all.mock.calls[0];
    expect(params).toEqual(['user-1']);
    expect(res.body).toEqual(rows);
  });

  it('passes the session userId as the only filter param', async () => {
    db.all.mockResolvedValueOnce([]);
    const handler = getHandler('get', '/mentions');
    await handler(mockReq({}, { userId: 'someone-else' }), mockRes());
    expect(db.all.mock.calls[0][1]).toEqual(['someone-else']);
  });
});

describe('POST /api/notifications/mentions/:id/seen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks an existing mention as seen', async () => {
    db.get.mockResolvedValueOnce({ id: 'm1' });
    const handler = getHandler('post', '/mentions/:id/seen');
    const res = mockRes();
    await handler(mockReq({ id: 'm1' }), res);

    expect(db.run).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE comment_mentions SET seen_at = NOW\(\)/),
      ['m1'],
    );
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 404 when the mention does not exist or does not belong to the user', async () => {
    db.get.mockResolvedValueOnce(null);
    const handler = getHandler('post', '/mentions/:id/seen');
    const res = mockRes();
    await handler(mockReq({ id: 'nope' }), res);

    expect(res.statusCode).toBe(404);
    expect(db.run).not.toHaveBeenCalled();
  });
});

describe('POST /api/notifications/mentions/seen-all', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks all of the user’s unseen mentions as seen', async () => {
    const handler = getHandler('post', '/mentions/seen-all');
    const res = mockRes();
    await handler(mockReq({}, { userId: 'user-9' }), res);

    expect(db.run).toHaveBeenCalledOnce();
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toMatch(/UPDATE comment_mentions SET seen_at = NOW\(\)/);
    expect(sql).toMatch(/mentioned_user_id = \$1/);
    expect(params).toEqual(['user-9']);
    expect(res.body).toEqual({ ok: true });
  });
});
