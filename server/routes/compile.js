import { Router } from 'express';
import { fileURLToPath } from 'url';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import db from '../db.js';
import { requireMember } from '../middleware/auth.js';
import {
  compileProject,
  synctexForward,
  synctexInverse,
  stopCompilation,
  getTexPaths,
  detectTexDistributions,
  invalidateFileCache,
  userSuffix as makeUserSuffix,
  GENERATED_EXTS,
} from '../compiler.js';
import latexDiff from '../utils/latexDiff.js';
import { stripPendingDeletions, wrapPendingChangesAsMacros, injectTcMacros } from '../utils/tcMarks.js';
import { stripPaths, safeMsg } from '../middleware/errorHandler.js';
import path from 'path';
import logger from '../logger.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');

const router = Router();

// Per-project and per-user compilation rate limiting
const compileRateMap = new Map();
const userCompileRateMap = new Map();
const userFormatRateMap = new Map();
const COMPILE_RATE_WINDOW = 60000;
// DISABLE_RATE_LIMIT only takes effect outside production; production ignores it.
const SKIP_LIMITS = process.env.DISABLE_RATE_LIMIT === '1' && process.env.NODE_ENV !== 'production';
const COMPILE_RATE_MAX = SKIP_LIMITS ? Infinity : 15;
const USER_COMPILE_RATE_MAX = SKIP_LIMITS ? Infinity : 30;
// Format runs latexindent / tex-fmt with up to a 30s timeout per call. The
// global apiLimiter (200/min) is too permissive for that — bound a single
// authenticated user to 10 format calls per minute so they can't tie up
// process slots.
const USER_FORMAT_RATE_MAX = SKIP_LIMITS ? Infinity : 10;
// Hard cap on the LaTeX source we'll format in one call. Anything larger is
// almost certainly a misuse rather than a real document, and avoids handing
// a multi-MB string to latexindent.
const FORMAT_MAX_BYTES = 2 * 1024 * 1024;

/** Check per-project and per-user compilation rate limits. Returns false if limit exceeded. */
function checkCompileRate(projectId, userId) {
  const now = Date.now();
  // Per-project limit
  let entry = compileRateMap.get(projectId);
  if (!entry || now - entry.start > COMPILE_RATE_WINDOW) {
    entry = { start: now, count: 0 };
    compileRateMap.set(projectId, entry);
  }
  entry.count++;
  if (entry.count > COMPILE_RATE_MAX) return false;

  // Per-user limit (across all projects)
  if (userId) {
    let userEntry = userCompileRateMap.get(userId);
    if (!userEntry || now - userEntry.start > COMPILE_RATE_WINDOW) {
      userEntry = { start: now, count: 0 };
      userCompileRateMap.set(userId, userEntry);
    }
    userEntry.count++;
    if (userEntry.count > USER_COMPILE_RATE_MAX) return false;
  }

  return true;
}

// Clean up stale rate limit entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of compileRateMap) {
    if (now - entry.start > COMPILE_RATE_WINDOW * 2) compileRateMap.delete(id);
  }
  for (const [id, entry] of userCompileRateMap) {
    if (now - entry.start > COMPILE_RATE_WINDOW * 2) userCompileRateMap.delete(id);
  }
}, 60 * 1000).unref();

async function requireMembership(projectId, userId, res) {
  return !!(await requireMember(projectId, userId, res));
}

/** GET /api/compile/texlive-distributions -- List installed TeX Live distributions. */
router.get('/texlive-distributions', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json(detectTexDistributions());
});

/** GET /api/compile/formatters -- List available LaTeX code formatters (latexindent, tex-fmt). */
router.get('/formatters', (req, res) => {
  res.json(detectFormatters());
});

