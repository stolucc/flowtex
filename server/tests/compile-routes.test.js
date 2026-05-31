import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireMember: vi.fn(),
}));

vi.mock('../compiler.js', () => ({
  compileProject: vi.fn(),
  synctexForward: vi.fn(),
  synctexInverse: vi.fn(),
  stopCompilation: vi.fn(),
  syncFilesToDisk: vi.fn(),
  invalidateFileCache: vi.fn(),
  userSuffix: (userId, opts = {}) => (userId ? '_' + userId.slice(0, 8) : '') + (opts.tc ? '_tc' : ''),
  GENERATED_EXTS: new Set(['.aux', '.log', '.fls', '.fdb_latexmk', '.synctex.gz', '.synctex', '.bbl', '.blg', '.out', '.toc', '.lof', '.lot', '.nav', '.snm', '.vrb', '.idx', '.ind', '.ilg', '.glo', '.gls', '.glg', '.cb', '.cb2', '.bcf', '.run.xml', '.xdv']),
  TEX_PATHS: '/usr/local/texlive/bin',
  getTexPaths: vi.fn(() => '/usr/local/texlive/bin'),
  detectTexDistributions: vi.fn(() => [{ id: 'texlive2024', name: 'TeX Live 2024' }]),
}));

vi.mock('../utils/latexDiff.js', () => ({
  default: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock fs — we need specific behaviors per test
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ size: 1024, mtime: new Date('2025-01-01') })),
      mkdtempSync: vi.fn(() => '/tmp/flowtex-fmt-xxx'),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      rmSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 1024, mtime: new Date('2025-01-01') })),
    mkdtempSync: vi.fn(() => '/tmp/flowtex-fmt-xxx'),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Mock child_process to prevent actual exec calls
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => ''),
}));

import db from '../db.js';
import { requireMember } from '../middleware/auth.js';
import { compileProject, stopCompilation, detectTexDistributions } from '../compiler.js';
import fs from 'fs';
import router from '../routes/compile.js';

// ── Handler extraction ──────────────────────────────────────────────────
function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        return layer.route.stack[0].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────
function mockReq(params = {}, body = {}, overrides = {}) {
  return {
    params,
    body,
    query: {},
    session: { userId: 'user-1', userName: 'Alice' },
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(function (data) {
      res.body = data;
      return res;
    }),
    sendFile: vi.fn(function (...args) {
      // Express supports both res.sendFile(path, cb) and
      // res.sendFile(path, options, cb). Find the trailing callback.
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null); // success by default
    }),
    set: vi.fn().mockReturnThis(),
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  return res;
}

const MEMBER = { role: 'editor' };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: requireMember resolves to a member
  requireMember.mockResolvedValue(MEMBER);
});

