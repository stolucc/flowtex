import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock db.js before importing compiler
vi.mock('../db.js', () => ({
  default: { get: vi.fn(), run: vi.fn(), all: vi.fn() },
}));

// Mock fs and fs/promises
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(),
    },
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
  };
});

// `vi.mock` is hoisted, so external references in the factory must be
// hoisted too via `vi.hoisted`. After syncFilesToDisk switched from
// fsp.writeFile to fsp.open(path).writeFile(buf), we forward the open()
// path through the FileHandle stub so existing (path, content) assertions
// on the writeFile spy still match.
const { fspWriteFileSpy, makeOpenSpy } = vi.hoisted(() => {
  const spy = vi.fn(async () => {});
  let lastPath;
  const handle = {
    writeFile: vi.fn(async (buf) => spy(lastPath, buf)),
    close: vi.fn(async () => {}),
  };
  const open = vi.fn(async (p) => {
    lastPath = p;
    return handle;
  });
  return { fspWriteFileSpy: spy, makeOpenSpy: open };
});
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => {}),
    writeFile: fspWriteFileSpy,
    readdir: vi.fn(async () => []),
    unlink: vi.fn(async () => {}),
    open: makeOpenSpy,
  },
  mkdir: vi.fn(async () => {}),
  writeFile: fspWriteFileSpy,
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => {}),
  open: makeOpenSpy,
}));

// Mock fileBytes so syncFilesToDisk tests can stub the byte source
// without provisioning a real on-disk blob.
const { loadFileBytesMock } = vi.hoisted(() => ({
  loadFileBytesMock: vi.fn(async (_projectId, file) =>
    file.is_binary ? Buffer.alloc(0) : (file.content ?? ''),
  ),
}));
vi.mock('../services/fileBytes.js', () => ({
  loadFileBytes: loadFileBytesMock,
}));

// Now import the module under test
import {
  TEX_PATHS,
  getTexPaths,
  COMPILERS,
  stopCompilation,
  compileMetrics,
  invalidateFileCache,
  syncFilesToDisk,
  PROJECTS_DIR,
  _testing,
} from '../compiler.js';

import fs from 'fs';
import fsp from 'fs/promises';

const { safePath, recordCompile, fileHashCache, contentHash } = _testing;

// ---------------------------------------------------------------------------
// TEX_PATHS
// ---------------------------------------------------------------------------
describe('TEX_PATHS', () => {
  it('is a non-empty string', () => {
    expect(typeof TEX_PATHS).toBe('string');
    expect(TEX_PATHS.length).toBeGreaterThan(0);
  });

  it('contains /usr/local/bin', () => {
    expect(TEX_PATHS).toContain('/usr/local/bin');
  });

  it('contains /Library/TeX/texbin', () => {
    expect(TEX_PATHS).toContain('/Library/TeX/texbin');
  });
});

// ---------------------------------------------------------------------------
// getTexPaths
// ---------------------------------------------------------------------------
describe('getTexPaths', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns TEX_PATHS when distro is null', () => {
    expect(getTexPaths(null)).toBe(TEX_PATHS);
  });

  it('returns TEX_PATHS when distro is undefined', () => {
    expect(getTexPaths(undefined)).toBe(TEX_PATHS);
  });

  it('returns TEX_PATHS when distro is empty string', () => {
    expect(getTexPaths('')).toBe(TEX_PATHS);
  });

  it('returns TEX_PATHS when distro is not a 4-digit year', () => {
    expect(getTexPaths('abc')).toBe(TEX_PATHS);
    expect(getTexPaths('12345')).toBe(TEX_PATHS);
    expect(getTexPaths('99')).toBe(TEX_PATHS);
  });

  it('returns TEX_PATHS when valid year but no paths exist on disk', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(getTexPaths('2025')).toBe(TEX_PATHS);
  });

  it('returns year-specific paths when some exist on disk', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === '/usr/local/texlive/2025/bin/universal-darwin';
    });

    const result = getTexPaths('2025');
    expect(result).toContain('/usr/local/texlive/2025/bin/universal-darwin');
    expect(result).toContain('/usr/local/bin');
    expect(result).toContain('/usr/bin');
    // Should NOT contain the default TEX_PATHS prefix like /Library/TeX/texbin
    expect(result).not.toContain('/Library/TeX/texbin');
  });

  it('includes all existing year paths', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === '/usr/local/texlive/2024/bin/universal-darwin' || p === '/usr/local/texlive/2024/bin/x86_64-darwin';
    });

    const result = getTexPaths('2024');
    expect(result).toContain('/usr/local/texlive/2024/bin/universal-darwin');
    expect(result).toContain('/usr/local/texlive/2024/bin/x86_64-darwin');
  });

  it('accepts numeric year as well as string', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === '/usr/local/texlive/2025/bin/universal-darwin';
    });
    const result = getTexPaths(2025);
    expect(result).toContain('/usr/local/texlive/2025/bin/universal-darwin');
  });
});

