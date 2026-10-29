import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ZIP import routes used to echo err.message, so a Postgres error
// ("invalid byte sequence for encoding \"UTF8\": 0x00") reached users.
// Intended validation errors (status set) still pass through verbatim.

vi.mock('../db.js', () => ({ default: { get: vi.fn(), all: vi.fn(), run: vi.fn() } }));
vi.mock('../services/projectService.js', async () => {
  const actual = await vi.importActual('../services/projectService.js');
  return { ...actual, createProjectFromZip: vi.fn() };
});
vi.mock('../utils/audit.js', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('multer', () => {
  const upload = { single: () => (req, _res, next) => next() };
  const multer = vi.fn(() => upload);
  multer.memoryStorage = vi.fn(() => ({}));
  return { default: multer };
});

import { createProjectFromZip } from '../services/projectService.js';
import router from '../routes/projects.js';

function handler(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const req = () => ({ session: { userId: 'u1' }, file: { buffer: Buffer.from('zip'), originalname: 'p.zip' }, body: {}, ip: '127.0.0.1' });
function res() {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

beforeEach(() => vi.clearAllMocks());

describe('POST /from-zip error responses', () => {
  it('hides internal errors (e.g. a raw Postgres message) behind a generic 500', async () => {
    createProjectFromZip.mockRejectedValueOnce(new Error('invalid byte sequence for encoding "UTF8": 0x00'));
    const r = res();
    await handler('post', '/from-zip')(req(), r);
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'Failed to create project from ZIP file' });
    expect(JSON.stringify(r.body)).not.toMatch(/UTF8|0x00/);
  });

  it('passes intended validation errors through with their status', async () => {
    createProjectFromZip.mockRejectedValueOnce(Object.assign(new Error('ZIP contains too many files (2001, max 2000)'), { status: 400 }));
    const r = res();
    await handler('post', '/from-zip')(req(), r);
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'ZIP contains too many files (2001, max 2000)' });
  });

  it('passes quota errors through', async () => {
    createProjectFromZip.mockRejectedValueOnce(Object.assign(new Error('Project limit reached'), { status: 403 }));
    const r = res();
    await handler('post', '/from-zip')(req(), r);
    expect(r.statusCode).toBe(403);
  });
});
