import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => {
  const mock = { get: vi.fn(), all: vi.fn(), run: vi.fn() };
  // HH1: history routes wrap snapshot count + delete in a tx; collapse
  // tx.get/tx.run to the same mocks so existing assertions on db.get /
  // db.run still observe the calls.
  mock.transaction = vi.fn(async (fn) => fn({ get: mock.get, run: mock.run, all: mock.all }));
  return { default: mock };
});

vi.mock('../middleware/auth.js', () => ({
  isProjectMember: vi.fn(),
}));

vi.mock('../utils/audit.js', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';
import { auditLog } from '../utils/audit.js';
import router from '../routes/history.js';

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

function mockReq(params = {}, body = {}, session = {}) {
  return {
    params,
    body,
    ip: '127.0.0.1',
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
    json: vi.fn(function (data) {
      res.body = data;
      return res;
    }),
  };
  return res;
}

const EDITOR = { role: 'editor' };
const VIEWER = { role: 'viewer' };

beforeEach(() => {
  vi.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /snapshot/:snapshotId — single-snapshot delete
// ═════════════════════════════════════════════════════════════════════════
describe('DELETE /snapshot/:snapshotId', () => {
  const handler = getHandler('delete', '/snapshot/:snapshotId');

  it('returns 404 when snapshot does not exist', async () => {
    db.get.mockResolvedValueOnce(null);
    const res = mockRes();
    await handler(mockReq({ snapshotId: 'missing' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Snapshot not found' });
  });

  it('returns 403 when caller is not a project member', async () => {
    db.get.mockResolvedValueOnce({ id: 'snap-1', project_id: 'proj-1' });
    isProjectMember.mockResolvedValueOnce(null);
    const res = mockRes();
    await handler(mockReq({ snapshotId: 'snap-1' }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'No access to this project' });
  });

  it('returns 403 when caller is only a viewer', async () => {
    db.get.mockResolvedValueOnce({ id: 'snap-1', project_id: 'proj-1' });
    isProjectMember.mockResolvedValueOnce(VIEWER);
    const res = mockRes();
    await handler(mockReq({ snapshotId: 'snap-1' }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Only editors can delete snapshots' });
    expect(db.run).not.toHaveBeenCalled();
  });

  it('returns 409 and refuses to delete the project’s last snapshot', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'snap-1', project_id: 'proj-1' })
      .mockResolvedValueOnce({ count: '1' });
    isProjectMember.mockResolvedValueOnce(EDITOR);
    const res = mockRes();
    await handler(mockReq({ snapshotId: 'snap-1' }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Cannot delete the only remaining snapshot' });
    // HH1: the first db.run is the advisory lock; assert no DELETE happened.
    const deleteCall = db.run.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM project_snapshots'));
    expect(deleteCall).toBeUndefined();
  });

  it('deletes the snapshot and writes an audit-log entry', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'snap-1', project_id: 'proj-1' })
      .mockResolvedValueOnce({ count: '5' });
    isProjectMember.mockResolvedValueOnce(EDITOR);
    db.run.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await handler(mockReq({ snapshotId: 'snap-1' }), res);
    // HH1: DELETE happens inside the tx after the advisory lock.
    const deleteCall = db.run.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM project_snapshots'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toEqual(['snap-1']);
    expect(auditLog).toHaveBeenCalledWith(
      'user-1',
      'snapshot_deleted',
      expect.objectContaining({ targetId: 'proj-1', detail: 'snap-1' }),
    );
    expect(res.body).toEqual({ ok: true });
  });

  // HH1: the snapshot count + delete must run inside a tx with a per-
  // project advisory lock so two parallel single-deletes can't both
  // observe count > 1 and both delete -- leaving the project with zero
  // restore points. This test pins the lock SQL + key.
  it('HH1 — takes pg_advisory_xact_lock on hashtext(snapshots:<projectId>) before the count', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'snap-1', project_id: 'proj-1' })
      .mockResolvedValueOnce({ count: '5' });
    isProjectMember.mockResolvedValueOnce(EDITOR);
    db.run.mockResolvedValueOnce(undefined);
    await handler(mockReq({ snapshotId: 'snap-1' }), mockRes());

    const lockCall = db.run.mock.calls.find(([sql]) => sql.startsWith('SELECT pg_advisory_xact_lock'));
    expect(lockCall).toBeDefined();
    expect(lockCall[1]).toEqual(['snapshots:proj-1']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /snapshots — bulk delete
// ═════════════════════════════════════════════════════════════════════════
describe('DELETE /snapshots (bulk)', () => {
  const handler = getHandler('delete', '/snapshots');

  it('returns 400 when ids missing or empty', async () => {
    const res = mockRes();
    await handler(mockReq({}, {}), res);
    expect(res.statusCode).toBe(400);

    const res2 = mockRes();
    await handler(mockReq({}, { ids: [] }), res2);
    expect(res2.statusCode).toBe(400);

    const res3 = mockRes();
    await handler(mockReq({}, { ids: 'not-an-array' }), res3);
    expect(res3.statusCode).toBe(400);
  });

  it('returns 400 when more than 500 ids', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `s${i}`);
    const res = mockRes();
    await handler(mockReq({}, { ids }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'too many ids (max 500)' });
  });

  it('silently drops non-string ids before querying', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'a', project_id: 'proj-1' },
      { id: 'b', project_id: 'proj-1' },
    ]);
    db.get.mockResolvedValueOnce({ count: '10' });
    isProjectMember.mockResolvedValueOnce(EDITOR);
    db.run.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await handler(mockReq({}, { ids: ['a', 'b', 7, null, undefined, { x: 1 }] }), res);
    // Only the string ids should be passed through to the SELECT.
    expect(db.all).toHaveBeenCalledWith(expect.any(String), [['a', 'b']]);
    expect(res.body).toEqual({ ok: true, deleted: 2 });
  });

  it('returns 404 when none of the ids match existing snapshots', async () => {
    db.all.mockResolvedValueOnce([]);
    const res = mockRes();
    await handler(mockReq({}, { ids: ['ghost'] }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'No snapshots found' });
  });

  it('returns 400 when ids span multiple projects', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'a', project_id: 'proj-1' },
      { id: 'b', project_id: 'proj-2' },
    ]);
    const res = mockRes();
    await handler(mockReq({}, { ids: ['a', 'b'] }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'snapshots span multiple projects' });
    expect(db.run).not.toHaveBeenCalled();
  });

  it('returns 403 for a viewer of the (single) target project', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'a', project_id: 'proj-1' },
      { id: 'b', project_id: 'proj-1' },
    ]);
    isProjectMember.mockResolvedValueOnce(VIEWER);
    const res = mockRes();
    await handler(mockReq({}, { ids: ['a', 'b'] }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Only editors can delete snapshots' });
  });

  it('returns 409 when the bulk delete would empty the project', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'a', project_id: 'proj-1' },
      { id: 'b', project_id: 'proj-1' },
    ]);
    db.get.mockResolvedValueOnce({ count: '2' });
    isProjectMember.mockResolvedValueOnce(EDITOR);
    const res = mockRes();
    await handler(mockReq({}, { ids: ['a', 'b'] }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Cannot delete every snapshot of a project' });
    // HH1: the first db.run is the advisory lock; assert no DELETE happened.
    const deleteCall = db.run.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM project_snapshots'));
    expect(deleteCall).toBeUndefined();
  });

  it('HH1 — bulk path takes pg_advisory_xact_lock on hashtext(snapshots:<projectId>)', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'a', project_id: 'proj-1' },
      { id: 'b', project_id: 'proj-1' },
    ]);
    db.get.mockResolvedValueOnce({ count: '10' });
    isProjectMember.mockResolvedValueOnce(EDITOR);
    db.run.mockResolvedValueOnce(undefined);
    await handler(mockReq({}, { ids: ['a', 'b'] }), mockRes());

    const lockCall = db.run.mock.calls.find(([sql]) => sql.startsWith('SELECT pg_advisory_xact_lock'));
    expect(lockCall).toBeDefined();
    expect(lockCall[1]).toEqual(['snapshots:proj-1']);
  });

  it('deletes the requested rows and audit-logs once for the batch', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'a', project_id: 'proj-1' },
      { id: 'b', project_id: 'proj-1' },
    ]);
    db.get.mockResolvedValueOnce({ count: '10' });
    isProjectMember.mockResolvedValueOnce(EDITOR);
    db.run.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await handler(mockReq({}, { ids: ['a', 'b'] }), res);
    const deleteCall = db.run.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM project_snapshots'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toEqual([['a', 'b']]);
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      'user-1',
      'snapshots_bulk_deleted',
      expect.objectContaining({ targetId: 'proj-1', detail: 'a,b' }),
    );
    expect(res.body).toEqual({ ok: true, deleted: 2 });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// A1 — commenter role must be rejected on all three history routes
