/**
 * One-shot migration: convert every pending row in `tracked_changes`
 * into an inline tcMarker embedded directly in the file content. After
 * this script finishes successfully, the legacy position-based code
 * paths (POST /api/tracked-changes, PATCH, DELETE, accept/reject,
 * adjust-positions, the `tracked_changes` table itself) can be removed.
 *
 * Run with:
 *   node --env-file=../.env server/migrate-tracked-changes-to-markers.js
 *
 * Idempotent: pending rows that resolve into the new marker form are
 * marked status='migrated' so a second run skips them.
 */
import pg from 'pg';
import { serialize as serializeMarker } from '../shared/tcMarkers.js';
import { resolvePosition } from './utils/trackedChangeMarkup.js';

const PROJECT_FILTER = process.argv[2] || null; // optional: limit to one project

async function main() {
  const pool = new pg.Pool({ database: process.env.PGDATABASE || 'flowtex' });
  const client = await pool.connect();
  try {
    // Group pending TCs by file so we can do one content rewrite per
    // file.  Order by from_pos DESC so when we walk the list and splice
    // markers into the content, earlier positions don't shift while we
    // process later ones.
    let q = `SELECT tc.id, tc.file_id, tc.project_id, tc.from_pos, tc.to_pos,
                    tc.inserted_text, tc.deleted_text,
                    tc.author_id, tc.author_name,
                    f.path AS file_path, f.content AS file_content
             FROM tracked_changes tc
             JOIN files f ON f.id = tc.file_id
             WHERE tc.status = 'pending'`;
    const params = [];
    if (PROJECT_FILTER) {
      params.push(PROJECT_FILTER);
      q += ' AND tc.project_id = $1';
    }
    q += ' ORDER BY tc.file_id, tc.from_pos DESC';
    const { rows } = await client.query(q, params);
    console.log(`Pending TCs to migrate: ${rows.length}`);

    // Group by file.
    const byFile = new Map();
    for (const r of rows) {
      if (!byFile.has(r.file_id)) byFile.set(r.file_id, { path: r.file_path, content: r.file_content, tcs: [] });
      byFile.get(r.file_id).tcs.push(r);
    }

    let migrated = 0;
    let skipped = 0;
    for (const [fileId, fileEntry] of byFile) {
      let content = fileEntry.content;
      const migratedIds = [];
      // Order the file's TCs by from_pos DESCENDING so splice doesn't
      // shift the positions of TCs we haven't processed yet.
      fileEntry.tcs.sort((a, b) => b.from_pos - a.from_pos);
      for (const tc of fileEntry.tcs) {
        // Each pending TC may carry an insertion, a deletion, or
        // both. Build the marker(s) and place them at the resolved
        // position. For a pure insertion, the marker REPLACES the
        // inserted_text in place (the insertion is currently part of
        // the live content already because the editor types straight
        // into the doc).  For a pure deletion, the deleted text is
        // currently still in the content (deletions in the legacy
        // model were visual marks); we wrap it in a del marker.  For
        // a replacement (both fields populated), we emit ins+del
        // adjacent at the same position.
        const author = tc.author_name || tc.author_id || '';
        const inText = tc.inserted_text || '';
        const delText = tc.deleted_text || '';
        let target = null;

        if (inText && delText) {
          // Replacement: the legacy from_pos..to_pos covers the
          // INSERTED text in the live content (the deletion is logical
          // only). We need the original deleted text too — which is
          // gone from the content. The best we can do is put both
          // markers at the insertion position; the user can review.
          target = resolvePosition(content, inText, tc.from_pos, tc.to_pos);
          if (!target) { skipped++; continue; }
          const marker =
            serializeMarker({ type: 'ins', id: tc.id.slice(0, 8), author, text: inText }) +
            serializeMarker({ type: 'del', id: tc.id.slice(0, 8) + 'd', author, text: delText });
          content = content.slice(0, target.from) + marker + content.slice(target.to);
        } else if (inText) {
          // Pure insertion: the inserted_text is currently sitting at
          // [from_pos..to_pos] in the content. Replace it with an ins
          // marker that wraps the same text.
          target = resolvePosition(content, inText, tc.from_pos, tc.to_pos);
          if (!target) { skipped++; continue; }
          const marker = serializeMarker({ type: 'ins', id: tc.id.slice(0, 8), author, text: inText });
          content = content.slice(0, target.from) + marker + content.slice(target.to);
        } else if (delText) {
          // Pure deletion: the deleted text is still in the content
          // (legacy model marked it visually only). Wrap it in a del
          // marker.
          target = resolvePosition(content, delText, tc.from_pos, tc.to_pos);
          if (!target) { skipped++; continue; }
          const marker = serializeMarker({ type: 'del', id: tc.id.slice(0, 8), author, text: delText });
          content = content.slice(0, target.from) + marker + content.slice(target.to);
        } else {
          // Empty TC (both fields empty) — phantom from the old buffer
          // bug. Drop without inserting any marker.
        }

        migratedIds.push(tc.id);
        migrated++;
      }

      // Write the new content and mark the migrated TCs as resolved.
      await client.query('BEGIN');
      try {
        await client.query('UPDATE files SET content = $1, updated_at = NOW() WHERE id = $2', [content, fileId]);
        if (migratedIds.length > 0) {
          await client.query(
            "UPDATE tracked_changes SET status = 'migrated' WHERE id = ANY($1::text[])",
            [migratedIds],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(`Migrated ${migrated} TCs into ${byFile.size} files; skipped ${skipped} (text not found).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
