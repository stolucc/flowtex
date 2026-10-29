// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  snapshotDropEntries,
  collectEntries,
  itemsFromFileList,
  checkLimits,
  buildZip,
  runFolderUpload,
  isJunkPath,
  MAX_FOLDER_FILES,
  MAX_FILE_BYTES,
} from '../folderUpload.js';

// Minimal FileSystemEntry fakes (the File and Directory Entries API).
function fileEntry(name, content = name, size) {
  const file = new File([content], name);
  if (size != null) Object.defineProperty(file, 'size', { value: size });
  return { name, isFile: true, isDirectory: false, file: (ok) => ok(file) };
}
function dirEntry(name, children, batchSize = 100) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let i = 0;
      // Real browsers return readEntries in batches until an empty batch.
      return {
        readEntries(ok) {
          const batch = children.slice(i, i + batchSize);
          i += batchSize;
          ok(batch);
        },
      };
    },
  };
}
const fakeItem = (entry) => ({ kind: 'file', webkitGetAsEntry: () => entry });

describe('isJunkPath', () => {
  it('flags dotfiles, __MACOSX and OS thumbnails at any depth', () => {
    for (const p of ['.DS_Store', 'img/.DS_Store', '__MACOSX/a.png', 'a/.git/config', 'x/Thumbs.db', 'desktop.ini']) {
      expect(isJunkPath(p)).toBe(true);
    }
    expect(isJunkPath('images/fig.1.png')).toBe(false);
  });
});

describe('snapshotDropEntries', () => {
  it('collects entries and detects a directory', () => {
    const d = dirEntry('images', []);
    const f = fileEntry('a.txt');
    const r = snapshotDropEntries({ items: [fakeItem(f), fakeItem(d), { kind: 'string' }] });
    expect(r.entries).toEqual([f, d]);
    expect(r.hasDirectory).toBe(true);
    expect(snapshotDropEntries({ items: [fakeItem(f)] }).hasDirectory).toBe(false);
  });

  it('tolerates browsers without webkitGetAsEntry / no items', () => {
    expect(snapshotDropEntries({ items: [{ kind: 'file' }] })).toEqual({ entries: [], hasDirectory: false });
    expect(snapshotDropEntries({})).toEqual({ entries: [], hasDirectory: false });
  });
});

