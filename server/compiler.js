import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECTS_DIR = path.join(__dirname, '..', 'projects');

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
  if (entry) {
    entry.child.kill('SIGTERM');
    activeCompilations.delete(projectId);
    // Return a promise that resolves when the process actually exits
    return entry.exitPromise;
  }
  return Promise.resolve(false);
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
export async function compileProject(
  projectId,
  mainFile = 'main.tex',
  onOutput,
  { files, onBeforeCompile, userId, texDistribution, compiler } = {},
) {
  // Sync files to disk before compiling
  if (files) {
    await syncFilesToDisk(projectId, files);

    // Warn about empty binary files (e.g. failed GitHub imports)
    const emptyBinaries = files.filter((f) => f.is_binary && (!f.content || f.content.length === 0));
    if (emptyBinaries.length > 0) {
      const names = emptyBinaries.map((f) => f.path).join(', ');
      const msg = `Warning: ${emptyBinaries.length} binary file(s) are empty and may cause compilation to fail: ${names}\n` +
        'These files may not have been imported correctly. Try re-importing or uploading them manually.\n\n';
      if (onOutput) onOutput(msg);
    }
  }
  if (onBeforeCompile) {
    await onBeforeCompile();
  }

  const timeoutMs = await getCompileTimeout();

  // Each user gets a unique jobname so concurrent compilations don't collide
  const userSuffix = userId ? '_' + userId.slice(0, 8) : '';
  return _doCompile(projectId, mainFile, onOutput, userSuffix, timeoutMs, texDistribution, compiler);
}

/** Internal: spawn latexmk and return a promise for the compilation result. */
function _doCompile(
  projectId,
  mainFile,
  onOutput,
  userSuffix = '',
  timeoutMs = 120000,
  texDistribution = null,
  compiler = null,
) {
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

    // Determine the latexmk engine flag based on the selected compiler
    const compilerEntry = COMPILERS.find((c) => c.id === compiler);
    const engineFlag = compilerEntry ? compilerEntry.flag : '-pdf';

    const child = execFile(
      'latexmk',
      [
        engineFlag,
        '-synctex=1',
        '-interaction=nonstopmode',
        '-f',
        '--no-shell-escape',
        `-jobname=${jobName}`,
        `-output-directory=${projectDir}`,
        mainFile,
      ],
      { cwd: projectDir, timeout: timeoutMs, env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        activeCompilations.delete(projectId);
        compileMetrics.active--;
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

        if (error?.killed || error?.signal === 'SIGTERM') {
          recordCompile(false, duration);
          if (fatalError) {
            reject(new Error(finalLog || fatalError));
          } else {
            reject(new Error('Compilation stopped by user'));
          }
        } else if (fs.existsSync(pdfPath)) {
          recordCompile(true, duration);
          resolve({ pdfPath, log: finalLog, jobName });
        } else {
          recordCompile(false, duration);
          reject(new Error(finalLog || stdout || stderr || 'Compilation failed'));
        }
      },
    );

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
  } catch (err) {
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
  } catch (err) {
    return null;
  }
}

// Cache of content hashes to skip unchanged file writes
// Key: "projectId:path" → md5 hex digest
const fileHashCache = new Map();

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
 * @param {Array<{path: string, content: string, is_binary: boolean}>} files
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
    const buf = file.is_binary && file.content ? Buffer.from(file.content, 'base64') : file.content;
    const hash = contentHash(typeof buf === 'string' ? buf : buf || '');
    const cacheKey = projectId + ':' + file.path;

    if (fileHashCache.get(cacheKey) === hash) return; // unchanged

    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, buf);
    fileHashCache.set(cacheKey, hash);
  });

  await Promise.all(writes);
}

// Test-only exports for internal helpers
export const _testing = { safePath, recordCompile, fileHashCache, contentHash };

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