/** POST /api/compile/format -- Format LaTeX source using the specified formatter. */
router.post('/format', async (req, res) => {
  const { content, formatter } = req.body;
  if (!content) return res.status(400).json({ error: 'No content provided' });
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > FORMAT_MAX_BYTES) {
    return res.status(413).json({ error: 'Content exceeds format size limit' });
  }

  // Per-user rate limit. The global apiLimiter doesn't bound formatter
  // process spawns tightly enough — each call is up to 30s of latexindent.
  const userId = req.session?.userId;
  if (userId && !SKIP_LIMITS) {
    const now = Date.now();
    let entry = userFormatRateMap.get(userId);
    if (!entry || now - entry.start > COMPILE_RATE_WINDOW) {
      entry = { start: now, count: 0 };
      userFormatRateMap.set(userId, entry);
    }
    if (entry.count >= USER_FORMAT_RATE_MAX) {
      return res.status(429).json({ error: 'Too many format requests, slow down a moment.' });
    }
    entry.count++;
  }

  const formatters = detectFormatters();
  const fmt = formatters.find((f) => f.id === (formatter || formatters[0]?.id));
  if (!fmt) return res.status(400).json({ error: 'No formatter available' });

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtex-fmt-'));
    const tmpFile = path.join(tmpDir, 'input.tex');
    fs.writeFileSync(tmpFile, content);

    let formatted;
    if (fmt.id === 'latexindent') {
      const { stdout } = await execFileAsync(fmt.path, [tmpFile, '-o', '-'], { timeout: 30000, cwd: tmpDir });
      formatted = stdout;
    } else if (fmt.id === 'texfmt') {
      const { stdout } = await execFileAsync(fmt.path, [tmpFile, '--print'], { timeout: 10000, cwd: tmpDir });
      formatted = stdout;
    } else {
      return res.status(400).json({ error: 'Unknown formatter' });
    }

    res.json({ formatted });
  } catch (err) {
    logger.error({ err }, 'Format error');
    res.status(500).json({ error: safeMsg(err, 'Formatting failed') });
  } finally {
    // Always clean up — covers the formatter timeout/error path and the
    // early return for an unknown formatter id, not just the success case.
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
});

/** POST /api/compile/:projectId -- Compile the project and return the log output. */
router.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!(await requireMembership(projectId, req.session.userId, res))) return;
    if (!checkCompileRate(projectId, req.session.userId)) {
      return res.status(429).json({ success: false, log: 'Too many compilations. Please wait a moment.' });
    }

    // V2-4: showTrackedChanges=true → render pending TC entries with
    // \TCadd / \TCdel macros in the PDF ("All Markup" view). Otherwise
    // strip them so the compiler sees the "Final" view.
    const showTC = req.query.showTrackedChanges === '1' || req.body?.showTrackedChanges === true;
    const rawFiles = await db.all(
      'SELECT path, content, is_binary, tc_marks FROM files WHERE project_id = $1',
      [projectId],
    );
    const project = await db.get('SELECT main_file, tex_distribution, compiler FROM projects WHERE id = $1', [
      projectId,
    ]);
    const mainFile = project?.main_file || 'main.tex';
    const files = rawFiles.map((f) => {
      if (f.is_binary) return f;
      let content = f.content;
      if (showTC) {
        content = wrapPendingChangesAsMacros(content, f.tc_marks);
        // Inject the macro definitions in the main file's preamble only.
        if (f.path === mainFile) content = injectTcMacros(content);
      } else {
        content = stripPendingDeletions(content, f.tc_marks);
      }
      return { ...f, content };
    });

    const { log } = await compileProject(projectId, mainFile, null, {
      files,
      userId: req.session.userId,
      texDistribution: project?.tex_distribution,
      compiler: project?.compiler,
    });

    res.json({ success: true, log });
  } catch (err) {
    res.status(400).json({ success: false, log: safeMsg(err, 'Compilation failed') });
  }
});

