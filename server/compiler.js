import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import db from './db.js';
import logger from './logger.js';
import { analyzeRebuild, checkBuildCache, findStaleBibOutputToTouch } from './utils/rebuildAnalyzer.js';
import { loadFileBytes } from './services/fileBytes.js';
import {
  isDockerSandboxEnabled,
  runDockerCompile,
} from './services/dockerCompileSandbox.js';
import { withSpan } from './tracing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { PROJECTS_DIR } from './paths.js';
export { PROJECTS_DIR };
const PROFILE_WRAPPER_PATH = path.join(__dirname, 'utils', 'compileProfileWrapper.mjs');

/** Build the latexmk `-e '$tool = q[…]'` overrides that route each phase
 *  through the profile wrapper. The wrapper exec's the real tool, so
 *  semantics are unchanged — it just adds a stopwatch + appends a JSON
 *  line per invocation.
 *
 *  Uses Perl's q[…] string delimiter (square brackets) so single quotes
 *  inside the wrapped command — which we use to shell-quote paths — don't
 *  need further escaping. The wrapper and profile paths are
 *  server-controlled and never contain `[`/`]`.
 */
function profileLatexmkOverrides({ profilePath, compiler }) {
  // LuaLaTeX needs --safer to seal the Lua os/io libs against directlua
  // escapes — the existing pre-profile path appended it via $lualatex
  // override; we keep that flag here. pdflatex and xelatex have no
  // embedded scripting language and are sealed by --no-shell-escape alone.
  const luaExtra = compiler === 'lualatex' ? ' --safer' : '';
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote
  const wrapped = (tool, realCmd) =>
    `${shq(process.execPath)} ${shq(PROFILE_WRAPPER_PATH)} --tool=${tool} --profile=${shq(profilePath)} -- ${realCmd}`;

  const overrides = [
    ['$pdflatex',  wrapped('pdflatex',  'pdflatex %O %S')],
    ['$xelatex',   wrapped('xelatex',   'xelatex %O %S')],
    ['$lualatex',  wrapped('lualatex',  `lualatex${luaExtra} %O %S`)],
    ['$bibtex',    wrapped('bibtex',    'bibtex %O %S')],
    ['$biber',     wrapped('biber',     'biber %O %S')],
    ['$makeindex', wrapped('makeindex', 'makeindex %O %S')],
  ];
  const args = [];
  for (const [varName, cmd] of overrides) {
    if (cmd.includes('[') || cmd.includes(']')) {
      // Fail-safe: square brackets would break Perl's q[…] delimiter.
      // The server-controlled paths never contain them, but assert anyway.
      throw new Error(`compileProfileWrapper: refusing override containing [ or ] for ${varName}`);
    }
    args.push('-e', `${varName} = q[${cmd}]`);
  }
  return args;
}

/** Parse the JSONL profile file produced by compileProfileWrapper.mjs into
 *  a phase breakdown: total time, per-tool sums + invocation counts. Returns
 *  null if the file is missing or every line is malformed — callers should
 *  treat absence as "profiling disabled," not as a compile failure. */
function readCompileProfile(profilePath) {
  let raw;
  try {
    raw = fs.readFileSync(profilePath, 'utf-8');
  } catch {
    return null;
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.tool === 'string' && typeof r.durationMs === 'number') {
        records.push(r);
      }
    } catch { /* skip malformed lines */ }
  }
  if (records.length === 0) return null;
  const phases = new Map();
  let totalMs = 0;
  for (const r of records) {
    const cur = phases.get(r.tool) || { tool: r.tool, count: 0, durationMs: 0 };
    cur.count += 1;
    cur.durationMs += r.durationMs;
    phases.set(r.tool, cur);
    totalMs += r.durationMs;
  }
  const phaseList = [...phases.values()]
    .sort((a, b) => b.durationMs - a.durationMs)
    .map((p) => ({ ...p, percent: totalMs > 0 ? Math.round((p.durationMs / totalMs) * 100) : 0 }));
  return { totalMs, phases: phaseList };
}

