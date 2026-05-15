import pg from 'pg';

const pool = new pg.Pool({
  database: process.env.PGDATABASE || 'flowtex',
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  ssl:
    process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'verify-full'
      ? { rejectUnauthorized: process.env.PGSSLMODE === 'verify-full' }
      : false,
});

// Prevent unhandled errors from idle clients crashing the process
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

// ─── Write counter ──────────────────────────────────────────────────────
// In-memory only; resets on process restart. Surfaced via
// /api/admin/stats/db-writes. Reads (SELECT, BEGIN, COMMIT, ROLLBACK) are
// intentionally not counted.
const writeStats = {
  total: 0,
  byOp: Object.create(null),
  byTable: Object.create(null),
  startedAt: new Date().toISOString(),
};

/**
 * Inspect a SQL statement and return { op, table } if it's a write, else
 * null. Recognized ops: INSERT / UPDATE / DELETE / CREATE / ALTER / DROP /
 * TRUNCATE. Table extraction is best-effort: it handles the IF [NOT] EXISTS
 * clause, optional ONLY, double-quoted identifiers, and `INSERT INTO`,
 * `DELETE FROM`, `TRUNCATE TABLE` variants. Unparseable writes still bump
 * the total counter but land in the `unknown` table bucket.
 */
function detectWrite(sql) {
  if (typeof sql !== 'string') return null;
  const trimmed = sql.replace(/^\s*\/\*[\s\S]*?\*\//, '').trimStart();
  const opMatch = /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.exec(trimmed);
  if (!opMatch) return null;
  const op = opMatch[1].toUpperCase();
  const patterns = {
    INSERT: /^INSERT\s+INTO\s+(?:ONLY\s+)?"?(\w+)"?/i,
    UPDATE: /^UPDATE\s+(?:ONLY\s+)?"?(\w+)"?/i,
    DELETE: /^DELETE\s+FROM\s+(?:ONLY\s+)?"?(\w+)"?/i,
    CREATE: /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i,
    ALTER:  /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?(\w+)"?/i,
    DROP:   /^DROP\s+(?:TABLE|INDEX|VIEW)\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i,
    TRUNCATE: /^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?"?(\w+)"?/i,
  };
  const m = patterns[op].exec(trimmed);
  return { op, table: (m && m[1]) || 'unknown' };
}

/** Bump the write-stats counters for one SQL statement, if it's a write. */
// Defensive cap so the in-memory map can't grow unbounded if untrusted
// SQL ever reaches db.run (today it can't; this is belt-and-braces).
// FlowTex has well under 64 real tables; 256 leaves comfortable headroom.
const MAX_TABLE_BUCKETS = 256;

function recordWrite(sql) {
  const w = detectWrite(sql);
  if (!w) return;
  writeStats.total++;
  writeStats.byOp[w.op] = (writeStats.byOp[w.op] || 0) + 1;
  const key =
    Object.prototype.hasOwnProperty.call(writeStats.byTable, w.table) ||
    Object.keys(writeStats.byTable).length < MAX_TABLE_BUCKETS
      ? w.table
      : '_other';
  writeStats.byTable[key] = (writeStats.byTable[key] || 0) + 1;
}

/** Read-only snapshot of write counters since process start. */
export function getWriteStats() {
  return {
    total: writeStats.total,
    byOp: { ...writeStats.byOp },
    byTable: { ...writeStats.byTable },
    startedAt: writeStats.startedAt,
  };
}

/** Test-only: reset the counters. Gated to NODE_ENV=test. */
export function _resetWriteStatsForTesting() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetWriteStatsForTesting may only be called in tests');
  }
  writeStats.total = 0;
  writeStats.byOp = Object.create(null);
  writeStats.byTable = Object.create(null);
  writeStats.startedAt = new Date().toISOString();
}

// ─── Integration-test shared client ─────────────────────────────────────
// When set (test-only), every db.{get,all,run} and db.transaction routes
// through this single pg client instead of the pool. The integration test
// harness wraps each test in `BEGIN … ROLLBACK` on this client so all
// changes from the test (and any nested db.transaction calls, which now
// use SAVEPOINTs) are reverted at the end of the test — no test data
// leaks into the real database.
let _sharedClient = null;

/**
 * Test-only: install a single pg client that all queries will use until
 * cleared with `_setSharedClient(null)`. Production code must never call
 * this; it would serialize every API request through one connection.
 */