/** GET /api/compile/:projectId/compile-stream -- Compile with SSE streaming log output. */
router.get('/:projectId/compile-stream', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;
  if (!checkCompileRate(projectId, req.session.userId)) {
    // Must respond as SSE so EventSource doesn't infinitely retry a 429.
    // Send the error as an SSE "done" event, then close.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: done\ndata: ${JSON.stringify({ success: false, log: 'Too many compilations. Please wait a moment before compiling again.' })}\n\n`);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let clientDisconnected = false;
  res.on('close', () => {
    clientDisconnected = true;
    stopCompilation(projectId).catch((e) => logger.warn({ err: e }, 'Failed to stop compilation on disconnect'));
  });

  const send = (event, data) => {
    if (clientDisconnected) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  

  try {
    const showTC = req.query.showTrackedChanges === '1';
    const rawFiles = await db.all(
      'SELECT path, content, is_binary, tc_marks FROM files WHERE project_id = $1',
      [projectId],
    );
    const project = await db.get('SELECT main_file, tex_distribution, compiler FROM projects WHERE id = $1', [
      projectId,
    ]);
    const mainFile = project?.main_file || 'main.tex';
    const files = rawFiles.map((f) => {
      if (f.is_binary) return f;
      let content = f.content;
      if (showTC) {
        content = wrapPendingChangesAsMacros(content, f.tc_marks);
        if (f.path === mainFile) content = injectTcMacros(content);
      } else {
        content = stripPendingDeletions(content, f.tc_marks);
      }
      return { ...f, content };
    });
    const { log } = await compileProject(
      projectId,
      mainFile,
      (chunk) => {
        send('output', { text: stripPaths(chunk) });
      },
      {
        files,
        userId: req.session.userId,
        texDistribution: project?.tex_distribution,
        compiler: project?.compiler,
        onBeforeCompile: async () => {
          const compilerName = project?.compiler || 'pdflatex';
          send('output', { text: `Synced ${files.length} file(s). Compiling ${mainFile} with ${compilerName}...\n` });
        },
      },
    );

    send('done', { success: true, log: stripPaths(log) });
  } catch (err) {
    send('done', { success: false, log: stripPaths(err.message) });
  }

  if (!clientDisconnected) res.end();
});

/** POST /api/compile/:projectId/stop -- Abort a running compilation for the project. */
router.post('/:projectId/stop', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;
  const stopped = await stopCompilation(projectId);
  res.json({ ok: true, stopped: !!stopped });
});

/** GET /api/compile/:projectId/pdf -- Serve the compiled PDF for the current user. */
router.get('/:projectId/pdf', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const project = await db.get('SELECT main_file FROM projects WHERE id = $1', [projectId]);
  const baseName = (project?.main_file || 'main.tex').replace(/\.tex$/, '');
  const userSuffix = makeUserSuffix(req.session.userId);
  const pdfPath = path.join(PROJECTS_DIR, projectId, baseName + userSuffix + '.pdf');

  res.set('Cache-Control', 'no-store');
  res.sendFile(pdfPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'PDF not found. Compile first.' });
    }
  });
});

/** GET /api/compile/:projectId/syncforward -- SyncTeX forward: map editor line/column to PDF position. */
router.get('/:projectId/syncforward', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const { line, column, file } = req.query;
  const project = await db.get('SELECT main_file FROM projects WHERE id = $1', [projectId]);
  const mainFile = project?.main_file || 'main.tex';
  const userSuffix = makeUserSuffix(req.session.userId);
  const result = synctexForward(
    projectId,
    parseInt(line),
    parseInt(column || '0'),
    file || mainFile,
    mainFile,
    userSuffix,
  );
  if (result) {
    res.json(result);
  } else {
    res.status(404).json({ error: 'No sync data found' });
  }
});

/** GET /api/compile/:projectId/syncinverse -- SyncTeX inverse: map PDF page/position to editor line. */
router.get('/:projectId/syncinverse', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const { page, x, y } = req.query;
  const project = await db.get('SELECT main_file FROM projects WHERE id = $1', [projectId]);
  const mainFile = project?.main_file || 'main.tex';
  const userSuffix = makeUserSuffix(req.session.userId);
  const result = synctexInverse(projectId, parseInt(page), parseFloat(x), parseFloat(y), mainFile, userSuffix);
  if (result) {
    res.json(result);
  } else {
    res.status(404).json({ error: 'No sync data found' });
  }
});

