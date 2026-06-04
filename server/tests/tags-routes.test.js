import { describe, it, expect, vi, beforeEach } from 'vitest';

// V2 (audit round 7): PATCH /api/tags/:id was missing the typeof + length
// validation that POST has, and didn't translate the SQLSTATE 23505
// unique-violation to a clean 409. Tests below pin all three.

vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
}));

import db from '../db.js';
import router from '../routes/tags.js';

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

function mockReq(params = {}, body = {}, session = {}) {
  return {
    params,
    body,
    session: { userId: 'user-1', ...session },
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

const EXISTING_TAG = { id: 'tag-1', user_id: 'user-1', name: 'old', color: '#abc' };

describe('PATCH /api/tags/:id — V2 validation parity with POST', () => {
  const handler = getHandler('patch', '/:id');

  beforeEach(() => {
    vi.clearAllMocks();
    // First db.get returns the tag (ownership check).
    db.get.mockResolvedValueOnce(EXISTING_TAG);
  });

  it('returns 400 when name is not a string', async () => {
    const res = mockRes();
    await handler(mockReq({ id: 'tag-1' }, { name: 12345 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/required/i);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('returns 400 when name is empty after trim', async () => {
    const res = mockRes();
    await handler(mockReq({ id: 'tag-1' }, { name: '   ' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/required/i);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('returns 400 when name exceeds 100 characters', async () => {
    const res = mockRes();
    await handler(mockReq({ id: 'tag-1' }, { name: 'x'.repeat(101) }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/too long/i);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('translates unique-violation (23505) to 409', async () => {
    db.run.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const res = mockRes();
    await handler(mockReq({ id: 'tag-1' }, { name: 'duplicate' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('accepts a valid rename and returns ok', async () => {
    db.run.mockResolvedValueOnce({});
    const res = mockRes();
    await handler(mockReq({ id: 'tag-1' }, { name: 'newname' }), res);
    expect(res.body.ok).toBe(true);
    expect(db.run).toHaveBeenCalledWith(
      'UPDATE tags SET name = $1 WHERE id = $2',
      ['newname', 'tag-1'],
    );
  });

  it('returns 404 when the tag does not belong to the user', async () => {
    // Override the beforeEach mock: tag lookup returns undefined.
    db.get.mockReset();
    db.get.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await handler(mockReq({ id: 'tag-1' }, { name: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(db.run).not.toHaveBeenCalled();
  });
});
