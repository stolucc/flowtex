/**
 * Integration tests for tracked changes — hits the real PostgreSQL database.
 *
 * Each test runs inside a transaction that is rolled back, so no data persists.
 * Requires a running PostgreSQL instance with the flowtex database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { v4 as uuid } from 'uuid';

// ── Database connection ───────────────────────────────────────────────────
let pool;
let client; // single client for transactional isolation

beforeAll(async () => {
  pool = new pg.Pool({
    database: process.env.PGDATABASE || 'flowtex',
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
  });
  // Verify connection
  await pool.query('SELECT 1');
});

afterAll(async () => {
  await pool.end();
});

// ── Per-test transaction ──────────────────────────────────────────────────
// Each test gets its own transaction that rolls back so tests don't interfere.
let db;

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');

  // Thin db wrapper matching our server/db.js API
  db = {
    async get(sql, params = []) {
      const { rows } = await client.query(sql, params);
      return rows[0] || undefined;
    },
    async all(sql, params = []) {
      const { rows } = await client.query(sql, params);
      return rows;
    },
    async run(sql, params = []) {
      return client.query(sql, params);
    },
  };
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

// ── Seed helpers ──────────────────────────────────────────────────────────
async function createUser(name = 'Alice', email) {
  const id = uuid();
  await db.run('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [
    id,
    email || `${id}@test.com`,
    name,
    'hash',
  ]);
  return { id, name };
}

async function createProject(ownerId) {
  const id = uuid();
  await db.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [id, 'Test Project']);
  await db.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [id, ownerId, 'owner']);
  return id;
}

async function addMember(projectId, userId, role = 'editor') {
  await db.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
    projectId,
    userId,
    role,
  ]);
}

async function createFile(projectId, path = 'main.tex', content = '') {
  const id = uuid();
  await db.run('INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)', [
    id,
    projectId,
    path,
    content,
  ]);
  return id;
}

async function createChange(fileId, projectId, authorId, authorName, opts = {}) {
  const id = uuid();
  const { from_pos = 0, to_pos = 0, inserted_text = '', deleted_text = '', status = 'pending' } = opts;
  await db.run(
    `INSERT INTO tracked_changes (id, file_id, project_id, from_pos, to_pos, inserted_text, deleted_text, author_id, author_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, fileId, projectId, from_pos, to_pos, inserted_text, deleted_text, authorId, authorName, status],
  );
  return id;
}

async function getChange(id) {
  return db.get('SELECT * FROM tracked_changes WHERE id = $1', [id]);
}

async function getPendingChanges(fileId) {
  return db.all("SELECT * FROM tracked_changes WHERE file_id = $1 AND status = 'pending' ORDER BY from_pos", [fileId]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Basic CRUD
// ═══════════════════════════════════════════════════════════════════════════
describe('Tracked changes CRUD', () => {
  it('creates an insertion change and retrieves it', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId, 'main.tex', 'Hello world');

    const changeId = await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 5,
      to_pos: 5,
      inserted_text: ' beautiful',
    });

    const change = await getChange(changeId);
    expect(change).toBeDefined();
    expect(change.file_id).toBe(fileId);
    expect(change.project_id).toBe(projectId);
    expect(change.from_pos).toBe(5);
    expect(change.to_pos).toBe(5);
    expect(change.inserted_text).toBe(' beautiful');
    expect(change.deleted_text).toBe('');
    expect(change.author_id).toBe(user.id);
    expect(change.author_name).toBe('Alice');
    expect(change.status).toBe('pending');
  });

  it('creates a deletion change', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId, 'main.tex', 'Hello cruel world');

    const changeId = await createChange(fileId, projectId, user.id, 'Bob', {
      from_pos: 5,
      to_pos: 11,
      deleted_text: ' cruel',
    });

    const change = await getChange(changeId);
    expect(change.deleted_text).toBe(' cruel');
    expect(change.from_pos).toBe(5);
    expect(change.to_pos).toBe(11);
  });

  it('creates a replacement change (delete + insert)', async () => {
    const user = await createUser('Carol');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Carol', {
      from_pos: 0,
      to_pos: 5,
      deleted_text: 'Hello',
      inserted_text: 'Goodbye',
    });

    const change = await getChange(changeId);
    expect(change.deleted_text).toBe('Hello');
    expect(change.inserted_text).toBe('Goodbye');
  });

  it('retrieves all changes for a file ordered by position', async () => {
    const user = await createUser('Dan');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    await createChange(fileId, projectId, user.id, 'Dan', { from_pos: 50, to_pos: 55, inserted_text: 'c' });
    await createChange(fileId, projectId, user.id, 'Dan', { from_pos: 10, to_pos: 15, inserted_text: 'a' });
    await createChange(fileId, projectId, user.id, 'Dan', { from_pos: 30, to_pos: 35, inserted_text: 'b' });

    const changes = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1 ORDER BY from_pos', [fileId]);
    expect(changes).toHaveLength(3);
    expect(changes[0].from_pos).toBe(10);
    expect(changes[1].from_pos).toBe(30);
    expect(changes[2].from_pos).toBe(50);
  });

  it('deletes a change', async () => {
    const user = await createUser('Eve');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Eve', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'test',
    });

    await db.run('DELETE FROM tracked_changes WHERE id = $1', [changeId]);
    const deleted = await getChange(changeId);
    expect(deleted).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Accept / Reject lifecycle
// ═══════════════════════════════════════════════════════════════════════════
describe('Accept and reject', () => {
  it('accepts a pending change', async () => {
    const author = await createUser('Author');
    const reviewer = await createUser('Reviewer');
    const projectId = await createProject(author.id);
    await addMember(projectId, reviewer.id, 'editor');
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, author.id, 'Author', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'Hello',
    });

    await db.run("UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE id = $2", [
      reviewer.id,
      changeId,
    ]);

    const change = await getChange(changeId);
    expect(change.status).toBe('accepted');
    expect(change.resolved_by).toBe(reviewer.id);
  });

  it('rejects a pending change', async () => {
    const author = await createUser('Author');
    const reviewer = await createUser('Reviewer');
    const projectId = await createProject(author.id);
    await addMember(projectId, reviewer.id, 'editor');
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, author.id, 'Author', {
      from_pos: 0,
      to_pos: 3,
      deleted_text: 'foo',
    });

    await db.run("UPDATE tracked_changes SET status = 'rejected', resolved_by = $1 WHERE id = $2", [
      reviewer.id,
      changeId,
    ]);

    const change = await getChange(changeId);
    expect(change.status).toBe('rejected');
    expect(change.resolved_by).toBe(reviewer.id);
  });

  it('accepted changes are excluded from pending query', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const id1 = await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'a',
    });
    await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 10,
      to_pos: 15,
      inserted_text: 'b',
    });

    // Accept first change
    await db.run("UPDATE tracked_changes SET status = 'accepted' WHERE id = $1", [id1]);

    const pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(1);
    expect(pending[0].inserted_text).toBe('b');
  });

  it('rejected changes are excluded from pending query', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const id1 = await createChange(fileId, projectId, user.id, 'Bob', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'x',
    });

    await db.run("UPDATE tracked_changes SET status = 'rejected' WHERE id = $1", [id1]);

    const pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Bulk accept / reject all
// ═══════════════════════════════════════════════════════════════════════════
describe('Bulk accept/reject all', () => {
  it('accepts all pending changes for a file', async () => {
    const user = await createUser('Alice');
    const reviewer = await createUser('Reviewer');
    const projectId = await createProject(user.id);
    await addMember(projectId, reviewer.id, 'editor');
    const fileId = await createFile(projectId);

    await createChange(fileId, projectId, user.id, 'Alice', { from_pos: 0, to_pos: 5, inserted_text: 'a' });
    await createChange(fileId, projectId, user.id, 'Alice', { from_pos: 10, to_pos: 15, inserted_text: 'b' });
    await createChange(fileId, projectId, user.id, 'Alice', { from_pos: 20, to_pos: 25, inserted_text: 'c' });

    await db.run(
      "UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
      [reviewer.id, fileId],
    );

    const pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(0);

    const all = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1', [fileId]);
    expect(all.every((c) => c.status === 'accepted')).toBe(true);
    expect(all.every((c) => c.resolved_by === reviewer.id)).toBe(true);
  });

  it('rejects all pending changes for a file', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    await createChange(fileId, projectId, user.id, 'Bob', { from_pos: 0, to_pos: 5, inserted_text: 'a' });
    await createChange(fileId, projectId, user.id, 'Bob', { from_pos: 10, to_pos: 15, inserted_text: 'b' });

    await db.run(
      "UPDATE tracked_changes SET status = 'rejected', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
      [user.id, fileId],
    );

    const all = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1', [fileId]);
    expect(all.every((c) => c.status === 'rejected')).toBe(true);
  });

  it('bulk accept does not affect already-resolved changes', async () => {
    const user = await createUser('Carol');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const id1 = await createChange(fileId, projectId, user.id, 'Carol', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'a',
    });
    await createChange(fileId, projectId, user.id, 'Carol', {
      from_pos: 10,
      to_pos: 15,
      inserted_text: 'b',
    });

    // Reject the first one individually
    await db.run("UPDATE tracked_changes SET status = 'rejected', resolved_by = $1 WHERE id = $2", [user.id, id1]);

    // Now bulk accept
    await db.run(
      "UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
      [user.id, fileId],
    );

    const c1 = await getChange(id1);
    expect(c1.status).toBe('rejected'); // Unchanged — was already resolved

    const all = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1', [fileId]);
    const statuses = all.map((c) => c.status).sort();
    expect(statuses).toEqual(['accepted', 'rejected']);
  });

  it('bulk accept on file with no pending changes is a no-op', async () => {
    const user = await createUser('Dan');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    // No changes at all
    await db.run(
      "UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
      [user.id, fileId],
    );

    const all = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1', [fileId]);
    expect(all).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Position adjustment after edits
// ═══════════════════════════════════════════════════════════════════════════
describe('Position adjustment', () => {
  it('shifts positions forward when text is inserted before changes', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId, 'main.tex', 'Hello world');

    const id1 = await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 20,
      to_pos: 25,
      inserted_text: 'aaa',
    });
    const id2 = await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 40,
      to_pos: 45,
      inserted_text: 'bbb',
    });

    // Insert 10 chars at position 5 → shift everything after pos 5 by +10
    const delta = 10;
    const afterPos = 5;
    await db.run(
      `UPDATE tracked_changes SET from_pos = from_pos + $1, to_pos = to_pos + $1
       WHERE file_id = $2 AND status = 'pending' AND from_pos >= $3`,
      [delta, fileId, afterPos],
    );

    const c1 = await getChange(id1);
    expect(c1.from_pos).toBe(30);
    expect(c1.to_pos).toBe(35);

    const c2 = await getChange(id2);
    expect(c2.from_pos).toBe(50);
    expect(c2.to_pos).toBe(55);
  });

  it('shifts positions backward when text is deleted before changes', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const id1 = await createChange(fileId, projectId, user.id, 'Bob', {
      from_pos: 30,
      to_pos: 35,
      inserted_text: 'x',
    });

    // Delete 8 chars before position 10 → shift by -8
    await db.run(
      `UPDATE tracked_changes SET from_pos = from_pos + $1, to_pos = to_pos + $1
       WHERE file_id = $2 AND status = 'pending' AND from_pos >= $3`,
      [-8, fileId, 10],
    );

    const c1 = await getChange(id1);
    expect(c1.from_pos).toBe(22);
    expect(c1.to_pos).toBe(27);
  });

  it('does not shift changes before the edit position', async () => {
    const user = await createUser('Carol');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const idBefore = await createChange(fileId, projectId, user.id, 'Carol', {
      from_pos: 5,
      to_pos: 10,
      inserted_text: 'early',
    });
    const idAfter = await createChange(fileId, projectId, user.id, 'Carol', {
      from_pos: 50,
      to_pos: 55,
      inserted_text: 'late',
    });

    // Shift after position 30
    await db.run(
      `UPDATE tracked_changes SET from_pos = from_pos + $1, to_pos = to_pos + $1
       WHERE file_id = $2 AND status = 'pending' AND from_pos >= $3`,
      [10, fileId, 30],
    );

    const before = await getChange(idBefore);
    expect(before.from_pos).toBe(5); // unchanged
    expect(before.to_pos).toBe(10);

    const after = await getChange(idAfter);
    expect(after.from_pos).toBe(60); // shifted
    expect(after.to_pos).toBe(65);
  });

  it('does not shift resolved changes', async () => {
    const user = await createUser('Dan');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const idResolved = await createChange(fileId, projectId, user.id, 'Dan', {
      from_pos: 20,
      to_pos: 25,
      inserted_text: 'done',
      status: 'accepted',
    });
    const idPending = await createChange(fileId, projectId, user.id, 'Dan', {
      from_pos: 30,
      to_pos: 35,
      inserted_text: 'todo',
    });

    await db.run(
      `UPDATE tracked_changes SET from_pos = from_pos + $1, to_pos = to_pos + $1
       WHERE file_id = $2 AND status = 'pending' AND from_pos >= $3`,
      [5, fileId, 0],
    );

    const resolved = await getChange(idResolved);
    expect(resolved.from_pos).toBe(20); // not shifted

    const pending = await getChange(idPending);
    expect(pending.from_pos).toBe(35); // shifted
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Multi-user scenarios
// ═══════════════════════════════════════════════════════════════════════════
describe('Multi-user collaboration', () => {
  it('different users can create changes in the same file', async () => {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    const projectId = await createProject(alice.id);
    await addMember(projectId, bob.id, 'editor');
    const fileId = await createFile(projectId);

    await createChange(fileId, projectId, alice.id, 'Alice', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'aaa',
    });
    await createChange(fileId, projectId, bob.id, 'Bob', {
      from_pos: 10,
      to_pos: 15,
      inserted_text: 'bbb',
    });

    const changes = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1 ORDER BY from_pos', [fileId]);
    expect(changes).toHaveLength(2);
    expect(changes[0].author_name).toBe('Alice');
    expect(changes[1].author_name).toBe('Bob');
  });

  it("one user can accept another user's change", async () => {
    const alice = await createUser('Alice');
    const bob = await createUser('Bob');
    const projectId = await createProject(alice.id);
    await addMember(projectId, bob.id, 'editor');
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, alice.id, 'Alice', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'hello',
    });

    // Bob accepts Alice's change
    await db.run("UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE id = $2", [bob.id, changeId]);

    const change = await getChange(changeId);
    expect(change.status).toBe('accepted');
    expect(change.author_id).toBe(alice.id);
    expect(change.resolved_by).toBe(bob.id);
  });

  it('changes from different files in same project are independent', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileA = await createFile(projectId, 'a.tex');
    const fileB = await createFile(projectId, 'b.tex');

    await createChange(fileA, projectId, user.id, 'Alice', { from_pos: 0, to_pos: 5, inserted_text: 'x' });
    await createChange(fileA, projectId, user.id, 'Alice', { from_pos: 10, to_pos: 15, inserted_text: 'y' });
    await createChange(fileB, projectId, user.id, 'Alice', { from_pos: 0, to_pos: 3, inserted_text: 'z' });

    const changesA = await getPendingChanges(fileA);
    const changesB = await getPendingChanges(fileB);
    expect(changesA).toHaveLength(2);
    expect(changesB).toHaveLength(1);
  });

  it('bulk accept only affects the targeted file', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileA = await createFile(projectId, 'a.tex');
    const fileB = await createFile(projectId, 'b.tex');

    await createChange(fileA, projectId, user.id, 'Bob', { from_pos: 0, to_pos: 5, inserted_text: 'x' });
    await createChange(fileB, projectId, user.id, 'Bob', { from_pos: 0, to_pos: 5, inserted_text: 'y' });

    // Accept all in file A only
    await db.run(
      "UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
      [user.id, fileA],
    );

    const pendingA = await getPendingChanges(fileA);
    const pendingB = await getPendingChanges(fileB);
    expect(pendingA).toHaveLength(0);
    expect(pendingB).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Change update / merge (PATCH behavior)
// ═══════════════════════════════════════════════════════════════════════════
describe('Change update (merge edits)', () => {
  it('updates position and text of a pending change', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 10,
      to_pos: 15,
      inserted_text: 'hello',
    });

    await db.run('UPDATE tracked_changes SET from_pos = $1, to_pos = $2, inserted_text = $3 WHERE id = $4', [
      10,
      20,
      'helloworld',
      changeId,
    ]);

    const updated = await getChange(changeId);
    expect(updated.from_pos).toBe(10);
    expect(updated.to_pos).toBe(20);
    expect(updated.inserted_text).toBe('helloworld');
  });

  it('can extend an insertion by appending characters', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Bob', {
      from_pos: 5,
      to_pos: 8,
      inserted_text: 'abc',
    });

    // User types 'def' after 'abc'
    await db.run('UPDATE tracked_changes SET to_pos = $1, inserted_text = $2 WHERE id = $3', [11, 'abcdef', changeId]);

    const updated = await getChange(changeId);
    expect(updated.inserted_text).toBe('abcdef');
    expect(updated.to_pos).toBe(11);
    expect(updated.from_pos).toBe(5); // unchanged
  });

  it('can shrink an insertion by removing characters', async () => {
    const user = await createUser('Carol');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Carol', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'hello',
    });

    // Backspace: remove 'o'
    await db.run('UPDATE tracked_changes SET to_pos = $1, inserted_text = $2 WHERE id = $3', [4, 'hell', changeId]);

    const updated = await getChange(changeId);
    expect(updated.inserted_text).toBe('hell');
    expect(updated.to_pos).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Cascade delete (file → changes)
// ═══════════════════════════════════════════════════════════════════════════
describe('Cascade behavior', () => {
  it('deleting a file cascades to its tracked changes', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId, 'temp.tex');

    await createChange(fileId, projectId, user.id, 'Alice', { from_pos: 0, to_pos: 5, inserted_text: 'x' });
    await createChange(fileId, projectId, user.id, 'Alice', { from_pos: 10, to_pos: 15, inserted_text: 'y' });

    const before = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1', [fileId]);
    expect(before).toHaveLength(2);

    await db.run('DELETE FROM files WHERE id = $1', [fileId]);

    const after = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1', [fileId]);
    expect(after).toHaveLength(0);
  });

  it('deleting a project cascades to files and their tracked changes', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId, 'main.tex');

    await createChange(fileId, projectId, user.id, 'Bob', { from_pos: 0, to_pos: 5, inserted_text: 'x' });

    await db.run('DELETE FROM projects WHERE id = $1', [projectId]);

    const changes = await db.all('SELECT * FROM tracked_changes WHERE project_id = $1', [projectId]);
    expect(changes).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Edge cases and data integrity
// ═══════════════════════════════════════════════════════════════════════════
describe('Edge cases', () => {
  it('handles zero-length range (pure insertion at cursor)', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 0,
      to_pos: 0,
      inserted_text: 'new text',
    });

    const change = await getChange(changeId);
    expect(change.from_pos).toBe(0);
    expect(change.to_pos).toBe(0);
    expect(change.inserted_text).toBe('new text');
  });

  it('handles empty inserted_text and deleted_text', async () => {
    const user = await createUser('Bob');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Bob', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: '',
      deleted_text: '',
    });

    const change = await getChange(changeId);
    expect(change.inserted_text).toBe('');
    expect(change.deleted_text).toBe('');
  });

  it('handles large inserted text', async () => {
    const user = await createUser('Carol');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const bigText = 'x'.repeat(100000);
    const changeId = await createChange(fileId, projectId, user.id, 'Carol', {
      from_pos: 0,
      to_pos: 0,
      inserted_text: bigText,
    });

    const change = await getChange(changeId);
    expect(change.inserted_text.length).toBe(100000);
  });

  it('handles unicode text in changes', async () => {
    const user = await createUser('日本語ユーザー');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, '日本語ユーザー', {
      from_pos: 0,
      to_pos: 0,
      inserted_text: '数学の公式 ∑ ∫ √',
      deleted_text: 'αβγδ',
    });

    const change = await getChange(changeId);
    expect(change.author_name).toBe('日本語ユーザー');
    expect(change.inserted_text).toBe('数学の公式 ∑ ∫ √');
    expect(change.deleted_text).toBe('αβγδ');
  });

  it('handles LaTeX special characters in tracked text', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const latex = '\\begin{equation}\n  E = mc^{2}\n\\end{equation}';
    const changeId = await createChange(fileId, projectId, user.id, 'Alice', {
      from_pos: 0,
      to_pos: 0,
      inserted_text: latex,
    });

    const change = await getChange(changeId);
    expect(change.inserted_text).toBe(latex);
  });

  it('multiple changes can exist at the same position', async () => {
    const user = await createUser('Dan');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    await createChange(fileId, projectId, user.id, 'Dan', {
      from_pos: 10,
      to_pos: 10,
      inserted_text: 'first',
    });
    await createChange(fileId, projectId, user.id, 'Dan', {
      from_pos: 10,
      to_pos: 10,
      inserted_text: 'second',
    });

    const changes = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1 AND from_pos = 10', [fileId]);
    expect(changes).toHaveLength(2);
  });

  it('created_at is set automatically', async () => {
    const user = await createUser('Eve');
    const projectId = await createProject(user.id);
    const fileId = await createFile(projectId);

    const changeId = await createChange(fileId, projectId, user.id, 'Eve', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'test',
    });

    const change = await getChange(changeId);
    expect(change.created_at).toBeDefined();
    expect(new Date(change.created_at).getTime()).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Full review walkthrough simulation
// ═══════════════════════════════════════════════════════════════════════════
describe('Review walkthrough simulation', () => {
  it('walks through changes accepting each one sequentially', async () => {
    const author = await createUser('Author');
    const reviewer = await createUser('Reviewer');
    const projectId = await createProject(author.id);
    await addMember(projectId, reviewer.id, 'editor');
    const fileId = await createFile(projectId, 'main.tex', 'The quick brown fox jumps over the lazy dog');

    // Create 3 changes at different positions
    const c1 = await createChange(fileId, projectId, author.id, 'Author', {
      from_pos: 4,
      to_pos: 9,
      deleted_text: 'quick',
      inserted_text: 'slow',
    });
    const c2 = await createChange(fileId, projectId, author.id, 'Author', {
      from_pos: 20,
      to_pos: 20,
      inserted_text: 'happily ',
    });
    const c3 = await createChange(fileId, projectId, author.id, 'Author', {
      from_pos: 35,
      to_pos: 39,
      deleted_text: 'lazy',
    });

    // Simulate review walkthrough: get sorted pending, accept first
    let pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(3);
    expect(pending[0].id).toBe(c1); // first by position

    // Accept change 1
    await db.run("UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE id = $2", [reviewer.id, c1]);

    pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(2);
    expect(pending[0].id).toBe(c2); // now first

    // Reject change 2
    await db.run("UPDATE tracked_changes SET status = 'rejected', resolved_by = $1 WHERE id = $2", [reviewer.id, c2]);

    pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(c3);

    // Accept change 3
    await db.run("UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE id = $2", [reviewer.id, c3]);

    pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(0);

    // Verify final states
    const all = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1 ORDER BY from_pos', [fileId]);
    expect(all[0].status).toBe('accepted');
    expect(all[1].status).toBe('rejected');
    expect(all[2].status).toBe('accepted');
  });

  it('handles accept-all during walkthrough', async () => {
    const author = await createUser('Author');
    const reviewer = await createUser('Reviewer');
    const projectId = await createProject(author.id);
    await addMember(projectId, reviewer.id, 'editor');
    const fileId = await createFile(projectId);

    await createChange(fileId, projectId, author.id, 'Author', { from_pos: 0, to_pos: 5, inserted_text: 'a' });
    await createChange(fileId, projectId, author.id, 'Author', { from_pos: 10, to_pos: 15, inserted_text: 'b' });
    await createChange(fileId, projectId, author.id, 'Author', { from_pos: 20, to_pos: 25, inserted_text: 'c' });

    // Reviewer starts walkthrough, then decides to accept all
    const pending = await getPendingChanges(fileId);
    expect(pending).toHaveLength(3);

    await db.run(
      "UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
      [reviewer.id, fileId],
    );

    const remaining = await getPendingChanges(fileId);
    expect(remaining).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Project-wide queries
// ═══════════════════════════════════════════════════════════════════════════
describe('Project-wide tracked changes', () => {
  it('queries pending changes across all project files', async () => {
    const user = await createUser('Alice');
    const projectId = await createProject(user.id);
    const fileA = await createFile(projectId, 'main.tex');
    const fileB = await createFile(projectId, 'intro.tex');
    const fileC = await createFile(projectId, 'conclusion.tex');

    await createChange(fileA, projectId, user.id, 'Alice', { from_pos: 0, to_pos: 5, inserted_text: 'a' });
    await createChange(fileB, projectId, user.id, 'Alice', { from_pos: 0, to_pos: 5, inserted_text: 'b' });
    // Accepted in fileC
    await createChange(fileC, projectId, user.id, 'Alice', {
      from_pos: 0,
      to_pos: 5,
      inserted_text: 'c',
      status: 'accepted',
    });

    const pendingAll = await db.all(
      `SELECT tc.*, f.path as file_path FROM tracked_changes tc
       JOIN files f ON tc.file_id = f.id
       WHERE tc.project_id = $1 AND tc.status = 'pending'`,
      [projectId],
    );

    expect(pendingAll).toHaveLength(2);
    const paths = pendingAll.map((c) => c.file_path).sort();
    expect(paths).toEqual(['intro.tex', 'main.tex']);
  });
});