// Detect prlimit (util-linux) so we can wrap LaTeX compilation in
// hard resource caps on Linux. The container already enforces caps
// via cgroups; this layer protects bare-metal Linux installs from a
// pathological .tex eating all memory or producing a 50GB output.
// Defaults: 2GB virtual memory, CPU = timeout + 10s, 100MB max output
// file write, 64 subprocesses (latexmk + pdflatex passes + helpers).
// Tunables via env. macOS / non-Linux skip prlimit (it doesn't exist
// there); operators on those platforms must enforce limits another way
// or use the Docker deployment path.
const PRLIMIT_PATH = (() => {
  if (process.platform !== 'linux') return null;
  try {
    const out = execFileSync('which', ['prlimit'], { encoding: 'utf-8' }).trim();
    return out || null;
  } catch {
    return null;
  }
})();
const COMPILE_RLIMIT_AS = Number(process.env.COMPILE_RLIMIT_AS_BYTES || 2 * 1024 * 1024 * 1024);
const COMPILE_RLIMIT_FSIZE = Number(process.env.COMPILE_RLIMIT_FSIZE_BYTES || 100 * 1024 * 1024);
const COMPILE_RLIMIT_NPROC = Number(process.env.COMPILE_RLIMIT_NPROC || 64);
if (process.platform === 'linux' && !PRLIMIT_PATH) {
  logger.warn(
    '[compiler] prlimit not found on PATH — LaTeX compiles will run without resource limits. ' +
      'Install util-linux (apt install util-linux) or use the Docker deployment to enforce caps.',
  );
}

// Compile timeout in ms — cached from DB, refreshed every 30s
let _compileTimeoutMs = 120000;
let _lastTimeoutFetch = 0;

/** Fetch the compile timeout (in ms) from DB settings, cached for 30s. */
async function getCompileTimeout() {
  const now = Date.now();
  if (now - _lastTimeoutFetch > 30000) {
    try {
      const row = await db.get("SELECT value FROM settings WHERE key = 'compile_timeout'");
      if (row) _compileTimeoutMs = parseInt(row.value) * 1000 || 120000;
    } catch {
      /* use cached value */
    }
    _lastTimeoutFetch = now;
  }
  return _compileTimeoutMs;
}

// Common non-TeX-Live paths that are always included
const COMMON_PATHS = ['/opt/local/bin', '/usr/local/bin', '/usr/bin'];

// Build a PATH that includes common TeX Live locations (default, all distributions)
export const TEX_PATHS = [
  '/Library/TeX/texbin',
  '/usr/local/texlive/2025/bin/universal-darwin',
  '/usr/local/texlive/2024/bin/universal-darwin',
  '/usr/local/texlive/2025/bin/x86_64-darwin',
  '/usr/local/texlive/2024/bin/x86_64-darwin',
  ...COMMON_PATHS,
].join(':');

/**
 * Build a PATH for a specific TeX Live distribution year.
 * If distro is null/undefined, returns TEX_PATHS (all distributions).
 */
export function getTexPaths(distro) {
  if (!distro) return TEX_PATHS;
  const year = String(distro);
  if (!/^\d{4}$/.test(year)) return TEX_PATHS; // must be a 4-digit year
  const distPaths = [
    `/usr/local/texlive/${year}/bin/universal-darwin`,
    `/usr/local/texlive/${year}/bin/x86_64-darwin`,
    `/usr/local/texlive/${year}/bin/aarch64-linux`,
    `/usr/local/texlive/${year}/bin/x86_64-linux`,
  ].filter((p) => fs.existsSync(p));
  if (distPaths.length === 0) return TEX_PATHS; // fallback
  return [...distPaths, ...COMMON_PATHS].join(':');
}

/**
 * Detect installed TeX Live distributions by scanning /usr/local/texlive/
 * Returns array of { year, path, version } sorted newest first.
 */
let _cachedDistros = null;
let _distrosCacheTime = 0;

