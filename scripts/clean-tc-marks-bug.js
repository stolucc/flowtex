#!/usr/bin/env node
// Recovery utility for FlowTex projects corrupted by the
// "all text marked as new tracked-change insert" bug, fixed in
// commit 566bd77. Between the time FEATURE_YJS_SYNC went on in
// production and 2026-06-10, opening any project would synchronously
// produce a giant ins-mark covering the file's previous content,
// attributed to the user who opened it.
//
// What it does, per file:
//   1. Parse files.tc_marks (JSONB array of {id, type, from, to,
//      authorId, authorName, timestamp}).
//   2. Drop the entries that look like the bug: type='ins',
//      authorId === <bug-author>, timestamp >= <bug-since>, and
//      (to - from) >= <min-range>. Defaults are tight enough that
//      a real user-typed insert in that range is rare.
//   3. Write the filtered array back.
//
// Default mode is SCAN: prints what WOULD be removed, with counts.
// Pass --apply to actually mutate.
//
// USAGE
//   # Scan: how much would the cleanup remove?
//   node scripts/clean-tc-marks-bug.js \
//     --author=<user-id> --since=2026-06-09 [--min-range=100]
//
//   # Apply (mutates the DB):
//   node scripts/clean-tc-marks-bug.js \
//     --author=<user-id> --since=2026-06-09 --apply
//
//   # Limit to one project for caution:
//   node scripts/clean-tc-marks-bug.js \
//     --author=<user-id> --since=2026-06-09 --project=<uuid>
//
// ENV
//   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD  (standard libpq)
//
// REQUIRES
//   Reads env vars but does NOT require the FlowTex server to be
//   running. Recommended sequence: stop the web tier, run --scan,
//   review the report, run --apply, start the web tier.
//
// SAFETY
//   - Default --min-range=100: only marks spanning at least 100
//     chars are candidates. Real typed inserts of that size in a
//     single transaction are uncommon; the bug created marks
//     spanning the entire file content (typically thousands of
//     chars). Tune lower if needed, but err high.
//   - --author is REQUIRED. There's no "wipe across all authors"
//     mode -- that would be too easy to misfire.
//   - Mutations run inside a single transaction per file. If a
//     single UPDATE fails, the whole file's tc_marks rollback.
//   - --apply prints the affected file UUIDs so you have a paper
//     trail.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function autoLoadEnv() {
  if (typeof process.loadEnvFile !== 'function') return;
  const candidates = [
    process.env.FLOWTEX_ENV_FILE,
    '/opt/flowtex/.env',
    path.resolve(__dirname, '..', 'server', '.env'),
    path.resolve(__dirname, '..', '.env'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (existsSync(file)) {
      try { process.loadEnvFile(file); return; } catch { /* try next */ }
    }
  }
}
autoLoadEnv();

const serverRequire = createRequire(path.resolve(__dirname, '..', 'server', 'package.json'));
const pg = serverRequire('pg');

// ─── Args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const argMap = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => a.slice(2).split('=', 2)),
);

const AUTHOR_ID = argMap.author || '';
const SINCE = argMap.since || '';
const MIN_RANGE = parseInt(argMap['min-range'] || '100', 10);
const PROJECT_UUID = argMap.project || '';

if (!AUTHOR_ID || !SINCE) {
  console.error('Usage: clean-tc-marks-bug.js --author=<user-id> --since=<ISO-date> [--min-range=100] [--project=<uuid>] [--apply]');
  console.error('');
  console.error('Required:');
  console.error('  --author=<user-id>   UUID of the user whose inserts to scrub');
  console.error('  --since=<ISO-date>   ISO 8601 timestamp; mark.timestamp >= this is a candidate');
  console.error('Optional:');
  console.error('  --min-range=N        Only marks where (to - from) >= N. Default 100.');
  console.error('  --project=<uuid>     Limit scope to one project (recommended first run).');
  console.error('  --apply              Actually mutate. Without it, scan only.');
  process.exit(2);
}

