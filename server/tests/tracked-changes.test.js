import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock database ──────────────────────────────────────────────────────────
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock('../middleware/auth.js', () => ({
  isProjectMember: vi.fn(),
}));

vi.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';

// ── Import router and extract route handlers ───────────────────────────────
// We import the router and manually invoke route handlers to unit-test them.
// This avoids spinning up an Express server.
import router from '../routes/tracked-changes.js';

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

// ── Helpers ────────────────────────────────────────────────────────────────
function mockReq(params = {}, body = {}, session = {}) {
  return {
    params,
    body,
    session: { userId: 'user-1', userName: 'Alice', ...session },
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

const FILE_ROW = { project_id: 'proj-1' };
const MEMBER_EDITOR = { role: 'editor' };
const MEMBER_VIEWER = { role: 'viewer' };

const PENDING_CHANGE = {
  id: 'change-1',
  file_id: 'file-1',
  project_id: 'proj-1',
  from_pos: 10,
  to_pos: 15,
  inserted_text: 'hello',
  deleted_text: '',
  author_id: 'user-1',
  author_name: 'Alice',
  status: 'pending',
};

const ACCEPTED_CHANGE = { ...PENDING_CHANGE, id: 'change-2', status: 'accepted' };

// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /:fileId — list changes for a file
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /:fileId', () => {
  const handler = getHandler('get', '/:fileId');

  it('returns all changes for a file', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.all.mockResolvedValueOnce([PENDING_CHANGE, ACCEPTED_CHANGE]);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.json).toHaveBeenCalledWith([PENDING_CHANGE, ACCEPTED_CHANGE]);
  });

  it('returns 404 when file does not exist', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ fileId: 'missing' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toBe('File not found');
  });

  it('returns 403 when user is not a project member', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows viewers to read changes', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);
    db.all.mockResolvedValueOnce([PENDING_CHANGE]);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.json).toHaveBeenCalledWith([PENDING_CHANGE]);
  });

  it('returns empty array when file has no changes', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.all.mockResolvedValueOnce([]);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.json).toHaveBeenCalledWith([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /project/:projectId — list pending changes for entire project
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /project/:projectId', () => {
  const handler = getHandler('get', '/project/:projectId');

  it('returns pending changes across all files', async () => {
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    const changes = [
      { ...PENDING_CHANGE, file_path: 'main.tex' },
      { ...PENDING_CHANGE, id: 'change-3', file_path: 'intro.tex' },
    ];
    db.all.mockResolvedValueOnce(changes);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.json).toHaveBeenCalledWith(changes);
    expect(db.all.mock.calls[0][0]).toContain("status = 'pending'");
  });

  it('returns 403 when not a member', async () => {
    isProjectMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:fileId — create a tracked change
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /:fileId', () => {
  const handler = getHandler('post', '/:fileId');

  it('creates a change with insertion text', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW); // requireFileEditor → file lookup
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce({ ...PENDING_CHANGE, id: 'test-uuid-1234' });

    const body = { from_pos: 10, to_pos: 10, inserted_text: 'hello', deleted_text: '' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][1]).toContain('test-uuid-1234');
    expect(res.body.id).toBe('test-uuid-1234');
  });

  it('creates a change with deletion text', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce({ ...PENDING_CHANGE, deleted_text: 'world', inserted_text: '' });

    const body = { from_pos: 5, to_pos: 10, inserted_text: '', deleted_text: 'world' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.body.deleted_text).toBe('world');
  });

  it('creates a change with both insertion and deletion', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce({ ...PENDING_CHANGE, inserted_text: 'new', deleted_text: 'old' });

    const body = { from_pos: 0, to_pos: 3, inserted_text: 'new', deleted_text: 'old' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.body.inserted_text).toBe('new');
    expect(res.body.deleted_text).toBe('old');
  });

  it('rejects negative from_pos', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: -1, to_pos: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('Invalid position values');
  });

  it('rejects negative to_pos', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 0, to_pos: -1 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects non-integer from_pos', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 1.5, to_pos: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects string positions', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 'abc', to_pos: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects missing positions', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, {}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('accepts from_pos === to_pos (pure insertion)', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce({ ...PENDING_CHANGE, from_pos: 5, to_pos: 5 });

    const body = { from_pos: 5, to_pos: 5, inserted_text: 'x' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.statusCode).toBe(200);
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const body = { from_pos: 0, to_pos: 5, inserted_text: 'hi' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toMatch(/[Vv]iewer/);
  });

  it('returns 404 when file is missing', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const body = { from_pos: 0, to_pos: 5, inserted_text: 'hi' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'missing' }, body), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('defaults inserted_text and deleted_text to empty string', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce(PENDING_CHANGE);

    const body = { from_pos: 0, to_pos: 5 };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    // The INSERT args should contain empty strings for text fields
    const insertArgs = db.run.mock.calls[0][1];
    expect(insertArgs[5]).toBe(''); // inserted_text
    expect(insertArgs[6]).toBe(''); // deleted_text
  });

  it('uses session userName for author_name', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce(PENDING_CHANGE);

    const body = { from_pos: 0, to_pos: 0, inserted_text: 'a' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body, { userId: 'user-1', userName: 'Bob' }), res);

    const insertArgs = db.run.mock.calls[0][1];
    expect(insertArgs[8]).toBe('Bob'); // author_name
  });

  it('falls back to DB user name when session userName is missing', async () => {
    db.get
      .mockResolvedValueOnce(FILE_ROW) // file lookup
      .mockResolvedValueOnce({ name: 'DbAlice' }) // user name lookup
      .mockResolvedValueOnce(PENDING_CHANGE); // final SELECT
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const body = { from_pos: 0, to_pos: 0, inserted_text: 'a' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body, { userId: 'user-1', userName: '' }), res);

    const insertArgs = db.run.mock.calls[0][1];
    expect(insertArgs[8]).toBe('DbAlice');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:changeId/accept — accept a single change
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /:changeId/accept', () => {
  const handler = getHandler('post', '/:changeId/accept');

  it('accepts a pending change', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.body).toEqual({ ok: true, id: 'change-1', status: 'accepted' });
    expect(db.run.mock.calls[0][1]).toContain('accepted');
  });

  it('rejects already-accepted change', async () => {
    db.get.mockResolvedValueOnce(ACCEPTED_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-2' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.error).toBe('Change already resolved');
  });

  it('rejects already-rejected change', async () => {
    db.get.mockResolvedValueOnce({ ...PENDING_CHANGE, status: 'rejected' });
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('returns 404 when change does not exist', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ changeId: 'missing' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('stores resolved_by as the accepting user', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }, {}, { userId: 'reviewer-99' }), res);

    expect(db.run.mock.calls[0][1]).toContain('reviewer-99');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:changeId/reject — reject a single change
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /:changeId/reject', () => {
  const handler = getHandler('post', '/:changeId/reject');

  it('rejects a pending change', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.body).toEqual({ ok: true, id: 'change-1', status: 'rejected' });
  });

  it('cannot reject an already-resolved change', async () => {
    db.get.mockResolvedValueOnce(ACCEPTED_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-2' }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('returns 404 for non-existent change', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ changeId: 'nope' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 for non-members', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:changeId — update a change (merge edits)
// ═══════════════════════════════════════════════════════════════════════════
describe('PATCH /:changeId', () => {
  const handler = getHandler('patch', '/:changeId');

  it('updates position and text', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE); // requireChangeEditor
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce({ ...PENDING_CHANGE, from_pos: 10, to_pos: 20, inserted_text: 'helloworld' });

    const body = { from_pos: 10, to_pos: 20, inserted_text: 'helloworld' };
    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }, body), res);

    expect(res.body.inserted_text).toBe('helloworld');
    expect(res.body.to_pos).toBe(20);
  });

  it('partially updates — keeps original for missing fields', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce({ ...PENDING_CHANGE, to_pos: 25 });

    // Only update to_pos
    const body = { to_pos: 25 };
    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }, body), res);

    // Should use original from_pos (via nullish coalescing)
    const updateArgs = db.run.mock.calls[0][1];
    expect(updateArgs[0]).toBe(PENDING_CHANGE.from_pos); // kept original
    expect(updateArgs[1]).toBe(25); // updated
  });

  it('cannot update resolved change', async () => {
    db.get.mockResolvedValueOnce(ACCEPTED_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-2' }, { to_pos: 99 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('returns 404 for non-existent change', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ changeId: 'nope' }, {}), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /:changeId — delete a change
// ═══════════════════════════════════════════════════════════════════════════
describe('DELETE /:changeId', () => {
  const handler = getHandler('delete', '/:changeId');

  it('deletes a change', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.body).toEqual({ ok: true });
    expect(db.run.mock.calls[0][0]).toContain('DELETE');
  });

  it('returns 404 for non-existent change', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ changeId: 'nope' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /file/:fileId/accept-all — bulk accept
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /file/:fileId/accept-all', () => {
  const handler = getHandler('post', '/file/:fileId/accept-all');

  it('accepts all pending changes for a file', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.body).toEqual({ ok: true });
    const sql = db.run.mock.calls[0][0];
    expect(sql).toContain("status = 'accepted'");
    expect(sql).toContain("status = 'pending'");
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 for missing file', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ fileId: 'nope' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('stores resolved_by as the current user', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, {}, { userId: 'reviewer-5' }), res);

    expect(db.run.mock.calls[0][1][0]).toBe('reviewer-5');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /file/:fileId/reject-all — bulk reject
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /file/:fileId/reject-all', () => {
  const handler = getHandler('post', '/file/:fileId/reject-all');

  it('rejects all pending changes for a file', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.body).toEqual({ ok: true });
    const sql = db.run.mock.calls[0][0];
    expect(sql).toContain("status = 'rejected'");
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /file/:fileId/adjust-positions — bulk position adjustment
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /file/:fileId/adjust-positions', () => {
  const handler = getHandler('post', '/file/:fileId/adjust-positions');

  it('adjusts positions of pending changes after a given position', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const body = { afterPos: 20, delta: -5 };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.body).toEqual({ ok: true });
    const args = db.run.mock.calls[0][1];
    expect(args[0]).toBe(-5); // delta
    expect(args[2]).toBe(20); // afterPos
  });

  it('handles positive delta (text inserted before changes)', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const body = { afterPos: 0, delta: 10 };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(db.run.mock.calls[0][1][0]).toBe(10);
  });

  it('rejects non-integer afterPos', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { afterPos: 'abc', delta: 5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects non-integer delta', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { afterPos: 10, delta: 1.5 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects missing parameters', async () => {
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, {}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const body = { afterPos: 0, delta: 5 };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('only adjusts pending changes, SQL includes status filter', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const body = { afterPos: 0, delta: 5 };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    const sql = db.run.mock.calls[0][0];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('from_pos >= $3');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-cutting: auth helper edge cases
// ═══════════════════════════════════════════════════════════════════════════
describe('Auth helpers', () => {
  it('requireFileEditor returns 403 for non-members on create', async () => {
    const handler = getHandler('post', '/:fileId');
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(null);

    const body = { from_pos: 0, to_pos: 5, inserted_text: 'hi' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toBe('No access');
  });

  it('requireChangeEditor returns 403 for non-members on accept', async () => {
    const handler = getHandler('post', '/:changeId/accept');
    db.get.mockResolvedValueOnce(PENDING_CHANGE);
    isProjectMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ changeId: 'change-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toBe('No access');
  });
});
