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
  syncFilesToDisk,
  TEX_PATHS,
  getTexPaths,
  detectTexDistributions,
} from '../compiler.js';
import latexDiff from '../utils/latexDiff.js';
import path from 'path';
import logger from '../logger.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');

const router = Router();

// Per-project and per-user compilation rate limiting
const compileRateMap = new Map();
const userCompileRateMap = new Map();
const COMPILE_RATE_WINDOW = 60000;
const COMPILE_RATE_MAX = process.env.DISABLE_RATE_LIMIT === '1' ? Infinity : 5;
const USER_COMPILE_RATE_MAX = process.env.DISABLE_RATE_LIMIT === '1' ? Infinity : 20;

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

// Detect installed TeX Live distributions
router.get('/texlive-distributions', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json(detectTexDistributions());
});

// --- LaTeX formatters (must be before /:projectId routes) ---
router.get('/formatters', (req, res) => {
  res.json(detectFormatters());
});

router.post('/format', async (req, res) => {
  const { content, formatter } = req.body;
  if (!content) return res.status(400).json({ error: 'No content provided' });

  const formatters = detectFormatters();
  const fmt = formatters.find((f) => f.id === (formatter || formatters[0]?.id));
  if (!fmt) return res.status(400).json({ error: 'No formatter available' });

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtex-fmt-'));
    const tmpFile = path.join(tmpDir, 'input.tex');
    fs.writeFileSync(tmpFile, content);

    let formatted;
    if (fmt.id === 'latexindent') {
      const { stdout } = await execFileAsync(fmt.path, [tmpFile, '-o', '-'], { timeout: 10000 });
      formatted = stdout;
    } else if (fmt.id === 'texfmt') {
      const { stdout } = await execFileAsync(fmt.path, ['--stdin'], { timeout: 10000, input: content });
      formatted = stdout;
    } else {
      return res.status(400).json({ error: 'Unknown formatter' });
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    res.json({ formatted });
  } catch (err) {
    logger.error({ err }, 'Format error');
    // Strip internal paths from error messages
    const safeMsg = (err.message || 'Formatting failed').replace(/\/[^\s:]+\//g, '');
    res.status(500).json({ error: safeMsg });
  }
});

// Compile a project (returns final result)
router.post('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!(await requireMembership(projectId, req.session.userId, res))) return;
    if (!checkCompileRate(projectId, req.session.userId)) {
      return res.status(429).json({ success: false, log: 'Too many compilations. Please wait a moment.' });
    }

    const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [projectId]);

    const project = await db.get('SELECT main_file, tex_distribution, compiler FROM projects WHERE id = $1', [projectId]);
    const mainFile = project?.main_file || 'main.tex';

    const { pdfPath, log } = await compileProject(projectId, mainFile, null, {
      files,
      userId: req.session.userId,
      texDistribution: project?.tex_distribution,
      compiler: project?.compiler,
    });

    res.json({ success: true, log });
  } catch (err) {
    // Strip internal paths from error messages
    const safeMsg = (err.message || 'Compilation failed').replace(/\/[^\s:]+\//g, '');
    res.status(400).json({ success: false, log: safeMsg });
  }
});

// Compile with SSE streaming output
router.get('/:projectId/compile-stream', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;
  if (!checkCompileRate(projectId, req.session.userId)) {
    return res.status(429).json({ success: false, log: 'Too many compilations. Please wait a moment.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [projectId]);
    const project = await db.get('SELECT main_file, tex_distribution, compiler FROM projects WHERE id = $1', [projectId]);
    const mainFile = project?.main_file || 'main.tex';

    const stripPaths = (text) => text.replace(/\/[^\s:)]+\//g, '');
    const { pdfPath, log } = await compileProject(
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
        onBeforeCompile: () => {
          const compilerName = project?.compiler || 'pdflatex';
          send('output', { text: `Synced ${files.length} file(s). Compiling ${mainFile} with ${compilerName}...\n` });
        },
      },
    );

    send('done', { success: true, log: stripPaths(log) });
  } catch (err) {
    send('done', { success: false, log: stripPaths(err.message) });
  }

  res.end();
});

// Stop compilation
router.post('/:projectId/stop', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;
  const stopped = await stopCompilation(projectId);
  res.json({ ok: true, stopped: !!stopped });
});

// Serve compiled PDF (per-user jobname)
router.get('/:projectId/pdf', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const project = await db.get('SELECT main_file FROM projects WHERE id = $1', [projectId]);
  const baseName = (project?.main_file || 'main.tex').replace(/\.tex$/, '');
  const userSuffix = '_' + req.session.userId.slice(0, 8);
  const pdfPath = path.join(PROJECTS_DIR, projectId, baseName + userSuffix + '.pdf');

  res.sendFile(pdfPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'PDF not found. Compile first.' });
    }
  });
});

// Forward sync: editor → PDF
router.get('/:projectId/syncforward', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const { line, column, file } = req.query;
  const project = await db.get('SELECT main_file FROM projects WHERE id = $1', [projectId]);
  const mainFile = project?.main_file || 'main.tex';
  const userSuffix = '_' + req.session.userId.slice(0, 8);
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

// Inverse sync: PDF → editor
router.get('/:projectId/syncinverse', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const { page, x, y } = req.query;
  const project = await db.get('SELECT main_file FROM projects WHERE id = $1', [projectId]);
  const mainFile = project?.main_file || 'main.tex';
  const userSuffix = '_' + req.session.userId.slice(0, 8);
  const result = synctexInverse(projectId, parseInt(page), parseFloat(x), parseFloat(y), mainFile, userSuffix);
  if (result) {
    res.json(result);
  } else {
    res.status(404).json({ error: 'No sync data found' });
  }
});

