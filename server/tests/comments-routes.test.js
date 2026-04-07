import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────
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

vi.mock('uuid', () => ({ v4: () => 'comment-uuid-1234' }));

vi.mock('../utils/mentions.js', () => ({
  recordMentions: vi.fn().mockResolvedValue([]),
}));

import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';
import router from '../routes/comments.js';

// ── Handler extraction ──────────────────────────────────────────────────
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

// ── Helpers ─────────────────────────────────────────────────────────────
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

const FILE_ROW = { id: 'file-1', project_id: 'proj-1', path: 'main.tex' };
const MEMBER_EDITOR = { role: 'editor' };
const MEMBER_VIEWER = { role: 'viewer' };

const COMMENT = {
  id: 'comment-1',
  file_id: 'file-1',
  from_pos: 10,
  to_pos: 20,
  text: 'Fix this',
  author: 'Alice',
  author_id: 'user-1',
  resolved: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:fileId — list comments with replies
// ═════════════════════════════════════════════════════════════════════════
describe('GET /:fileId', () => {
  const handler = getHandler('get', '/:fileId');

  it('returns comments with replies', async () => {
    // requireFileAccess mocks
    db.get.mockResolvedValueOnce(FILE_ROW); // file lookup
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const comments = [
      { ...COMMENT, id: 'c1' },
      { ...COMMENT, id: 'c2' },
    ];
    db.all.mockResolvedValueOnce(comments); // comments query
    db.all.mockResolvedValueOnce([
      { id: 'r1', comment_id: 'c1', text: 'Done', author: 'Bob', created_at: '2025-01-01' },
    ]); // replies query

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.body).toHaveLength(2);
    expect(res.body[0].replies).toHaveLength(1);
    expect(res.body[1].replies).toEqual([]);
  });

  it('returns empty array when no comments exist', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.all.mockResolvedValueOnce([]); // no comments

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.body).toEqual([]);
  });

  it('returns 404 when file does not exist', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ fileId: 'missing' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toMatch(/file not found/i);
  });

  it('returns 403 when user is not a project member', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows viewers to read comments', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);
    db.all.mockResolvedValueOnce([COMMENT]);
    db.all.mockResolvedValueOnce([]); // no replies

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }), res);

    expect(res.body).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /:fileId — create a comment
