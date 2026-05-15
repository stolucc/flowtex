import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// Mock db.js before importing websocket module
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    run: vi.fn(),
    all: vi.fn(),
  },
}));

// Mock logger to suppress output
vi.mock('../logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock ioredis to avoid real connections
vi.mock('ioredis', () => ({
  default: vi.fn(),
}));

import db from '../db.js';
import { _testing } from '../websocket.js';

const {
  unsignCookie,
  handleChanges,
  handleCursor,
  handleComment,
  handleCommentReply,
  handleCommentResolve,
  handleCommentDelete,
  handleCommentEdit,
  handleTrackedChange,
  handleTrackedChangeResolve,
  handleTrackedChangeDelete,
  handleTcDeleteMark,
  handleChat,
  handleTyping,
  handleJoin,
  writeTypes,
  projectRooms,
  broadcastToRoom,
  getRoom,
  WS_RATE_WINDOW,
  WS_RATE_MAX,
} = _testing;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeWs() {
  return { send: vi.fn(), readyState: 1, close: vi.fn() };
}

// Stable UUIDs used across the suite. Real fileIds are UUIDs because they
// come from Postgres; the WS handlers now validate this format, so tests
// must use the same shape.
const TEST_FILE_IDS = {
  f1: '00000000-0000-4000-8000-000000000001',
  f2: '00000000-0000-4000-8000-000000000002',
};

function makeState(overrides = {}) {
  const ws = makeWs();
  return {
    authenticatedUserId: 'user-1',
    authenticatedUserName: 'Alice',
    projectId: 'project-123',
    clientEntry: { ws, userId: 'user-1', userName: 'Alice', cursor: null },
    memberRole: 'editor',
    fileIds: new Set(Object.values(TEST_FILE_IDS)),
    ...overrides,
  };
}

function signCookie(id, secret) {
  const mac = crypto.createHmac('sha256', secret).update(id).digest('base64').replace(/=+$/, '');
  return `s:${id}.${mac}`;
}

function setupRoom(projectId, clients) {
  projectRooms.set(projectId, new Set(clients));
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  projectRooms.clear();
  vi.clearAllMocks();
});

// ── unsignCookie ─────────────────────────────────────────────────────────

describe('unsignCookie', () => {
  const secret = 'test-secret-key';

  it('returns null for values not prefixed with s:', async () => {
    expect(unsignCookie('plain-value', secret)).toBeNull();
    expect(unsignCookie('', secret)).toBeNull();
  });

  it('returns null when there is no dot separator', async () => {
    expect(unsignCookie('s:nodot', secret)).toBeNull();
  });

  it('returns null for invalid signatures', async () => {
    expect(unsignCookie('s:session-id.invalidsignature', secret)).toBeNull();
  });

  it('returns null when mac length differs from expected', async () => {
    // Signature that is the wrong length
    expect(unsignCookie('s:session-id.short', secret)).toBeNull();
  });

  it('returns the session ID for a valid signed cookie', async () => {
    const sessionId = 'abc123-session-id';
    const signed = signCookie(sessionId, secret);
    expect(unsignCookie(signed, secret)).toBe(sessionId);
  });

  it('returns null when secret is wrong', async () => {
    const signed = signCookie('my-session', 'correct-secret');
    expect(unsignCookie(signed, 'wrong-secret')).toBeNull();
  });

  it('handles session IDs containing dots', async () => {
    const sessionId = 'session.with.dots';
    const signed = signCookie(sessionId, secret);
    // lastIndexOf('.') is used, so this should work
    expect(unsignCookie(signed, secret)).toBe(sessionId);
  });
});

// ── handleChanges ────────────────────────────────────────────────────────