// ---------------------------------------------------------------------------
// COMPILERS
// ---------------------------------------------------------------------------
describe('COMPILERS', () => {
  it('has exactly 3 entries', () => {
    expect(COMPILERS).toHaveLength(3);
  });

  it('each entry has id, name, and flag properties', () => {
    for (const c of COMPILERS) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('flag');
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.flag).toBe('string');
    }
  });

  it('includes pdflatex with flag -pdf', () => {
    const pdflatex = COMPILERS.find((c) => c.id === 'pdflatex');
    expect(pdflatex).toBeDefined();
    expect(pdflatex.flag).toBe('-pdf');
    expect(pdflatex.name).toBe('pdfLaTeX');
  });

  it('includes xelatex with flag -xelatex', () => {
    const xelatex = COMPILERS.find((c) => c.id === 'xelatex');
    expect(xelatex).toBeDefined();
    expect(xelatex.flag).toBe('-xelatex');
  });

  it('includes lualatex with flag -lualatex', () => {
    const lualatex = COMPILERS.find((c) => c.id === 'lualatex');
    expect(lualatex).toBeDefined();
    expect(lualatex.flag).toBe('-lualatex');
  });
});

// ---------------------------------------------------------------------------
// stopCompilation
// ---------------------------------------------------------------------------
describe('stopCompilation', () => {
  it('returns a promise that resolves to false if no active compilation', async () => {
    const result = await stopCompilation('nonexistent-project-id');
    expect(result).toBe(false);
  });

  it('returns a promise (always thenable)', () => {
    const result = stopCompilation('no-such-project');
    expect(result).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// compileMetrics & recordCompile
// ---------------------------------------------------------------------------
describe('compileMetrics', () => {
  it('has the expected shape', () => {
    expect(compileMetrics).toHaveProperty('total');
    expect(compileMetrics).toHaveProperty('success');
    expect(compileMetrics).toHaveProperty('failed');
    expect(compileMetrics).toHaveProperty('active');
    expect(compileMetrics).toHaveProperty('history');
    expect(Array.isArray(compileMetrics.history)).toBe(true);
  });

  it('active starts at 0', () => {
    expect(compileMetrics.active).toBe(0);
  });
});

describe('recordCompile', () => {
  let initialTotal, initialSuccess, initialFailed;

  beforeEach(() => {
    initialTotal = compileMetrics.total;
    initialSuccess = compileMetrics.success;
    initialFailed = compileMetrics.failed;
  });

  it('increments total and success on successful compile', () => {
    recordCompile(true, 1500);
    expect(compileMetrics.total).toBe(initialTotal + 1);
    expect(compileMetrics.success).toBe(initialSuccess + 1);
    expect(compileMetrics.failed).toBe(initialFailed);
  });

  it('increments total and failed on failed compile', () => {
    recordCompile(false, 2000);
    expect(compileMetrics.total).toBe(initialTotal + 1);
    expect(compileMetrics.failed).toBe(initialFailed + 1);
    expect(compileMetrics.success).toBe(initialSuccess);
  });

  it('appends to history with time, duration, and success', () => {
    const before = Date.now();
    recordCompile(true, 500);
    const after = Date.now();
    const last = compileMetrics.history[compileMetrics.history.length - 1];
    expect(last.duration).toBe(500);
    expect(last.success).toBe(true);
    expect(last.time).toBeGreaterThanOrEqual(before);
    expect(last.time).toBeLessThanOrEqual(after);
  });

  it('caps history at 300 entries', () => {
    // Fill history to 300+
    const count = 305 - compileMetrics.history.length;
    for (let i = 0; i < count; i++) {
      recordCompile(true, 100);
    }
    expect(compileMetrics.history.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------
describe('contentHash', () => {
  it('returns a 32-character hex string (md5)', () => {
    const hash = contentHash('hello world');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns same hash for same content', () => {
    expect(contentHash('test')).toBe(contentHash('test'));
  });

  it('returns different hash for different content', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

// ---------------------------------------------------------------------------
// invalidateFileCache
// ---------------------------------------------------------------------------
describe('invalidateFileCache', () => {
  beforeEach(() => {
    fileHashCache.clear();
  });

  it('removes entries matching the projectId prefix', () => {
    fileHashCache.set('proj1:main.tex', 'abc');
    fileHashCache.set('proj1:chapter/intro.tex', 'def');
    fileHashCache.set('proj2:main.tex', 'ghi');

    invalidateFileCache('proj1');

    expect(fileHashCache.has('proj1:main.tex')).toBe(false);
    expect(fileHashCache.has('proj1:chapter/intro.tex')).toBe(false);
    expect(fileHashCache.has('proj2:main.tex')).toBe(true);
  });

  it('does nothing when no entries match', () => {
    fileHashCache.set('proj2:main.tex', 'ghi');
    invalidateFileCache('proj999');
    expect(fileHashCache.size).toBe(1);
  });

  it('handles empty cache gracefully', () => {
    expect(() => invalidateFileCache('anything')).not.toThrow();
  });

  it('does not remove entries with similar but non-matching prefixes', () => {
    fileHashCache.set('proj1:main.tex', 'abc');
    fileHashCache.set('proj10:main.tex', 'def');

    invalidateFileCache('proj1');

    expect(fileHashCache.has('proj1:main.tex')).toBe(false);
    // proj10 should NOT be removed — key starts with "proj10:" not "proj1:"
    expect(fileHashCache.has('proj10:main.tex')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syncFilesToDisk
// ---------------------------------------------------------------------------
describe('syncFilesToDisk', () => {
  beforeEach(() => {
    fileHashCache.clear();
    vi.mocked(fsp.mkdir).mockReset().mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(fsp.readdir).mockReset().mockResolvedValue([]);
  });

  it('creates the project directory', async () => {
    await syncFilesToDisk('proj-abc', []);
    const expectedDir = path.join(PROJECTS_DIR, 'proj-abc');
    expect(fsp.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
  });

  it('writes a text file to disk', async () => {
    const files = [{ path: 'main.tex', content: '\\documentclass{article}', is_binary: false }];
    await syncFilesToDisk('proj-abc', files);

    const expectedPath = path.join(PROJECTS_DIR, 'proj-abc', 'main.tex');
    expect(fsp.writeFile).toHaveBeenCalledWith(expectedPath, '\\documentclass{article}');
  });

  it('writes a binary file streamed from the blob store', async () => {
    // Phase C: binary rows reference a sha256 in the blob store. The
    // file's bytes are pulled via loadFileBytes (mocked above to bypass
    // an actual disk read at services/fileBytes.js).
    const bytes = Buffer.from('binary data here');
    loadFileBytesMock.mockResolvedValueOnce(bytes);
    const files = [{
      path: 'image.png',
      content: '',
      is_binary: true,
      binary_sha256: 'a'.repeat(64),
    }];
    await syncFilesToDisk('proj-abc', files);

    const expectedPath = path.join(PROJECTS_DIR, 'proj-abc', 'image.png');
    expect(fsp.writeFile).toHaveBeenCalledWith(expectedPath, bytes);
  });

  it('creates subdirectories for nested file paths', async () => {
    const files = [{ path: 'chapters/intro.tex', content: 'hello', is_binary: false }];
    await syncFilesToDisk('proj-abc', files);

    const expectedDir = path.join(PROJECTS_DIR, 'proj-abc', 'chapters');
    // mkdir is called for project dir + for file's parent dir
    expect(fsp.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
  });

  it('skips writing unchanged files (hash cache hit)', async () => {
    const files = [{ path: 'main.tex', content: 'same content', is_binary: false }];

    // First write — should actually write
    await syncFilesToDisk('proj-abc', files);
    expect(fsp.writeFile).toHaveBeenCalledTimes(1);

    vi.mocked(fsp.writeFile).mockClear();

    // Second write with identical content — should skip
    await syncFilesToDisk('proj-abc', files);
    expect(fsp.writeFile).not.toHaveBeenCalled();
  });

  it('writes again if content changes', async () => {
    await syncFilesToDisk('proj-abc', [{ path: 'main.tex', content: 'v1', is_binary: false }]);
    vi.mocked(fsp.writeFile).mockClear();

    await syncFilesToDisk('proj-abc', [{ path: 'main.tex', content: 'v2', is_binary: false }]);
    expect(fsp.writeFile).toHaveBeenCalledTimes(1);
  });

  it('calls removeSymlinks (readdir on project dir)', async () => {
    await syncFilesToDisk('proj-abc', []);
    const expectedDir = path.join(PROJECTS_DIR, 'proj-abc');
    expect(fsp.readdir).toHaveBeenCalledWith(expectedDir, { withFileTypes: true });
  });

  it('handles files with null/undefined content gracefully', async () => {
    const files = [{ path: 'empty.tex', content: null, is_binary: false }];
    await expect(syncFilesToDisk('proj-abc', files)).resolves.not.toThrow();
  });

  it('writes multiple files in parallel', async () => {
    const files = [
      { path: 'a.tex', content: 'aaa', is_binary: false },
      { path: 'b.tex', content: 'bbb', is_binary: false },
      { path: 'c.tex', content: 'ccc', is_binary: false },
    ];
    await syncFilesToDisk('proj-abc', files);
    expect(fsp.writeFile).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// safePath (via _testing export)
// ---------------------------------------------------------------------------
describe('safePath (via _testing)', () => {
  const projectDir = path.join(PROJECTS_DIR, 'test-proj');

  it('resolves a simple filename', () => {
    expect(safePath(projectDir, 'main.tex')).toBe(path.join(projectDir, 'main.tex'));
  });

  it('resolves a nested path', () => {
    expect(safePath(projectDir, 'chapters/intro.tex')).toBe(path.join(projectDir, 'chapters', 'intro.tex'));
  });

  it('rejects path traversal', () => {
    expect(() => safePath(projectDir, '../../etc/passwd')).toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => safePath(projectDir, '/etc/passwd')).toThrow('Invalid file path');
  });

  it('rejects null bytes', () => {
    expect(() => safePath(projectDir, 'foo\0bar')).toThrow('Invalid file path');
  });
});
