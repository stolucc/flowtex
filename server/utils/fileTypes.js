// @ts-check
/** File extensions treated as binary (base64-encoded in the database). */
export const BINARY_EXTS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.ico',
  '.eps',
  '.ps',
  '.wmf',
  '.emf',
  '.svg',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.a',
  '.class',
  '.jar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wav',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
]);

/** True when the bytes are not storable as text: a NUL in the first 8000
 *  bytes (git's heuristic). Postgres TEXT cannot hold 0x00, so anything
 *  this flags must go to the blob store, whatever its extension says --
 *  a .webp / .heic / .avif / .tif / .ai / data file would otherwise fail
 *  with "invalid byte sequence for encoding UTF8: 0x00".
 *  @param {Uint8Array} buf */
export function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** Binary by extension OR by content.
 *  @param {string} ext  lower-case, with leading dot
 *  @param {Uint8Array} buf */
export function isBinaryContent(ext, buf) {
  return BINARY_EXTS.has(ext) || looksBinary(buf);
}
