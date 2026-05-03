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

function makeState(overrides = {}) {
  const ws = makeWs();
  return {
    authenticatedUserId: 'user-1',
    authenticatedUserName: 'Alice',
    projectId: 'project-123',
    clientEntry: { ws, userId: 'user-1', userName: 'Alice', cursor: null },
    memberRole: 'editor',
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

  it('returns null for values not prefixed with s:', () => {
    expect(unsignCookie('plain-value', secret)).toBeNull();
    expect(unsignCookie('', secret)).toBeNull();
  });

  it('returns null when there is no dot separator', () => {
    expect(unsignCookie('s:nodot', secret)).toBeNull();
  });

  it('returns null for invalid signatures', () => {
    expect(unsignCookie('s:session-id.invalidsignature', secret)).toBeNull();
  });

  it('returns null when mac length differs from expected', () => {
    // Signature that is the wrong length
    expect(unsignCookie('s:session-id.short', secret)).toBeNull();
  });

  it('returns the session ID for a valid signed cookie', () => {
    const sessionId = 'abc123-session-id';
    const signed = signCookie(sessionId, secret);
    expect(unsignCookie(signed, secret)).toBe(sessionId);
  });

  it('returns null when secret is wrong', () => {
    const signed = signCookie('my-session', 'correct-secret');
    expect(unsignCookie(signed, 'wrong-secret')).toBeNull();
  });

  it('handles session IDs containing dots', () => {
    const sessionId = 'session.with.dots';
    const signed = signCookie(sessionId, secret);
    // lastIndexOf('.') is used, so this should work
    expect(unsignCookie(signed, secret)).toBe(sessionId);
  });
});

// ── handleChanges ────────────────────────────────────────────────────────

