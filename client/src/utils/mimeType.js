// MIME-type helper, factored out of BinaryPreview.jsx so callers that
// only need the lookup don't drag pdfjs-dist into the main bundle via
// the BinaryPreview module. (pdfjs is ~hundreds of KB; loading it on
// every page paint to read three lines of mime mapping made no sense.)

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Returns the MIME type for a file path based on its extension. */
export function getMimeType(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