/** POST /api/compile/:projectId/lint -- Lint LaTeX content using ChkTeX or lacheck. */
router.post('/:projectId/lint', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!(await requireMembership(projectId, req.session.userId, res))) return;

    const { content, filename, linter } = req.body;
    if (!content) return res.json({ diagnostics: [] });
    // Only allow known linter values
    if (linter && linter !== 'chktex' && linter !== 'lacheck') {
      return res.status(400).json({ error: 'Invalid linter' });
    }

    // Write content to temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-'));
    const safeFilename = path.basename(filename || 'input.tex').replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpFile = path.join(tmpDir, safeFilename);
    fs.writeFileSync(tmpFile, content);

    const project = await db.get('SELECT tex_distribution FROM projects WHERE id = $1', [projectId]);
    const env = { ...process.env, PATH: getTexPaths(project?.tex_distribution) + ':' + (process.env.PATH || '') };

    try {
      const diagnostics = [];

      if (linter === 'lacheck') {
        // Run lacheck for syntax errors (unmatched braces, environments, etc.)
        const { stdout, stderr } = await execFileAsync('lacheck', [tmpFile], { timeout: 5000, env }).catch((e) => ({
          stdout: e.stdout || '',
          stderr: e.stderr || '',
        }));
        const output = stdout || stderr || '';
        for (const line of output.split('\n').filter(Boolean)) {
          const match = line.match(/line (\d+):\s*(.+)/);
          if (match) {
            diagnostics.push({
              line: parseInt(match[1]),
              col: 1,
              len: 0,
              severity: 'warning',
              code: 0,
              message: match[2].trim(),
            });
          }
        }
      } else {
        // Default: ChkTeX for LaTeX warnings and style checks
        // -v0 = machine-readable output, -q = quiet, -f = custom format
        const { stdout, stderr } = await execFileAsync('chktex', ['-v0', '-q', '-f', '%l:%c:%d:%n:%k:%m\\n', tmpFile], {
          timeout: 5000,
          env,
        }).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));

        const output = stdout || stderr || '';
        for (const line of output.split('\n').filter(Boolean)) {
          // Format: line:col:len:code:severity:message
          const match = line.match(/^(\d+):(\d+):(\d+):(\d+):(\w+):(.+)/);
          if (match) {
            diagnostics.push({
              line: parseInt(match[1]),
              col: parseInt(match[2]),
              len: parseInt(match[3]),
              severity: match[5] === 'Error' ? 'error' : 'warning',
              code: parseInt(match[4]),
              message: match[6].trim(),
            });
          }
        }
      }

      res.json({ diagnostics });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    logger.error({ err }, 'Lint error');
    res.json({ diagnostics: [] });
  }
});

