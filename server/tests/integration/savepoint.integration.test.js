// Integration: db.transaction must use SAVEPOINTs when a shared client is
// installed (test mode), so the outer per-test BEGIN/ROLLBACK still works
// across code that calls db.transaction internally.

import { describe, it, expect } from 'vitest';
import { seedUser } from './setup.js';
import db from '../../db.js';

describe('db.transaction inside a test-shared transaction', () => {
  it('commits the inner work AND rolls back when the outer rolls back', async () => {
    const u = await seedUser();
    // Inside db.transaction → SAVEPOINT path
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE users SET name = $1 WHERE id = $2`, ['Inside-Tx', u.id]);
    });
    // The inner RELEASE doesn't commit globally — it's inside the outer
    // BEGIN that the test will roll back. But within this test we should
    // still SEE the change.
    const row = await db.get('SELECT name FROM users WHERE id = $1', [u.id]);
    expect(row.name).toBe('Inside-Tx');
    // The afterEach hook will ROLLBACK the outer transaction; we can't
    // assert from here that the next test won't see it, but other tests
    // pass with their own seeded users → proof enough.
  });

  it('rolling back inside db.transaction does not poison the outer transaction', async () => {
    const u = await seedUser();
    await expect(
      db.transaction(async (tx) => {
        await tx.run(`UPDATE users SET name = $1 WHERE id = $2`, ['About-to-throw', u.id]);
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);

    // The outer transaction is still alive — we can still read.
    const row = await db.get('SELECT name FROM users WHERE id = $1', [u.id]);
    // The inner UPDATE was rolled back at the SAVEPOINT
    expect(row.name).not.toBe('About-to-throw');

    // And we can still WRITE (transaction wasn't aborted).
    await db.run(`UPDATE users SET name = $1 WHERE id = $2`, ['After-rollback', u.id]);
    const row2 = await db.get('SELECT name FROM users WHERE id = $1', [u.id]);
    expect(row2.name).toBe('After-rollback');
  });

  it('two consecutive db.transaction calls each get their own SAVEPOINT', async () => {
    const u = await seedUser();
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE users SET name = $1 WHERE id = $2`, ['First', u.id]);
    });
    await db.transaction(async (tx) => {
      await tx.run(`UPDATE users SET name = $1 WHERE id = $2`, ['Second', u.id]);
    });
    const row = await db.get('SELECT name FROM users WHERE id = $1', [u.id]);
    expect(row.name).toBe('Second');
  });
});

describe('no leakage between tests (rollback works)', () => {
  it('records a magic-marker user — would conflict with next test if leaked', async () => {
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, email_verified)
       VALUES ('leak-marker', 'leak-marker@example.test', 'Marker', 'x', TRUE)`,
    );
    const row = await db.get(`SELECT id FROM users WHERE id = 'leak-marker'`);
    expect(row).toBeTruthy();
  });

  it('does NOT see the marker from the previous test', async () => {
    const row = await db.get(`SELECT id FROM users WHERE id = 'leak-marker'`);
    expect(row).toBeUndefined();
  });
});
