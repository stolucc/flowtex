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

async function getCompileTimeout() {
  const now = Date.now();
  if (now - _lastTimeoutFetch > 30000) {
    try {
      const row = await db.get("SELECT value FROM settings WHERE key = 'compile_timeout'");
      if (row) _compileTimeoutMs = parseInt(row.value) * 1000 || 120000;
    } catch { /* use cached value */ }
    _lastTimeoutFetch = now;
  }
  return _compileTimeoutMs;
}

// Build a PATH that includes common TeX Live locations
export const TEX_PATHS = [
  '/Library/TeX/texbin',
  '/usr/local/texlive/2025/bin/universal-darwin',
  '/usr/local/texlive/2024/bin/universal-darwin',
  '/usr/local/texlive/2025/bin/x86_64-darwin',
  '/usr/local/texlive/2024/bin/x86_64-darwin',
  '/opt/local/bin',
  '/usr/local/bin',
  '/usr/bin',
].join(':');

// Track active compilations so they can be stopped
const activeCompilations = new Map();

// Compilation metrics
export const compileMetrics = {
  total: 0,
  success: 0,
  failed: 0,
  active: 0,
  history: [],  // last 300 entries: { time, duration, success }
};

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

export async function compileProject(projectId, mainFile = 'main.tex', onOutput, { files, onBeforeCompile, userId } = {}) {
  // Sync files to disk before compiling
  if (files) {
    await syncFilesToDisk(projectId, files);
  }
  if (onBeforeCompile) {
    await onBeforeCompile();
  }

  const timeoutMs = await getCompileTimeout();

  // Each user gets a unique jobname so concurrent compilations don't collide
  const userSuffix = userId ? '_' + userId.slice(0, 8) : '';
  return _doCompile(projectId, mainFile, onOutput, userSuffix, timeoutMs);
}

function _doCompile(projectId, mainFile, onOutput, userSuffix = '', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
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
      PATH: TEX_PATHS + ':' + (process.env.PATH || ''),
      // Restrict LaTeX file I/O to prevent reading arbitrary server files
      openin_any: 'p',   // only open files in the current directory or below
      openout_any: 'p',  // only write files in the current directory or below
    };

    let resolveExit;
    const exitPromise = new Promise((r) => { resolveExit = r; });

    compileMetrics.active++;
    const compileStartTime = Date.now();

    const child = execFile(
      'latexmk',
      [
        '-pdf',
        '-synctex=1',
        '-interaction=nonstopmode',
        '-f',
        '--shell-restricted',
        `-jobname=${jobName}`,
        `-output-directory=${projectDir}`,
        mainFile,
      ],
      { cwd: projectDir, timeout: timeoutMs, env },
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
        try { finalLog = fs.readFileSync(logPath, 'utf-8'); } catch { finalLog = stdout; }

        if (error?.killed || error?.signal === 'SIGTERM') {
          recordCompile(false, duration);
          reject(new Error('Compilation stopped by user'));
        } else if (fs.existsSync(pdfPath)) {
          recordCompile(true, duration);
          resolve({ pdfPath, log: finalLog, jobName });
        } else {
          recordCompile(false, duration);
          reject(new Error(finalLog || stdout || stderr || 'Compilation failed'));
        }
      }
    );

    activeCompilations.set(projectId, { child, exitPromise });

    if (onOutput) {
      child.stdout?.on('data', (data) => onOutput(data.toString()));
      child.stderr?.on('data', (data) => onOutput(data.toString()));
    }
  });
}

// Forward sync: editor line → PDF page/position
export function synctexForward(projectId, line, column, inputFile = 'main.tex', mainFile = 'main.tex', userSuffix = '') {
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
    const output = execFileSync('synctex', [
      'view',
      '-i', `${line}:${column}:${safeInputFile}`,
      '-o', pdfFile,
    ], { encoding: 'utf-8', timeout: 5000 });

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

// Inverse sync: PDF page/position → editor line
export function synctexInverse(projectId, page, x, y, mainFile = 'main.tex', userSuffix = '') {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  // Validate mainFile to prevent path traversal
  const safeMainFile = safePath(projectDir, mainFile.replace(/\.tex$/, '') + userSuffix + '.pdf');
  const pdfFile = safeMainFile;

  try {
    const output = execFileSync('synctex', [
      'edit',
      '-o', `${page}:${x}:${y}:${pdfFile}`,
    ], { encoding: 'utf-8', timeout: 5000 });

    const lineMatch = output.match(/Line:(\d+)/);
    const columnMatch = output.match(/Column:(-?\d+)/);
    const inputMatch = output.match(/Input:(.+)/);

    if (lineMatch) {
      let file = inputMatch ? inputMatch[1].trim() : 'main.tex';
      // Make path relative to project dir
      if (file.startsWith(projectDir)) {
        file = file.slice(projectDir.length + 1);
      }
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

function contentHash(content) {
  return createHash('md5').update(content).digest('hex');
}

/** Clear cached hashes for a project (e.g. after git pull overwrites files on disk). */
export function invalidateFileCache(projectId) {
  for (const key of fileHashCache.keys()) {
    if (key.startsWith(projectId + ':')) fileHashCache.delete(key);
  }
}

// Async file sync — only writes files whose content has changed
export async function syncFilesToDisk(projectId, files) {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  await fsp.mkdir(projectDir, { recursive: true });

  const writes = files.map(async (file) => {
    const filePath = safePath(projectDir, file.path);
    const buf = file.is_binary && file.content
      ? Buffer.from(file.content, 'base64')
      : file.content;
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
