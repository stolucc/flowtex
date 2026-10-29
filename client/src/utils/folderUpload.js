// @ts-check
// Folder upload: turn a drag-and-drop (or <input webkitdirectory>) of a
// whole folder into one ZIP that POSTs to /api/projects/:id/upload-zip
// with preservePaths=1. One request instead of one per file -- the
// per-file upload route is rate-limited to 10 per 15 minutes -- and the
// server's existing ZIP guards (entry count, size, ratio, path, denied
// extensions, quotas) apply unchanged.

// Mirrors server/services/projectService.js + routes/projects.js. Checked
// client-side only to give a clear message up front; the server enforces.
export const MAX_FOLDER_FILES = 2000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024;

/** @typedef {{ file: File, path: string }} FolderItem */

/** Junk the OS adds to folders; the server would skip most of it anyway.
 *  @param {string} path */
export function isJunkPath(path) {
  return path.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX' || seg === 'Thumbs.db' || seg === 'desktop.ini');
}

/** @param {any} entry @returns {Promise<File>} */
function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** readEntries returns results in batches (100 in Chrome); call until empty.
 *  @param {any} dirEntry @returns {Promise<any[]>} */
async function readAllEntries(dirEntry) {
  const reader = dirEntry.createReader();
  /** @type {any[]} */
  const all = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** @param {any} entry @param {string} prefix @param {FolderItem[]} out */
async function walk(entry, prefix, out) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (isJunkPath(path)) return;
  if (entry.isFile) {
    out.push({ file: await entryFile(entry), path });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry)) await walk(child, path, out);
  }
}

/**
 * Snapshot the FileSystemEntry objects of a drop. MUST be called
 * synchronously inside the drop handler -- the DataTransferItemList is
 * emptied once the event returns.
 * @param {DataTransfer} dataTransfer
 * @returns {{ entries: any[], hasDirectory: boolean }}
 */
export function snapshotDropEntries(dataTransfer) {
  const entries = [];
  const items = dataTransfer?.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  return { entries, hasDirectory: entries.some((e) => e.isDirectory) };
}

/**
 * Expand dropped entries (files and folders, recursively) into
 * { file, path } items, with `targetFolder` prepended to every path.
 * @param {any[]} entries
 * @param {string} [targetFolder]
 * @returns {Promise<FolderItem[]>}
 */
export async function collectEntries(entries, targetFolder = '') {
  /** @type {FolderItem[]} */
  const out = [];
  for (const e of entries) await walk(e, targetFolder, out);
  return out;
}

/** Items from <input type="file" webkitdirectory> (each File carries
 *  webkitRelativePath = "folder/sub/file.png").
 *  @param {FileList | File[]} fileList
 *  @param {string} [targetFolder]
 *  @returns {FolderItem[]} */
export function itemsFromFileList(fileList, targetFolder = '') {
  const out = [];
  for (const file of Array.from(fileList)) {
    const rel = /** @type {any} */ (file).webkitRelativePath || file.name;
    const path = targetFolder ? `${targetFolder}/${rel}` : rel;
    if (!isJunkPath(path)) out.push({ file, path });
  }
  return out;
}

/**
 * Up-front limits check, so the user gets a precise reason instead of a
 * generic server error. Files over the per-file cap are dropped (and
 * reported); the rest must fit the count and request-size caps.
 * @param {FolderItem[]} items
 * @returns {{ ok: FolderItem[], tooLarge: string[], error: string | null }}
 */