describe('handleChanges', () => {
  it('drops message if changes is not an array', async () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges({ type: 'changes', changes: 'not-array' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if changes is null', async () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges({ type: 'changes', changes: null }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if changes array exceeds 1000 elements', async () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const changes = Array.from({ length: 1001 }, () => ({ from: 0, insert: 'x' }));
    await handleChanges({ type: 'changes', changes }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if a change has insert exceeding 500000 chars', async () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const changes = [{ from: 0, insert: 'x'.repeat(500001) }];
    await handleChanges({ type: 'changes', changes }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if change.from is not a number', async () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges({ type: 'changes', changes: [{ from: 'bad' }] }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid changes to other clients in the room', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const changes = [{ from: 0, to: 5, insert: 'hello' }];
    await handleChanges({ type: 'changes', fileId: TEST_FILE_IDS.f1, changes }, state, ws);

    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('changes');
    expect(sent.fileId).toBe(TEST_FILE_IDS.f1);
    expect(sent.changes).toEqual(changes);
    expect(sent.userId).toBe('user-1');
  });

  it('preserves the sender-supplied originId in the broadcast (echo-filter contract)', async () => {
    // The client tags its outgoing changes with a per-tab originId so it can
    // drop echoes of its own edits on reconnect. That only works if the
    // server passes the field through unchanged in its broadcast.
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges(
      { type: 'changes', fileId: TEST_FILE_IDS.f1, changes: [{ from: 0, insert: 'x' }], originId: 'tab-uuid-abc' },
      state,
      ws,
    );
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.originId).toBe('tab-uuid-abc');
  });

  it('omits originId from the broadcast when the sender did not provide one', async () => {
    // Backwards compatible — older clients that don't stamp the field
    // shouldn't get an `originId: undefined` polluting the broadcast.
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges(
      { type: 'changes', fileId: TEST_FILE_IDS.f1, changes: [{ from: 0, insert: 'x' }] },
      state,
      ws,
    );
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect('originId' in sent).toBe(false);
  });

  it('rejects a non-string originId (does not echo arbitrary types)', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges(
      { type: 'changes', fileId: TEST_FILE_IDS.f1, changes: [{ from: 0, insert: 'x' }], originId: { evil: true } },
      state,
      ws,
    );
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect('originId' in sent).toBe(false);
  });

  it('does not send back to the sender', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    setupRoom('project-123', [state.clientEntry]);

    await handleChanges({ type: 'changes', fileId: TEST_FILE_IDS.f1, changes: [{ from: 0 }] }, state, ws);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('includes tracked and deletions fields when present', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges(
      { type: 'changes', fileId: TEST_FILE_IDS.f1, changes: [{ from: 0 }], tracked: true, deletions: [{ id: 'd1' }] },
      state,
      ws,
    );
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.tracked).toBe(true);
    expect(sent.deletions).toEqual([{ id: 'd1' }]);
  });

  it('accepts changes with only insert (no from/to)', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges({ type: 'changes', fileId: TEST_FILE_IDS.f1, changes: [{ insert: 'text' }] }, state, ws);
    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
  });

  it('accepts empty changes array', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChanges({ type: 'changes', fileId: TEST_FILE_IDS.f1, changes: [] }, state, ws);
    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
  });
});

// ── handleCursor ─────────────────────────────────────────────────────────

