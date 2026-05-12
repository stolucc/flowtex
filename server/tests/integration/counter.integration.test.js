// Integration: the db-write counter actually moves on real writes.
// Each test wraps in a transaction; the counter is in-memory and module-
// scoped so the *delta* tells us what one test caused.

import { describe, it, expect } from 'vitest';
import { seedUser, seedProject } from './setup.js';
import db, { getWriteStats, _resetWriteStatsForTesting } from '../../db.js';

function snapshot() {
  return getWriteStats();
}

describe('db write counter', () => {
  it('increments on INSERT through db.run', async () => {
    const before = snapshot();
    await seedUser(); // 1 INSERT into users
    const after = snapshot();
    expect(after.total).toBeGreaterThan(before.total);
    expect((after.byOp.INSERT || 0) - (before.byOp.INSERT || 0)).toBeGreaterThanOrEqual(1);
    expect((after.byTable.users || 0) - (before.byTable.users || 0)).toBeGreaterThanOrEqual(1);
  });

  it('increments on UPDATE', async () => {
    const u = await seedUser();
    const before = snapshot();
    await db.run('UPDATE users SET name = $1 WHERE id = $2', ['Renamed', u.id]);
    const after = snapshot();
    expect((after.byOp.UPDATE || 0) - (before.byOp.UPDATE || 0)).toBe(1);
    expect((after.byTable.users || 0) - (before.byTable.users || 0)).toBe(1);
  });

  it('increments on DELETE', async () => {
    const u = await seedUser();
    const before = snapshot();
    await db.run('DELETE FROM users WHERE id = $1', [u.id]);
    const after = snapshot();
    expect((after.byOp.DELETE || 0) - (before.byOp.DELETE || 0)).toBe(1);
  });

  it('does NOT increment on SELECT', async () => {
    const u = await seedUser();
    const before = snapshot();
    await db.get('SELECT email FROM users WHERE id = $1', [u.id]);
    await db.all('SELECT id, email FROM users LIMIT 5');
    const after = snapshot();
    expect(after.total).toBe(before.total);
  });

  it('counts writes inside db.transaction (SAVEPOINT path)', async () => {
    const u = await seedUser();
    const before = snapshot();
    await db.transaction(async (tx) => {
      await tx.run('UPDATE users SET name = $1 WHERE id = $2', ['Inside-Tx', u.id]);
      await tx.run('UPDATE users SET name = $1 WHERE id = $2', ['Inside-Tx-2', u.id]);
    });
    const after = snapshot();
    expect((after.byOp.UPDATE || 0) - (before.byOp.UPDATE || 0)).toBe(2);
    expect((after.byTable.users || 0) - (before.byTable.users || 0)).toBe(2);
  });

  it('extracts table name from `INSERT INTO "users"` (quoted identifier)', async () => {
    const before = snapshot();
    const u = await seedUser();
    await db.run(`UPDATE "users" SET name = $1 WHERE id = $2`, ['Q', u.id]);
    const after = snapshot();
    expect((after.byTable.users || 0)).toBeGreaterThan(before.byTable.users || 0);
  });

  it('extracts table name from `DELETE FROM ONLY users` (Postgres ONLY)', async () => {
    const u = await seedUser();
    const before = snapshot();
    await db.run('DELETE FROM ONLY users WHERE id = $1', [u.id]);
    const after = snapshot();
    expect((after.byTable.users || 0) - (before.byTable.users || 0)).toBe(1);
  });

  it('handles DDL: CREATE / DROP / ALTER table writes', async () => {
    const before = snapshot();
    // Use a uniquely-named scratch table so we can't collide with anything real
    const tableName = `it_scratch_${Date.now()}`;
    await db.run(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`);
    await db.run(`ALTER TABLE ${tableName} ADD COLUMN extra TEXT`);
    await db.run(`DROP TABLE ${tableName}`);
    const after = snapshot();
    expect((after.byOp.CREATE || 0) - (before.byOp.CREATE || 0)).toBe(1);
    expect((after.byOp.ALTER || 0) - (before.byOp.ALTER || 0)).toBe(1);
    expect((after.byOp.DROP || 0) - (before.byOp.DROP || 0)).toBe(1);
    expect((after.byTable[tableName] || 0)).toBe(3);
  });

  it('_resetWriteStatsForTesting clears all counters (test-mode only)', async () => {
    await seedUser(); // bump some counters
    _resetWriteStatsForTesting();
    const fresh = snapshot();
    expect(fresh.total).toBe(0);
    expect(Object.keys(fresh.byOp)).toEqual([]);
    expect(Object.keys(fresh.byTable)).toEqual([]);
  });

  it('returns INSERT bucket for seedProject (multiple writes per call)', async () => {
    _resetWriteStatsForTesting();
    const u = await seedUser();
    const before = snapshot();
    await seedProject(u.id);
    // seedProject inserts into projects + project_members → 2 INSERTs
    const after = snapshot();
    expect((after.byOp.INSERT || 0) - (before.byOp.INSERT || 0)).toBe(2);
    expect((after.byTable.projects || 0) - (before.byTable.projects || 0)).toBe(1);
    expect((after.byTable.project_members || 0) - (before.byTable.project_members || 0)).toBe(1);
  });
});