// Lint endpoint — supports ChkTeX and lacheck
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
        const { stdout, stderr } = await execFileAsync('lacheck', [tmpFile], { timeout: 5000, env }).catch(
          (e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }),
        );
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
        const { stdout, stderr } = await execFileAsync(
          'chktex',
          ['-v0', '-q', '-f', '%l:%c:%d:%n:%k:%m\\n', tmpFile],
          { timeout: 5000, env },
        ).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || '' }));

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

// Word count using texcount
router.get('/:projectId/wordcount', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!(await requireMembership(projectId, req.session.userId, res))) return;

    const project = await db.get('SELECT main_file, tex_distribution, compiler FROM projects WHERE id = $1', [projectId]);
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

// Compare files with latexdiff — SSE streaming
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

  const stripPaths = (text) => text.replace(/\/[^\s:)]+\//g, '');
  const send = (event, data) => {
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
      res.end();
      return;
    }

    const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [projectId]);
    const projectDir = path.join(PROJECTS_DIR, projectId);

    // Run latexdiff (doesn't touch the project dir, works on content strings)
    send('output', { text: `Running latexdiff: ${oldFile.path} → ${newFile.path}...\n` });

    let diffOutput;
    try {
      diffOutput = await latexDiff(oldFile.content || '', newFile.content || '', { workDir: projectDir });
    } catch (diffErr) {
      send('output', { text: `Diff error: ${stripPaths(diffErr.message)}\n` });
      if (diffErr.stderr) send('output', { text: stripPaths(diffErr.stderr) + '\n' });
      send('done', { success: false, log: stripPaths(diffErr.message) });
      res.end();
      return;
    }

    const userSuffix = '_' + req.session.userId.slice(0, 8);
    const diffJobName = '__diff__' + userSuffix;

    // Write diff to temp file and compile
    send('output', { text: 'Compiling diff...\n' });
    try {
      const { pdfPath, log } = await compileProject(
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
    } catch (compileErr) {
      // Read the log file and stream it to the console
      const diffLogPath = path.join(projectDir, diffJobName + '.log');
      if (fs.existsSync(diffLogPath)) {
        const logContents = fs.readFileSync(diffLogPath, 'utf-8');
        send('output', { text: stripPaths('\n--- diff log ---\n' + logContents + '\n') });
      }
      // Check if PDF was produced anyway
      const diffPdfPath = path.join(projectDir, diffJobName + '.pdf');
      if (fs.existsSync(diffPdfPath)) {
        send('done', { success: true, log: stripPaths(compileErr.message) });
      } else {
        send('done', { success: false, log: stripPaths(compileErr.message) });
      }
    }
  } catch (err) {
    send('done', { success: false, log: stripPaths(err.message) });
  }

  res.end();
});

// Serve diff PDF
router.get('/:projectId/diff-pdf', async (req, res) => {
  const { projectId } = req.params;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const userSuffix = '_' + req.session.userId.slice(0, 8);
  const pdfPath = path.join(PROJECTS_DIR, projectId, '__diff__' + userSuffix + '.pdf');
  res.set('Cache-Control', 'no-store');
  res.sendFile(pdfPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Diff PDF not found. Run diff first.' });
    }
  });
});

// Delete LaTeX-generated files (aux, log, bbl, etc.)
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

  const userSuffix = '_' + req.session.userId.slice(0, 8);
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
  const userSuffix = '_' + req.session.userId.slice(0, 8);
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

router.post('/:projectId/clean', async (req, res) => {
  const projectId = req.params.projectId;
  if (!(await requireMembership(projectId, req.session.userId, res))) return;

  const projectDir = path.join(PROJECTS_DIR, projectId);
  if (!fs.existsSync(projectDir)) return res.json({ deleted: 0 });

  const generatedExts = new Set([
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

  const userSuffix = '_' + req.session.userId.slice(0, 8);
  let deleted = 0;
  const entries = fs.readdirSync(projectDir);
  for (const entry of entries) {
    const ext = entry.includes('.') ? '.' + entry.split('.').slice(1).join('.') : '';
    const lowerExt = ext.toLowerCase();
    if (generatedExts.has(lowerExt) || lowerExt === '.synctex.gz') {
      // Only delete files generated by the requesting user
      const baseName = entry.split('.')[0];
      if (!baseName.endsWith(userSuffix)) continue;
      try {
        fs.unlinkSync(path.join(projectDir, entry));
        deleted++;
      } catch {}
    }
  }
  res.json({ deleted });
});

// --- LaTeX formatters ---
const KNOWN_FORMATTERS = [
  { id: 'latexindent', name: 'latexindent', commands: ['latexindent', '/opt/local/bin/latexindent'] },
  { id: 'texfmt', name: 'texfmt', commands: ['texfmt'] },
];

let _cachedFormatters = null;
let _formattersCacheTime = 0;

// Allowed directories for formatter executables
const SAFE_BIN_DIRS = new Set([
  '/opt/local/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/Library/TeX/texbin',
]);

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
          const m = out.match(/(\d+\.\d+[\.\d]*)/);
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
