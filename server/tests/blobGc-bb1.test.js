import { describe, it, expect, vi, beforeEach } from 'vitest';

// BB1 (audit round 13): sweepOrphanRefcounts USED to unlink the on-disk
// blob unconditionally after the DB DELETE. The DELETE is gated on
// `ref_count <= 0`, so a concurrent uploadBinaryFile that bumps the
// refcount between the GC's SELECT and DELETE leaves the DELETE
// returning 0 rows -- but the unlink would still run, breaking the
// (now live) file row's reference. The fix: check rowCount; only
// unlink when the DB row actually came out.
//
// The race can't be reproduced black-box (the SELECT itself filters
// bumped rows), so this unit test mocks db.run to inject the "rescue
// happened" scenario directly between SELECT and DELETE.

vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
}));
vi.mock('../services/blobStore.js', () => ({
  deleteBlob: vi.fn(async () => {}),
}));
vi.mock('../logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import db from '../db.js';
import { deleteBlob } from '../services/blobStore.js';
import { sweepOrphanRefcounts } from '../services/blobGc.js';

const FIXTURE = {
  project_id: '11111111-1111-1111-1111-111111111111',
  sha256: 'a'.repeat(64),
};

beforeEach(() => { vi.clearAllMocks(); });

describe('sweepOrphanRefcounts — BB1 concurrent refcount rescue', () => {
  it('skips deleteBlob when DELETE affected 0 rows (concurrent write rescued the refcount)', async () => {
    db.all.mockResolvedValueOnce([FIXTURE]); // SELECT candidates
    // Simulate the race: the DELETE's `WHERE ref_count <= 0` filters
    // the row out because a concurrent uploadBinaryFile just bumped
    // ref_count to 1.
    db.run.mockResolvedValueOnce({ rowCount: 0 });

    const out = await sweepOrphanRefcounts();

    expect(db.run).toHaveBeenCalledTimes(1); // only the DELETE attempt
    // Crucial assertion: deleteBlob was NOT called, so the on-disk
    // blob stays alive for the file row that just gained a reference.
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(out.collected).toBe(0);
  });

  it('unlinks the on-disk blob when DELETE affected 1 row (no rescue)', async () => {
    db.all.mockResolvedValueOnce([FIXTURE]);
    db.run.mockResolvedValueOnce({ rowCount: 1 });

    const out = await sweepOrphanRefcounts();

    // Positive control: when the row really came out, the unlink runs.
    expect(deleteBlob).toHaveBeenCalledWith(FIXTURE.project_id, FIXTURE.sha256);
    expect(out.collected).toBe(1);
  });

  it('skips a candidate whose sha fails the format check', async () => {
    db.all.mockResolvedValueOnce([{ project_id: FIXTURE.project_id, sha256: 'not-a-sha' }]);

    const out = await sweepOrphanRefcounts();
    expect(db.run).not.toHaveBeenCalled();
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(out.collected).toBe(0);
  });
});
