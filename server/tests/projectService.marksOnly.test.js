// Unit (mocked-DB) cover for updateFileContent's Y.js marks-only save
// path + createHistorySnapshotIfDue. The integration suite also exercises
// these against a real Postgres, but it's excluded from Stryker; these
// mocked tests give the mutation runner something to kill on the new code.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = { get: vi.fn(), run: vi.fn(), all: vi.fn() };

vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    run: vi.fn(),
    all: vi.fn(),
    transaction: vi.fn(async (/** @type {(t:any)=>Promise<any>} */ fn) => fn(tx)),
  },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../services/yjsRoomSelector.js', () => ({ peekRoom: vi.fn(() => null) }));

import * as Y from 'yjs';
import db from '../db.js';
import { peekRoom } from '../services/yjsRoomSelector.js';
import { updateFileContent } from '../services/projectService.js';

const FILE = '00000000-0000-4000-8000-000000000001';
const PROJ = 'proj-1';

/** Wire db.get / tx.get to answer by SQL shape. */
function wireDb({ file, latestSnap = { id: 's0', created_at: new Date() }, interval = 30 } = {}) {
  db.get.mockImplementation(async (/** @type {string} */ sql) => {
    if (/SELECT \* FROM files/.test(sql)) return file;
    if (/SELECT id, name FROM users/.test(sql)) return { id: 'u1', name: 'Alice' };
    if (/SELECT updated_at FROM files/.test(sql)) return { updated_at: new Date('2030-01-01T00:00:00Z') };
    return null;
  });
  tx.get.mockImplementation(async (/** @type {string} */ sql) => {
    if (/snapshot_interval_sec/.test(sql)) return { snapshot_interval_sec: interval };
    if (/FROM project_snapshots/.test(sql)) return latestSnap;
    return null;
  });
  tx.all.mockResolvedValue([{ id: FILE, path: 'main.tex', content: 'x', is_binary: false }]);
  tx.run.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateFileContent — marks-only (content undefined)', () => {
  it('persists tc_marks WITHOUT touching content or content_yjs', async () => {
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'canonical', tc_marks: [] } });
    const marks = [{ id: 'm1', from: 0, to: 3, kind: 'insert' }];

    const out = await updateFileContent(FILE, undefined, 'u1', marks, '2020-01-01T00:00:00.000Z');

    expect(out.ok).toBe(true);
    expect(out.conflict).toBeUndefined();
    // The tc_marks UPDATE must NOT mention content or content_yjs.
    const marksUpdate = tx.run.mock.calls.find(([sql]) => /UPDATE files SET tc_marks/.test(sql));
    expect(marksUpdate).toBeDefined();
    expect(marksUpdate[0]).not.toMatch(/content/);
    expect(JSON.parse(marksUpdate[1][0])).toEqual(marks);
    // No content write of any kind.
    const contentWrite = tx.run.mock.calls.find(([sql]) => /content_yjs|SET content/.test(sql));
    expect(contentWrite).toBeUndefined();
  });

  it('ignores baseVersion entirely (never conflicts) on a marks-only save', async () => {
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] } });
    const out = await updateFileContent(FILE, undefined, 'u1', [{ id: 'a', from: 0, to: 1, kind: 'insert' }], 'STALE');
    expect(out.ok).toBe(true);
    expect(out.conflict).toBeUndefined();
  });

  it('makes NO write when the marks are unchanged', async () => {
    const marks = [{ id: 'm1', from: 0, to: 3, kind: 'insert' }];
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: marks } });

    const out = await updateFileContent(FILE, undefined, 'u1', marks, undefined);
    expect(out.ok).toBe(true);
    const marksUpdate = tx.run.mock.calls.find(([sql]) => /UPDATE files SET tc_marks/.test(sql));
    expect(marksUpdate).toBeUndefined();
  });

  it('treats content === null the same as undefined (marks-only)', async () => {
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] } });
    const out = await updateFileContent(FILE, null, 'u1', [{ id: 'a', from: 0, to: 1, kind: 'insert' }], undefined);
    expect(out.ok).toBe(true);
    // Took the marks-only branch: no content / content_yjs write.
    const contentWrite = tx.run.mock.calls.find(([sql]) => /content_yjs|SET content/.test(sql));
    expect(contentWrite).toBeUndefined();
    const marksUpdate = tx.run.mock.calls.find(([sql]) => /UPDATE files SET tc_marks/.test(sql));
    expect(marksUpdate).toBeDefined();
  });

  it('anchors marks against the live Y.Doc room when one is active', async () => {
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, 'hello world');
    peekRoom.mockReturnValueOnce({ ydoc });
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'hello world', tc_marks: [] } });

    const marks = [{ id: 'm1', from: 0, to: 5, kind: 'insert' }];
    const out = await updateFileContent(FILE, undefined, 'u1', marks, undefined);

    expect(out.ok).toBe(true);
    expect(peekRoom).toHaveBeenCalledWith(PROJ, FILE);
    const marksUpdate = tx.run.mock.calls.find(([sql]) => /UPDATE files SET tc_marks/.test(sql));
    expect(marksUpdate).toBeDefined();
    // captureTcMarkAnchors enriches each entry with relative-position
    // anchors, so the persisted JSON is NOT the bare input.
    const persisted = JSON.parse(marksUpdate[1][0]);
    expect(persisted[0]).not.toEqual(marks[0]);
  });

  it('returns the file row updated_at as the version', async () => {
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] } });
    const out = await updateFileContent(FILE, undefined, 'u1', [{ id: 'a', from: 0, to: 1, kind: 'insert' }], undefined);
    expect(out.version).toBe('2030-01-01T00:00:00.000Z');
    expect(out.projectId).toBe(PROJ);
  });

  it('derives authorName from the user, falling back to Unknown when no userId', async () => {
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] }, latestSnap: null });
    const withUser = await updateFileContent(FILE, undefined, 'u1', [{ id: 'a', from: 0, to: 1, kind: 'insert' }], undefined);
    expect(withUser.authorName).toBe('Alice');

    vi.clearAllMocks();
    wireDb({ file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] }, latestSnap: null });
    const noUser = await updateFileContent(FILE, undefined, undefined, [{ id: 'a', from: 0, to: 1, kind: 'insert' }], undefined);
    expect(noUser.authorName).toBe('Unknown');
  });

  it('throws when the file row is missing', async () => {
    wireDb({ file: null });
    await expect(updateFileContent(FILE, undefined, 'u1', [], undefined)).rejects.toThrow(/File not found/);
  });
});

