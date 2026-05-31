import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import {
  parseFlsInputs,
  buildManifest,
  readManifest,
  writeManifest,
  diffManifests,
  detectRerunSignals,
  analyzeRebuild,
  checkBuildCache,
} from '../utils/rebuildAnalyzer.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flowtex-rebuild-'));
}

describe('parseFlsInputs', () => {
  it('extracts INPUT lines that point inside projectDir, deduped', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'main.tex'), '');
    await fsp.writeFile(path.join(dir, 'chap.tex'), '');
    const fls = [
      `PWD ${dir}`,
      `INPUT ${path.join(dir, 'main.tex')}`,
      `INPUT ${path.join(dir, 'chap.tex')}`,
      `INPUT ${path.join(dir, 'main.tex')}`, // dup
      `OUTPUT ${path.join(dir, 'main.pdf')}`,
      `INPUT /usr/local/texlive/2024/texmf-dist/tex/latex/base/article.cls`, // system
      `INPUT ${path.join(dir, 'main.aux')}`, // intermediate, skipped
    ].join('\n');
    const inputs = parseFlsInputs(fls, dir);
    expect(inputs.sort()).toEqual(['chap.tex', 'main.tex']);
  });

  it('returns empty for empty/missing content', () => {
    expect(parseFlsInputs('', '/tmp/x')).toEqual([]);
    expect(parseFlsInputs(null, '/tmp/x')).toEqual([]);
  });

  it('skips the manifest and profile files themselves', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'a.flowtex-build-manifest.json'), '{}');
    await fsp.writeFile(path.join(dir, 'a.profile.jsonl'), '');
    await fsp.writeFile(path.join(dir, 'real.tex'), '');
    const fls = [
      `INPUT ${path.join(dir, 'real.tex')}`,
      `INPUT ${path.join(dir, 'a.flowtex-build-manifest.json')}`,
      `INPUT ${path.join(dir, 'a.profile.jsonl')}`,
    ].join('\n');
    expect(parseFlsInputs(fls, dir)).toEqual(['real.tex']);
  });
});

describe('buildManifest / readManifest / writeManifest', () => {
  it('round-trips a manifest and includes sha256 + size + mtime for each file', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'a.tex'), 'hello');
    await fsp.writeFile(path.join(dir, 'b.tex'), 'world');
    const m = await buildManifest(dir, ['a.tex', 'b.tex']);
    expect(Object.keys(m.files).sort()).toEqual(['a.tex', 'b.tex']);
    expect(m.files['a.tex'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.files['a.tex'].size).toBe(5);
    expect(m.version).toBe(1);

    await writeManifest(dir, 'main', m);
    const round = readManifest(dir, 'main');
    expect(round).toEqual(m);
  });

  it('readManifest returns null for missing or invalid files', () => {
    expect(readManifest('/no/such/dir', 'x')).toBeNull();
  });

  it('skips files that cannot be read (treated as removed by diff)', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'real.tex'), 'x');
    const m = await buildManifest(dir, ['real.tex', 'ghost.tex']);
    expect(Object.keys(m.files)).toEqual(['real.tex']);
  });
});