if (!/^[0-9a-f-]{36}$/i.test(AUTHOR_ID)) {
  console.error(`Refusing: --author=${AUTHOR_ID} doesn't look like a UUID.`);
  process.exit(2);
}

const SINCE_TS = Date.parse(SINCE);
if (Number.isNaN(SINCE_TS)) {
  console.error(`Refusing: --since=${SINCE} doesn't parse as a date.`);
  process.exit(2);
}

if (PROJECT_UUID && !/^[0-9a-f-]{36}$/i.test(PROJECT_UUID)) {
  console.error(`Refusing: --project=${PROJECT_UUID} doesn't look like a UUID.`);
  process.exit(2);
}

if (!Number.isFinite(MIN_RANGE) || MIN_RANGE < 1) {
  console.error(`Refusing: --min-range=${argMap['min-range']} is invalid.`);
  process.exit(2);
}

// ─── Connect ────────────────────────────────────────────────────────

const pool = new pg.Pool({ max: 4 });

// Per-mark filter -- returns true if the mark looks like bug debris.
/**
 * @param {any} m
 * @returns {boolean}
 */
function isBugMark(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type !== 'ins') return false;
  if (m.authorId !== AUTHOR_ID) return false;
  if (typeof m.timestamp !== 'string') return false;
  const ts = Date.parse(m.timestamp);
  if (Number.isNaN(ts) || ts < SINCE_TS) return false;
  if (typeof m.from !== 'number' || typeof m.to !== 'number') return false;
  if ((m.to - m.from) < MIN_RANGE) return false;
  return true;
}

async function main() {
  const projectFilter = PROJECT_UUID ? 'AND f.project_id = $1' : '';
  const filterParams = PROJECT_UUID ? [PROJECT_UUID] : [];

  const rows = await pool.query(
    `SELECT f.id AS file_id, f.project_id, f.path, f.tc_marks
       FROM files f
       WHERE f.tc_marks IS NOT NULL
         AND jsonb_array_length(f.tc_marks) > 0
         ${projectFilter}
       ORDER BY f.project_id, f.path`,
    filterParams,
  );

  console.log(`Inspected ${rows.rowCount} file(s) with non-empty tc_marks.`);
  console.log(`Bug criteria: type=ins, authorId=${AUTHOR_ID}, since=${SINCE}, min-range=${MIN_RANGE}`);
  console.log(PROJECT_UUID ? `Project scope: ${PROJECT_UUID}` : 'Scope: all projects');
  console.log(APPLY ? 'Mode: APPLY (will mutate)' : 'Mode: scan only (use --apply to mutate)');
  console.log('');

  let filesAffected = 0;
  let marksRemoved = 0;

  for (const row of rows.rows) {
    const marks = Array.isArray(row.tc_marks) ? row.tc_marks : [];
    const candidates = marks.filter(isBugMark);
    if (candidates.length === 0) continue;

    filesAffected += 1;
    marksRemoved += candidates.length;

    const survivors = marks.filter((m) => !isBugMark(m));
    const sampleRange = candidates
      .map((m) => `${m.from}..${m.to}`)
      .slice(0, 3)
      .join(', ');

    console.log(
      `[${APPLY ? 'APPLY' : 'SCAN '}] project=${row.project_id} path=${row.path}` +
        `  marks ${marks.length} → ${survivors.length}` +
        `  (-${candidates.length}, sample ranges: ${sampleRange})`,
    );

    if (APPLY) {
      // One-file transaction: if the UPDATE fails the file's
      // tc_marks stay intact.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE files SET tc_marks = $1::jsonb WHERE id = $2',
          [JSON.stringify(survivors), row.file_id],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`  ! failed to update file ${row.file_id}: ${err.message}`);
        process.exitCode = 1;
      } finally {
        client.release();
      }
    }
  }

  console.log('');
  console.log(`Summary: ${filesAffected} file(s) match criteria, ${marksRemoved} mark(s) ${APPLY ? 'removed' : 'would be removed'}.`);
  if (!APPLY && filesAffected > 0) {
    console.log('Re-run with --apply once the report looks right.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
