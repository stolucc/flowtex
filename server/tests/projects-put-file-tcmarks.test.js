// L1 (security review 2026-06-17): PUT /files/:fileId must bound the
// tcMarks sidecar. Under Y.js the autosave is marks-only, so tcMarks is
// the primary write path; without a cap an authenticated editor could
// persist an unbounded jsonb blob (storage abuse). The cap is enforced
// BEFORE the DB access lookup so a bad payload is rejected cheaply.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { get: vi.fn(), all: vi.fn(), run: vi.fn() },
}));

vi.mock('../services/projectService.js', async () => {
  const actual = await vi.importActual('../services/projectService.js');
  return { ...actual, getFileWithAccess: vi.fn(), updateFileContent: vi.fn() };
});
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('multer', () => {
  const upload = { single: () => (req, _res, next) => next() };
  const multer = vi.fn(() => upload);
  multer.memoryStorage = vi.fn(() => ({}));
  return { default: multer };
});

import { getFileWithAccess, updateFileContent } from '../services/projectService.js';
import router from '../routes/projects.js';

function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route && Object.keys(layer.route.methods)[0] === method && layer.route.path === pathPattern) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler for ${method} ${pathPattern}`);
}
function mockReq(body) {
  return { params: { fileId: 'f1' }, body, session: { userId: 'u1' }, app: { locals: {} } };
}
function mockRes() {
  const res = {
    statusCode: 200, body: null,
    status: vi.fn(function (c) { res.statusCode = c; return res; }),
    json: vi.fn(function (d) { res.body = d; return res; }),
  };
  return res;
}

const handler = getHandler('put', '/files/:fileId');

describe('PUT /files/:fileId — tcMarks cap (L1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFileWithAccess.mockResolvedValue({ id: 'f1', project_id: 'p1' });
    updateFileContent.mockResolvedValue({ ok: true, version: 'v1' });
  });

  it('rejects a non-array tcMarks with 400 and never touches the DB', async () => {
    const res = mockRes();
    await handler(mockReq({ tcMarks: { not: 'an array' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/tcMarks must be an array/);
    expect(getFileWithAccess).not.toHaveBeenCalled();
    expect(updateFileContent).not.toHaveBeenCalled();
  });

  it('rejects too many marks (> 50000) before the access lookup', async () => {
    const res = mockRes();
    const many = Array.from({ length: 50001 }, (_, i) => ({ id: String(i), from: 0, to: 1, kind: 'insert' }));
    await handler(mockReq({ tcMarks: many }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Too many tracked-change marks/);
    expect(getFileWithAccess).not.toHaveBeenCalled();
  });

  it('rejects an oversized (> 2MB serialized) tcMarks payload', async () => {
    const res = mockRes();
    // A few entries whose fields carry ~2.5MB of text total.
    const big = [{ id: 'x', from: 0, to: 1, kind: 'insert', note: 'A'.repeat(2.5 * 1024 * 1024) }];
    await handler(mockReq({ tcMarks: big }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(getFileWithAccess).not.toHaveBeenCalled();
  });

  it('accepts a normal tcMarks payload (passes through to the service)', async () => {
    const res = mockRes();
    const marks = [{ id: 'm1', from: 0, to: 3, kind: 'insert' }];
    await handler(mockReq({ tcMarks: marks }), res);
    expect(res.statusCode).toBe(200);
    expect(getFileWithAccess).toHaveBeenCalledWith('f1', 'u1', { edit: true });
    expect(updateFileContent).toHaveBeenCalled();
    expect(updateFileContent.mock.calls[0][3]).toEqual(marks); // tcMarks arg forwarded
  });

  it('still enforces the existing content cap (10MB)', async () => {
    const res = mockRes();
    await handler(mockReq({ content: 'A'.repeat(10 * 1024 * 1024 + 1) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/File too large/);
  });
});