describe('diffManifests', () => {
  const mk = (files) => ({ version: 1, builtAt: 0, files });

  it('detects added, removed, and modified files', () => {
    const prev = mk({
      'a.tex': { sha256: 'aaa', size: 1, mtimeMs: 0 },
      'b.tex': { sha256: 'bbb', size: 1, mtimeMs: 0 },
    });
    const next = mk({
      'a.tex': { sha256: 'aaa', size: 1, mtimeMs: 0 },          // unchanged
      'b.tex': { sha256: 'bbb_new', size: 2, mtimeMs: 1 },      // modified
      'c.tex': { sha256: 'ccc', size: 1, mtimeMs: 0 },          // added
    });
    const changes = diffManifests(prev, next);
    expect(changes).toEqual([
      { path: 'b.tex', change: 'modified' },
      { path: 'c.tex', change: 'added' },
    ]);
  });

  it('sorts modified before added before removed, alphabetically within', () => {
    const prev = mk({
      'old1.tex': { sha256: 'x', size: 0, mtimeMs: 0 },
      'old2.tex': { sha256: 'y', size: 0, mtimeMs: 0 },
      'mod-b.tex': { sha256: 'mb', size: 0, mtimeMs: 0 },
      'mod-a.tex': { sha256: 'ma', size: 0, mtimeMs: 0 },
    });
    const next = mk({
      'mod-a.tex': { sha256: 'ma2', size: 0, mtimeMs: 0 },
      'mod-b.tex': { sha256: 'mb2', size: 0, mtimeMs: 0 },
      'new-b.tex': { sha256: 'nb', size: 0, mtimeMs: 0 },
      'new-a.tex': { sha256: 'na', size: 0, mtimeMs: 0 },
    });
    const changes = diffManifests(prev, next);
    expect(changes.map((c) => `${c.change}:${c.path}`)).toEqual([
      'modified:mod-a.tex',
      'modified:mod-b.tex',
      'added:new-a.tex',
      'added:new-b.tex',
      'removed:old1.tex',
      'removed:old2.tex',
    ]);
  });

  it('returns [] when nothing changed', () => {
    const m = mk({ 'a.tex': { sha256: 'aaa', size: 1, mtimeMs: 0 } });
    expect(diffManifests(m, m)).toEqual([]);
  });
});

describe('detectRerunSignals', () => {
  it('flags "Label(s) may have changed"', () => {
    expect(detectRerunSignals('LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.'))
      .toMatch(/cross-references/);
  });

  it('flags undefined citations', () => {
    expect(detectRerunSignals('LaTeX Warning: Citation `foo` on page 3 undefined on input line 7.'))
      .toMatch(/undefined citations/);
  });

  it('returns null when the log is clean', () => {
    expect(detectRerunSignals('Output written on main.pdf.\nTranscript written.')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectRerunSignals('')).toBeNull();
    expect(detectRerunSignals(null)).toBeNull();
  });
});

describe('analyzeRebuild (end-to-end)', () => {
  it('reports "initial" on the first build and persists a manifest', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'main.tex'), 'hello');
    const fls = `INPUT ${path.join(dir, 'main.tex')}\n`;
    await fsp.writeFile(path.join(dir, 'main.fls'), fls);
    const reason = await analyzeRebuild({ projectDir: dir, jobName: 'main', logContent: '' });
    expect(reason.kind).toBe('initial');
    expect(reason.changedFiles).toEqual([]);
    // A manifest is persisted so the next build can diff.
    expect(readManifest(dir, 'main')).toBeTruthy();
  });

  it('reports "changed" with the modified file on the second build', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'main.tex'), 'v1');
    await fsp.writeFile(path.join(dir, 'main.fls'), `INPUT ${path.join(dir, 'main.tex')}\n`);
    await analyzeRebuild({ projectDir: dir, jobName: 'main', logContent: '' });

    // Modify the file and re-run.
    await fsp.writeFile(path.join(dir, 'main.tex'), 'v2');
    const reason = await analyzeRebuild({ projectDir: dir, jobName: 'main', logContent: '' });
    expect(reason.kind).toBe('changed');
    expect(reason.changedFiles).toEqual([{ path: 'main.tex', change: 'modified' }]);
  });

  it('reports "unchanged" when nothing actually changed', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'main.tex'), 'stable');
    await fsp.writeFile(path.join(dir, 'main.fls'), `INPUT ${path.join(dir, 'main.tex')}\n`);
    await analyzeRebuild({ projectDir: dir, jobName: 'main', logContent: '' });
    const reason = await analyzeRebuild({ projectDir: dir, jobName: 'main', logContent: '' });
    expect(reason.kind).toBe('unchanged');
    expect(reason.changedFiles).toEqual([]);
  });

  it('forwards rerun reasons detected in the log', async () => {
    const dir = tmpDir();
    await fsp.writeFile(path.join(dir, 'main.tex'), 'x');
    await fsp.writeFile(path.join(dir, 'main.fls'), `INPUT ${path.join(dir, 'main.tex')}\n`);
    const reason = await analyzeRebuild({
      projectDir: dir,
      jobName: 'main',
      logContent: 'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
    });
    expect(reason.rerunReason).toMatch(/cross-references/);
  });
});