describe('collectEntries', () => {
  it('walks nested folders, keeps relative paths, skips junk', async () => {
    const tree = dirEntry('images', [
      fileEntry('a.png'),
      fileEntry('.DS_Store'),
      dirEntry('sub', [fileEntry('b.png')]),
      dirEntry('.hidden', [fileEntry('secret.txt')]),
    ]);
    const items = await collectEntries([tree, fileEntry('loose.tex')]);
    expect(items.map((i) => i.path)).toEqual(['images/a.png', 'images/sub/b.png', 'loose.tex']);
    expect(items[0].file).toBeInstanceOf(File);
  });

  it('prefixes the target folder', async () => {
    const items = await collectEntries([dirEntry('imgs', [fileEntry('a.png')])], 'chapters/one');
    expect(items.map((i) => i.path)).toEqual(['chapters/one/imgs/a.png']);
  });

  it('reads past the first readEntries batch (Chrome caps at 100)', async () => {
    const many = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.png`));
    const items = await collectEntries([dirEntry('big', many, 100)]);
    expect(items).toHaveLength(250);
  });
});

describe('itemsFromFileList', () => {
  it('uses webkitRelativePath, prefixes target, skips junk', () => {
    const mk = (rel) => {
      const f = new File(['x'], rel.split('/').pop());
      Object.defineProperty(f, 'webkitRelativePath', { value: rel });
      return f;
    };
    const items = itemsFromFileList([mk('pics/a.png'), mk('pics/.DS_Store'), mk('pics/s/b.jpg')], 'fig');
    expect(items.map((i) => i.path)).toEqual(['fig/pics/a.png', 'fig/pics/s/b.jpg']);
  });
});

describe('checkLimits', () => {
  const item = (path, size) => {
    const file = new File(['x'], path);
    Object.defineProperty(file, 'size', { value: size });
    return { file, path };
  };

  it('separates over-size files and passes the rest', () => {
    const r = checkLimits([item('a', 10), item('big', MAX_FILE_BYTES + 1)]);
    expect(r.ok.map((i) => i.path)).toEqual(['a']);
    expect(r.tooLarge).toEqual(['big']);
    expect(r.error).toBeNull();
  });

  it('rejects too many files and too many bytes, with the reason', () => {
    const lots = Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, i) => item(`f${i}`, 1));
    expect(checkLimits(lots).error).toMatch(/limit is 2000/);
    const heavy = Array.from({ length: 6 }, (_, i) => item(`f${i}`, 9 * 1024 * 1024));
    expect(checkLimits(heavy).error).toMatch(/54 MB.*limit is 50 MB/);
  });

  it('empty folder', () => {
    expect(checkLimits([]).error).toMatch(/empty/);
  });
});

describe('buildZip', () => {
  it('round-trips paths and bytes, uncompressed', async () => {
    const zip = await buildZip([
      { file: new File(['hello'], 'a.txt'), path: 'images/a.txt' },
      { file: new File([new Uint8Array([137, 80, 78, 71])], 'b.png'), path: 'images/sub/b.png' },
    ]);
    expect(zip.type).toBe('application/zip');
    const out = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(out).sort()).toEqual(['images/a.txt', 'images/sub/b.png']);
    expect(strFromU8(out['images/a.txt'])).toBe('hello');
    expect(Array.from(out['images/sub/b.png'])).toEqual([137, 80, 78, 71]);
  });
});

describe('runFolderUpload', () => {
  const items = (paths) => paths.map((p) => ({ file: new File(['x'], p.split('/').pop()), path: p }));
  const okRes = (files) => ({ ok: true, json: async () => ({ ok: true, files }) });
  const deps = (over = {}) => ({
    projectId: 'p1',
    existingPaths: [],
    upload: vi.fn(async () => okRes([])),
    alert: vi.fn(),
    confirm: vi.fn(async () => true),
    ...over,
  });

  it('posts one zip with preservePaths=1 and returns the new file list', async () => {
    const files = [{ path: 'images/a.png' }, { path: 'images/b.png' }];
    const d = deps({ upload: vi.fn(async () => okRes(files)) });
    const out = await runFolderUpload({ ...d, items: items(['images/a.png', 'images/b.png']) });
    expect(out).toEqual(files);
    expect(d.upload).toHaveBeenCalledTimes(1);
    const [url, form] = d.upload.mock.calls[0];
    expect(url).toBe('/api/projects/p1/upload-zip');
    expect(form.get('preservePaths')).toBe('1');
    const zip = unzipSync(new Uint8Array(await form.get('file').arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual(['images/a.png', 'images/b.png']);
    expect(d.alert).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it('asks before replacing existing files; cancelling uploads nothing', async () => {
    const d = deps({ existingPaths: ['images/a.png'], confirm: vi.fn(async () => false) });
    const out = await runFolderUpload({ ...d, items: items(['images/a.png', 'images/b.png']) });
    expect(out).toBeNull();
    expect(d.confirm).toHaveBeenCalledWith(expect.stringMatching(/1 file already exists.*images\/a\.png/), expect.objectContaining({ confirmLabel: 'Replace' }));
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('reports files the server did not accept', async () => {
    const d = deps({ upload: vi.fn(async () => okRes([{ path: 'images/a.png' }])) });
    await runFolderUpload({ ...d, items: items(['images/a.png', 'images/run.exe']) });
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/Uploaded 1 of 2.*Not accepted.*images\/run\.exe/s), expect.anything());
  });

  it('shows the server error (e.g. rate limit) and returns null', async () => {
    const d = deps({ upload: vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Too many uploads, please try again later' }) })) });
    const out = await runFolderUpload({ ...d, items: items(['a/b.png']) });
    expect(out).toBeNull();
    expect(d.alert).toHaveBeenCalledWith('Too many uploads, please try again later', expect.anything());
  });

  it('stops before uploading when over the limits', async () => {
    const d = deps();
    const big = Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, i) => `f/${i}.png`);
    await runFolderUpload({ ...d, items: items(big) });
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/limit is 2000/), expect.anything());
  });
});