// (regression cover for the self-audit finding: when the commenter
// role landed, these three sites still only rejected viewer).
// ═════════════════════════════════════════════════════════════════════════

const COMMENTER = { role: 'commenter' };

describe('A1 — commenter rejection on history routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /restore/:snapshotId rejects commenter with 403', async () => {
    const handler = getHandler('post', '/restore/:snapshotId');
    db.get.mockResolvedValueOnce({ id: 'snap-1', project_id: 'proj-1' });
    isProjectMember.mockResolvedValueOnce(COMMENTER);

    const res = mockRes();
    await handler(mockReq({ snapshotId: 'snap-1' }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/only editors/i);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('DELETE /snapshot/:snapshotId rejects commenter with 403', async () => {
    const handler = getHandler('delete', '/snapshot/:snapshotId');
    db.get.mockResolvedValueOnce({ id: 'snap-1', project_id: 'proj-1' });
    isProjectMember.mockResolvedValueOnce(COMMENTER);

    const res = mockRes();
    await handler(mockReq({ snapshotId: 'snap-1' }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/only editors/i);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('DELETE /snapshots (bulk) rejects commenter with 403', async () => {
    const handler = getHandler('delete', '/snapshots');
    db.all.mockResolvedValueOnce([
      { id: 'a', project_id: 'proj-1' },
      { id: 'b', project_id: 'proj-1' },
    ]);
    isProjectMember.mockResolvedValueOnce(COMMENTER);

    const res = mockRes();
    await handler(mockReq({}, { ids: ['a', 'b'] }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/only editors/i);
    expect(db.run).not.toHaveBeenCalled();
  });
});
