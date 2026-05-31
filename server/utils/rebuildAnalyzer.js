// Per-project rebuild explainer. After each successful compile we record a
// manifest of which input files were used and their SHA-256 hashes. On the
// next compile we diff old-vs-new and tell the user "rebuilt because A
// changed, B was added." Pairs with the per-phase profile so the console
// answers both *why* a build happened and *where* it spent its time.
//
// The manifest lives next to the .aux/.log/.pdf at
//   <projectDir>/<jobName>.flowtex-build-manifest.json
// The leading dot is unnecessary: this dir is a server-only workspace,
// never part of the user's file tree (which is DB-driven) and never
// shipped in export-zip (which packages DB rows). Per-jobname so
// concurrent compiles by different users don't race.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

const MANIFEST_SUFFIX = '.flowtex-build-manifest.json';

/** Parse a recorder .fls file and return the set of INPUT paths that live
 *  inside the project dir. We deliberately ignore system inputs (TeX Live
 *  packages, fonts) — those rarely change and would dominate the manifest.
 *  OUTPUT entries are ignored too: they're artefacts we're producing, not
 *  things that triggered the build.
 *
 *  Returns an array of relative paths (relative to projectDir), deduped.
 */
export function parseFlsInputs(flsContent, projectDir) {
  if (!flsContent) return [];
  const seen = new Set();
  const out = [];
  const normalisedRoot = path.resolve(projectDir);
  for (const rawLine of flsContent.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('INPUT ')) continue;
    const absOrRel = line.slice('INPUT '.length).trim();
    // pdflatex emits absolute paths after `PWD` line; some entries are
    // relative to PWD (which is projectDir). Resolve and bound-check.
    const abs = path.resolve(projectDir, absOrRel);
    if (!abs.startsWith(normalisedRoot + path.sep) && abs !== normalisedRoot) continue;
    const rel = path.relative(normalisedRoot, abs);
    // Skip our own bookkeeping artefacts so the manifest can't trigger
    // itself ("rebuilt because manifest changed" is meaningless).
    if (rel.endsWith(MANIFEST_SUFFIX)) continue;
    if (rel.endsWith('.profile.jsonl')) continue;
    // Skip latexmk's intermediate outputs that pdflatex re-reads on the
    // next pass (.aux, .toc, .out, .bbl, .lof, .lot, .idx, .ind, …) —
    // these change on every compile and would create misleading "rebuilt
    // because .aux changed" messages.
    if (/\.(aux|toc|out|bbl|blg|lof|lot|idx|ind|ilg|gls|glo|glg|nav|snm|vrb|synctex(\.gz)?|fls|fdb_latexmk|log)$/i.test(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** Hash a file's contents (SHA-256). Returns null if the file can't be
 *  read so the caller can decide whether to treat that as "removed." */
export async function hashFile(absPath) {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) return null;
    const buf = await fsp.readFile(absPath);
    return {
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  } catch {
    return null;
  }
}

/** Build a manifest object {path -> {size, mtimeMs, sha256}} for the
 *  given list of relative paths under projectDir. Files we can't hash
 *  are skipped (they'll surface as "removed" against the next manifest).
 *
 *  `env` captures the build environment (engine + tex distribution) so
 *  the skip-rebuild cache invalidates when the user switches compilers
 *  — the same source can produce a different PDF under xelatex vs
 *  pdflatex, so a stale PDF must not be served. */
export async function buildManifest(projectDir, relativePaths, env = null) {
  const entries = await Promise.all(
    relativePaths.map(async (rel) => {
      const meta = await hashFile(path.join(projectDir, rel));
      return meta ? [rel, meta] : null;
    }),
  );
  const files = {};
  for (const e of entries) if (e) files[e[0]] = e[1];
  return {
    version: 1,
    builtAt: Date.now(),
    env: env ? { compiler: env.compiler ?? null, texDistribution: env.texDistribution ?? null } : null,
    files,
  };
}

export function manifestPath(projectDir, jobName) {
  return path.join(projectDir, `${jobName}${MANIFEST_SUFFIX}`);
}

/** Read a previously-stored manifest. Returns null on any error
 *  (missing file, corrupt JSON) — the caller treats null as "no
 *  previous build to compare against." */
export function readManifest(projectDir, jobName) {
  try {
    const raw = fs.readFileSync(manifestPath(projectDir, jobName), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !parsed?.files) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomically replace the on-disk manifest with `manifest`. Writes to a
 *  sibling .tmp then renames so a crashed write never leaves a half-file
 *  that readManifest would silently throw away. */
export async function writeManifest(projectDir, jobName, manifest) {
  const target = manifestPath(projectDir, jobName);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest));
  await fsp.rename(tmp, target);
}

/** Diff two manifests. Returns the per-file change list — added /
 *  modified / removed — that goes into the user-facing explanation. */
export function diffManifests(prev, next) {
  const changes = [];
  const prevFiles = prev?.files || {};
  const nextFiles = next?.files || {};
  const allPaths = new Set([...Object.keys(prevFiles), ...Object.keys(nextFiles)]);
  for (const p of allPaths) {
    const a = prevFiles[p];
    const b = nextFiles[p];
    if (!a && b) changes.push({ path: p, change: 'added' });
    else if (a && !b) changes.push({ path: p, change: 'removed' });
    else if (a && b && a.sha256 !== b.sha256) changes.push({ path: p, change: 'modified' });
  }
  // Stable order: alphabetical within change type.
  const rank = { modified: 0, added: 1, removed: 2 };
  changes.sort((x, y) => (rank[x.change] - rank[y.change]) || x.path.localeCompare(y.path));
  return changes;
}

/** Scan the final .log for messages that explain why latexmk had to
 *  re-run pdflatex (or will need to next time). Returns a short
 *  human-readable reason or null if no rerun signal was found.
 *
 *  We look at the LAST occurrence — if an earlier pass complained but
 *  the final pass didn't, the build is stable and there's nothing to
 *  surface. The patterns mirror what latexmk itself watches for. */
export function detectRerunSignals(logContent) {
  if (!logContent) return null;
  const patterns = [
    [/Label\(s\) may have changed\./i,                        'cross-references resolved on rerun'],
    [/Rerun to get cross-references right\./i,                'cross-references resolved on rerun'],
    [/Rerun to get citations correct\./i,                     'citations resolved on rerun'],
    [/Rerun to get outlines right/i,                          'PDF outline updated on rerun'],
    [/Citation .* on page \d+ undefined/i,                    'undefined citations'],
    [/Reference .* on page \d+ undefined/i,                   'undefined references'],
    [/No file .*\.bbl\./i,                                    'bibliography produced on first run'],
    [/Package rerunfilecheck Warning: File .* has changed/i,  'rerunfilecheck detected changes'],
  ];
  // Walk in reverse line order so we see the FINAL-pass warnings first.
  const lines = logContent.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    for (const [pat, reason] of patterns) {
      if (pat.test(lines[i])) return reason;
    }
  }
  return null;
}

/** When every .bib file the previous build saw still hashes the same now,
 *  return the path to the previous build's .bbl so the caller can `touch`
 *  it to be newer than the .bib files. That neutralises latexmk's
 *  mtime-only "input newer than output" check on bibliographies — which
 *  is exactly the path that mis-fires when something bumps a .bib's
 *  mtime without changing content (git checkout, editor save with no
 *  edits, GitHub sync). Returns null if any bib changed (let latexmk
 *  run biber normally) or no .bbl exists yet (first build).
 *
 *  Safety: latexmk separately re-runs biber when pdflatex generates an
 *  .aux/.bcf with a new \cite key, regardless of mtimes. So pre-touching
 *  the .bbl is safe in the case of "user added a new citation" — biber
 *  will still run because of the content check, not the mtime check.
 *  The pre-touch only wins when nothing biber would care about changed.
 *
 *  Sibling case for makeindex/glossaries is harder: .idx and .glo are
 *  themselves generated by pdflatex during pass 1, so we can't decide
 *  pre-latexmk whether they will or won't change. Left for a later
 *  pass if biographies prove the touch-trick worth extending. */
export async function findStaleBibOutputToTouch({ projectDir, jobName }) {
  const prev = readManifest(projectDir, jobName);
  if (!prev) return null;
  const prevBibs = Object.entries(prev.files).filter(([p]) => /\.bib$/i.test(p));
  if (prevBibs.length === 0) return null;
  for (const [rel, meta] of prevBibs) {
    const now = await hashFile(path.join(projectDir, rel));
    if (!now || now.sha256 !== meta.sha256) return null;
  }
  const bblPath = path.join(projectDir, `${jobName}.bbl`);
  try {
    await fsp.access(bblPath);
    return bblPath;
  } catch {
    return null;
  }
}

/** Decide whether the previous build's PDF can be served as-is without
 *  invoking latexmk. Hits ONLY when every file the previous build read
 *  still hashes the same now AND the build environment (engine, tex
 *  distribution) is unchanged.
 *
 *  Returns `{ hit: true }` or `{ hit: false, reason, changedFiles? }`.
 *  `changedFiles` reuses the diffManifests shape so the UI can render
 *  cache misses with the same component as a real rebuild.
 *
 *  Performance: hashing is bounded by the number of files in the prev
 *  manifest, not the entire project — typically a few tens of KB.
 *  Caller is responsible for verifying the PDF still exists on disk
 *  before serving it (a manual `clean` could have removed it). */
export async function checkBuildCache({ projectDir, jobName, compiler, texDistribution }) {
  const prev = readManifest(projectDir, jobName);
  if (!prev) return { hit: false, reason: 'no previous build manifest' };

  const prevEnv = prev.env || {};
  const wantCompiler = compiler ?? null;
  const wantTex = texDistribution ?? null;
  if (prevEnv.compiler !== wantCompiler || prevEnv.texDistribution !== wantTex) {
    return { hit: false, reason: 'compiler or tex distribution changed' };
  }

  const paths = Object.keys(prev.files);
  if (paths.length === 0) {
    // Empty manifest: nothing to verify; safer to recompile.
    return { hit: false, reason: 'previous manifest had no tracked inputs' };
  }
  const current = await buildManifest(projectDir, paths, { compiler: wantCompiler, texDistribution: wantTex });
  const changes = diffManifests(prev, current);
  if (changes.length > 0) {
    return { hit: false, reason: 'inputs changed', changedFiles: changes };
  }
  return { hit: true };
}

/** End-to-end: read .fls, build new manifest, compare to prev manifest,
 *  parse log warnings, persist the new manifest. Returns the structured
 *  rebuildReason that the route forwards to the client. */
export async function analyzeRebuild({ projectDir, jobName, logContent, env = null }) {
  const flsPath = path.join(projectDir, `${jobName}.fls`);
  let flsContent = '';
  try { flsContent = await fsp.readFile(flsPath, 'utf-8'); } catch { /* no recorder file */ }
  const inputs = parseFlsInputs(flsContent, projectDir);

  const prev = readManifest(projectDir, jobName);
  const next = await buildManifest(projectDir, inputs, env);

  // Persist for the next compile. Failure here is non-fatal — at worst
  // the next compile sees "initial build."
  try { await writeManifest(projectDir, jobName, next); } catch { /* best-effort */ }

  const rerunReason = detectRerunSignals(logContent);

  if (!prev) {
    return {
      kind: 'initial',
      message: 'First tracked build for this project — nothing to compare against yet.',
      changedFiles: [],
      rerunReason,
    };
  }

  const changes = diffManifests(prev, next);
  return {
    kind: changes.length > 0 ? 'changed' : 'unchanged',
    message:
      changes.length === 0
        ? 'No tracked input files changed since the last build.'
        : `Rebuilt because ${changes.length} input file${changes.length === 1 ? '' : 's'} changed.`,
    changedFiles: changes,
    rerunReason,
  };
}