/** GET /api/compile/:projectId/wordcount -- Count words, headers, math, and floats using texcount. */
router.get('/:projectId/wordcount', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!(await requireMembership(projectId, req.session.userId, res))) return;

    const project = await db.get('SELECT main_file, tex_distribution, compiler FROM projects WHERE id = $1', [
      projectId,
    ]);
    const mainFile = project?.main_file || 'main.tex';

    const projectDir = path.join(PROJECTS_DIR, projectId);
    const texFile = path.join(projectDir, mainFile);
    if (!fs.existsSync(texFile)) {
      return res.status(404).json({ error: `Main file not found: ${mainFile}` });
    }

    const env = { ...process.env, PATH: getTexPaths(project?.tex_distribution) + ':' + (process.env.PATH || '') };
    const { stdout } = await execFileAsync('texcount', ['-sub', '-merge', '-inc', '-utf8', mainFile], {
      cwd: projectDir,
      timeout: 15000,
      env,
    });

    // Parse totals from "Sum of files" / "File(s) total" block
    const totalBlock = stdout.match(/File\(s\) total:[\s\S]*?(?=\nFiles:|\nSubcounts:|\n\n|$)/);
    const totText = totalBlock ? totalBlock[0] : stdout;
    const words = parseInt((totText.match(/Words in text:\s*(\d+)/) || [])[1]) || 0;
    const headers = parseInt((totText.match(/Words in headers:\s*(\d+)/) || [])[1]) || 0;
    const captions = parseInt((totText.match(/Words outside text[^:]*:\s*(\d+)/) || [])[1]) || 0;
    const mathInline = parseInt((totText.match(/Number of math inlines:\s*(\d+)/) || [])[1]) || 0;
    const mathDisplay = parseInt((totText.match(/Number of math displayed:\s*(\d+)/) || [])[1]) || 0;
    const floats = parseInt((totText.match(/Number of floats[^:]*:\s*(\d+)/) || [])[1]) || 0;

    // Parse per-section subcounts: "  N+N+N (N/N/N/N) Section: Title"
    const sections = [];
    const subRe = /^\s*(\d+)\+(\d+)\+(\d+)\s+\((\d+)\/(\d+)\/(\d+)\/(\d+)\)\s+(.+)$/gm;
    let m;
    while ((m = subRe.exec(stdout)) !== null) {
      const label = m[8].trim();
      // Skip file-level entries, only include section/subsection/chapter entries
      if (label.startsWith('File:') || label.startsWith('Included file:')) continue;
      // Clean up label: remove trailing \label{...} and braces
      const cleanLabel = label
        .replace(/\\label\{[^}]*\}/g, '')
        .replace(/[{}]/g, '')
        .trim();
      sections.push({
        label: cleanLabel,
        words: parseInt(m[1]),
        headers: parseInt(m[2]),
        captions: parseInt(m[3]),
      });
    }

    res.json({
      words,
      headers,
      captions,
      mathInline,
      mathDisplay,
      floats,
      total: words + headers + captions,
      sections,
    });
  } catch (err) {
    logger.error({ err }, 'Word count error');
    const msg = (err.message || 'Word count failed').replace(/\/[^\s:]+\//g, '');
    res.status(400).json({ error: msg });
  }
});