export function detectTexDistributions() {
  const now = Date.now();
  if (_cachedDistros && now - _distrosCacheTime < 60000) return _cachedDistros;

  const distros = [];
  const base = '/usr/local/texlive';
  try {
    const entries = fs.readdirSync(base);
    for (const entry of entries) {
      const year = parseInt(entry);
      if (isNaN(year) || year < 2000) continue;
      const dir = path.join(base, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      // Find the bin directory
      const binDir = path.join(dir, 'bin');
      if (!fs.existsSync(binDir)) continue;
      const archs = fs.readdirSync(binDir).filter((a) => fs.existsSync(path.join(binDir, a, 'pdflatex')));
      if (archs.length === 0) continue;
      // Get version from pdflatex
      let version = `TeX Live ${year}`;
      try {
        const out = execFileSync(path.join(binDir, archs[0], 'pdflatex'), ['--version'], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        const m = out.match(/pdfTeX[^,]*, Version [^\n]+/);
        if (m) version = m[0];
      } catch {}
      distros.push({ year, path: path.join(binDir, archs[0]), version });
    }
  } catch {}
  distros.sort((a, b) => b.year - a.year);
  _cachedDistros = distros;
  _distrosCacheTime = now;
  return distros;
}

// Track active compilations so they can be stopped
const activeCompilations = new Map();
const MAX_CONCURRENT_COMPILES = parseInt(process.env.MAX_CONCURRENT_COMPILES || '10', 10);

// Compilation metrics
export const compileMetrics = {
  total: 0,
  success: 0,
  failed: 0,
  active: 0,
  history: [], // last 300 entries: { time, duration, success }
};

// Periodic sanity check: if active counter drifts above the actual number of
// tracked child processes, reset it. This prevents permanent lockout from leaked counters.
setInterval(() => {
  const actual = activeCompilations.size;
  if (compileMetrics.active > actual) {
    compileMetrics.active = actual;
  }
}, 30000).unref();

/** Record a compilation result in the metrics history ring buffer. */
function recordCompile(success, duration) {
  compileMetrics.total++;
  if (success) compileMetrics.success++;
  else compileMetrics.failed++;
  compileMetrics.history.push({ time: Date.now(), duration, success });
  if (compileMetrics.history.length > 300) compileMetrics.history.shift();
}

/**
 * Validate and sanitize a file path to prevent path traversal.
 * Returns the safe absolute path or throws.
 */
function safePath(projectDir, filePath) {
  // Reject null bytes, absolute paths
  if (filePath.includes('\0') || path.isAbsolute(filePath)) {
    throw new Error(`Invalid file path: ${filePath}`);
  }
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

/**
 * Kill a running compilation for the given project.
 * @param {string} projectId
 * @returns {Promise<void|false>} Resolves when the process exits, or false if none was active.
 */
export function stopCompilation(projectId) {
  const entry = activeCompilations.get(projectId);
  if (!entry) return Promise.resolve(false);
  // Docker-path compiles store child: null because runDockerCompile
  // tracks the docker-CLI subprocess internally (and its own
  // timeoutMs is the kill signal). The route was calling
  // .kill on a null and throwing TypeError ("Cannot read
  // properties of null (reading 'kill')"). Be defensive.
  if (entry.child && typeof entry.child.kill === 'function') {
    try { entry.child.kill('SIGTERM'); } catch { /* already dead */ }
  }
  activeCompilations.delete(projectId);
  // Return a promise that resolves when the process actually exits
  return entry.exitPromise;
}

/**
 * Abort every in-flight compilation. Used by the graceful-shutdown path
 * in `server/index.js` so SIGTERM doesn't leave orphan latexmk children
 * blocking on the dead parent's stdio. Each child gets SIGTERM, then we
 * wait up to `timeoutMs` for the process to actually exit.
 *
 * @param {number} [timeoutMs=2000] - Per-child grace period before we stop awaiting.
 * @returns {Promise<number>} Number of compilations that were active when called.
 */
export async function abortAllCompilations(timeoutMs = 2000) {
  const entries = Array.from(activeCompilations.values());
  for (const entry of entries) {
    // Same null-guard as stopCompilation: Docker-path entries don't
    // have a host-side child handle.
    if (entry.child && typeof entry.child.kill === 'function') {
      try { entry.child.kill('SIGTERM'); } catch { /* already dead */ }
    }
  }
  activeCompilations.clear();
  await Promise.all(
    entries.map((entry) =>
      Promise.race([
        entry.exitPromise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]),
    ),
  );
  return entries.length;
}

/**
 * Each user gets a unique jobname so concurrent compilations don't collide.
 * The suffix flows into latexmk's `-jobname` argument and into filesystem
 * paths, so it is hex-only — anything outside [a-fA-F0-9] is dropped before
 * truncation. Returns `''` when the input is falsy or has no usable chars.
 *
 * `opts.tc` (boolean): append a `_tc` tag so the tracked-changes view
 * keeps its own .pdf / .aux / .log / .flowtex-build-manifest.json
 * separate from the plain view. Lets the client toggle "show tracked
 * changes" without invalidating the plain PDF (each mode's skip-rebuild
 * cache is also per-mode for free).
 */
export function userSuffix(userId, opts = {}) {
  const tcTag = opts.tc ? '_tc' : '';
  if (!userId) return tcTag;
  const safe = String(userId).replace(/[^a-fA-F0-9]/g, '').slice(0, 8);
  return (safe ? '_' + safe : '') + tcTag;
}

// Supported compilers and their latexmk flags
export const COMPILERS = [
  { id: 'pdflatex', name: 'pdfLaTeX', flag: '-pdf' },
  { id: 'xelatex', name: 'XeLaTeX', flag: '-xelatex' },
  { id: 'lualatex', name: 'LuaLaTeX', flag: '-lualatex' },
];

/**
 * Compile a LaTeX project, syncing files to disk first.
 * @param {string} projectId
 * @param {string} mainFile - Entry .tex file (default 'main.tex').
 * @param {Function|null} onOutput - Callback for streaming stdout/stderr chunks.
 * @param {object} [opts] - Extra options: files, onBeforeCompile, userId, texDistribution, compiler.
 * @returns {Promise<{pdfPath: string, log: string, jobName: string}>}
 */
export async function compileProject(projectId, mainFile = 'main.tex', onOutput, opts = {}) {
  // SAAS-FOUNDATIONS item 5: wrap the whole compile in a trace span
  // so auto-instrumented work it triggers (pg queries for tc_marks,
  // ioredis for cache hits, child_process for latexmk, docker CLI
  // when sandboxed) becomes child spans under one named parent. The
  // span carries enough attributes that an outlier in the compile
  // duration histogram can be drilled to the project + engine that
  // hit it without paging through the raw log.
  return withSpan('compile.project', async (span) => {
    span.setAttribute('flowtex.project_id', projectId);
    span.setAttribute('flowtex.main_file', mainFile);
    span.setAttribute('flowtex.compiler', opts.compiler || 'pdflatex');
    span.setAttribute('flowtex.tracked_changes', !!opts.tc);
    span.setAttribute('flowtex.sandbox', isDockerSandboxEnabled() ? 'docker' : 'host');
    return _compileProjectInner(projectId, mainFile, onOutput, opts, span);
  });
}

async function _compileProjectInner(
  projectId,
  mainFile,
  onOutput,
  { files, onBeforeCompile, userId, texDistribution, compiler, tc = false } = {},
  _parentSpan,
) {
  // Sync files to disk before compiling
  if (files) {
    await syncFilesToDisk(projectId, files);

    // Warn about binary files with no underlying blob (e.g. failed GitHub
    // imports, or rows from before the per-file blob migration that were
    // never re-uploaded). Post-Phase-C.3 the bytes live on disk via
    // binary_sha256; an is_binary row WITHOUT a sha is the "broken
    // import" case the warning is meant to flag. Pre-C.3 this filter
    // was `!f.content || f.content.length === 0`, which post-migration
    // matches EVERY binary (content is always '') and produced a
    // false-positive warning in every compile log.
    const emptyBinaries = files.filter((f) => f.is_binary && !f.binary_sha256);
    if (emptyBinaries.length > 0) {
      const names = emptyBinaries.map((f) => f.path).join(', ');
      const msg = `Warning: ${emptyBinaries.length} binary file(s) are empty and may cause compilation to fail: ${names}\n` +
        'These files may not have been imported correctly. Try re-importing or uploading them manually.\n\n';
      if (onOutput) onOutput(msg);
    }
  }
  // Skip-rebuild cache: if the previous build's manifest still matches
  // every input on disk (and the engine/distribution are unchanged), we
  // can serve the previous PDF directly without invoking latexmk. Cheap
  // and decisive — "compile button mash with no edits" goes from seconds
  // to milliseconds. Failure inside the check is non-fatal: we fall
  // through to a normal compile.
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const suffix = userSuffix(userId, { tc });
  const jobName = mainFile.replace(/\.tex$/, '') + suffix;
  const pdfPath = path.join(projectDir, `${jobName}.pdf`);
  try {
    const cacheCheck = await checkBuildCache({
      projectDir,
      jobName,
      compiler: compiler || null,
      texDistribution: texDistribution || null,
    });
    if (cacheCheck.hit && fs.existsSync(pdfPath)) {
      if (onBeforeCompile) await onBeforeCompile();
      if (onOutput) {
        onOutput(`Cache hit — no tracked inputs changed since the last build. Reused PDF.\n`);
      }
      return {
        pdfPath,
        log: '',
        jobName,
        cached: true,
        profile: null,
        rebuildReason: {
          kind: 'cached',
          message: 'No tracked inputs changed since the last build.',
          changedFiles: [],
          rerunReason: null,
        },
      };
    }
  } catch (err) {
    logger.warn({ err, jobName }, 'checkBuildCache failed; falling through to a normal compile');
  }

  if (onBeforeCompile) {
    await onBeforeCompile();
  }

  // Cache missed (something changed) but if NONE of the .bib files
  // changed since the last successful build, pre-touch the existing
  // .bbl so latexmk's mtime check decides biber is up-to-date. Saves
  // the biber re-run in the common "edited a .tex file, didn't touch
  // citations" case where git or an editor previously bumped the .bib
  // mtime. Failure is non-fatal — biber just runs as usual.
  try {
    const bblToTouch = await findStaleBibOutputToTouch({ projectDir, jobName });
    if (bblToTouch) {
      const now = new Date();
      await fsp.utimes(bblToTouch, now, now);
    }
  } catch (err) {
    logger.warn({ err, jobName }, 'findStaleBibOutputToTouch failed; biber will run normally');
  }

  const timeoutMs = await getCompileTimeout();

  return _doCompile(projectId, mainFile, onOutput, suffix, timeoutMs, texDistribution, compiler);
}

/** Internal: spawn latexmk and return a promise for the compilation result. */
async function _doCompile(
  projectId,
  mainFile,
  onOutput,
  userSuffix = '',
  timeoutMs = 120000,
  texDistribution = null,
  compiler = null,
) {
  // If there's already an active compilation for this project, kill it and wait
  const existing = activeCompilations.get(projectId);
  if (existing) {
    try { existing.child.kill('SIGTERM'); } catch {}
    activeCompilations.delete(projectId);
    // Wait for exit but with a timeout — never hang forever
    await Promise.race([
      existing.exitPromise.catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    // Small delay to let the OS release file locks
    await new Promise((r) => setTimeout(r, 200));
  }

  return new Promise((resolve, reject) => {
    if (compileMetrics.active >= MAX_CONCURRENT_COMPILES) {
      return reject(new Error('Server busy — too many concurrent compilations. Please try again in a moment.'));
    }

    const projectDir = path.join(PROJECTS_DIR, projectId);

    // Validate mainFile path
    let texFile;
    try {
      texFile = safePath(projectDir, mainFile);
    } catch (err) {
      return reject(err);
    }

    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    if (!fs.existsSync(texFile)) {
      return reject(new Error(`File not found: ${mainFile}`));
    }

    // Use a per-user jobname so concurrent compilations produce separate
    // intermediate files (main_ab12cd34.aux, .log, .pdf, etc.)
    const baseName = mainFile.replace(/\.tex$/, '');
    const jobName = baseName + userSuffix;

    const env = {
      ...process.env,
      PATH: getTexPaths(texDistribution) + ':' + (process.env.PATH || ''),
      // Restrict LaTeX file I/O to prevent reading arbitrary server files
      openin_any: 'p', // only open files in the current directory or below
      openout_any: 'p', // only write files in the current directory or below
    };

    let resolveExit;
    const exitPromise = new Promise((r) => {
      resolveExit = r;
    });

    compileMetrics.active++;
    const compileStartTime = Date.now();
    let callbackFired = false;

    // Safety: if the callback never fires (e.g. execFile throws), decrement active
    // after timeout + 10s grace period to prevent permanent counter leak.
    const safetyTimer = setTimeout(() => {
      if (!callbackFired) {
        callbackFired = true;
        activeCompilations.delete(projectId);
        compileMetrics.active = Math.max(0, compileMetrics.active - 1);
        resolveExit();
        reject(new Error('Compilation timed out (safety fallback)'));
      }
    }, timeoutMs + 10000);
    safetyTimer.unref();

    // Determine the latexmk engine flag based on the selected compiler
    const compilerEntry = COMPILERS.find((c) => c.id === compiler);
    const engineFlag = compilerEntry ? compilerEntry.flag : '-pdf';

    // Per-phase profile: latexmk's $pdflatex / $bibtex / $biber / $makeindex
    // / engine command strings are overridden to invoke a wrapper that
    // stopwatches each phase and appends a JSON line to this file. After
    // latexmk exits we parse it to produce a phase breakdown. Best-effort
    // — if any record is malformed or the file is absent the compile
    // result simply lacks a profile.
    const profilePath = path.join(projectDir, `${jobName}.profile.jsonl`);
    try { fs.unlinkSync(profilePath); } catch { /* fine: fresh job */ }

    let child;
    try {
      const profileOverrides = profileLatexmkOverrides({
        profilePath,
        compiler,
      });
      const latexmkArgs = [
        engineFlag,
        '-synctex=1',
        '-interaction=nonstopmode',
        '-f',
        '--no-shell-escape',
        '-recorder', // emit <jobname>.fls listing every input/output for the rebuild explainer
        '-e', '$max_repeat=4',
        ...profileOverrides,
        `-jobname=${jobName}`,
        `-output-directory=${projectDir}`,
        // JJ1 (audit round 21) HAD added `--` here as a belt-and-
        // braces against argument injection through filenames
        // starting with `-`. Removed because every shipping
        // latexmk version (at least up to 4.87) treats `--` as
        // "unknown option" -- it's NOT a getopt-style terminator
        // for this program, despite the convention elsewhere. The
        // authoritative guard against the original JJ1 threat is
        // `isValidFilePath` in services/projectService.js, which
        // rejects path segments starting with `-` so the file
        // can't even land in a project. The remap shim in the
        // Docker sandbox path drops `--` for the same reason
        // (latexmk 4.79 in Bookworm), so this change keeps the two
        // paths consistent.
        mainFile,
      ];
      // On Linux with prlimit available, wrap the invocation in
      // address-space, file-size, CPU-time, and process-count caps.
      // CPU time is set slightly above the JS timeout so the kernel
      // never beats us to the punch on a normal compile.
      const cpuLimitSec = Math.ceil(timeoutMs / 1000) + 10;
      const exe = PRLIMIT_PATH ? PRLIMIT_PATH : 'latexmk';
      const args = PRLIMIT_PATH
        ? [
            `--as=${COMPILE_RLIMIT_AS}`,
            `--fsize=${COMPILE_RLIMIT_FSIZE}`,
            `--cpu=${cpuLimitSec}`,
            `--nproc=${COMPILE_RLIMIT_NPROC}`,
            'latexmk',
            ...latexmkArgs,
          ]
        : latexmkArgs;
      // SAAS-FOUNDATIONS item 1 (phase 1.5): the on-exit handling is
      // the same regardless of whether the spawn was a host-side
      // execFile or a Docker sibling-container run. Name it once so
      // both spawn paths route into the same callback shape.
      const onCompilerExit = (error, stdout, stderr) => {
          if (callbackFired) return; // safety timer already fired
          callbackFired = true;
          clearTimeout(safetyTimer);
          activeCompilations.delete(projectId);
          compileMetrics.active = Math.max(0, compileMetrics.active - 1);
          const duration = Date.now() - compileStartTime;
          resolveExit();
        const pdfName = jobName + '.pdf';
        const pdfPath = path.join(projectDir, pdfName);

        // Read the .log file from the final pdflatex pass (not the full latexmk stdout
        // which contains output from all passes including early ones with unresolved refs)
        const logPath = path.join(projectDir, jobName + '.log');
        let finalLog = '';
        try {
          finalLog = fs.readFileSync(logPath, 'utf-8');
        } catch {
          finalLog = stdout;
        }

        const profile = readCompileProfile(profilePath);
        // The profile file lives in the project dir alongside .aux/.log;
        // remove it now so the next compile starts clean and the user's
        // file listing isn't polluted with build artefacts.
        try { fs.unlinkSync(profilePath); } catch { /* ignore */ }

        if (error?.killed || error?.signal === 'SIGTERM') {
          recordCompile(false, duration);
          if (fatalError) {
            reject(new Error(finalLog || fatalError));
          } else {
            reject(new Error('Compilation stopped by user'));
          }
        } else if (fs.existsSync(pdfPath)) {
          recordCompile(true, duration);
          // Only run the rebuild analyzer on success — a failed build
          // shouldn't poison the manifest we compare against next time.
          // Failure inside the analyzer is non-fatal: the compile result
          // simply lacks rebuildReason. env is stored in the manifest so
          // the skip-rebuild cache invalidates when the engine changes.
          analyzeRebuild({
            projectDir,
            jobName,
            logContent: finalLog,
            env: { compiler: compiler || null, texDistribution: texDistribution || null },
          })
            .then((rebuildReason) => {
              resolve({ pdfPath, log: finalLog, jobName, profile, rebuildReason });
            })
            .catch((err) => {
              logger.warn({ err, jobName }, 'rebuildAnalyzer failed; returning compile result without reason');
              resolve({ pdfPath, log: finalLog, jobName, profile });
            });
        } else {
          recordCompile(false, duration);
          reject(new Error(finalLog || stdout || stderr || 'Compilation failed'));
        }
      };

      if (isDockerSandboxEnabled()) {
        // SAAS-FOUNDATIONS item 1: Docker sibling-container path.
        // The compile-sandbox image runs latexmk as PID 1 inside a
        // network-less, read-only, capability-stripped container
        // with memory/cpu/pids caps. This is the only safe model
        // for untrusted multi-tenant compilation; the
        // host-execFile-with-prlimit path is fine for self-hosted
        // groups where all users are trusted, but a host-level
        // TeX exploit would otherwise own the VPS.
        //
        // Differences vs the execFile path:
        //   - No `child` handle is set, so the fatal-pattern early-
        //     kill below is a no-op. The container's own caps
        //     (cpu / memory / pids / --stop-timeout) are the kill
        //     mechanism instead.
        //   - `activeCompilations.set` runs without the child --
        //     just enough to satisfy the count + the exit promise.
        //   - On Docker-side failures (daemon unreachable, image
        //     missing, etc.) runDockerCompile rejects; we surface
        //     it to onCompilerExit as a regular error.
        activeCompilations.set(projectId, { child: null, exitPromise });
        runDockerCompile({
          projectDir,
          latexmkArgs,
          timeoutMs,
          env,
          // Thread the streaming callback through so the SSE
          // compile-stream sees stdout/stderr chunks as they arrive,
          // matching what the host execFile path does via
          // child.stdout.on('data'). Without this the client console
          // sits on the initial "Compiling..." line until the
          // compile finishes -- looks like the compile is hung even
          // when it's running.
          onOutput,
        })
          .then((result) => {
            const error = result.exitCode === 0
              ? null
              : Object.assign(
                  new Error(`compile-sandbox latexmk exited ${result.exitCode}`),
                  { code: result.exitCode, signal: result.signal },
                );
            onCompilerExit(error, result.stdout, result.stderr);
          })
          .catch((err) => onCompilerExit(err, '', ''));
        return;
      }

      child = execFile(
        exe,
        args,
        { cwd: projectDir, timeout: timeoutMs, env, maxBuffer: 10 * 1024 * 1024 },
        onCompilerExit,
      );

    } catch (spawnErr) {
      // execFile failed synchronously (e.g. latexmk not found)
      if (!callbackFired) {
        callbackFired = true;
        clearTimeout(safetyTimer);
        compileMetrics.active = Math.max(0, compileMetrics.active - 1);
        resolveExit();
        return reject(new Error(spawnErr.message || 'Failed to start compiler'));
      }
    }

    activeCompilations.set(projectId, { child, exitPromise });

    // Detect fatal errors in output and kill the process early
    let fatalError = null;
    const fatalPatterns = [
      /!pdfTeX error:.*reading image file failed/i,
      /Fatal error occurred, no output PDF file produced/i,
      /Emergency stop/,
    ];

    const checkFatal = (text) => {
      if (!fatalError && fatalPatterns.some((p) => p.test(text))) {
        fatalError = text.trim();
        child.kill('SIGTERM');
      }
    };

    if (onOutput) {
      child.stdout?.on('data', (data) => {
        const text = data.toString();
        onOutput(text);
        checkFatal(text);
      });
      child.stderr?.on('data', (data) => {
        const text = data.toString();
        onOutput(text);
        checkFatal(text);
      });
    } else {
      child.stdout?.on('data', (data) => checkFatal(data.toString()));
      child.stderr?.on('data', (data) => checkFatal(data.toString()));
    }
  });
}

/**
 * Forward SyncTeX: map an editor position (file, line, column) to a PDF page/position.
 * @returns {{page: number, x: number, y: number, h: number, v: number} | null}
 */
export function synctexForward(
  projectId,
  line,
  column,
  inputFile = 'main.tex',
  mainFile = 'main.tex',
  userSuffix = '',
) {
  const projectDir = path.join(PROJECTS_DIR, projectId);

  // Validate inputFile
  let safeInputFile;
  try {
    safeInputFile = safePath(projectDir, inputFile);
  } catch {
    return null;
  }

  const mainBase = mainFile.replace(/\.tex$/, '');
  const pdfFile = path.join(projectDir, mainBase + userSuffix + '.pdf');

  try {
    const output = execFileSync('synctex', ['view', '-i', `${line}:${column}:${safeInputFile}`, '-o', pdfFile], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const pageMatch = output.match(/Page:(\d+)/);
    const xMatch = output.match(/x:([\d.]+)/);
    const yMatch = output.match(/y:([\d.]+)/);
    const hMatch = output.match(/h:([\d.]+)/);
    const vMatch = output.match(/v:([\d.]+)/);

    if (pageMatch) {
      return {
        page: parseInt(pageMatch[1]),
        x: xMatch ? parseFloat(xMatch[1]) : 0,
        y: yMatch ? parseFloat(yMatch[1]) : 0,
        h: hMatch ? parseFloat(hMatch[1]) : 0,
        v: vMatch ? parseFloat(vMatch[1]) : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Inverse SyncTeX: map a PDF page/position back to an editor file and line.
 * @returns {{line: number, column: number, file: string} | null}
 */
export function synctexInverse(projectId, page, x, y, mainFile = 'main.tex', userSuffix = '') {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  // Validate mainFile to prevent path traversal
  const safeMainFile = safePath(projectDir, mainFile.replace(/\.tex$/, '') + userSuffix + '.pdf');
  const pdfFile = safeMainFile;

  try {
    const output = execFileSync('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfFile}`], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lineMatch = output.match(/Line:(\d+)/);
    const columnMatch = output.match(/Column:(-?\d+)/);
    const inputMatch = output.match(/Input:(.+)/);

    if (lineMatch) {
      let file = inputMatch ? inputMatch[1].trim() : 'main.tex';
      // Make path relative to project dir
      if (file.startsWith(projectDir)) {
        file = file.slice(projectDir.length + 1);
      }
      // Strip leading ./ prefix
      if (file.startsWith('./')) file = file.slice(2);
      return {
        line: parseInt(lineMatch[1]),
        column: Math.max(0, parseInt(columnMatch?.[1] || '0')),
        file,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Cache of content hashes to skip unchanged file writes.
// Key: "projectId:path" → md5 hex digest. Bounded so the map can't
// grow without limit on a long-running instance with many projects.
// Insertion order = age (Map iteration order in V8); we evict the
// oldest when we cross FILE_HASH_CACHE_MAX. 50 000 entries ≈ a few
// MB at typical key/value sizes, plenty for hundreds of active
// projects. Hits don't refresh entry age — the cache only matters
// for "did this file change since I last wrote it", which doesn't
// benefit from LRU touch.
const FILE_HASH_CACHE_MAX = 50_000;
const fileHashCache = new Map();

function setFileHash(key, hash) {
  if (!fileHashCache.has(key) && fileHashCache.size >= FILE_HASH_CACHE_MAX) {
    const oldest = fileHashCache.keys().next().value;
    if (oldest !== undefined) fileHashCache.delete(oldest);
  }
  fileHashCache.set(key, hash);
}

/** Compute an MD5 hex digest of content for change detection. */
function contentHash(content) {
  return createHash('md5').update(content).digest('hex');
}

/** Clear cached hashes for a project (e.g. after git pull overwrites files on disk). */
export function invalidateFileCache(projectId) {
  for (const key of fileHashCache.keys()) {
    if (key.startsWith(projectId + ':')) fileHashCache.delete(key);
  }
}

// Extensions of files generated by LaTeX compilation — should not be synced from DB to disk
export const GENERATED_EXTS = new Set([
  '.aux',
  '.log',
  '.fls',
  '.fdb_latexmk',
  // The skip-rebuild cache file: lives next to .aux/.log; tracked here so
  // a "clean" wipes it too, otherwise a stale manifest would survive a
  // user-initiated clean compile and incorrectly serve the cache next.
  '.flowtex-build-manifest.json',
  '.synctex.gz',
  '.synctex',
  '.bbl',
  '.blg',
  '.out',
  '.toc',
  '.lof',
  '.lot',
  '.nav',
  '.snm',
  '.vrb',
  '.idx',
  '.ind',
  '.ilg',
  '.glo',
  '.gls',
  '.glg',
  '.cb',
  '.cb2',
  '.bcf',
  '.run.xml',
  '.xdv',
]);

function getFileExt(filePath) {
  // Handle compound extensions like .synctex.gz
  const base = path.basename(filePath);
  const dotIdx = base.indexOf('.');
  return dotIdx >= 0 ? base.slice(dotIdx).toLowerCase() : '';
}

/**
 * Write project files to disk, skipping unchanged files and generated artifacts.
 * @param {string} projectId
 * @param {Array<{path: string, content: string, is_binary: boolean, binary_sha256?: string}>} files
 */
export async function syncFilesToDisk(projectId, files) {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  await fsp.mkdir(projectDir, { recursive: true });

  // Remove any symlinks in the project directory (could be created by TeX packages)
  await removeSymlinks(projectDir);

  const writes = files.map(async (file) => {
    // Skip generated files (e.g. .aux, .log, .bbl) — they can be stale from GitHub imports
    // and would corrupt the build if written over fresh ones from latexmk
    const ext = getFileExt(file.path);
    if (GENERATED_EXTS.has(ext)) return;

    const filePath = safePath(projectDir, file.path);
    // Bytes come via loadFileBytes so we transparently handle both legacy
    // base64-in-DB and Phase A.2+ blob-stored binaries. For text rows the
    // string is returned as-is. A binary row without binary_sha256 (would
    // indicate a code-path regression) throws here; skip just that file
    // with a warning rather than aborting the entire compile.
    let buf;
    try {
      buf = await loadFileBytes(projectId, file);
    } catch (err) {
      logger.warn({ err, projectId, path: file.path }, 'syncFilesToDisk: skipping file with unloadable bytes');
      return;
    }
    const hash = contentHash(typeof buf === 'string' ? buf : buf || '');
    const cacheKey = projectId + ':' + file.path;

    if (fileHashCache.get(cacheKey) === hash) return; // unchanged

    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    // Refuse to follow symlinks. A hostile TeX package could create a symlink
    // between removeSymlinks() and this write; O_NOFOLLOW closes that race.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    let handle;
    try {
      handle = await fsp.open(filePath, flags);
    } catch (err) {
      if (err.code === 'ELOOP' || err.code === 'EMLINK') {
        // Path was a symlink — unlink and retry once with the same restricted flags.
        await fsp.unlink(filePath).catch(() => {});
        handle = await fsp.open(filePath, flags);
      } else {
        throw err;
      }
    }
    try {
      await handle.writeFile(buf);
    } finally {
      await handle.close();
    }
    setFileHash(cacheKey, hash);
  });

  await Promise.all(writes);
}

// Test-only exports for internal helpers — only populated in NODE_ENV=test.
export const _testing = process.env.NODE_ENV === 'test'
  ? { safePath, recordCompile, fileHashCache, contentHash }
  : undefined;

/** Recursively remove symlinks from a directory tree. */
async function removeSymlinks(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await fsp.unlink(fullPath).catch((e) => console.warn('Failed to remove symlink:', fullPath, e.message));
    } else if (entry.isDirectory()) {
      await removeSymlinks(fullPath);
    }
  }
}
