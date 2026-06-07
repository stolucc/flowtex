import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { get: vi.fn(), run: vi.fn(), all: vi.fn() },
}));

import db from '../db.js';
import * as Y from 'yjs';
import { main } from '../migrate-yjs-init.js';

let originalArgv;

beforeEach(() => {
  vi.clearAllMocks();
  originalArgv = process.argv;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('migrate-yjs-init', () => {
  it('migrates a non-empty file with NULL content_yjs', async () => {
    process.argv = ['node', '/path/to/migrate-yjs-init.js'];
    db.all
      .mockResolvedValueOnce([{ id: 'f1', project_id: 'p1', content: 'hello world' }])
      .mockResolvedValueOnce([]);
    db.run.mockResolvedValue(undefined);

    const result = await main();

    expect(result.totalMigrated).toBe(1);
    expect(result.totalSkippedEmpty).toBe(0);
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toMatch(/UPDATE files SET content_yjs/);
    expect(sql).toMatch(/content_yjs IS NULL/);
    expect(params[1]).toBe('f1');
    expect(params[2]).toBe('p1');
    expect(Buffer.isBuffer(params[0])).toBe(true);

    const fresh = new Y.Doc();
    Y.applyUpdateV2(fresh, new Uint8Array(params[0]));
    expect(fresh.getText('content').toString()).toBe('hello world');
  });

  it('skips files with empty content (lazy-path fallback handles them)', async () => {
    process.argv = ['node', '/path/to/migrate-yjs-init.js'];
    db.all
      .mockResolvedValueOnce([{ id: 'f1', project_id: 'p1', content: '' }])
      .mockResolvedValueOnce([]);

    const result = await main();

    expect(result.totalSkippedEmpty).toBe(1);
    expect(result.totalMigrated).toBe(0);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('paginates by id and stops when a page returns empty', async () => {
    process.argv = ['node', '/path/to/migrate-yjs-init.js'];
    db.all
      .mockResolvedValueOnce([
        { id: 'f1', project_id: 'p1', content: 'one' },
        { id: 'f2', project_id: 'p1', content: 'two' },
      ])
      .mockResolvedValueOnce([{ id: 'f3', project_id: 'p1', content: 'three' }])
      .mockResolvedValueOnce([]);
    db.run.mockResolvedValue(undefined);

    const result = await main();

    expect(result.totalMigrated).toBe(3);
    expect(db.all).toHaveBeenCalledTimes(3);
    // The "lastId" paginator passes the previous max id each time.
    expect(db.all.mock.calls[1][1][0]).toBe('f2');
    expect(db.all.mock.calls[2][1][0]).toBe('f3');
  });

  it('scopes to a single project when project id is passed as argv[2]', async () => {
    process.argv = ['node', '/path/to/migrate-yjs-init.js', 'specific-project'];
    db.all.mockResolvedValueOnce([]);

    await main();

    expect(db.all).toHaveBeenCalledTimes(1);
    const [sql, params] = db.all.mock.calls[0];
    expect(sql).toMatch(/project_id = \$1/);
    expect(params[0]).toBe('specific-project');
  });

  it('skips rows that the lazy path beat us to (atomic AND content_yjs IS NULL)', async () => {
    // Simulate a race: between the SELECT and the UPDATE, another
    // path (HTTP save / lazy room acquire) populated content_yjs.
    // The UPDATE filter `AND content_yjs IS NULL` makes the write a
    // no-op rather than overwriting the newer state.
    process.argv = ['node', '/path/to/migrate-yjs-init.js'];
    db.all
      .mockResolvedValueOnce([{ id: 'f1', project_id: 'p1', content: 'hi' }])
      .mockResolvedValueOnce([]);
    db.run.mockResolvedValue(undefined);

    await main();

    const [sql] = db.run.mock.calls[0];
    expect(sql).toMatch(/content_yjs IS NULL/);
  });
});
