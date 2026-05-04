import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { all: vi.fn(), run: vi.fn() },
}));

let _uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => `uuid-${++_uuidCounter}`),
}));

import db from '../db.js';
import { recordMentions } from '../utils/mentions.js';

describe('recordMentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _uuidCounter = 0;
  });

  it('returns an empty array when the text contains no mentions', async () => {
    const result = await recordMentions({
      text: 'just some plain text with no at-signs',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual([]);
    expect(db.all).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });

  it('extracts a simple @Name mention and records it for a matching member', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'alice-id', name_lower: 'alice' },
    ]);
    const result = await recordMentions({
      text: 'hi @Alice take a look',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual(['alice-id']);
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toContain('INSERT INTO comment_mentions');
    expect(params).toEqual([
      'uuid-1',           // id
      'c1',               // comment_id
      null,               // reply_id
      'alice-id',         // mentioned_user_id
      'me',               // mentioner_user_id
      'p1',               // project_id
      'hi @Alice take a look',  // snippet
    ]);
  });

  it('extracts a quoted @"Full Name" mention', async () => {
    db.all.mockResolvedValueOnce([{ id: 'bob-id', name_lower: 'bob jones' }]);
    const result = await recordMentions({
      text: 'cc @"Bob Jones" please',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual(['bob-id']);
  });

  it('matches case-insensitively (mention case ignored)', async () => {
    db.all.mockResolvedValueOnce([{ id: 'a-id', name_lower: 'alice' }]);
    const result = await recordMentions({
      text: 'hello @ALICE',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual(['a-id']);
  });

  it('skips a mention that does not match any project member', async () => {
    db.all.mockResolvedValueOnce([{ id: 'alice-id', name_lower: 'alice' }]);
    const result = await recordMentions({
      text: '@nobody here',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual([]);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('skips self-mentions (mentioner mentioning themselves)', async () => {
    db.all.mockResolvedValueOnce([{ id: 'me', name_lower: 'me' }]);
    const result = await recordMentions({
      text: '@Me note to self',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual([]);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('records multiple distinct members in one comment', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'a-id', name_lower: 'alice' },
      { id: 'b-id', name_lower: 'bob' },
    ]);
    const result = await recordMentions({
      text: '@Alice @Bob look at this',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual(['a-id', 'b-id']);
    expect(db.run).toHaveBeenCalledTimes(2);
  });

  it('uses replyId column when commentId is absent', async () => {
    db.all.mockResolvedValueOnce([{ id: 'a-id', name_lower: 'alice' }]);
    await recordMentions({
      text: '@Alice',
      replyId: 'r1', mentionerUserId: 'me', projectId: 'p1',
    });
    const [, params] = db.run.mock.calls[0];
    expect(params[1]).toBeNull();      // comment_id
    expect(params[2]).toBe('r1');      // reply_id
  });

  it('passes commentId and a null replyId when both are typically not set together', async () => {
    db.all.mockResolvedValueOnce([{ id: 'a-id', name_lower: 'alice' }]);
    await recordMentions({
      text: '@Alice', commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    const [, params] = db.run.mock.calls[0];
    expect(params[1]).toBe('c1');
    expect(params[2]).toBeNull();
  });

  it('truncates snippet to 200 chars + ellipsis when text exceeds 200 chars', async () => {
    db.all.mockResolvedValueOnce([{ id: 'a-id', name_lower: 'alice' }]);
    const long = '@Alice ' + 'x'.repeat(500);
    await recordMentions({
      text: long, commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    const snippet = db.run.mock.calls[0][1][6];
    expect(snippet.length).toBe(201);   // 200 + '…'
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('keeps snippet verbatim at exactly 200 chars (no ellipsis)', async () => {
    db.all.mockResolvedValueOnce([{ id: 'a-id', name_lower: 'alice' }]);
    const exact = '@Alice ' + 'x'.repeat(200 - 7);  // exactly 200 chars total
    expect(exact.length).toBe(200);
    await recordMentions({
      text: exact, commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    const snippet = db.run.mock.calls[0][1][6];
    expect(snippet).toBe(exact);
    expect(snippet.endsWith('…')).toBe(false);
  });

  it('queries project_members joined with users for the given project_id', async () => {
    db.all.mockResolvedValueOnce([{ id: 'a-id', name_lower: 'alice' }]);
    await recordMentions({
      text: '@Alice', commentId: 'c1', mentionerUserId: 'me', projectId: 'proj-42',
    });
    const [sql, params] = db.all.mock.calls[0];
    expect(sql).toContain('FROM project_members pm');
    expect(sql).toContain('JOIN users u');
    expect(sql).toContain('pm.project_id = $1');
    expect(params).toEqual(['proj-42']);
  });

  it('a quoted mention can contain spaces; an unquoted mention stops at whitespace', async () => {
    db.all.mockResolvedValueOnce([
      { id: 'q-id', name_lower: 'two words' },
      { id: 'b-id', name_lower: 'bob' },
    ]);
    const result = await recordMentions({
      text: '@"Two Words" and @Bob',
      commentId: 'c1', mentionerUserId: 'me', projectId: 'p1',
    });
    expect(result).toEqual(['q-id', 'b-id']);
  });
});
