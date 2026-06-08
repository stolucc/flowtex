#!/usr/bin/env node
// Recovery utility for FlowTex projects corrupted by Y.Doc split-brain
// (the 2026-06-08 incident pattern: cluster mode + no worker tier =
// duplicated content in every collaborative file).
//
// What it does, per project:
//   1. Find every .tex file in the project.
//   2. For each file, detect whether its content has >=2 occurrences
//      of \documentclass{...} -- the canonical split-brain symptom.
//   3. Replace the corrupted content with the FIRST occurrence's
//      \documentclass...\end{document} block (i.e. keep the original
//      document, drop the duplicate that got merged in).
//   4. Write the cleaned content to both Postgres (files.content)
//      and disk (server/projects/<id>/<path>).
//
// Default mode is --dry-run: prints what WOULD change, doesn't
// write. Pass --apply to actually perform the writes.
//
// USAGE
//   # Find affected projects across the whole DB (dry-run):
//   node scripts/reset-yjs-project.js --scan
//
//   # Show what would change for one project:
//   node scripts/reset-yjs-project.js <project-uuid>
//
//   # Actually fix one project:
//   node scripts/reset-yjs-project.js <project-uuid> --apply
//
//   # Fix every affected project (scan + apply):
//   node scripts/reset-yjs-project.js --scan --apply
//
// ENV
//   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD  (standard libpq)
//   FLOWTEX_PROJECTS_DIR  (default: server/projects/ next to this script)
//
// REQUIRES
//   The script reads env vars but does NOT require the FlowTex server
//   to be running. Recommended sequence: stop the web tier, run this,
//   start the web tier.

import { writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve `pg` from server/node_modules regardless of where the
// script is invoked. The deps are installed under server/, not at
// the repo root, so a bare `import pg from 'pg'` only works if the
// operator first `cd`s into server/. Using createRequire scoped to
// the server tree makes the script runnable from anywhere
// (including via `sudo -u flowtex node /opt/flowtex/scripts/...`).
const serverRequire = createRequire(path.resolve(__dirname, '..', 'server', 'package.json'));
const pg = serverRequire('pg');

const PROJECTS_DIR =
  process.env.FLOWTEX_PROJECTS_DIR
  || path.resolve(__dirname, '..', 'server', 'projects');

const args = process.argv.slice(2);
const SCAN = args.includes('--scan');
const APPLY = args.includes('--apply');
const PROJECT_UUID = args.find((a) => /^[0-9a-f-]{36}$/i.test(a));

if (!SCAN && !PROJECT_UUID) {
  console.error('Usage: reset-yjs-project.js [--scan] [<project-uuid>] [--apply]');
  console.error('Run with --scan to find affected projects, or pass a project UUID.');
  process.exit(2);
}

const pool = new pg.Pool({ max: 4 });

// A file is split-brain-corrupted iff its content has >= 2
// `\documentclass{...}` declarations. Single-document LaTeX should
// never have more than one; the duplicate is the smoking gun.
function corruptionCount(content) {
  if (typeof content !== 'string') return 0;
  const matches = content.match(/\\documentclass\b/g);
  return matches ? matches.length : 0;
}

// Cleaning rule: take everything from the FIRST \documentclass up to
// the FIRST \end{document}. That's the original document; everything
// after is the duplicate the broadcast merged in.
function cleanContent(content) {
  const start = content.search(/\\documentclass\b/);
  if (start < 0) return content;
  const endMarker = '\\end{document}';
  const endIdx = content.indexOf(endMarker, start);
  if (endIdx < 0) return content; // no \end{document}; refuse to guess
  return content.slice(start, endIdx + endMarker.length) + '\n';
}

async function findAffectedProjects() {
  const { rows } = await pool.query(
    `SELECT DISTINCT project_id
       FROM files
      WHERE path LIKE '%.tex'
        AND content ~ '\\\\documentclass.*\\\\documentclass'
   ORDER BY project_id`,
  );
  return rows.map((r) => r.project_id);
}

async function processProject(projectId, { apply }) {
  const { rows } = await pool.query(
    `SELECT id, path, content
       FROM files
      WHERE project_id = $1 AND path LIKE '%.tex'`,
    [projectId],
  );

  let touched = 0;
  for (const row of rows) {
    const before = corruptionCount(row.content);
    if (before < 2) {
      console.log(`  ok       ${row.path}  (${before} \\documentclass)`);
      continue;
    }
    const cleaned = cleanContent(row.content);
    const after = corruptionCount(cleaned);
    if (after > 1) {
      console.log(`  SKIP     ${row.path}  (still has ${after} \\documentclass after cleaning; needs manual review)`);
      continue;
    }
    console.log(`  WOULD CLEAN  ${row.path}  (${before} -> ${after} \\documentclass; ${row.content.length} -> ${cleaned.length} bytes)`);

    if (apply) {
      // 1. Update Postgres
      await pool.query(
        `UPDATE files SET content = $1 WHERE id = $2`,
        [cleaned, row.id],
      );
      // 2. Update disk (best-effort -- some operators store text-
      //    files only in PG and don't sync to disk for non-binary
      //    files; that's fine, the next compile will write the
      //    cleaned content out of the DB into the project dir)
      const diskPath = path.join(PROJECTS_DIR, projectId, row.path);
      try {
        await stat(diskPath);                       // exists?
        await writeFile(diskPath, cleaned, 'utf-8');
        console.log(`  applied  ${row.path}  (PG + disk updated)`);
      } catch {
        console.log(`  applied  ${row.path}  (PG updated; disk file not present -- will materialise on next compile)`);
      }
      touched += 1;
    }
  }
  return touched;
}

async function main() {
  let projects = [];
  if (SCAN) {
    projects = await findAffectedProjects();
    if (projects.length === 0) {
      console.log('No projects with duplicate \\documentclass found.');
      return;
    }
    console.log(`Found ${projects.length} affected project(s):`);
    for (const id of projects) console.log(`  ${id}`);
    console.log('');
    if (!APPLY && !PROJECT_UUID) {
      console.log('(re-run with --apply to clean them all, or with a specific UUID to inspect)');
      return;
    }
  }
  if (PROJECT_UUID) projects = [PROJECT_UUID];

  if (!APPLY) console.log('--- DRY RUN (pass --apply to actually write changes) ---\n');

  for (const projectId of projects) {
    console.log(`Project ${projectId}`);
    const touched = await processProject(projectId, { apply: APPLY });
    if (APPLY) console.log(`  -> ${touched} file(s) cleaned\n`);
    else console.log('');
  }
}

main()
  .catch((err) => {
    console.error('reset-yjs-project: fatal:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