describe('handleCursor', () => {
  it('drops message if head is not a number', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleCursor({ type: 'cursor', head: 'bad', anchor: 0, fileId: TEST_FILE_IDS.f1 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if anchor is not a number', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleCursor({ type: 'cursor', head: 5, anchor: 'bad', fileId: TEST_FILE_IDS.f1 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if fileId is not a string', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleCursor({ type: 'cursor', head: 5, anchor: 0, fileId: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('updates clientEntry.cursor and broadcasts to room', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleCursor({ type: 'cursor', head: 10, anchor: 5, fileId: TEST_FILE_IDS.f1 }, state, ws);

    expect(state.clientEntry.cursor).toEqual({ fileId: TEST_FILE_IDS.f1, head: 10, anchor: 5 });
    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('cursor');
    expect(sent.head).toBe(10);
    expect(sent.anchor).toBe(5);
    expect(sent.fileId).toBe(TEST_FILE_IDS.f1);
    expect(sent.userId).toBe('user-1');
    expect(sent.userName).toBe('Alice');
  });

  it('preserves the sender-supplied originId so own-cursor echoes can be filtered client-side', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleCursor(
      { type: 'cursor', head: 10, anchor: 5, fileId: TEST_FILE_IDS.f1, originId: 'tab-uuid-abc' },
      state,
      ws,
    );
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.originId).toBe('tab-uuid-abc');
  });
});

// ── handleComment ────────────────────────────────────────────────────────

describe('handleComment', () => {
  it('drops message if comment JSON exceeds 10000 chars', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const bigComment = { text: 'x'.repeat(10000) };
    await handleComment({ type: 'comment', fileId: TEST_FILE_IDS.f1, comment: bigComment }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if comment is falsy', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleComment({ type: 'comment', fileId: TEST_FILE_IDS.f1, comment: null }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid comment to room', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const comment = { id: 'c1', text: 'Great work!' };
    await handleComment({ type: 'comment', fileId: TEST_FILE_IDS.f1, comment }, state, ws);

    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('comment');
    expect(sent.comment).toEqual(comment);
    expect(sent.fileId).toBe(TEST_FILE_IDS.f1);
  });
});

// ── handleCommentReply ───────────────────────────────────────────────────

describe('handleCommentReply', () => {
  it('drops message if reply JSON exceeds 10000 chars', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentReply({ type: 'comment-reply', commentId: 'c1', reply: { text: 'x'.repeat(10000) } }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if reply is falsy', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentReply({ type: 'comment-reply', commentId: 'c1', reply: null }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid reply', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentReply({ type: 'comment-reply', commentId: 'c1', reply: { text: 'Thanks!' } }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('comment-reply');
    expect(sent.commentId).toBe('c1');
  });
});

// ── handleCommentResolve ─────────────────────────────────────────────────

describe('handleCommentResolve', () => {
  it('drops message if resolved is not a boolean', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentResolve({ type: 'comment-resolve', commentId: 'c1', resolved: 'yes' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid resolve', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentResolve({ type: 'comment-resolve', commentId: 'c1', resolved: true }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('comment-resolve');
    expect(sent.resolved).toBe(true);
  });
});

// ── handleCommentDelete ──────────────────────────────────────────────────

describe('handleCommentDelete', () => {
  it('drops message if commentId is falsy', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentDelete({ type: 'comment-delete', commentId: '' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid delete', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentDelete({ type: 'comment-delete', commentId: 'c1' }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('comment-delete');
    expect(sent.commentId).toBe('c1');
  });
});

// ── handleCommentEdit ────────────────────────────────────────────────────

describe('handleCommentEdit', () => {
  it('drops message if text is not a string', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentEdit({ type: 'comment-edit', commentId: 'c1', text: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if text exceeds 10000 chars', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentEdit({ type: 'comment-edit', commentId: 'c1', text: 'x'.repeat(10001) }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid edit', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentEdit({ type: 'comment-edit', commentId: 'c1', text: 'updated' }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('comment-edit');
    expect(sent.text).toBe('updated');
  });
});

// ── handleChat ───────────────────────────────────────────────────────────

describe('handleChat', () => {
  it('trims and caps text at 5000 chars', async () => {
    db.run.mockResolvedValue({});
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const longText = 'a'.repeat(6000);
    await handleChat({ type: 'chat', text: `  ${longText}  ` }, state);

    expect(db.run).toHaveBeenCalledTimes(1);
    const insertedText = db.run.mock.calls[0][1][4];
    expect(insertedText.length).toBe(5000);
  });

  it('ignores empty or whitespace-only text', async () => {
    const state = makeState();

    await handleChat({ type: 'chat', text: '   ' }, state);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('ignores missing text', async () => {
    const state = makeState();

    await handleChat({ type: 'chat' }, state);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('calls db.run to insert and broadcasts to room', async () => {
    db.run.mockResolvedValue({});
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChat({ type: 'chat', text: 'Hello everyone!' }, state);

    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toContain('INSERT INTO chat_messages');
    expect(params[1]).toBe('project-123');
    expect(params[2]).toBe('user-1');
    expect(params[3]).toBe('Alice');
    expect(params[4]).toBe('Hello everyone!');

    // Both sender and peer should receive chat (no excludeWs for chat)
    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('chat');
    expect(sent.text).toBe('Hello everyone!');
    expect(sent.userId).toBe('user-1');
    expect(sent.userName).toBe('Alice');
    expect(sent.id).toBeDefined();
    expect(sent.created_at).toBeDefined();
  });

  it('does not broadcast if db insert fails', async () => {
    db.run.mockRejectedValue(new Error('DB error'));
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleChat({ type: 'chat', text: 'Hello' }, state);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });
});

// ── handleTrackedChange ──────────────────────────────────────────────────

describe('handleTrackedChange', () => {
  it('drops if change is falsy', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTrackedChange({ type: 'tracked-change', change: null, fileId: TEST_FILE_IDS.f1 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if fileId is not a string', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTrackedChange({ type: 'tracked-change', change: { from: 0 }, fileId: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if change JSON exceeds 10000 chars', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const bigChange = { text: 'x'.repeat(10000) };
    await handleTrackedChange({ type: 'tracked-change', change: bigChange, fileId: TEST_FILE_IDS.f1 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid tracked change', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const change = { from: 0, to: 5, insert: 'new' };
    await handleTrackedChange({ type: 'tracked-change', change, fileId: TEST_FILE_IDS.f1 }, state, ws);

    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('tracked-change');
    expect(sent.fileId).toBe(TEST_FILE_IDS.f1);
    expect(sent.change).toEqual(change);
  });
});

// ── handleTrackedChangeResolve ───────────────────────────────────────────

describe('handleTrackedChangeResolve', () => {
  it('drops if status is not accepted or rejected', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChangeResolve({ type: 'tracked-change-resolve', changeId: 'tc1', status: 'pending' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid resolve with accepted status', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChangeResolve({ type: 'tracked-change-resolve', changeId: 'tc1', status: 'accepted' }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('tracked-change-resolve');
    expect(sent.status).toBe('accepted');
  });

  it('broadcasts valid resolve with rejected status', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChangeResolve({ type: 'tracked-change-resolve', changeId: 'tc1', status: 'rejected' }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.status).toBe('rejected');
  });
});

// ── handleTrackedChangeDelete ────────────────────────────────────────────

describe('handleTrackedChangeDelete', () => {
  it('drops if changeId is not a string', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTrackedChangeDelete({ type: 'tracked-change-delete', changeId: 123, fileId: TEST_FILE_IDS.f1 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if fileId is not a string', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTrackedChangeDelete({ type: 'tracked-change-delete', changeId: 'tc1', fileId: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid tracked change delete', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTrackedChangeDelete({ type: 'tracked-change-delete', changeId: 'tc1', fileId: TEST_FILE_IDS.f1 }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('tracked-change-delete');
    expect(sent.changeId).toBe('tc1');
    expect(sent.fileId).toBe(TEST_FILE_IDS.f1);
  });
});

// ── handleTcDeleteMark ───────────────────────────────────────────────────

describe('handleTcDeleteMark', () => {
  it('drops if from is not a number', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTcDeleteMark({ type: 'tc-delete-mark', from: 'bad', to: 10, fileId: TEST_FILE_IDS.f1 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if to is not a number', async () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTcDeleteMark({ type: 'tc-delete-mark', from: 0, to: 'bad', fileId: TEST_FILE_IDS.f1 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid tc-delete-mark', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    await handleTcDeleteMark({ type: 'tc-delete-mark', from: 0, to: 10, fileId: TEST_FILE_IDS.f1 }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('tc-delete-mark');
    expect(sent.from).toBe(0);
    expect(sent.to).toBe(10);
  });
});

// ── handleTyping ─────────────────────────────────────────────────────────

describe('handleTyping', () => {
  it('broadcasts typing indicator to room excluding sender', async () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTyping({ type: 'typing' }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('typing');
    expect(sent.userId).toBe('user-1');
    expect(sent.userName).toBe('Alice');
  });
});

// ── writeTypes ───────────────────────────────────────────────────────────

describe('writeTypes', () => {
  it('contains all write message types', async () => {
    const expected = [
      'changes',
      'comment',
      'comment-reply',
      'comment-resolve',
      'comment-delete',
      'comment-edit',
      'tracked-change',
      'tracked-change-resolve',
      'tracked-change-delete',
      'tc-delete-mark',
    ];
    for (const type of expected) {
      expect(writeTypes.has(type)).toBe(true);
    }
  });

  it('does NOT contain join', async () => {
    expect(writeTypes.has('join')).toBe(false);
  });

  it('does NOT contain cursor', async () => {
    expect(writeTypes.has('cursor')).toBe(false);
  });

  it('contains chat (viewers must be read-only)', async () => {
    expect(writeTypes.has('chat')).toBe(true);
  });

  it('does NOT contain typing', async () => {
    expect(writeTypes.has('typing')).toBe(false);
  });
});

// ── handleJoin ───────────────────────────────────────────────────────────

describe('handleJoin', () => {
  const validUUID = '12345678-1234-1234-1234-123456789abc';

  it('returns early if projectId is not a valid UUID', async () => {
    const ws = makeWs();
    const state = makeState({ projectId: null, clientEntry: null });

    await handleJoin(ws, { type: 'join', projectId: 'not-a-uuid' }, state);
    expect(db.get).not.toHaveBeenCalled();
    expect(state.projectId).toBeNull();
  });

  it('returns early if projectId is not a string', async () => {
    const ws = makeWs();
    const state = makeState({ projectId: null, clientEntry: null });

    await handleJoin(ws, { type: 'join', projectId: 123 }, state);
    expect(db.get).not.toHaveBeenCalled();
  });

  it('closes ws if user is not a member of the project', async () => {
    db.get.mockResolvedValue(undefined);
    const ws = makeWs();
    const state = makeState({ projectId: null, clientEntry: null });

    await handleJoin(ws, { type: 'join', projectId: validUUID }, state);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'error', error: 'No access' }));
    expect(ws.close).toHaveBeenCalled();
  });

  it('adds client to room and sends joined message on success', async () => {
    db.get.mockResolvedValue({ role: 'editor' });
    const ws = makeWs();
    const state = {
      authenticatedUserId: 'user-1',
      authenticatedUserName: 'Alice',
      projectId: null,
      clientEntry: null,
      memberRole: null,
    };

    await handleJoin(ws, { type: 'join', projectId: validUUID }, state);

    expect(state.projectId).toBe(validUUID);
    expect(state.memberRole).toBe('editor');
    expect(state.clientEntry).not.toBeNull();
    expect(state.clientEntry.ws).toBe(ws);
    expect(state.clientEntry.userId).toBe('user-1');

    // Should have sent 'joined' message
    const joinedCall = ws.send.mock.calls.find((c) => {
      const msg = JSON.parse(c[0]);
      return msg.type === 'joined';
    });
    expect(joinedCall).toBeDefined();
    const joinedMsg = JSON.parse(joinedCall[0]);
    expect(joinedMsg.userId).toBe('user-1');
    expect(joinedMsg.userName).toBe('Alice');

    // Room should contain the client
    const room = projectRooms.get(validUUID);
    expect(room).toBeDefined();
    expect(room.has(state.clientEntry)).toBe(true);
  });

  it('leaves previous room when joining a different project', async () => {
    // Set up initial room with the client
    const ws = makeWs();
    const oldEntry = { ws, userId: 'user-1', userName: 'Alice', cursor: null };
    const oldPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('old-project-id', new Set([oldEntry, oldPeer]));

    const state = {
      authenticatedUserId: 'user-1',
      authenticatedUserName: 'Alice',
      projectId: 'old-project-id',
      clientEntry: oldEntry,
      memberRole: 'editor',
    };

    db.get.mockResolvedValue({ role: 'owner' });

    await handleJoin(ws, { type: 'join', projectId: validUUID }, state);

    // Old room should no longer contain the client
    const oldRoom = projectRooms.get('old-project-id');
    expect(oldRoom).toBeDefined();
    expect(oldRoom.has(oldEntry)).toBe(false);
    // But the peer should still be there
    expect(oldRoom.has(oldPeer)).toBe(true);

    // New room should contain the new client entry
    expect(state.projectId).toBe(validUUID);
    expect(state.memberRole).toBe('owner');
  });

  it('broadcasts presence after joining', async () => {
    db.get.mockResolvedValue({ role: 'editor' });
    const ws = makeWs();
    const existingPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob', cursor: null };
    setupRoom(validUUID, [existingPeer]);

    const state = {
      authenticatedUserId: 'user-1',
      authenticatedUserName: 'Alice',
      projectId: null,
      clientEntry: null,
      memberRole: null,
    };

    await handleJoin(ws, { type: 'join', projectId: validUUID }, state);

    // Both clients should receive presence broadcast
    const peerPresence = existingPeer.ws.send.mock.calls.find((c) => {
      const msg = JSON.parse(c[0]);
      return msg.type === 'presence';
    });
    expect(peerPresence).toBeDefined();
    const presenceMsg = JSON.parse(peerPresence[0]);
    expect(presenceMsg.users).toHaveLength(2);
    const userIds = presenceMsg.users.map((u) => u.id);
    expect(userIds).toContain('user-1');
    expect(userIds).toContain('user-2');
  });

  it('sends existing cursors to newly joined client', async () => {
    db.get.mockResolvedValue({ role: 'editor' });
    const ws = makeWs();
    const existingPeer = {
      ws: makeWs(),
      userId: 'user-2',
      userName: 'Bob',
      cursor: { fileId: TEST_FILE_IDS.f1, head: 42, anchor: 42 },
    };
    setupRoom(validUUID, [existingPeer]);

    const state = {
      authenticatedUserId: 'user-1',
      authenticatedUserName: 'Alice',
      projectId: null,
      clientEntry: null,
      memberRole: null,
    };

    await handleJoin(ws, { type: 'join', projectId: validUUID }, state);

    // The new client should receive the existing peer's cursor
    const cursorCall = ws.send.mock.calls.find((c) => {
      const msg = JSON.parse(c[0]);
      return msg.type === 'cursor';
    });
    expect(cursorCall).toBeDefined();
    const cursorMsg = JSON.parse(cursorCall[0]);
    expect(cursorMsg.userId).toBe('user-2');
    expect(cursorMsg.head).toBe(42);
    expect(cursorMsg.fileId).toBe(TEST_FILE_IDS.f1);
  });
});

// ── broadcastToRoom ──────────────────────────────────────────────────────

describe('broadcastToRoom', () => {
  it('sends to all clients except the excluded one', async () => {
    const ws1 = makeWs();
    const ws2 = makeWs();
    const ws3 = makeWs();
    setupRoom('p1', [
      { ws: ws1, userId: 'u1', userName: 'A' },
      { ws: ws2, userId: 'u2', userName: 'B' },
      { ws: ws3, userId: 'u3', userName: 'C' },
    ]);

    broadcastToRoom('p1', { type: 'test', data: 'hello' }, ws2);

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).not.toHaveBeenCalled();
    expect(ws3.send).toHaveBeenCalledTimes(1);
  });

  it('skips clients with readyState !== 1', async () => {
    const wsOpen = makeWs();
    const wsClosed = { send: vi.fn(), readyState: 3 };
    setupRoom('p1', [
      { ws: wsOpen, userId: 'u1', userName: 'A' },
      { ws: wsClosed, userId: 'u2', userName: 'B' },
    ]);

    broadcastToRoom('p1', { type: 'test' });

    expect(wsOpen.send).toHaveBeenCalledTimes(1);
    expect(wsClosed.send).not.toHaveBeenCalled();
  });

  it('does nothing if room does not exist', async () => {
    // Should not throw
    broadcastToRoom('nonexistent', { type: 'test' });
  });

  it('sends to all clients when excludeWs is not provided', async () => {
    const ws1 = makeWs();
    const ws2 = makeWs();
    setupRoom('p1', [
      { ws: ws1, userId: 'u1', userName: 'A' },
      { ws: ws2, userId: 'u2', userName: 'B' },
    ]);

    broadcastToRoom('p1', { type: 'test' });
    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
  });
});

// ── getRoom ──────────────────────────────────────────────────────────────

describe('getRoom', () => {
  it('creates a new room if one does not exist', async () => {
    const room = getRoom('new-project');
    expect(room).toBeInstanceOf(Set);
    expect(room.size).toBe(0);
    expect(projectRooms.has('new-project')).toBe(true);
  });

  it('returns existing room', async () => {
    const existing = new Set([{ ws: makeWs(), userId: 'u1' }]);
    projectRooms.set('existing', existing);
    expect(getRoom('existing')).toBe(existing);
  });
});

// ── Rate limiting constants ──────────────────────────────────────────────

describe('rate limiting constants', () => {
  it('WS_RATE_WINDOW is 1000ms', async () => {
    expect(WS_RATE_WINDOW).toBe(1000);
  });

  it('WS_RATE_MAX is 30', async () => {
    expect(WS_RATE_MAX).toBe(30);
  });
});
