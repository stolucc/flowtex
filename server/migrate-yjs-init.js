// @ts-check
/**
 * YJS-MIGRATION phase 3 — one-shot backfill of files.content_yjs.
 *
 * For every non-binary file row whose content_yjs is still NULL,
 * construct a fresh Y.Doc, insert the file's `content` text, and
 * persist Y.encodeStateAsUpdateV2 into content_yjs.
 *
 * Safe to run multiple times. Files already migrated (content_yjs
 * IS NOT NULL) are skipped. Files that are binary (is_binary = TRUE)
 * are skipped because the Y.Doc text channel doesn't model binary
 * content.
 *
 * Optional. The lazy migration path in services/yjsRoom.js already
 * seeds on first acquireRoom for files whose content_yjs is NULL,
 * so this script is for operators who would rather pay the
 * migration cost at deploy time than on the first interactive
 * file-open. Useful if a project has very large files and the user
 * doesn't want the initial yjs-request-state to block.
 *
 * Usage:
 *   node --env-file=.env server/migrate-yjs-init.js              # whole installation
 *   node --env-file=.env server/migrate-yjs-init.js <project-id> # one project
 */

import * as Y from 'yjs';
import db from './db.js';

const BATCH_SIZE = 200;

// Detect whether we're being executed directly (CLI) versus imported
// from a test. When imported, we expose main() but skip the auto-run
// so the test can drive it under its own mocked argv / db.
const IS_CLI =
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  process.argv[1].endsWith('migrate-yjs-init.js');

export async function main() {
  const projectId = process.argv[2] || null;

  console.log('YJS backfill starting…' + (projectId ? ` (project ${projectId})` : ' (all projects)'));

  let totalSeen = 0;
  let totalMigrated = 0;
  let totalSkippedEmpty = 0;
  let lastId = '';

  // Page through files by id to keep memory bounded. The WHERE
  // content_yjs IS NULL filter shrinks each subsequent batch as the
  // backfill progresses; combined with the > lastId paginator this
  // terminates after one pass over the qualifying rows.
  while (true) {
    const params = projectId ? [projectId, lastId, BATCH_SIZE] : [lastId, BATCH_SIZE];
    const sql = projectId
      ? `SELECT id, project_id, content
           FROM files
          WHERE project_id = $1
            AND id > $2
            AND content_yjs IS NULL
            AND is_binary = FALSE
          ORDER BY id ASC
          LIMIT $3`
      : `SELECT id, project_id, content
           FROM files
          WHERE id > $1
            AND content_yjs IS NULL
            AND is_binary = FALSE
          ORDER BY id ASC
          LIMIT $2`;
    const rows = await db.all(sql, params);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      totalSeen += 1;
      lastId = row.id;
      if (typeof row.content !== 'string' || row.content.length === 0) {
        // Empty file -- skip (the lazy path will still work; the
        // Y.Doc just stays empty until someone types).
        totalSkippedEmpty += 1;
        continue;
      }
      const ydoc = new Y.Doc();
      ydoc.getText('content').insert(0, row.content);
      const bytes = Y.encodeStateAsUpdateV2(ydoc);
      await db.run(
        'UPDATE files SET content_yjs = $1 WHERE id = $2 AND project_id = $3 AND content_yjs IS NULL',
        [Buffer.from(bytes), row.id, row.project_id],
      );
      ydoc.destroy();
      totalMigrated += 1;
    }
    console.log(`  …${totalSeen} seen, ${totalMigrated} migrated, ${totalSkippedEmpty} empty`);
  }

  console.log(`Done. Seen: ${totalSeen}, migrated: ${totalMigrated}, skipped empty: ${totalSkippedEmpty}.`);
  return { totalSeen, totalMigrated, totalSkippedEmpty };
}

if (IS_CLI) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('YJS backfill failed:', err);
      process.exit(1);
    });
}