describe('handleChanges', () => {
  it('drops message if changes is not an array', () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleChanges({ type: 'changes', changes: 'not-array' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if changes is null', () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleChanges({ type: 'changes', changes: null }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if changes array exceeds 1000 elements', () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const changes = Array.from({ length: 1001 }, () => ({ from: 0, insert: 'x' }));
    handleChanges({ type: 'changes', changes }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if a change has insert exceeding 500000 chars', () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const changes = [{ from: 0, insert: 'x'.repeat(500001) }];
    handleChanges({ type: 'changes', changes }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if change.from is not a number', () => {
    const state = makeState();
    const ws = makeWs();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleChanges({ type: 'changes', changes: [{ from: 'bad' }] }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid changes to other clients in the room', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const changes = [{ from: 0, to: 5, insert: 'hello' }];
    handleChanges({ type: 'changes', fileId: 'file-1', changes }, state, ws);

    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('changes');
    expect(sent.fileId).toBe('file-1');
    expect(sent.changes).toEqual(changes);
    expect(sent.userId).toBe('user-1');
  });

  it('does not send back to the sender', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    setupRoom('project-123', [state.clientEntry]);

    handleChanges({ type: 'changes', fileId: 'f1', changes: [{ from: 0 }] }, state, ws);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('includes tracked and deletions fields when present', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleChanges(
      { type: 'changes', fileId: 'f1', changes: [{ from: 0 }], tracked: true, deletions: [{ id: 'd1' }] },
      state,
      ws,
    );
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.tracked).toBe(true);
    expect(sent.deletions).toEqual([{ id: 'd1' }]);
  });

  it('accepts changes with only insert (no from/to)', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleChanges({ type: 'changes', fileId: 'f1', changes: [{ insert: 'text' }] }, state, ws);
    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
  });

  it('accepts empty changes array', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleChanges({ type: 'changes', fileId: 'f1', changes: [] }, state, ws);
    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
  });
});

// ── handleCursor ─────────────────────────────────────────────────────────

describe('handleCursor', () => {
  it('drops message if head is not a number', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCursor({ type: 'cursor', head: 'bad', anchor: 0, fileId: 'f1' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if anchor is not a number', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCursor({ type: 'cursor', head: 5, anchor: 'bad', fileId: 'f1' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if fileId is not a string', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCursor({ type: 'cursor', head: 5, anchor: 0, fileId: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('updates clientEntry.cursor and broadcasts to room', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCursor({ type: 'cursor', head: 10, anchor: 5, fileId: 'file-1' }, state, ws);

    expect(state.clientEntry.cursor).toEqual({ fileId: 'file-1', head: 10, anchor: 5 });
    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('cursor');
    expect(sent.head).toBe(10);
    expect(sent.anchor).toBe(5);
    expect(sent.fileId).toBe('file-1');
    expect(sent.userId).toBe('user-1');
    expect(sent.userName).toBe('Alice');
  });
});

// ── handleComment ────────────────────────────────────────────────────────

describe('handleComment', () => {
  it('drops message if comment JSON exceeds 10000 chars', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const bigComment = { text: 'x'.repeat(10000) };
    handleComment({ type: 'comment', fileId: 'f1', comment: bigComment }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if comment is falsy', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleComment({ type: 'comment', fileId: 'f1', comment: null }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid comment to room', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const comment = { id: 'c1', text: 'Great work!' };
    handleComment({ type: 'comment', fileId: 'f1', comment }, state, ws);

    expect(mockPeer.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('comment');
    expect(sent.comment).toEqual(comment);
    expect(sent.fileId).toBe('f1');
  });
});

// ── handleCommentReply ───────────────────────────────────────────────────

describe('handleCommentReply', () => {
  it('drops message if reply JSON exceeds 10000 chars', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentReply({ type: 'comment-reply', commentId: 'c1', reply: { text: 'x'.repeat(10000) } }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if reply is falsy', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentReply({ type: 'comment-reply', commentId: 'c1', reply: null }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid reply', () => {
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
  it('drops message if resolved is not a boolean', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentResolve({ type: 'comment-resolve', commentId: 'c1', resolved: 'yes' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid resolve', () => {
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
  it('drops message if commentId is falsy', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentDelete({ type: 'comment-delete', commentId: '' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid delete', () => {
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
  it('drops message if text is not a string', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentEdit({ type: 'comment-edit', commentId: 'c1', text: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops message if text exceeds 10000 chars', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleCommentEdit({ type: 'comment-edit', commentId: 'c1', text: 'x'.repeat(10001) }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid edit', () => {
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
  it('drops if change is falsy', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChange({ type: 'tracked-change', change: null, fileId: 'f1' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if fileId is not a string', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChange({ type: 'tracked-change', change: { from: 0 }, fileId: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if change JSON exceeds 10000 chars', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const bigChange = { text: 'x'.repeat(10000) };
    handleTrackedChange({ type: 'tracked-change', change: bigChange, fileId: 'f1' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid tracked change', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    const change = { from: 0, to: 5, insert: 'new' };
    handleTrackedChange({ type: 'tracked-change', change, fileId: 'f1' }, state, ws);

    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('tracked-change');
    expect(sent.fileId).toBe('f1');
    expect(sent.change).toEqual(change);
  });
});

// ── handleTrackedChangeResolve ───────────────────────────────────────────

describe('handleTrackedChangeResolve', () => {
  it('drops if status is not accepted or rejected', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChangeResolve({ type: 'tracked-change-resolve', changeId: 'tc1', status: 'pending' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid resolve with accepted status', () => {
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

  it('broadcasts valid resolve with rejected status', () => {
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
  it('drops if changeId is not a string', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChangeDelete({ type: 'tracked-change-delete', changeId: 123, fileId: 'f1' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if fileId is not a string', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChangeDelete({ type: 'tracked-change-delete', changeId: 'tc1', fileId: 123 }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid tracked change delete', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTrackedChangeDelete({ type: 'tracked-change-delete', changeId: 'tc1', fileId: 'f1' }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('tracked-change-delete');
    expect(sent.changeId).toBe('tc1');
    expect(sent.fileId).toBe('f1');
  });
});

// ── handleTcDeleteMark ───────────────────────────────────────────────────

describe('handleTcDeleteMark', () => {
  it('drops if from is not a number', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTcDeleteMark({ type: 'tc-delete-mark', from: 'bad', to: 10, fileId: 'f1' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('drops if to is not a number', () => {
    const ws = makeWs();
    const state = makeState();
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTcDeleteMark({ type: 'tc-delete-mark', from: 0, to: 'bad', fileId: 'f1' }, state, ws);
    expect(mockPeer.ws.send).not.toHaveBeenCalled();
  });

  it('broadcasts valid tc-delete-mark', () => {
    const ws = makeWs();
    const state = makeState();
    state.clientEntry.ws = ws;
    const mockPeer = { ws: makeWs(), userId: 'user-2', userName: 'Bob' };
    setupRoom('project-123', [state.clientEntry, mockPeer]);

    handleTcDeleteMark({ type: 'tc-delete-mark', from: 0, to: 10, fileId: 'f1' }, state, ws);
    const sent = JSON.parse(mockPeer.ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('tc-delete-mark');
    expect(sent.from).toBe(0);
    expect(sent.to).toBe(10);
  });
});

// ── handleTyping ─────────────────────────────────────────────────────────

describe('handleTyping', () => {
  it('broadcasts typing indicator to room excluding sender', () => {
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
  it('contains all write message types', () => {
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

  it('does NOT contain join', () => {
    expect(writeTypes.has('join')).toBe(false);
  });

  it('does NOT contain cursor', () => {
    expect(writeTypes.has('cursor')).toBe(false);
  });

  it('does NOT contain chat', () => {
    expect(writeTypes.has('chat')).toBe(false);
  });

  it('does NOT contain typing', () => {
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
      cursor: { fileId: 'f1', head: 42, anchor: 42 },
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
    expect(cursorMsg.fileId).toBe('f1');
  });
});

// ── broadcastToRoom ──────────────────────────────────────────────────────

describe('broadcastToRoom', () => {
  it('sends to all clients except the excluded one', () => {
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

  it('skips clients with readyState !== 1', () => {
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

  it('does nothing if room does not exist', () => {
    // Should not throw
    broadcastToRoom('nonexistent', { type: 'test' });
  });

  it('sends to all clients when excludeWs is not provided', () => {
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
  it('creates a new room if one does not exist', () => {
    const room = getRoom('new-project');
    expect(room).toBeInstanceOf(Set);
    expect(room.size).toBe(0);
    expect(projectRooms.has('new-project')).toBe(true);
  });

  it('returns existing room', () => {
    const existing = new Set([{ ws: makeWs(), userId: 'u1' }]);
    projectRooms.set('existing', existing);
    expect(getRoom('existing')).toBe(existing);
  });
});

// ── Rate limiting constants ──────────────────────────────────────────────

describe('rate limiting constants', () => {
  it('WS_RATE_WINDOW is 1000ms', () => {
    expect(WS_RATE_WINDOW).toBe(1000);
  });

  it('WS_RATE_MAX is 30', () => {
    expect(WS_RATE_MAX).toBe(30);
  });
});