export function _setSharedClient(client) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setSharedClient may only be called in tests (set NODE_ENV=test)');
  }
  _sharedClient = client;
}

/** The active query runner — shared client in test mode, pool in prod. */
function runner() {
  return _sharedClient || pool;
}

let _savepointCounter = 0;

/** Convenience wrappers around the pg Pool matching a simple get/all/run API. */
const db = {
  pool,

  /** Run a query and return the first row, or undefined. */
  async get(sql, params = []) {
    const { rows } = await runner().query(sql, params);
    return rows[0] || undefined;
  },

  /** Run a query and return all matching rows. */
  async all(sql, params = []) {
    const { rows } = await runner().query(sql, params);
    return rows;
  },

  /** Run a query and return the full pg Result (rowCount, rows, etc.). */
  async run(sql, params = []) {
    recordWrite(sql);
    const result = await runner().query(sql, params);
    return result;
  },

  /**
   * Run multiple statements in a serialized transaction.
   * In test mode (shared client active) we use SAVEPOINTs so the outer
   * test-level BEGIN/ROLLBACK keeps working — PostgreSQL doesn't allow
   * truly nested BEGIN, and a naive nested COMMIT here would leak the
   * inner changes past the outer rollback.
   * @param {(txDb: {get, all, run}) => Promise} fn - Receives a transaction-scoped db object.
   * @returns {Promise} The return value of fn.
   */
  async transaction(fn) {
    if (_sharedClient) {
      const sp = `sp_${++_savepointCounter}`;
      const c = _sharedClient;
      await c.query(`SAVEPOINT ${sp}`);
      try {
        const txDb = {
          async get(sql, params = []) {
            const { rows } = await c.query(sql, params);
            return rows[0] || undefined;
          },
          async all(sql, params = []) {
            const { rows } = await c.query(sql, params);
            return rows;
          },
          async run(sql, params = []) {
            recordWrite(sql);
            return c.query(sql, params);
          },
        };
        const result = await fn(txDb);
        await c.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        throw err;
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = {
        async get(sql, params = []) {
          const { rows } = await client.query(sql, params);
          return rows[0] || undefined;
        },
        async all(sql, params = []) {
          const { rows } = await client.query(sql, params);
          return rows;
        },
        async run(sql, params = []) {
          recordWrite(sql);
          return client.query(sql, params);
        },
      };
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

/** Create all database tables, indexes, and seed data if they don't exist. */
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
    -- Mark all existing users as verified (they were created before email verification was added)
    UPDATE users SET email_verified = TRUE WHERE email_verified = FALSE AND created_at < NOW() - INTERVAL '1 minute';

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      main_file TEXT NOT NULL DEFAULT 'main.tex',
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      trashed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS compiler TEXT NOT NULL DEFAULT 'pdflatex';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS tex_distribution TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS snapshot_interval_sec INTEGER NOT NULL DEFAULT 30;

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_binary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, path)
    );

    -- Explicit empty-folder bookkeeping. Folders are still implicit in file
    -- paths (e.g. a file at "parts/foo.tex" creates a virtual "parts" folder
    -- in the UI), but to let users create a folder *before* dropping a file
    -- into it, we persist those empty-folder paths here. The tree-build code
    -- unions file-derived folders with these rows.
    CREATE TABLE IF NOT EXISTS project_folders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, path)
    );
    CREATE INDEX IF NOT EXISTS project_folders_project_id_idx ON project_folders(project_id);
    -- tc_marks column kept dormant (track-changes pipeline was removed; will
    -- be repurposed when the feature is rebuilt). Default '[]' so existing
    -- inserts and the future rebuild can both rely on a non-null array.
    ALTER TABLE files ADD COLUMN IF NOT EXISTS tc_marks JSONB NOT NULL DEFAULT '[]'::jsonb;

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      from_pos INTEGER NOT NULL,
      to_pos INTEGER NOT NULL,
      text TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'User',
      author_id TEXT REFERENCES users(id),
      assigned_to TEXT REFERENCES users(id),
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS comment_replies (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      author_id TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- comment_mentions FKs to comment_replies, so it must be defined AFTER it.
    -- (Local dev didn't catch this because schema accreted over many boots
    --  and migrations; a fresh CI Postgres tripped on the missing relation.)
    CREATE TABLE IF NOT EXISTS comment_mentions (
      id TEXT PRIMARY KEY,
      comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      reply_id TEXT REFERENCES comment_replies(id) ON DELETE CASCADE,
      mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- mentioner_user_id is SET NULL on user delete: when the mentioner is
      -- gone, the recipient still wants to see "(deleted user) mentioned you
      -- in <project>" rather than have the whole row disappear.
      mentioner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snippet TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      notified_at TIMESTAMPTZ
    );
    -- In-app "seen" state for the notification bell — separate from
    -- notified_at (email-sent state) so the two systems are independent.
    ALTER TABLE comment_mentions ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;

    -- Migration (2026-05-15): preserve a recipient's notification history when
    -- the mentioner is deleted. Default Postgres FK names follow
    -- "<table>_<column>_fkey"; we drop it and re-add as ON DELETE SET NULL.
    -- DROP IF EXISTS + ADD is idempotent across re-runs and on fresh installs
    -- (where the CREATE TABLE already created the constraint with the new
    -- behavior, so the ALTERs just round-trip it).
    ALTER TABLE comment_mentions ALTER COLUMN mentioner_user_id DROP NOT NULL;
    ALTER TABLE comment_mentions DROP CONSTRAINT IF EXISTS comment_mentions_mentioner_user_id_fkey;
    ALTER TABLE comment_mentions
      ADD CONSTRAINT comment_mentions_mentioner_user_id_fkey
      FOREIGN KEY (mentioner_user_id) REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_comment_mentions_inbox
      ON comment_mentions(mentioned_user_id, created_at DESC);

    ALTER TABLE comments ADD COLUMN IF NOT EXISTS assigned_to TEXT REFERENCES users(id);

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS github_tokens (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS zotero_tokens (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      api_key TEXT NOT NULL,
      zotero_user_id TEXT NOT NULL,
      display_name TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_github_links (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      github_repo TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      last_sync_at TIMESTAMPTZ,
      last_sync_commit TEXT,
      auto_push BOOLEAN NOT NULL DEFAULT FALSE,
      auto_push_interval INTEGER NOT NULL DEFAULT 300,
      linked_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE project_github_links ADD COLUMN IF NOT EXISTS auto_push BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE project_github_links ADD COLUMN IF NOT EXISTS auto_push_interval INTEGER NOT NULL DEFAULT 300;

    CREATE TABLE IF NOT EXISTS project_invitations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      inviter_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, email)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#89b4fa',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS project_tags (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS file_versions (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT NOT NULL DEFAULT 'Unknown',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS project_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      data BYTEA NOT NULL,
      author_id TEXT,
      author_name TEXT NOT NULL DEFAULT 'Unknown',
      label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_snapshots_project ON project_snapshots(project_id, created_at DESC);

    -- (Tracked-changes pipeline was removed — to be rebuilt from scratch.)

    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

    -- Performance indexes
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(file_id);
    CREATE INDEX IF NOT EXISTS idx_comment_replies_comment ON comment_replies(comment_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_file_versions_project ON file_versions(project_id);
    CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id);
    CREATE INDEX IF NOT EXISTS idx_project_invitations_email ON project_invitations(email);
    CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag_id);

    -- Templates (preloaded + user-uploaded)
    CREATE TABLE IF NOT EXISTS user_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
      preloaded BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE user_templates ADD COLUMN IF NOT EXISTS preloaded BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE user_templates ALTER COLUMN created_by DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_user_templates_created_by ON user_templates(created_by);

    CREATE TABLE IF NOT EXISTS user_template_files (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES user_templates(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_binary BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(template_id, path)
    );

    -- Template tags (global, shared across all users)
    CREATE TABLE IF NOT EXISTS template_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#89b4fa',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Seed default template tags
    INSERT INTO template_tags (id, name, color) VALUES
      ('tag-academic', 'Academic', '#89b4fa'),
      ('tag-presentation', 'Presentation', '#a6e3a1'),
      ('tag-general', 'General', '#cba6f7')
    ON CONFLICT DO NOTHING;

    -- Many-to-many: templates <-> tags
    CREATE TABLE IF NOT EXISTS template_tag_map (
      template_id TEXT NOT NULL REFERENCES user_templates(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES template_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (template_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_template_tag_map_tag ON template_tag_map(tag_id);

    -- Drop legacy table if it exists
    DROP TABLE IF EXISTS builtin_template_tag_map;

    -- Audit log for sensitive actions
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

    -- Login attempt tracking for account lockout
    CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      ip TEXT,
      success BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, created_at);

    -- Password reset tokens
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

    -- Trusted devices for MFA bypass
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      device_name TEXT NOT NULL DEFAULT 'Unknown device',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_token ON trusted_devices(token_hash);

    -- Chat messages. user_id is SET NULL on user delete so co-members keep
    -- the conversation history; user_name acts as the frozen tombstone.
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      user_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at);

    -- Migration (2026-05-15): chat_messages.user_id was originally NOT NULL
    -- with ON DELETE CASCADE. We relax both so deleting a user preserves
    -- their chat history across every project they participated in.
    ALTER TABLE chat_messages ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_user_id_fkey;
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

    -- Emoji reactions on chat messages. The UNIQUE constraint is what enforces
    -- the toggle: each user can hold at most one of each emoji on each message,
    -- so re-applying the same emoji becomes a delete rather than a duplicate.
    CREATE TABLE IF NOT EXISTS chat_message_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_message_reactions_message ON chat_message_reactions(message_id);

    -- Emoji reactions on editor comments. Same toggle semantics as chat:
    -- the UNIQUE constraint turns a re-apply into a delete.
    CREATE TABLE IF NOT EXISTS comment_reactions (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (comment_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON comment_reactions(comment_id);

    -- Emoji reactions on comment replies. Same shape and toggle semantics as
    -- comment_reactions — kept in its own table because replies live in a
    -- separate table and the FK target differs.
    CREATE TABLE IF NOT EXISTS reply_reactions (
      id TEXT PRIMARY KEY,
      reply_id TEXT NOT NULL REFERENCES comment_replies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (reply_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reply_reactions_reply ON reply_reactions(reply_id);

    -- Used TOTP codes for cross-instance replay prevention
    CREATE TABLE IF NOT EXISTS used_totp_codes (
      user_id TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, code)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO settings (key, value) VALUES ('compile_timeout', '120')
      ON CONFLICT (key) DO NOTHING;

    -- Admin dashboard indexes
    CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at);
    CREATE INDEX IF NOT EXISTS idx_file_versions_created ON file_versions(created_at);
    CREATE INDEX IF NOT EXISTS idx_file_versions_author ON file_versions(author_id);
    CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
    CREATE INDEX IF NOT EXISTS idx_comments_assigned ON comments(assigned_to) WHERE assigned_to IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_comment_mentions_pending ON comment_mentions(mentioned_user_id) WHERE notified_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at);

    -- Session userId lookup (for logout-all / password reset)
    CREATE INDEX IF NOT EXISTS idx_session_userid ON session((sess->>'userId'));

    -- Password reset token lookup by hash
    CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token_hash) WHERE used = FALSE;

    -- Email verification token lookup by user
    CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);

    -- Invitation queries use LOWER(email) + status
    CREATE INDEX IF NOT EXISTS idx_project_invitations_email_lower ON project_invitations(LOWER(email)) WHERE status = 'pending';

    -- TOTP code expiry cleanup
    CREATE INDEX IF NOT EXISTS idx_used_totp_expires ON used_totp_codes(expires_at);
  `);

  // Bootstrap admin from env var
  if (process.env.ADMIN_EMAIL) {
    await pool.query('UPDATE users SET is_admin = TRUE WHERE email = $1', [
      process.env.ADMIN_EMAIL.toLowerCase().trim(),
    ]);
  }
}

// Initialize schema — called before server starts
db.initSchema = initSchema;

/** Start a periodic cleanup job that prunes old audit logs, login attempts, and expired tokens. */
function startCleanupJob() {
  async function cleanup() {
    try {
      // Audit log: keep 90 days
      await pool.query("DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'");
      // Login attempts: keep 30 days
      await pool.query("DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '30 days'");
      // Expired password reset tokens
      await pool.query('DELETE FROM password_reset_tokens WHERE expires_at < NOW()');
      // Expired email verification tokens
      await pool.query('DELETE FROM email_verification_tokens WHERE expires_at < NOW()');
      // Project snapshots: keep max 100 per project, delete oldest beyond that
      await pool.query(`
        DELETE FROM project_snapshots WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
            FROM project_snapshots
          ) ranked WHERE rn > 100
        )
      `);
    } catch (err) {
      console.error('DB cleanup error:', err.message);
    }
  }
  // Run once after 1 minute, then every 6 hours
  setTimeout(cleanup, 60000);
  setInterval(cleanup, 6 * 60 * 60 * 1000).unref();
}
db.startCleanupJob = startCleanupJob;

export default db;