// ═════════════════════════════════════════════════════════════════════════
describe('POST /:fileId', () => {
  const handler = getHandler('post', '/:fileId');

  it('creates a comment with valid data', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW); // requireFileAccess
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.get.mockResolvedValueOnce({ project_id: 'proj-1' }); // project_id lookup
    db.run.mockResolvedValueOnce({}); // INSERT
    db.get.mockResolvedValueOnce({ ...COMMENT, id: 'comment-uuid-1234' }); // SELECT after insert

    const body = { from_pos: 10, to_pos: 20, text: 'Fix this' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][1]).toContain('comment-uuid-1234');
    expect(res.body.id).toBe('comment-uuid-1234');
  });

  it('rejects negative from_pos', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: -1, to_pos: 5, text: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/position/i);
  });

  it('rejects negative to_pos', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 0, to_pos: -1, text: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects non-integer positions', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 1.5, to_pos: 5, text: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects string positions', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 'abc', to_pos: 5, text: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects missing text', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 0, to_pos: 5 }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('rejects empty text', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 0, to_pos: 5, text: '   ' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects text longer than 10000 characters', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, { from_pos: 0, to_pos: 5, text: 'a'.repeat(10001) }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/10000/);
  });

  it('rejects viewers from creating comments', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const body = { from_pos: 0, to_pos: 5, text: 'hi' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toMatch(/viewer/i);
  });

  it('returns 404 when file not found', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const body = { from_pos: 0, to_pos: 5, text: 'hi' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'missing' }, body), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('uses session userName for author', async () => {
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.get.mockResolvedValueOnce({ project_id: 'proj-1' }); // project_id lookup
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce(COMMENT);

    const body = { from_pos: 0, to_pos: 5, text: 'note' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body, { userId: 'user-1', userName: 'Bob' }), res);

    const insertArgs = db.run.mock.calls[0][1];
    expect(insertArgs[5]).toBe('Bob'); // author
  });

  it('falls back to DB user name when session userName is falsy', async () => {
    db.get
      .mockResolvedValueOnce(FILE_ROW) // file lookup
      .mockResolvedValueOnce({ project_id: 'proj-1' }) // project_id lookup
      .mockResolvedValueOnce({ name: 'DbAlice' }) // user name lookup
      .mockResolvedValueOnce(COMMENT); // final SELECT
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const body = { from_pos: 0, to_pos: 5, text: 'note' };
    const res = mockRes();
    await handler(mockReq({ fileId: 'file-1' }, body, { userId: 'user-1', userName: '' }), res);

    const insertArgs = db.run.mock.calls[0][1];
    expect(insertArgs[5]).toBe('DbAlice');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// PATCH /:commentId/resolve — toggle resolved flag
// ═════════════════════════════════════════════════════════════════════════
describe('PATCH /:commentId/resolve', () => {
  const handler = getHandler('patch', '/:commentId/resolve');

  it('resolves a comment', async () => {
    // requireCommentAccess: comment lookup, then requireFileAccess
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' }); // comment
    db.get.mockResolvedValueOnce(FILE_ROW); // file
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({}); // UPDATE

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { resolved: true }), res);

    expect(res.body).toEqual({ ok: true });
    expect(db.run.mock.calls[0][1][0]).toBe(true); // resolved = true
  });

  it('unresolves a comment', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { resolved: false }), res);

    expect(res.body).toEqual({ ok: true });
    expect(db.run.mock.calls[0][1][0]).toBe(false);
  });

  it('returns 404 when comment does not exist', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ commentId: 'missing' }, { resolved: true }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toMatch(/comment not found/i);
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { resolved: true }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /:commentId — delete a comment (only by author)
// ═════════════════════════════════════════════════════════════════════════
describe('DELETE /:commentId', () => {
  const handler = getHandler('delete', '/:commentId');

  it('deletes a comment by the author', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' }); // comment
    db.get.mockResolvedValueOnce(FILE_ROW); // file
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }), res);

    expect(res.body).toEqual({ ok: true });
    expect(db.run.mock.calls[0][0]).toContain('DELETE');
  });

  it('returns 403 when non-author tries to delete', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-other' }); // different author
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toMatch(/author/i);
  });

  it('returns 404 when comment does not exist', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ commentId: 'missing' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 for non-members', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /:commentId/reply — add a reply to a comment
// ═════════════════════════════════════════════════════════════════════════
describe('POST /:commentId/reply', () => {
  const handler = getHandler('post', '/:commentId/reply');

  it('creates a reply with valid text', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' }); // comment
    db.get.mockResolvedValueOnce(FILE_ROW); // file
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({}); // INSERT
    db.get.mockResolvedValueOnce({ id: 'c1', project_id: 'proj-1' }); // parentComment lookup
    db.get.mockResolvedValueOnce({ id: 'comment-uuid-1234', comment_id: 'c1', text: 'Thanks', author: 'Alice' }); // SELECT

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: 'Thanks' }), res);

    expect(res.body.id).toBe('comment-uuid-1234');
    expect(db.run.mock.calls[0][1]).toContain('comment-uuid-1234');
  });

  it('rejects missing text', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, {}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('rejects empty text', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: '   ' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects text longer than 10000 characters', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: 'x'.repeat(10001) }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when comment does not exist', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ commentId: 'missing' }, { text: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 403 for viewers', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_VIEWER);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('uses session userName for reply author', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});
    db.get.mockResolvedValueOnce({ id: 'r1', text: 'reply' });

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: 'reply' }, { userId: 'user-1', userName: 'Bob' }), res);

    const insertArgs = db.run.mock.calls[0][1];
    expect(insertArgs[3]).toBe('Bob'); // author
  });
});

// ═════════════════════════════════════════════════════════════════════════
// PATCH /:commentId — edit a comment's text (only by author)
// ═════════════════════════════════════════════════════════════════════════
describe('PATCH /:commentId', () => {
  const handler = getHandler('patch', '/:commentId');

  it('updates comment text by author', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' }); // comment
    db.get.mockResolvedValueOnce(FILE_ROW); // file
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: 'Updated text' }), res);

    expect(res.body).toEqual({ ok: true, text: 'Updated text' });
    expect(db.run.mock.calls[0][1][0]).toBe('Updated text');
  });

  it('trims whitespace from text', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: '  hello  ' }), res);

    expect(res.body.text).toBe('hello');
  });

  it('rejects missing text', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, {}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('rejects empty text (whitespace only)', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-1' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: '   ' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 403 when non-author tries to edit', async () => {
    db.get.mockResolvedValueOnce({ id: 'c1', file_id: 'file-1', author_id: 'user-other' });
    db.get.mockResolvedValueOnce(FILE_ROW);
    isProjectMember.mockResolvedValueOnce(MEMBER_EDITOR);

    const res = mockRes();
    await handler(mockReq({ commentId: 'c1' }, { text: 'hacked' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toMatch(/author/i);
  });

  it('returns 404 when comment does not exist', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ commentId: 'missing' }, { text: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