describe('checkBuildCache (skip-rebuild)', () => {
  async function seed(dir, content, env = { compiler: 'pdflatex', texDistribution: null }) {
    await fsp.writeFile(path.join(dir, 'main.tex'), content);
    await fsp.writeFile(path.join(dir, 'main.fls'), `INPUT ${path.join(dir, 'main.tex')}\n`);
    await analyzeRebuild({ projectDir: dir, jobName: 'main', logContent: '', env });
  }

  it('misses when no previous manifest exists', async () => {
    const dir = tmpDir();
    const r = await checkBuildCache({ projectDir: dir, jobName: 'main', compiler: 'pdflatex', texDistribution: null });
    expect(r.hit).toBe(false);
    expect(r.reason).toMatch(/no previous build/);
  });

  it('hits when no input changed and env matches', async () => {
    const dir = tmpDir();
    await seed(dir, 'stable');
    const r = await checkBuildCache({ projectDir: dir, jobName: 'main', compiler: 'pdflatex', texDistribution: null });
    expect(r.hit).toBe(true);
  });

  it('misses when an input file content changed', async () => {
    const dir = tmpDir();
    await seed(dir, 'v1');
    await fsp.writeFile(path.join(dir, 'main.tex'), 'v2');
    const r = await checkBuildCache({ projectDir: dir, jobName: 'main', compiler: 'pdflatex', texDistribution: null });
    expect(r.hit).toBe(false);
    expect(r.reason).toMatch(/inputs changed/);
    expect(r.changedFiles).toEqual([{ path: 'main.tex', change: 'modified' }]);
  });

  it('misses when an input file is removed', async () => {
    const dir = tmpDir();
    await seed(dir, 'stable');
    await fsp.unlink(path.join(dir, 'main.tex'));
    const r = await checkBuildCache({ projectDir: dir, jobName: 'main', compiler: 'pdflatex', texDistribution: null });
    expect(r.hit).toBe(false);
    expect(r.changedFiles?.[0]).toMatchObject({ change: 'removed' });
  });

  it('misses when the compiler changes between builds', async () => {
    const dir = tmpDir();
    await seed(dir, 'stable', { compiler: 'pdflatex', texDistribution: null });
    const r = await checkBuildCache({ projectDir: dir, jobName: 'main', compiler: 'xelatex', texDistribution: null });
    expect(r.hit).toBe(false);
    expect(r.reason).toMatch(/compiler/);
  });

  it('misses when the tex distribution changes between builds', async () => {
    const dir = tmpDir();
    await seed(dir, 'stable', { compiler: 'pdflatex', texDistribution: 'texlive-2024' });
    const r = await checkBuildCache({ projectDir: dir, jobName: 'main', compiler: 'pdflatex', texDistribution: 'texlive-2025' });
    expect(r.hit).toBe(false);
  });

  it('misses when the previous manifest had no tracked inputs', async () => {
    const dir = tmpDir();
    // Manifest with zero files (corner case: .fls was missing or empty).
    await writeManifest(dir, 'main', { version: 1, builtAt: Date.now(), env: { compiler: 'pdflatex', texDistribution: null }, files: {} });
    const r = await checkBuildCache({ projectDir: dir, jobName: 'main', compiler: 'pdflatex', texDistribution: null });
    expect(r.hit).toBe(false);
    expect(r.reason).toMatch(/no tracked inputs/);
  });
});