export function checkLimits(items) {
  const tooLarge = items.filter((i) => i.file.size > MAX_FILE_BYTES).map((i) => i.path);
  const ok = items.filter((i) => i.file.size <= MAX_FILE_BYTES);
  if (ok.length === 0) {
    return { ok, tooLarge, error: tooLarge.length ? null : 'The folder is empty.' };
  }
  if (ok.length > MAX_FOLDER_FILES) {
    return { ok, tooLarge, error: `That folder has ${ok.length} files; the limit is ${MAX_FOLDER_FILES} per upload.` };
  }
  const total = ok.reduce((n, i) => n + i.file.size, 0);
  if (total > MAX_REQUEST_BYTES) {
    const mb = Math.ceil(total / 1024 / 1024);
    return { ok, tooLarge, error: `That folder is ${mb} MB; the limit is ${MAX_REQUEST_BYTES / 1024 / 1024} MB per upload. Upload it in parts.` };
  }
  return { ok, tooLarge, error: null };
}

/**
 * Pack items into an uncompressed ZIP (images/PDFs don't compress, and
 * level 0 keeps the server's compression-ratio guard trivially happy).
 * fflate is loaded on demand so it stays out of the main bundle.
 * @param {FolderItem[]} items
 * @returns {Promise<Blob>}
 */
export async function buildZip(items) {
  const { zipSync } = await import('fflate');
  /** @type {Record<string, Uint8Array>} */
  const tree = {};
  for (const { file, path } of items) {
    tree[path] = new Uint8Array(await file.arrayBuffer());
  }
  const bytes = zipSync(tree, { level: 0 });
  return new Blob([bytes], { type: 'application/zip' });
}

/** @param {string[]} paths */
function listSome(paths) {
  return paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` and ${paths.length - 5} more` : '');
}

/**
 * The whole folder-upload flow: limits → replace prompt → zip → POST →
 * report anything that didn't make it. Dependencies are injected so the
 * flow is unit-testable without App.
 * @param {{
 *   items: FolderItem[],
 *   projectId: string,
 *   existingPaths: Iterable<string>,
 *   upload: (url: string, body: FormData) => Promise<Response>,
 *   alert: (msg: string, opts?: any) => any,
 *   confirm: (msg: string, opts?: any) => Promise<boolean>,
 * }} args
 * @returns {Promise<any[] | null>} the project's new file list, or null if nothing was uploaded
 */
export async function runFolderUpload({ items, projectId, existingPaths, upload, alert, confirm }) {
  const title = { title: 'Upload folder' };
  const { ok, tooLarge, error } = checkLimits(items);
  const tooLargeNote = tooLarge.length ? `\n\nSkipped (over 10 MB): ${listSome(tooLarge)}` : '';
  if (error) {
    alert(error + tooLargeNote, title);
    return null;
  }
  if (ok.length === 0) {
    alert(`Nothing to upload.${tooLargeNote}`, title);
    return null;
  }

  const existing = new Set(existingPaths);
  const clashes = ok.filter((i) => existing.has(i.path)).map((i) => i.path);
  if (clashes.length) {
    const n = clashes.length;
    const replace = await confirm(
      `${n} file${n === 1 ? '' : 's'} already exist${n === 1 ? 's' : ''} and will be replaced: ${listSome(clashes)}`,
      { ...title, confirmLabel: 'Replace', tone: 'danger' },
    );
    if (!replace) return null;
  }

  const zip = await buildZip(ok);
  const formData = new FormData();
  formData.append('file', zip, 'folder.zip');
  formData.append('preservePaths', '1');
  const res = await upload(`/api/projects/${projectId}/upload-zip`, formData);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Folder upload failed.', title);
    return null;
  }
  // The server silently drops entries it won't store (blocked file
  // types, dotfiles, invalid names). Tell the user which.
  const stored = new Set((data.files || []).map((/** @type {any} */ f) => f.path));
  const dropped = ok.filter((i) => !stored.has(i.path)).map((i) => i.path);
  if (dropped.length || tooLarge.length) {
    const droppedNote = dropped.length ? `\n\nNot accepted by the server: ${listSome(dropped)}` : '';
    alert(`Uploaded ${ok.length - dropped.length} of ${items.length} files.${tooLargeNote}${droppedNote}`, title);
  }
  return data.files || null;
}
