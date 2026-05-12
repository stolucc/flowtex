// Integration-test harness — runs against the real Postgres database.
//
// Each test runs inside a transaction on a single shared client. At the end
// of the test the transaction is rolled back, so nothing the test does
// persists. Code under test that calls `db.transaction(...)` uses SAVEPOINTs
// (see db.js) so its commit/rollback semantics still work without ending
// the outer test transaction.
//
// Safe defaults:
//   - All writes route through the shared client → rolled back automatically.
//   - The TOTP cleanup interval and other background jobs in the imported
//     code still run, but they go through db.run → shared client → rolled
//     back. Nothing escapes the test transaction.
//   - Unique per-test identifiers (UUIDs, randomized emails) prevent
//     accidental collisions with existing rows.

import { beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { v4 as uuid } from 'uuid';
import db, { _setSharedClient } from '../../db.js';

let client;

beforeAll(async () => {
  // Make sure the schema is up to date in the test target DB. Safe to call
  // against a populated database — every statement is CREATE … IF NOT
  // EXISTS / ALTER … IF NOT EXISTS.
  await db.initSchema();
});

beforeEach(async () => {
  client = await db.pool.connect();
  await client.query('BEGIN');
  _setSharedClient(client);
});

afterEach(async () => {
  try {
    await client.query('ROLLBACK');
  } finally {
    _setSharedClient(null);
    client.release();
    client = null;
  }
});

afterAll(async () => {
  await db.pool.end();
});

// ─── Helpers shared across integration tests ────────────────────────────

/** Create a user row directly via SQL and return { id, email, name }. */
export async function seedUser(over = {}) {
  const id = over.id || uuid();
  const email = over.email || `it-${id.slice(0, 8)}@example.test`;
  const name = over.name || 'Integration Test User';
  const passwordHash = over.password_hash || '$2a$04$0000000000000000000000.0000000000000000000000000000';
  await db.run(
    `INSERT INTO users (id, email, name, password_hash, email_verified${over.is_admin ? ', is_admin' : ''})
     VALUES ($1, $2, $3, $4, TRUE${over.is_admin ? ', TRUE' : ''})`,
    [id, email, name, passwordHash],
  );
  return { id, email, name, is_admin: !!over.is_admin };
}

/** Create a project owned by `ownerId` and return its row. */
export async function seedProject(ownerId, over = {}) {
  const id = over.id || uuid();
  const name = over.name || 'IT Project';
  await db.run(
    `INSERT INTO projects (id, name, main_file) VALUES ($1, $2, $3)`,
    [id, name, over.main_file || 'main.tex'],
  );
  await db.run(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)`,
    [id, ownerId, over.role || 'owner'],
  );
  return { id, name, main_file: over.main_file || 'main.tex' };
}

/** Insert a file into a project. */
export async function seedFile(projectId, path, content = '') {
  const id = uuid();
  await db.run(
    `INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)`,
    [id, projectId, path, content],
  );
  return { id, project_id: projectId, path, content };
}
