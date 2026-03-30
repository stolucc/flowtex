import pg from 'pg';

const pool = new pg.Pool({
  database: process.env.PGDATABASE || 'flowtex',
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  max: 20,
  ssl:
    process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'verify-full'
      ? { rejectUnauthorized: process.env.PGSSLMODE === 'verify-full' }
      : false,
});

// Prevent unhandled errors from idle clients crashing the process
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

// Convenience wrappers matching the old sync API shape but async
const db = {
  pool,

  // Returns first row or undefined
  async get(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || undefined;
  },

  // Returns all rows
  async all(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows;
  },

  // Returns { rowCount, rows }
  async run(sql, params = []) {
    const result = await pool.query(sql, params);
    return result;
  },

  // Run multiple statements in a transaction
  async transaction(fn) {
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

// ── Schema creation ─────────────────────────────────────────────────────
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

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      main_file TEXT NOT NULL DEFAULT 'main.tex',
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      trashed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

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

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      from_pos INTEGER NOT NULL,
      to_pos INTEGER NOT NULL,
      text TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'User',
      author_id TEXT REFERENCES users(id),
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

    CREATE TABLE IF NOT EXISTS tracked_changes (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_pos INTEGER NOT NULL,
      to_pos INTEGER NOT NULL,
      inserted_text TEXT NOT NULL DEFAULT '',
      deleted_text TEXT NOT NULL DEFAULT '',
      author_id TEXT REFERENCES users(id),
      author_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tracked_changes_file ON tracked_changes(file_id);
    CREATE INDEX IF NOT EXISTS idx_tracked_changes_project ON tracked_changes(project_id);

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

    -- Chat messages
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at);

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
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at);
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

export default db;