/** GET /api/compile/:projectId/diff-stream -- Run latexdiff and compile the result, streaming output via SSE. */
router.get('/:projectId/diff-stream', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const { oldFileId, newFileId } = req.query;
  if (!oldFileId || !newFileId) {
    return res.status(400).json({ error: 'Both oldFileId and newFileId required' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let clientDisconnected = false;
  res.on('close', () => {
    clientDisconnected = true;
    stopCompilation(projectId).catch((e) => logger.warn({ err: e }, 'Failed to stop compilation on disconnect'));
  });

  
  const send = (event, data) => {
    if (clientDisconnected) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const oldFile = await db.get('SELECT path, content FROM files WHERE id = $1 AND project_id = $2', [
      oldFileId,
      projectId,
    ]);
    const newFile = await db.get('SELECT path, content FROM files WHERE id = $1 AND project_id = $2', [
      newFileId,
      projectId,
    ]);
    if (!oldFile || !newFile) {
      send('done', { success: false, log: 'File not found' });
      if (!clientDisconnected) res.end();
      return;
    }

    const rawFiles = await db.all(
      'SELECT path, content, is_binary, tc_marks FROM files WHERE project_id = $1',
      [projectId],
    );
    // Strip pending del ranges before sending to LaTeX (M2 model — the
    // doc keeps strikethrough chars; the compiler must see "Final" view).
    const files = rawFiles.map((f) =>
      f.is_binary
        ? f
        : { ...f, content: stripPendingDeletions(f.content, f.tc_marks) },
    );
    const projectDir = path.join(PROJECTS_DIR, projectId);

    // Run latexdiff (doesn't touch the project dir, works on content strings)
    send('output', { text: `Running latexdiff: ${oldFile.path} → ${newFile.path}...\n` });

    let diffOutput;
    try {
      diffOutput = await latexDiff(oldFile.content || '', newFile.content || '', { workDir: projectDir });
    } catch (err) {
      send('output', { text: `Diff error: ${stripPaths(err.message)}\n` });
      if (err.stderr) send('output', { text: stripPaths(err.stderr) + '\n' });
      send('done', { success: false, log: stripPaths(err.message) });
      if (!clientDisconnected) res.end();
      return;
    }

    const userSuffix = makeUserSuffix(req.session.userId);
    const diffJobName = '__diff__' + userSuffix;

    // Write diff to temp file and compile
    send('output', { text: 'Compiling diff...\n' });
    try {
      const { log } = await compileProject(
        projectId,
        '__diff__.tex',
        (chunk) => {
          send('output', { text: stripPaths(chunk) });
        },
        {
          files,
          userId: req.session.userId,
          onBeforeCompile: async () => {
            const diffTexPath = path.join(projectDir, '__diff__.tex');
            fs.writeFileSync(diffTexPath, diffOutput);
            send('output', { text: `Wrote __diff__.tex (${diffOutput.length} bytes)\n` });
          },
        },
      );
      send('done', { success: true, log: stripPaths(log) });
    } catch (err) {
      // Read the log file and stream it to the console
      const diffLogPath = path.join(projectDir, diffJobName + '.log');
      if (fs.existsSync(diffLogPath)) {
        const logContents = fs.readFileSync(diffLogPath, 'utf-8');
        send('output', { text: stripPaths('\n--- diff log ---\n' + logContents + '\n') });
      }
      // Check if PDF was produced anyway
      const diffPdfPath = path.join(projectDir, diffJobName + '.pdf');
      if (fs.existsSync(diffPdfPath)) {
        send('done', { success: true, log: stripPaths(err.message) });
      } else {
        send('done', { success: false, log: stripPaths(err.message) });
      }
    }
  } catch (err) {
    send('done', { success: false, log: stripPaths(err.message) });
  }

  if (!clientDisconnected) res.end();
});

/** GET /api/compile/:projectId/diff-pdf -- Serve the compiled latexdiff PDF. */
router.get('/:projectId/diff-pdf', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const userSuffix = makeUserSuffix(req.session.userId);
  const pdfPath = path.join(PROJECTS_DIR, projectId, '__diff__' + userSuffix + '.pdf');
  res.set('Cache-Control', 'no-store');
  res.sendFile(pdfPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Diff PDF not found. Run diff first.' });
    }
  });
});

/** GET /api/compile/:projectId/generated-files -- List LaTeX-generated auxiliary files (aux, log, bbl, etc.). */
router.get('/:projectId/generated-files', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const projectDir = path.join(PROJECTS_DIR, projectId);
  if (!fs.existsSync(projectDir)) return res.json({ files: [] });

  const generatedExts = new Set([
    '.aux',
    '.log',
    '.bbl',
    '.blg',
    '.out',
    '.toc',
    '.lof',
    '.lot',
    '.nav',
    '.snm',
    '.idx',
    '.ind',
    '.ilg',
    '.glo',
    '.gls',
    '.glg',
    '.bcf',
    '.run.xml',
  ]);

  const userSuffix = makeUserSuffix(req.session.userId);
  const files = [];
  for (const entry of fs.readdirSync(projectDir)) {
    const ext = '.' + entry.split('.').slice(1).join('.');
    if (generatedExts.has(ext.toLowerCase())) {
      // Only show files generated for the logged-in user
      const baseName = entry.split('.')[0];
      if (!baseName.endsWith(userSuffix)) continue;
      const stat = fs.statSync(path.join(projectDir, entry));
      files.push({ name: entry, size: stat.size, mtime: stat.mtime });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ files });
});