// ═════════════════════════════════════════════════════════════════════════
// POST /:projectId — compile a project
// ═════════════════════════════════════════════════════════════════════════
describe('POST /:projectId', () => {
  const handler = getHandler('post', '/:projectId');

  it('compiles a project and returns success', async () => {
    db.all.mockResolvedValueOnce([{ path: 'main.tex', content: '\\begin{document}', is_binary: false }]);
    db.get.mockResolvedValueOnce({ main_file: 'main.tex', tex_distribution: null, compiler: 'pdflatex' });
    compileProject.mockResolvedValueOnce({ pdfPath: '/tmp/main.pdf', log: 'Done' });

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body).toMatchObject({ success: true, log: 'Done', cached: false });
    expect(compileProject).toHaveBeenCalledWith(
      'proj-1',
      'main.tex',
      null,
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('returns 403 when user is not a project member', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    // requireMembership calls requireMember which sends 403 itself
    // The handler returns early after requireMembership returns false
    expect(compileProject).not.toHaveBeenCalled();
  });

  it('returns 400 when compilation fails', async () => {
    db.all.mockResolvedValueOnce([]);
    db.get.mockResolvedValueOnce({ main_file: 'main.tex' });
    compileProject.mockRejectedValueOnce(new Error('pdflatex failed'));

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.success).toBe(false);
    expect(res.body.log).toContain('pdflatex failed');
  });

  it('defaults main_file to main.tex when project has none', async () => {
    db.all.mockResolvedValueOnce([]);
    db.get.mockResolvedValueOnce({ main_file: null });
    compileProject.mockResolvedValueOnce({ pdfPath: '/tmp/main.pdf', log: '' });

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(compileProject).toHaveBeenCalledWith('proj-1', 'main.tex', null, expect.anything());
  });

  it('strips internal paths from error messages', async () => {
    db.all.mockResolvedValueOnce([]);
    db.get.mockResolvedValueOnce({ main_file: 'main.tex' });
    compileProject.mockRejectedValueOnce(new Error('Error in /home/user/projects/proj-1/main.tex'));

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body.log).not.toContain('/home/user/projects/');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /:projectId/stop — stop compilation
// ═════════════════════════════════════════════════════════════════════════
describe('POST /:projectId/stop', () => {
  const handler = getHandler('post', '/:projectId/stop');

  it('stops compilation and returns ok', async () => {
    stopCompilation.mockResolvedValueOnce(true);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body).toEqual({ ok: true, stopped: true });
    expect(stopCompilation).toHaveBeenCalledWith('proj-1');
  });

  it('returns stopped: false when no active compilation', async () => {
    stopCompilation.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body).toEqual({ ok: true, stopped: false });
  });

  it('returns 403 when user is not a member', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(stopCompilation).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:projectId/pdf — serve compiled PDF
// ═════════════════════════════════════════════════════════════════════════
describe('GET /:projectId/pdf', () => {
  const handler = getHandler('get', '/:projectId/pdf');

  it('serves the PDF with a relative path and root option scoped to the project dir', async () => {
    db.get.mockResolvedValueOnce({ main_file: 'main.tex' });

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    // Relative filename (no path separators upstream of the project dir)
    expect(res.sendFile).toHaveBeenCalledWith(
      'main_user-1.pdf',
      expect.objectContaining({ root: expect.stringContaining('proj-1') }),
      expect.any(Function),
    );
  });

  it('returns 404 when PDF does not exist (sendFile error)', async () => {
    db.get.mockResolvedValueOnce({ main_file: 'main.tex' });

    const res = mockRes();
    // New signature: (relPath, options, cb) — cb is the third arg.
    res.sendFile = vi.fn((_relPath, _opts, cb) => cb(new Error('ENOENT')));
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toMatch(/pdf not found/i);
  });

  it('uses default main.tex when project has no main_file', async () => {
    db.get.mockResolvedValueOnce({ main_file: null });

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.sendFile).toHaveBeenCalledWith(
      expect.stringContaining('main_'),
      expect.objectContaining({ root: expect.any(String) }),
      expect.any(Function),
    );
  });

  it('selects the _tc sibling PDF when ?tc=1', async () => {
    db.get.mockResolvedValueOnce({ main_file: 'main.tex' });

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { tc: '1' } }), res);

    expect(res.sendFile).toHaveBeenCalledWith(
      'main_user-1_tc.pdf',
      expect.objectContaining({ root: expect.any(String) }),
      expect.any(Function),
    );
  });

  it('returns 403 for non-members', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.sendFile).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:projectId/generated-files — list generated files
// ═════════════════════════════════════════════════════════════════════════
describe('GET /:projectId/generated-files', () => {
  const handler = getHandler('get', '/:projectId/generated-files');

  it('returns generated files for the user', async () => {
    fs.existsSync.mockReturnValueOnce(true); // projectDir exists
    fs.readdirSync.mockReturnValueOnce([
      'main_user-1.aux',
      'main_user-1.log',
      'main_user-oth.aux', // different user
      'main_user-1.pdf', // not a generated ext
    ]);
    fs.statSync.mockReturnValue({ size: 512, mtime: new Date('2025-01-15') });

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body.files).toHaveLength(2);
    expect(res.body.files[0].name).toBe('main_user-1.aux');
    expect(res.body.files[1].name).toBe('main_user-1.log');
  });

  it('returns empty files when project directory does not exist', async () => {
    fs.existsSync.mockReturnValueOnce(false);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body).toEqual({ files: [] });
  });

  it('returns 403 for non-members', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('filters by user suffix — does not show other users files', async () => {
    fs.existsSync.mockReturnValueOnce(true);
    fs.readdirSync.mockReturnValueOnce(['main_otheruse.aux', 'main_otheruse.log']);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body.files).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:projectId/generated-file — read a generated file
// ═════════════════════════════════════════════════════════════════════════
describe('GET /:projectId/generated-file', () => {
  const handler = getHandler('get', '/:projectId/generated-file');

  it('returns 400 for missing file name', async () => {
    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/invalid file name/i);
  });

  it('returns 400 for path traversal attempt with ..', async () => {
    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { name: '../../../etc/passwd' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for file name with slashes', async () => {
    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { name: 'sub/file.aux' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for file name with null bytes', async () => {
    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { name: 'file\0.aux' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 403 for file belonging to another user', async () => {
    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { name: 'main_otheruse.aux' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when file does not exist on disk', async () => {
    fs.existsSync.mockReturnValueOnce(false);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { name: 'main_user-1.aux' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns file content for valid request', async () => {
    fs.existsSync.mockReturnValueOnce(true);
    fs.readFileSync.mockReturnValueOnce('\\relax \\citation{foo}');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { name: 'main_user-1.aux' } }), res);

    expect(res.body).toEqual({ name: 'main_user-1.aux', content: '\\relax \\citation{foo}' });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /texlive-distributions
// ═════════════════════════════════════════════════════════════════════════
describe('GET /texlive-distributions', () => {
  const handler = getHandler('get', '/texlive-distributions');

  it('returns detected distributions when authenticated', async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(detectTexDistributions).toHaveBeenCalled();
    expect(res.body).toEqual([{ id: 'texlive2024', name: 'TeX Live 2024' }]);
  });

  it('returns 401 when not authenticated', async () => {
    const res = mockRes();
    await handler(mockReq({}, {}, { session: {} }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /:projectId/clean — delete generated files
// ═════════════════════════════════════════════════════════════════════════
describe('POST /:projectId/clean', () => {
  const handler = getHandler('post', '/:projectId/clean');

  it('returns deleted count when files are cleaned', async () => {
    fs.existsSync.mockReturnValueOnce(true);
    fs.readdirSync.mockReturnValueOnce(['main_user-1.aux', 'main_user-1.log', 'main_user-1.bbl']);
    fs.unlinkSync.mockReturnValue(undefined);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body.deleted).toBe(3);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
  });

  it('returns deleted: 0 when project directory does not exist', async () => {
    fs.existsSync.mockReturnValueOnce(false);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body).toEqual({ deleted: 0 });
  });

  it('only deletes current user generated files, not other users', async () => {
    fs.existsSync.mockReturnValueOnce(true);
    fs.readdirSync.mockReturnValueOnce([
      'main_user-1.aux',    // matches user suffix
      'main_otheruse.aux',  // different user
      'main.aux',           // unsuffixed
    ]);
    fs.unlinkSync.mockReturnValue(undefined);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.body.deleted).toBe(1);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it('rejects viewers', async () => {
    requireMember.mockResolvedValueOnce({ role: 'viewer' });

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for non-members', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(fs.readdirSync).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /format — format LaTeX content
// ═════════════════════════════════════════════════════════════════════════
describe('POST /format', () => {
  const handler = getHandler('post', '/format');

  it('returns 400 when no content is provided', async () => {
    const res = mockRes();
    await handler(mockReq({}, { content: '' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/no content/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /:projectId/lint — lint endpoint validation
// ═════════════════════════════════════════════════════════════════════════
describe('POST /:projectId/lint', () => {
  const handler = getHandler('post', '/:projectId/lint');

  it('returns empty diagnostics when no content provided', async () => {
    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { content: '' }), res);

    expect(res.body).toEqual({ diagnostics: [] });
  });

  it('returns 400 for invalid linter name', async () => {
    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { content: 'hello', linter: 'evil-linter' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/invalid linter/i);
  });

  it('returns 403 for non-members', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { content: 'hello' }), res);

    // requireMembership sends 403 itself
    expect(fs.mkdtempSync).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:projectId/syncforward — forward sync validation
// ═════════════════════════════════════════════════════════════════════════
describe('GET /:projectId/syncforward', () => {
  const handler = getHandler('get', '/:projectId/syncforward');

  it('returns 403 for non-members', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { line: '5', column: '0' } }), res);

    // The handler returns early
    expect(db.get).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:projectId/syncinverse — inverse sync validation
// ═════════════════════════════════════════════════════════════════════════
describe('GET /:projectId/syncinverse', () => {
  const handler = getHandler('get', '/:projectId/syncinverse');

  it('returns 403 for non-members', async () => {
    requireMember.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, {}, { query: { page: '1', x: '100', y: '200' } }), res);

    expect(db.get).not.toHaveBeenCalled();
  });
});
