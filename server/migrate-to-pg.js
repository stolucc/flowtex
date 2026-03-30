/**
 * One-time migration script: SQLite → PostgreSQL
 * Run with: node server/migrate-to-pg.js
 */
import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqliteDb = new Database(path.join(__dirname, '..', 'flowtex.db'));

const pool = new pg.Pool({
  database: process.env.PGDATABASE || 'flowtex',
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432'),
  max: 5,
});

async function migrate() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Users
    const users = sqliteDb.prepare('SELECT * FROM users').all();
    console.log(`Migrating ${users.length} users...`);
    for (const u of users) {
      await client.query(
        'INSERT INTO users (id, email, name, password_hash, totp_secret, totp_enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
        [
          u.id,
          u.email,
          u.name,
          u.password_hash,
          u.totp_secret || null,
          !!u.totp_enabled,
          u.created_at || new Date().toISOString(),
        ],
      );
    }

    // 2. Projects
    const projects = sqliteDb.prepare('SELECT * FROM projects').all();
    console.log(`Migrating ${projects.length} projects...`);
    for (const p of projects) {
      await client.query(
        'INSERT INTO projects (id, name, main_file, archived, trashed, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
        [
          p.id,
          p.name,
          p.main_file || 'main.tex',
          !!p.archived,
          !!p.trashed,
          p.created_at || new Date().toISOString(),
          p.updated_at || new Date().toISOString(),
        ],
      );
    }

    // 3. Files
    const files = sqliteDb.prepare('SELECT * FROM files').all();
    console.log(`Migrating ${files.length} files...`);
    for (const f of files) {
      await client.query(
        'INSERT INTO files (id, project_id, path, content, is_binary, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
        [
          f.id,
          f.project_id,
          f.path,
          f.content,
          !!f.is_binary,
          f.created_at || new Date().toISOString(),
          f.updated_at || new Date().toISOString(),
        ],
      );
    }

    // 4. Project members
    const members = sqliteDb.prepare('SELECT * FROM project_members').all();
    console.log(`Migrating ${members.length} project members...`);
    for (const m of members) {
      await client.query(
        'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id, user_id) DO NOTHING',
        [m.project_id, m.user_id, m.role, m.created_at || new Date().toISOString()],
      );
    }

    // 5. Comments
    const comments = sqliteDb.prepare('SELECT * FROM comments').all();
    console.log(`Migrating ${comments.length} comments...`);
    for (const c of comments) {
      await client.query(
        'INSERT INTO comments (id, file_id, from_pos, to_pos, text, author, author_id, resolved, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING',
        [
          c.id,
          c.file_id,
          c.from_pos,
          c.to_pos,
          c.text,
          c.author,
          c.author_id || null,
          !!c.resolved,
          c.created_at || new Date().toISOString(),
        ],
      );
    }

    // 6. Comment replies
    const replies = sqliteDb.prepare('SELECT * FROM comment_replies').all();
    console.log(`Migrating ${replies.length} comment replies...`);
    for (const r of replies) {
      await client.query(
        'INSERT INTO comment_replies (id, comment_id, text, author, author_id, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
        [r.id, r.comment_id, r.text, r.author, r.author_id || null, r.created_at || new Date().toISOString()],
      );
    }

    // 7. GitHub tokens
    try {
      const tokens = sqliteDb.prepare('SELECT * FROM github_tokens').all();
      console.log(`Migrating ${tokens.length} GitHub tokens...`);
      for (const t of tokens) {
        await client.query(
          'INSERT INTO github_tokens (user_id, token, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING',
          [t.user_id, t.token, t.updated_at || new Date().toISOString()],
        );
      }
    } catch (e) {
      console.log('No github_tokens table, skipping.');
    }

    // 8. Project GitHub links
    try {
      const links = sqliteDb.prepare('SELECT * FROM project_github_links').all();
      console.log(`Migrating ${links.length} GitHub links...`);
      for (const l of links) {
        await client.query(
          'INSERT INTO project_github_links (project_id, github_repo, default_branch, last_sync_at, last_sync_commit, linked_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id) DO NOTHING',
          [
            l.project_id,
            l.github_repo,
            l.default_branch,
            l.last_sync_at || null,
            l.last_sync_commit || null,
            l.linked_by,
            l.created_at || new Date().toISOString(),
          ],
        );
      }
    } catch (e) {
      console.log('No project_github_links table, skipping.');
    }

    // 9. Project invitations
    try {
      const invitations = sqliteDb.prepare('SELECT * FROM project_invitations').all();
      console.log(`Migrating ${invitations.length} invitations...`);
      for (const i of invitations) {
        await client.query(
          'INSERT INTO project_invitations (id, project_id, email, role, inviter_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
          [i.id, i.project_id, i.email, i.role, i.inviter_id, i.status, i.created_at || new Date().toISOString()],
        );
      }
    } catch (e) {
      console.log('No project_invitations table, skipping.');
    }

    // 10. Tags
    try {
      const tags = sqliteDb.prepare('SELECT * FROM tags').all();
      console.log(`Migrating ${tags.length} tags...`);
      for (const t of tags) {
        await client.query(
          'INSERT INTO tags (id, user_id, name, color, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
          [t.id, t.user_id, t.name, t.color, t.created_at || new Date().toISOString()],
        );
      }
    } catch (e) {
      console.log('No tags table, skipping.');
    }

    // 11. Project tags
    try {
      const ptags = sqliteDb.prepare('SELECT * FROM project_tags').all();
      console.log(`Migrating ${ptags.length} project tags...`);
      for (const pt of ptags) {
        await client.query('INSERT INTO project_tags (project_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
          pt.project_id,
          pt.tag_id,
        ]);
      }
    } catch (e) {
      console.log('No project_tags table, skipping.');
    }

    // 12. File versions
    try {
      const versions = sqliteDb.prepare('SELECT * FROM file_versions').all();
      console.log(`Migrating ${versions.length} file versions...`);
      for (const v of versions) {
        await client.query(
          'INSERT INTO file_versions (id, file_id, project_id, file_path, content, author_id, author_name, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
          [
            v.id,
            v.file_id,
            v.project_id,
            v.file_path,
            v.content,
            v.author_id || null,
            v.author_name,
            v.created_at || new Date().toISOString(),
          ],
        );
      }
    } catch (e) {
      console.log('No file_versions table, skipping.');
    }

    await client.query('COMMIT');
    console.log('Migration complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    sqliteDb.close();
  }
}

migrate();