/** GET /api/compile/:projectId/generated-file -- Retrieve the content of a specific generated file. */
router.get('/:projectId/generated-file', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const fileName = req.query.name;
  if (
    !fileName ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    fileName.includes('\0')
  ) {
    return res.status(400).json({ error: 'Invalid file name' });
  }
  // Ensure resolved path stays within the project directory
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const resolvedPath = path.resolve(projectDir, fileName);
  if (!resolvedPath.startsWith(projectDir + path.sep)) {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  // Only allow access to the requesting user's generated files
  const userSuffix = makeUserSuffix(req.session.userId);
  const baseName = fileName.split('.')[0];
  if (!baseName.endsWith(userSuffix)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(PROJECTS_DIR, projectId, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({ name: fileName, content });
});

/** POST /api/compile/:projectId/clean -- Delete generated files (aux, log, pdf, synctex) for the current user. */
router.post('/:projectId/clean', async (req, res) => {
  const projectId = req.params.projectId;
  const member = await requireMember(projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot clean generated files' });

  const projectDir = path.join(PROJECTS_DIR, projectId);
  if (!fs.existsSync(projectDir)) return res.json({ deleted: 0 });

  // Only delete files belonging to the requesting user (scoped by user suffix)
  const userSuffix = makeUserSuffix(req.session.userId);
  let deleted = 0;
  const entries = fs.readdirSync(projectDir);
  for (const entry of entries) {
    // Match generated extensions including .pdf and synctex(busy) variants
    const ext = entry.includes('.') ? '.' + entry.split('.').slice(1).join('.') : '';
    const lowerExt = ext.toLowerCase();
    const isGenerated =
      GENERATED_EXTS.has(lowerExt) || lowerExt === '.pdf' || /\.synctex\(busy\)$/i.test(entry);
    if (!isGenerated) continue;

    // Only clean this user's generated files
    const baseName = entry.split('.')[0];
    if (!baseName.endsWith(userSuffix)) continue;

    try {
      fs.unlinkSync(path.join(projectDir, entry));
      deleted++;
    } catch {}
  }

  // Invalidate file hash cache so source files are re-synced on next compile
  invalidateFileCache(projectId);

  res.json({ deleted });
});

// --- LaTeX formatters ---
const KNOWN_FORMATTERS = [
  { id: 'latexindent', name: 'latexindent', commands: ['latexindent', '/opt/local/bin/latexindent'] },
  { id: 'texfmt', name: 'tex-fmt', commands: ['tex-fmt', 'texfmt'] },
];

let _cachedFormatters = null;
let _formattersCacheTime = 0;

// Allowed directories for formatter executables
const SAFE_BIN_DIRS = new Set(['/opt/local/bin', '/usr/local/bin', '/usr/bin', '/Library/TeX/texbin', '/opt/homebrew/bin']);

/** Detect available LaTeX formatters on the system, with 60s caching. */
function detectFormatters() {
  const now = Date.now();
  if (_cachedFormatters && now - _formattersCacheTime < 60000) return _cachedFormatters;

  const found = [];
  for (const fmt of KNOWN_FORMATTERS) {
    for (const cmd of fmt.commands) {
      try {
        const fullPath = execFileSync('which', [cmd], { encoding: 'utf-8', timeout: 3000 }).trim();
        // Validate the resolved path is in a known safe directory
        const dir = path.dirname(fullPath);
        if (!SAFE_BIN_DIRS.has(dir)) continue;
        // Reject paths with traversal attempts
        if (fullPath.includes('..') || fullPath.includes('\0')) continue;
        let version = '';
        try {
          const out = execFileSync(fullPath, ['--version'], { encoding: 'utf-8', timeout: 3000 });
          const m = out.match(/(\d+\.\d+[.\d]*)/);
          if (m) version = m[1];
        } catch {}
        found.push({ id: fmt.id, name: fmt.name, path: fullPath, version });
        break;
      } catch {}
    }
  }

  _cachedFormatters = found;
  _formattersCacheTime = now;
  return found;
}

export default router;