describe('createHistorySnapshotIfDue (via marks-only path)', () => {
  it('creates a snapshot when the interval has elapsed', async () => {
    wireDb({
      file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] },
      latestSnap: null, // no prior snapshot => elapsed = Infinity => due
    });
    const out = await updateFileContent(FILE, undefined, 'u1', [{ id: 'a', from: 0, to: 1, kind: 'insert' }], undefined);
    expect(out.newSnapshot).toBe(true);
    const snapInsert = tx.run.mock.calls.find(([sql]) => /INSERT INTO project_snapshots/.test(sql));
    expect(snapInsert).toBeDefined();
  });

  it('records snapshot_blob_refs for each unique binary file', async () => {
    wireDb({
      file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] },
      latestSnap: null,
    });
    // Two file rows sharing one binary sha + a text row: exactly one ref.
    tx.all.mockResolvedValueOnce([
      { id: 'a', path: 'fig.png', is_binary: true, binary_sha256: 'sha-1' },
      { id: 'b', path: 'copy.png', is_binary: true, binary_sha256: 'sha-1' },
      { id: 'c', path: 'main.tex', is_binary: false, binary_sha256: null },
    ]);
    await updateFileContent(FILE, undefined, 'u1', [{ id: 'a', from: 0, to: 1, kind: 'insert' }], undefined);
    const refInserts = tx.run.mock.calls.filter(([sql]) => /INSERT INTO snapshot_blob_refs/.test(sql));
    expect(refInserts).toHaveLength(1);
    expect(refInserts[0][1]).toContain('sha-1');
  });

  it('does NOT create a snapshot when the interval has not elapsed', async () => {
    wireDb({
      file: { id: FILE, project_id: PROJ, content: 'c', tc_marks: [] },
      latestSnap: { id: 's0', created_at: new Date() }, // just now => not due
      interval: 30,
    });
    const out = await updateFileContent(FILE, undefined, 'u1', [{ id: 'a', from: 0, to: 1, kind: 'insert' }], undefined);
    expect(out.newSnapshot).toBe(false);
    const snapInsert = tx.run.mock.calls.find(([sql]) => /INSERT INTO project_snapshots/.test(sql));
    expect(snapInsert).toBeUndefined();
  });
});
