// @ts-check
/**
 * Custom DOCX-to-LaTeX converter.
 * Replaces pandoc for DOCX import. Parses OOXML directly and emits LaTeX with
 * exact tracked-change positions, proper table widths, bold preservation, etc.
 */
// ReDoS triage 2026-06-02: 6 detect-unsafe-regex hits in this file.
// Each was reviewed individually. The dynamic ones (line ~502, building
// a regex from one of four hard-coded command names) are detect-non-
// literal-regexp false positives. The static ones (line ~454 author-text
// matcher, ~1830 strip-inline-command, ~3562-3563 textbf-fragment
// stripping, ~3589 fragile-command detector) all have either
// well-anchored character classes or fixed-length / non-greedy patterns
// that prevent catastrophic backtracking. Inputs are .docx-derived
// content bounded by the upload size cap (50 MB). Highest-risk surface
// in the codebase — re-review on every periodic security pass.
/* eslint-disable security/detect-unsafe-regex */
/* eslint-disable security/detect-non-literal-regexp */
// adm-zip ships no .d.ts.
// @ts-ignore
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCb);

// Cache: avoid re-checking the filesystem on every WMF/EMF media item.
/** @type {string | false | null} */
let _sofficeCache = null;
/**
 * Find the LibreOffice headless binary. Linux deployments install it as
 * `soffice` on $PATH (libreoffice apt package); macOS bundles it inside the
 * .app. Returns the resolved path, or null if not found — caller then marks
 * the media as unconvertible rather than crashing.
 */
function resolveSoffice() {
  if (_sofficeCache !== null) return _sofficeCache || null;
  /** @type {string[]} */
  const candidates = /** @type {string[]} */ ([
    process.env.SOFFICE_BIN,
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ].filter(Boolean));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        _sofficeCache = c;
        return c;
      }
    } catch { /* keep searching */ }
  }
  // Fall through: try $PATH lookup via `which` (may still fail)
  try {
    const out = execFileSync('which', ['soffice'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (out) {
      _sofficeCache = out;
      return out;
    }
  } catch { /* ignore */ }
  _sofficeCache = false;
  return null;
}

// ── XML Parser setup ─────────────────────────────────────────────────────────

const ARRAY_ELEMENTS = new Set([
  'w:p', 'w:r', 'w:t', 'w:tr', 'w:tc', 'w:tbl', 'w:gridCol',
  'w:ins', 'w:del', 'w:hyperlink', 'w:bookmarkStart', 'w:bookmarkEnd',
  'w:footnoteReference', 'w:endnoteReference', 'w:tab', 'w:br',
  'w:drawing', 'w:pict', 'w:sym', 'w:delText', 'w:fldSimple', 'w:fldChar',
  'w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference',
  'w:comment',
  'w:footnote', 'w:endnote',
  'w:instrText',
  'w:style', 'w:lsdException',
  'w:abstractNum', 'w:num', 'w:lvl', 'w:lvlOverride',
  'Relationship',
  'a:blip',
]);

function createParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ARRAY_ELEMENTS.has(name),
    preserveOrder: false,
    trimValues: false,
    processEntities: { maxEntityCount: 100000, maxTotalExpansions: 100000 },
  });
}

function createOrderedParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    trimValues: false,
    processEntities: { maxEntityCount: 100000, maxTotalExpansions: 100000 },
  });
}

// ── LaTeX special character escaping ─────────────────────────────────────────

const LATEX_SPECIALS = /[&%$#_{}~^\\]/g;
/** @type {Record<string, string>} */
const LATEX_ESCAPE_MAP = {
  '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_',
  '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}', '\\': '\\textbackslash{}',
};
/**
 * @param {string} text
 */
function escapeLatex(text) {
  return text.replace(LATEX_SPECIALS, (/** @type {string} */ ch) => LATEX_ESCAPE_MAP[ch]);
}

/**
 * @param {any} v
 */
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * True iff an OOXML boolean property is set on `props` under key `name`.
 * OOXML "boolean property" convention (used for w:b, w:i, w:strike, w:u, etc.):
 *   - Element absent  → false.
 *   - Element present with no @w:val (or @w:val="true"/"1"/"on") → true.
 *   - Element present with @w:val="false"/"0" → false (explicit toggle-off).
 * This helper expects the unordered (object) parser shape, where
 * `props['w:b']` is the value object (or array) — not the ordered shape that
 * exposes attributes via `:@`.
 * @param {any} props
 * @param {any} name
 */
function boolProp(props, name) {
  const v = props?.[name];
  if (v == null) return false;
  const val = v?.['@_w:val'];
  return val !== 'false' && val !== '0';
}

// ── String buffer for position tracking ──────────────────────────────────────

class LatexBuffer {
  constructor() {
    /** @type {string[]} */
    this.parts = [];
    this.length = 0;
  }
  /** @param {string | null | undefined} s */
  write(s) {
    if (s) {
      this.parts.push(s);
      this.length += s.length;
    }
    return this;
  }
  pos() { return this.length; }
  toString() { return this.parts.join(''); }
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   onProgress?: (msg: string, pct: number) => void,
 *   signal?: AbortSignal,
 *   docType?: string,
 * }} ConvertOpts
 *
 * @param {Buffer} buffer
 * @param {ConvertOpts} [options]
 */
export async function convertDocxToLatex(buffer, options = {}) {
  const _progress = options.onProgress || ((/** @type {string} */ _m, /** @type {number} */ _p) => {});
  // Yield event loop after progress so SSE events flush to the client
  const progress = async (/** @type {string} */ msg, /** @type {number} */ pct) => { _progress(msg, pct); await new Promise(r => setImmediate(r)); };
  const zip = new AdmZip(buffer);
  const parser = createParser();
  const orderedParser = createOrderedParser();

  await progress('Parsing document structure…', 5);
  // Phase 1: Parse XML
  const docXmlRaw = zip.getEntry('word/document.xml')?.getData().toString('utf8') || '';
  // Cap on the raw OOXML body before we hand it to fast-xml-parser. The
  // upload route already enforces 50 MB on the .docx; once unzipped, the
  // largest component is normally word/document.xml. Two-pass parsing
  // (parser + orderedParser) plus the in-flight LatexBuffer can balloon to
  // several hundred MB on a doc with deeply nested content. 30 MB of raw
  // OOXML is comfortably more than any real-world manuscript and stops a
  // crafted .docx from OOM-ing the server.
  const MAX_OOXML_BYTES = 30 * 1024 * 1024;
  if (Buffer.byteLength(docXmlRaw, 'utf8') > MAX_OOXML_BYTES) {
    throw new Error(
      `DOCX document too large: word/document.xml exceeds ${MAX_OOXML_BYTES} bytes uncompressed.`,
    );
  }
  const stylesXml = parseXml(zip, parser, 'word/styles.xml');
  const numberingXml = parseXml(zip, parser, 'word/numbering.xml');
  const footnotesXml = parseXml(zip, parser, 'word/footnotes.xml');
  const endnotesXml = parseXml(zip, parser, 'word/endnotes.xml');
  const relsXml = parseXml(zip, parser, 'word/_rels/document.xml.rels');
  const docXml = parser.parse(docXmlRaw);

  // Parse comments.xml if present
  const commentsXmlRaw = zip.getEntry('word/comments.xml')?.getData().toString('utf8') || '';
  const commentMap = new Map(); // id → { author, date, text }
  if (commentsXmlRaw) {
    const commentsXml = orderedParser.parse(commentsXmlRaw);
    const commentsRoot = findChild(commentsXml, 'w:comments');
    if (commentsRoot?.['w:comments']) {
      const commentEls = findChildren(commentsRoot['w:comments'], 'w:comment');
      for (const cEl of commentEls) {
        const ca = cEl[':@'] || {};
        const id = ca['@_w:id'];
        if (!id) continue;
        // Extract plain text from comment paragraphs
        const cChildren = cEl['w:comment'] || [];
        let text = '';
        for (const item of (Array.isArray(cChildren) ? cChildren : [cChildren])) {
          if (item['w:p']) {
            const pItems = Array.isArray(item['w:p']) ? item['w:p'] : [item['w:p']];
            for (const pi of pItems) {
              if (pi['w:r']) {
                const runs = Array.isArray(pi['w:r']) ? pi['w:r'] : [pi['w:r']];
                for (const r of runs) {
                  if (r['w:t'] != null) {
                    const tv = typeof r['w:t'] === 'string' ? r['w:t'] : (Array.isArray(r['w:t']) ? r['w:t'].map(t => typeof t === 'string' ? t : (t['#text'] || '')).join('') : (r['w:t']['#text'] || ''));
                    text += tv;
                  }
                }
              }
            }
          }
        }
        commentMap.set(id, {
          author: ca['@_w:author'] || 'Unknown',
          date: ca['@_w:date'] || '',
          text: text.trim(),
        });
      }
    }
  }

  await progress('Reading styles and metadata…', 10);
  // Phase 2: Metadata
  const metadata = parseMetadata(stylesXml, docXml, docXmlRaw);
  const rels = parseRelationships(relsXml);
  const numbering = parseNumbering(numberingXml);
  const footnoteMap = parseFootnotes(footnotesXml, rels, numbering, metadata);
  const endnoteMap = parseEndnotes(endnotesXml, rels, numbering, metadata);

  // Phase 2b: Resolve header/footer content from rIds
  if (metadata.headerFooter) {
    const hf = metadata.headerFooter;
    const resolveHF = (/** @type {string} */ rId) => {
      const rel = rels.get(rId);
      const target = rel?.target; // e.g. "header2.xml"
      if (!target) return null;
      const xml = parseXml(zip, parser, 'word/' + target);
      return xml ? extractHeaderFooterContent(xml) : null;
    };
    hf.resolvedHeaders = {};
    hf.resolvedFooters = {};
    if (hf.headers) {
      for (const [type, rId] of Object.entries(hf.headers)) {
        hf.resolvedHeaders[type] = resolveHF(rId);
      }
    }
    if (hf.footers) {
      for (const [type, rId] of Object.entries(hf.footers)) {
        hf.resolvedFooters[type] = resolveHF(rId);
      }
    }
  }

  // Phase 3: Media — extract files, convert unsupported formats for LaTeX compatibility.
  // SECURITY: rsvg-convert and ImageMagick `convert` run on attacker-controlled bytes
  // (any authenticated user can upload arbitrary SVG/GIF/TIFF/BMP). Operators should run
  // under bwrap/firejail and tighten /etc/ImageMagick-7/policy.xml. As an in-process
  // mitigation we cap memory/disk/threads on every `convert` invocation and provide an
  // env-var (DISABLE_IMAGE_CONVERSION=1) to skip the dangerous coders entirely.
  const SKIP_CONVERSION = process.env.DISABLE_IMAGE_CONVERSION === '1';
  const IM_LIMITS = ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '256MiB', '-limit', 'thread', '1'];
  const mediaFiles = [];
  const unconvertible = new Set(); // tracks images that couldn't be converted
  const CONVERT_TO_PNG = new Set(['gif', 'tiff', 'tif', 'bmp']);
  const NEEDS_LIBREOFFICE = new Set(['wmf', 'emf']);
  const mediaEntries = zip.getEntries().filter((/** @type {any} */ e) => e.entryName.startsWith('word/media/'));
  // Cap to bound the worst-case CPU cost of the per-image conversion
  // loop: each image up to 30 s of ImageMagick / rsvg-convert /
  // LibreOffice work. Without this a crafted DOCX with thousands of
  // tiny media entries could burn hours of CPU before downstream
  // quotas (FILES_PER_PROJECT) reject the writes. 1000 is generous
  // for any legitimate document (Word's own author guidance caps
  // single-doc image counts well below this) and quick to reject in
  // the rare malicious case.
  const MAX_DOCX_MEDIA = 1000;
  if (mediaEntries.length > MAX_DOCX_MEDIA) {
    throw new Error(`DOCX contains too many media files (${mediaEntries.length}, max ${MAX_DOCX_MEDIA})`);
  }
  const totalMedia = mediaEntries.length;
  const signal = options.signal; // AbortSignal from client disconnect
  let mediaIdx = 0;
  for (const entry of mediaEntries) {
    if (signal?.aborted) throw new Error('Import cancelled');
    const relPath = entry.entryName.replace('word/', '');
    const data = entry.getData();
    const ext = (relPath.split('.').pop() || '').toLowerCase();
    const fileName = relPath.split('/').pop();
    mediaIdx++;
    if (ext === 'svg') {
      if (SKIP_CONVERSION) { unconvertible.add(relPath); continue; }
      await progress(`Converting image ${mediaIdx}/${totalMedia} (${fileName})…`, 15 + Math.round((mediaIdx / totalMedia) * 25));
      try {
        const pdfData = execFileSync('rsvg-convert', ['-f', 'pdf'], { input: data, maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
        mediaFiles.push({ path: relPath.replace(/\.svg$/i, '.pdf'), data: pdfData });
      } catch {
        unconvertible.add(relPath);
      }
    } else if (CONVERT_TO_PNG.has(ext)) {
      if (SKIP_CONVERSION) { unconvertible.add(relPath); continue; }
      await progress(`Converting image ${mediaIdx}/${totalMedia} (${fileName})…`, 15 + Math.round((mediaIdx / totalMedia) * 25));
      try {
        const pngData = execFileSync('convert', [...IM_LIMITS, `${ext}:-`, 'png:-'], { input: data, maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
        mediaFiles.push({ path: relPath.replace(/\.\w+$/, '.png'), data: pngData });
      } catch {
        unconvertible.add(relPath);
      }
    } else if (NEEDS_LIBREOFFICE.has(ext)) {
      // WMF/EMF (legacy Windows metafiles) require LibreOffice to convert.
      // Like rsvg/convert, soffice runs on attacker-controlled bytes — gate
      // it behind the same DISABLE_IMAGE_CONVERSION switch so an operator
      // who can't sandbox LibreOffice can disable the path entirely.
      if (SKIP_CONVERSION) { unconvertible.add(relPath); continue; }
      await progress(`Converting image ${mediaIdx}/${totalMedia} (${fileName})…`, 15 + Math.round((mediaIdx / totalMedia) * 25));
      const sofficeBin = resolveSoffice();
      if (!sofficeBin) {
        unconvertible.add(relPath);
        continue;
      }
      try {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtex-wmf-'));
        const inFile = path.join(tmpDir, `image.${ext}`);
        fs.writeFileSync(inFile, data);
        // Per-invocation user-profile dir keeps a compromised LibreOffice
        // run from persisting state into ~/.config/libreoffice (which would
        // survive process exit and affect later invocations). --safe-mode
        // disables extensions and the Java component framework.
        const userInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtex-lo-prof-'));
        await execFile(sofficeBin, [
          '--headless',
          '--safe-mode',
          `-env:UserInstallation=file://${userInstallDir}`,
          '--convert-to', 'pdf',
          '--outdir', tmpDir,
          inFile,
        ], { timeout: 30000 });
        const outFile = path.join(tmpDir, 'image.pdf');
        if (fs.existsSync(outFile)) {
          const pdfData = fs.readFileSync(outFile);
          mediaFiles.push({ path: relPath.replace(/\.\w+$/, '.pdf'), data: pdfData });
        } else {
          unconvertible.add(relPath);
        }
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
        try { fs.rmSync(userInstallDir, { recursive: true }); } catch { /* ignore */ }
      } catch {
        unconvertible.add(relPath);
      }
    } else {
      mediaFiles.push({ path: relPath, data });
    }
  }

  await progress('Analysing document layout…', 45);
  // Phase 4: Build preamble
  /** @type {any} */
  const ctx = {
    metadata, rels, numbering, footnoteMap, endnoteMap, unconvertible,
    buf: new LatexBuffer(),
    trackedChanges: [],
    comments: [],
    commentMap,
    commentStarts: new Map(), // id → buffer position when commentRangeStart was seen
    usedPackages: new Set(),
    listStack: [],
    inLandscape: false, // tracks current page orientation state
    bibEntries: new Map(), // citeKey → { type, author, title, year, ... }
  };

  // Phase 5: Walk document body using preserveOrder parser for correct element ordering
  const ordered = orderedParser.parse(docXmlRaw);
  const docEl = findChild(ordered, 'w:document');
  const bodyChildren = docEl ? findChildren(docEl['w:document'], 'w:body') : null;
  const bodyContent = bodyChildren?.[0]?.['w:body'] || [];

  await progress('Converting document body (pass 1)…', 50);
  // First pass: determine which packages are needed (write to a temp buffer)
  /** @type {any} */
  const tempCtx = { ...ctx, buf: new LatexBuffer(), trackedChanges: [], comments: [], commentStarts: new Map(), listStack: [], inLandscape: false, bibEntries: new Map() };
  emitOrderedBody(bodyContent, tempCtx);
  ctx.usedPackages = tempCtx.usedPackages;
  ctx.bibEntries = tempCtx.bibEntries;

  // Determine document class from user-selected document type, or fall back to heuristic
  let docClass;
  if (options.docType === 'book') {
    docClass = 'book';
  } else if (options.docType === 'report') {
    docClass = 'report';
  } else if (options.docType === 'journal' || options.docType === 'conference') {
    docClass = 'article';
  } else {
    // Heuristic: many top-level sections suggest a book/thesis
    const h1Count = (tempCtx.buf.toString().match(/\\section\*?\{/g) || []).length;
    docClass = h1Count >= 5 ? 'book' : 'article';
  }
  ctx.docClass = docClass;

  await progress('Building preamble…', 60);
  // Build preamble now that we know which packages are needed
  const preamble = buildPreamble(metadata, ctx.usedPackages, docClass);
  ctx.buf.write(preamble);
  ctx.buf.write('\\sloppy\n\\begin{document}\n');

  ctx.buf.pos();

  await progress('Converting document body (pass 2)…', 65);
  // Second pass: emit body into the real buffer
  emitOrderedBody(bodyContent, ctx);

  // Add bibliography if citations were found
  const bibContent = generateBibContent(ctx.bibEntries);
  if (ctx.bibEntries.size > 0) {
    ctx.buf.write('\n\\bibliographystyle{plainnat}\n\\bibliography{references}\n');
  }

  ctx.buf.write('\n\\end{document}\n');

  await progress('Post-processing LaTeX…', 75);
  // Post-process: merge adjacent runs with identical fontsize wrappers
  const rawLatex = ctx.buf.toString();
  let latex = mergeAdjacentFontSizeRuns(rawLatex, false);

  // Post-process: deduplicate author names before \cite{} commands
  // DOCX author-year citations often have "Author et al." as plain text + field "(Year)",
  // producing "Author et al. \cite{AuthorYear}" which renders with duplicated author names.
  // Detect and replace with \citet{} (natbib textual citation).
  latex = deduplicateCiteAuthors(latex, ctx.bibEntries);

  // Remap tracked change positions after post-processing changed the string
  if (latex !== rawLatex) {
    remapTrackedChangePositions(ctx.trackedChanges, rawLatex, latex);
  }

  return {
    latex,
    metadata,
    bibContent,
    trackedChanges: ctx.trackedChanges,
    comments: ctx.comments,
    mediaFiles,
  };
}

// ── Post-processing: deduplicate author names before \cite ───────────────────

/**
 * Detect patterns like "Author et al. \cite{AuthorYear}" and replace with \citet{}.
 * Also handles "Author and Other \cite{}", "Author, Other and Third \cite{}", etc.
 * @param {any} latex
 * @param {any} bibEntries
 */
function deduplicateCiteAuthors(latex, bibEntries) {
  if (!bibEntries || bibEntries.size === 0) return latex;

  // Build a map: citeKey → first author surname
  const keyToSurname = new Map();
  for (const [key, entry] of bibEntries) {
    if (!entry.author) continue;
    // First author is before " and " — surname is the last word (or everything before comma)
    const firstAuthor = entry.author.split(' and ')[0].trim();
    // Handle "Surname, First" or "First Surname" formats
    let surname;
    if (firstAuthor.includes(',')) {
      surname = firstAuthor.split(',')[0].trim();
    } else {
      const parts = firstAuthor.split(/\s+/);
      surname = parts[parts.length - 1];
    }
    // Clean LaTeX accents for matching (e.g., \'{e} → é won't match, but plain text will)
    if (surname) keyToSurname.set(key, surname);
  }

  // Match: optional formatting, author text, optional "et al."/"and X", then \cite{keys}
  // We process each \cite{...} occurrence and look back for author text
  return latex.replace(
    /([A-ZÀ-ÖØ-öø-ÿĀ-žǍ-ǜ][A-Za-zÀ-ÖØ-öø-ÿĀ-žǍ-ǜ'-]+(?:\s+(?:et\s+al\.?|and\s+[A-ZÀ-ÖØ-öø-ÿĀ-žǍ-ǜ][A-Za-zÀ-ÖØ-öø-ÿĀ-žǍ-ǜ'-]+(?:\s+and\s+[A-ZÀ-ÖØ-öø-ÿĀ-žǍ-ǜ][A-Za-zÀ-ÖØ-öø-ÿĀ-žǍ-ǜ'-]+)*))?)\s*\\cite\{([^}]+)\}/g,
    (/** @type {string} */ match, /** @type {string} */ authorText, /** @type {string} */ citeKeys) => {
      const keys = citeKeys.split(',').map((/** @type {string} */ k) => k.trim());
      // Check if the preceding author text matches any of the cited authors
      const authorTextClean = authorText.replace(/\\emph\{([^}]*)\}/g, '$1').trim();
      const matchesAuthor = keys.some((/** @type {string} */ key) => {
        const surname = keyToSurname.get(key);
        if (!surname) return false;
        return authorTextClean.startsWith(surname);
      });
      if (matchesAuthor) {
        return `\\citet{${citeKeys}}`;
      }
      return match;
    }
  );
}

// ── Post-processing: merge fragmented runs ────────────────────────────────────

/**
 * Merge adjacent runs that have identical formatting wrappers.
 * Fixes fragmented output like:
 *   {\fontsize{24}{29}\selectfont \textbf{s}}{\fontsize{24}{29}\selectfont \textbf{upporting}}
 * Into:
 *   {\fontsize{24}{29}\selectfont \textbf{supporting}}
 *
 * Also merges adjacent \textbf{}, \emph{}, \textsc{} with no intervening content.
 * @param {any} latex
 * @param {any} skipFormattingMerge
 */
function mergeAdjacentFontSizeRuns(latex, skipFormattingMerge) {
  // Merge adjacent {\fontsize{X}{Y}\selectfont CONTENT} blocks with same size
  // We do this iteratively since merging two may create a new pair
  let changed = true;
  while (changed) {
    changed = false;
    const result = mergeOneFontSizePair(latex);
    if (result !== latex) {
      latex = result;
      changed = true;
    }
  }

  // Merge adjacent \textbf{A}\textbf{B} → \textbf{AB}
  // Skip when tracked changes exist — merging destroys TC text boundaries
  // (e.g. \emph{positively }\emph{associated...} becomes \emph{positively associated...}
  // and the TC referencing \emph{positively } can no longer be found).
  if (!skipFormattingMerge) {
    for (const cmd of ['textbf', 'emph', 'textsc', 'textit']) {
      const re = new RegExp(`\\\\${cmd}\\{([^}]*)\\}\\\\${cmd}\\{`, 'g');
      let prev = latex;
      latex = latex.replace(re, `\\${cmd}{$1`);
      while (latex !== prev) {
        prev = latex;
        latex = latex.replace(re, `\\${cmd}{$1`);
      }
    }
  }

  return latex;
}

/**
 * Find and merge one pair of adjacent fontsize blocks with identical sizes.
 * Returns the modified string, or the original if no merge was possible.
 * @param {any} latex
 */
function mergeOneFontSizePair(latex) {
  // Pattern: {\fontsize{N}{M}\selectfont CONTENT}{\fontsize{N}{M}\selectfont CONTENT}
  // The CONTENT can contain nested braces, so we need brace-balanced matching.
  const opener = /\{\\fontsize\{(\d+)\}\{(\d+)\}\\selectfont /g;
  let match;
  while ((match = opener.exec(latex)) !== null) {
    const startPos = match.index;
    const size1 = match[1];
    const size2 = match[2];
    // Find the matching closing brace for the first block
    let depth = 1;
    let pos = match.index + match[0].length;
    while (pos < latex.length && depth > 0) {
      if (latex[pos] === '{') depth++;
      else if (latex[pos] === '}') depth--;
      pos++;
    }
    if (depth !== 0) continue;
    const firstEnd = pos; // position after the closing }

    // Check if immediately followed by {\fontsize{same}{same}\selectfont
    const nextOpener = `{\\fontsize{${size1}}{${size2}}\\selectfont `;
    if (latex.substring(firstEnd, firstEnd + nextOpener.length) === nextOpener) {
      // Extract content of first block (between opener and closing brace)
      const firstContent = latex.substring(match.index + match[0].length, firstEnd - 1);
      // Find the closing brace of the second block
      const secondContentStart = firstEnd + nextOpener.length;
      depth = 1;
      pos = secondContentStart;
      while (pos < latex.length && depth > 0) {
        if (latex[pos] === '{') depth++;
        else if (latex[pos] === '}') depth--;
        pos++;
      }
      if (depth !== 0) continue;
      const secondContent = latex.substring(secondContentStart, pos - 1);
      // Merge: replace both blocks with a single block
      const merged = `{\\fontsize{${size1}}{${size2}}\\selectfont ${firstContent}${secondContent}}`;
      return latex.substring(0, startPos) + merged + latex.substring(pos);
    }
  }
  return latex; // no merge found
}

/**
 * Prettify generated LaTeX: normalize blank lines, indent environments, trim trailing whitespace.
 * @param {any} latex
 */
export function prettifyLatex(latex) {
  let lines = latex.split('\n');

  // 1. Trim trailing whitespace from each line
  lines = lines.map((/** @type {string} */ l) => l.replace(/\s+$/, ''));

  // 2. Collapse 3+ consecutive blank lines down to 2
  const collapsed = [];
  let blankCount = 0;
  for (const line of lines) {
    if (line === '') {
      blankCount++;
      if (blankCount <= 2) collapsed.push(line);
    } else {
      blankCount = 0;
      collapsed.push(line);
    }
  }
  lines = collapsed;

  // 3. Indent content inside \begin{...} / \end{...} environments
  //    Skip verbatim-like environments where indentation would alter content
  const verbatimEnvs = new Set(['verbatim', 'lstlisting', 'minted', 'filecontents']);
  const result = [];
  let depth = 0;
  let inVerbatim = false;
  let verbatimName = '';

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Check for end of verbatim environment
    if (inVerbatim) {
      result.push(line);
      const endMatch = trimmed.match(/^\\end\{(\w+)\}/);
      if (endMatch && endMatch[1] === verbatimName) {
        inVerbatim = false;
        verbatimName = '';
      }
      continue;
    }

    const endMatch = trimmed.match(/^\\end\{(\w+)\}/);
    const beginMatch = trimmed.match(/^\\begin\{(\w+)\}/);

    if (endMatch) {
      depth = Math.max(0, depth - 1);
      result.push('  '.repeat(depth) + trimmed);
    } else if (beginMatch) {
      result.push('  '.repeat(depth) + trimmed);
      if (verbatimEnvs.has(beginMatch[1])) {
        inVerbatim = true;
        verbatimName = beginMatch[1];
      } else {
        depth++;
      }
    } else {
      // Regular line — indent only if inside an environment and line isn't already
      // a top-level command that should stay at current depth
      if (depth > 0 && trimmed !== '') {
        result.push('  '.repeat(depth) + trimmed);
      } else {
        result.push(trimmed);
      }
    }
  }

  return result.join('\n');
}

// ── XML helpers ──────────────────────────────────────────────────────────────

// Per-file size cap on any parsed OOXML part. The 30 MB document.xml ceiling
// is enforced separately in the main pipeline; this catches the auxiliary
// parts (styles, numbering, footnotes, endnotes, comments, rels) where a
// crafted .docx could otherwise inflate parser memory unchecked. 10 MB is
// generous for these — real-world auxiliary parts are kilobytes.
const MAX_OOXML_PART_BYTES = 10 * 1024 * 1024;

/**
 * @param {any} zip
 * @param {any} parser
 * @param {any} path
 */
function parseXml(zip, parser, path) {
  const entry = zip.getEntry(path);
  if (!entry) return null;
  const data = entry.getData();
  if (data.length > MAX_OOXML_PART_BYTES) return null;
  try { return parser.parse(data.toString('utf8')); }
  catch { return null; }
}

/**
 * Find first child object with given key in a preserveOrder array.
 * @param {any} arr
 * @param {any} key
 */
function findChild(arr, key) {
  if (!Array.isArray(arr)) return null;
  return arr.find(el => el[key]) || null;
}

/**
 * Find all child objects with given key.
 * @param {any} arr
 * @param {any} key
 */
function findChildren(arr, key) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(el => el[key]);
}

/**
 * Get attributes from a preserveOrder element.
 * @param {any} el
 */
function attrs(el) {
  return el?.[':@'] || {};
}

/**
 * Parse a border side element from w:tblBorders or w:tcBorders.
 * Returns { style, sz, color } or null if the border is absent/none.
 * `style` is the OOXML val (single, double, dashed, etc.),
 * `sz` is in eighths of a point, `color` is hex or 'auto'.
 */
/**
 * Parse a border side element from w:tblBorders or w:tcBorders.
 * Returns:
 *   - border object { style, sz, color } if the border is visible
 *   - false if the border element is present but explicitly none/nil
 *   - undefined if the border element is absent (no override)
 * @param {any} bordersChildren
 * @param {any} sideName
 */
function parseBorderSide(bordersChildren, sideName) {
  const el = findChild(bordersChildren, sideName);
  if (!el) return undefined; // absent — no override
  const a = attrs(el);
  const val = a['@_w:val'] || '';
  if (!val || val === 'none' || val === 'nil') return false; // explicitly no border
  return {
    style: val,
    sz: parseInt(a['@_w:sz'] || '4') || 4,
    color: a['@_w:color'] || 'auto',
  };
}

/**
 * Extract table-level border config from w:tblPr.
 * Returns { top, bottom, left, right, insideH, insideV } where each is
 * a border object or null.
 * @param {any} tblChildren
 */
function parseTableBorders(tblChildren) {
  const tblPr = findChild(tblChildren, 'w:tblPr');
  if (!tblPr?.['w:tblPr']) return null;
  const prArr = Array.isArray(tblPr['w:tblPr']) ? tblPr['w:tblPr'] : [tblPr['w:tblPr']];
  for (const prop of prArr) {
    if (prop['w:tblBorders'] != null) {
      const bc = Array.isArray(prop['w:tblBorders']) ? prop['w:tblBorders'] : [];
      return {
        top: parseBorderSide(bc, 'w:top'),
        bottom: parseBorderSide(bc, 'w:bottom'),
        left: parseBorderSide(bc, 'w:left'),
        right: parseBorderSide(bc, 'w:right'),
        insideH: parseBorderSide(bc, 'w:insideH'),
        insideV: parseBorderSide(bc, 'w:insideV'),
      };
    }
  }
  return null;
}

/**
 * Resolve table borders: first check direct w:tblBorders, then fall back to
 * the named table style from styles.xml. `tblChildren` is preserveOrder array.
 * @param {any} tblChildren
 * @param {any} ctx
 */
function resolveTableBorders(tblChildren, ctx) {
  const direct = parseTableBorders(tblChildren);
  if (direct) return direct;
  // Look up style-defined borders
  const tblPr = findChild(tblChildren, 'w:tblPr');
  if (tblPr?.['w:tblPr']) {
    const prArr = Array.isArray(tblPr['w:tblPr']) ? tblPr['w:tblPr'] : [tblPr['w:tblPr']];
    for (const prop of prArr) {
      if (prop['w:tblStyle'] != null) {
        const styleId = attrs(prop)['@_w:val'] || '';
        if (styleId && ctx.metadata.tableStyles?.[styleId]) {
          return ctx.metadata.tableStyles[styleId];
        }
        break;
      }
    }
  }
  return null;
}

/**
 * Extract cell-level border overrides from w:tcPr > w:tcBorders.
 * Returns { top, bottom, left, right } or null.
 * @param {any} tcContent
 */
function parseCellBorders(tcContent) {
  if (!Array.isArray(tcContent)) return null;
  const tcPr = findChild(tcContent, 'w:tcPr');
  if (!tcPr?.['w:tcPr']) return null;
  const prArr = Array.isArray(tcPr['w:tcPr']) ? tcPr['w:tcPr'] : [tcPr['w:tcPr']];
  for (const prop of prArr) {
    if (prop['w:tcBorders'] != null) {
      const bc = Array.isArray(prop['w:tcBorders']) ? prop['w:tcBorders'] : [];
      return {
        top: parseBorderSide(bc, 'w:top'),
        bottom: parseBorderSide(bc, 'w:bottom'),
        left: parseBorderSide(bc, 'w:left'),
        right: parseBorderSide(bc, 'w:right'),
      };
    }
  }
  return null;
}

// ── Metadata ─────────────────────────────────────────────────────────────────

/**
 * @param {any} stylesXml
 * @param {any} docXml
 * @param {any} docXmlRaw
 */
function parseMetadata(stylesXml, docXml, docXmlRaw) {
  /** @type {any} */
  const meta = { mainFont: '', mainFontSize: '', lineSpacing: '', margins: null, headingStyles: {}, headingStyleNumbered: {}, defaultParSpacing: null };
  if (!stylesXml) return meta;

  const styles = stylesXml['w:styles'];
  if (!styles) return meta;

  // docDefaults
  const rPrDefault = styles['w:docDefaults']?.['w:rPrDefault']?.['w:rPr'];
  if (rPrDefault) {
    if (rPrDefault['w:rFonts']?.['@_w:ascii']) meta.mainFont = rPrDefault['w:rFonts']['@_w:ascii'];
    if (rPrDefault['w:sz']?.['@_w:val']) meta.mainFontSize = String(parseInt(rPrDefault['w:sz']['@_w:val']) / 2);
  }
  const pPrDefault = styles['w:docDefaults']?.['w:pPrDefault']?.['w:pPr'];
  if (pPrDefault?.['w:spacing']) {
    const sp = pPrDefault['w:spacing'];
    meta.defaultParSpacing = {
      before: sp['@_w:before'] ? Math.round(parseInt(sp['@_w:before']) / 20) : 0,
      after: sp['@_w:after'] ? Math.round(parseInt(sp['@_w:after']) / 20) : 0,
    };
  }

  // Named styles
  for (const style of asArray(styles['w:style'])) {
    const type = style['@_w:type'];
    const styleId = style['@_w:styleId'];

    if (type === 'paragraph' && style['@_w:default'] === '1') {
      const rPr = style['w:rPr'];
      if (rPr?.['w:rFonts']?.['@_w:ascii']) meta.mainFont = rPr['w:rFonts']['@_w:ascii'];
      if (rPr?.['w:sz']?.['@_w:val']) meta.mainFontSize = String(parseInt(rPr['w:sz']['@_w:val']) / 2);
      const spacing = style['w:pPr']?.['w:spacing'];
      if (spacing?.['@_w:line']) {
        const val = parseInt(spacing['@_w:line']);
        meta.defaultLineSpacing = val; // raw OOXML value (240=single, 360=1.5×, 480=double)
        if (val >= 440) meta.lineSpacing = '2';
        else if (val >= 320) meta.lineSpacing = '1.5';
      }
    }

    if (type === 'paragraph' && styleId === 'Title') {
      const rPr = style['w:rPr'];
      /** @type {any} */
      const info = {};
      if (rPr) {
        if (rPr['w:rFonts']?.['@_w:ascii']) info.font = rPr['w:rFonts']['@_w:ascii'];
        if (rPr['w:sz']?.['@_w:val']) info.size = String(parseInt(rPr['w:sz']['@_w:val']) / 2);
        if (boolProp(rPr, 'w:b')) info.bold = true;
        if (boolProp(rPr, 'w:i')) info.italic = true;
      }
      meta.titleStyle = info;
    }

    if (type === 'paragraph' && /^Heading\d$/.test(styleId)) {
      const level = styleId.replace('Heading', '');
      /** @type {any} */
      const info = {};
      const rPr = style['w:rPr'];
      if (rPr) {
        if (rPr['w:rFonts']?.['@_w:ascii']) info.font = rPr['w:rFonts']['@_w:ascii'];
        if (rPr['w:sz']?.['@_w:val']) info.size = String(parseInt(rPr['w:sz']['@_w:val']) / 2);
        if (boolProp(rPr, 'w:b')) info.bold = true;
        if (boolProp(rPr, 'w:i')) info.italic = true;
        const color = rPr['w:color'];
        if (color?.['@_w:val'] && /^[0-9A-Fa-f]{6}$/.test(color['@_w:val'])) info.color = color['@_w:val'];
      }
      if (boolProp(rPr, 'w:smallCaps')) info.smallCaps = true;
      if (boolProp(rPr, 'w:caps')) info.allCaps = true;
      // Check if heading style has numbering, alignment, and spacing
      const pPr = style['w:pPr'];
      if (pPr?.['w:numPr']) info.numbered = true;
      if (pPr?.['w:jc']?.['@_w:val'] === 'center') info.centered = true;
      const hSpacing = pPr?.['w:spacing'];
      if (hSpacing) {
        if (hSpacing['@_w:before']) info.spaceBefore = Math.round(parseInt(hSpacing['@_w:before']) / 20);
        if (hSpacing['@_w:after']) info.spaceAfter = Math.round(parseInt(hSpacing['@_w:after']) / 20);
      }
      meta.headingStyles[level] = info;
    }

    // Build maps of paragraph style → font size and line spacing for table cell styling
    if (type === 'paragraph' && styleId) {
      const rPrS = style['w:rPr'];
      if (rPrS?.['w:sz']?.['@_w:val']) {
        if (!meta.styleFontSizes) meta.styleFontSizes = {};
        meta.styleFontSizes[styleId] = parseInt(rPrS['w:sz']['@_w:val']) || 0;
      }
      const pPrS = style['w:pPr'];
      const spS = pPrS?.['w:spacing'];
      if (spS?.['@_w:line']) {
        if (!meta.styleLineSpacing) meta.styleLineSpacing = {};
        meta.styleLineSpacing[styleId] = {
          line: parseInt(spS['@_w:line']) || 0,
          rule: spS['@_w:lineRule'] || 'auto',
        };
      }
    }

    // Track numbering status for ALL heading style variants (Heading1NoChapNo, etc.)
    if (type === 'paragraph' && /^[Hh]eading\d/.test(styleId)) {
      const pPr = style['w:pPr'];
      const numPr = pPr?.['w:numPr'];
      if (numPr) {
        const numIdVal = numPr['w:numId']?.['@_w:val'];
        // numId="0" explicitly suppresses numbering
        meta.headingStyleNumbered[styleId] = numIdVal !== '0' && numIdVal !== undefined;
      } else {
        // No numPr at all — check if based on a style that has numbering
        // (will resolve via basedOn chain if needed, but for now mark as unnumbered)
        meta.headingStyleNumbered[styleId] = false;
      }
    }
  }

  // Margins
  if (docXml) {
    const body = docXml['w:document']?.['w:body'];
    const sectPr = body?.['w:sectPr'] || findSectPrInParagraphs(body);
    if (sectPr) {
      const pgMar = sectPr['w:pgMar'];
      if (pgMar?.['@_w:top'] && pgMar['@_w:bottom'] && pgMar['@_w:left'] && pgMar['@_w:right']) {
        meta.margins = {
          top: (parseInt(pgMar['@_w:top']) / 1440).toFixed(2),
          bottom: (parseInt(pgMar['@_w:bottom']) / 1440).toFixed(2),
          left: (parseInt(pgMar['@_w:left']) / 1440).toFixed(2),
          right: (parseInt(pgMar['@_w:right']) / 1440).toFixed(2),
        };
      }
    }
  }

  // Headers and footers
  if (docXml) {
    const body = docXml['w:document']?.['w:body'];
    const sectPr = body?.['w:sectPr'] || findSectPrInParagraphs(body);
    if (sectPr) {
      meta.headerFooter = {};
      // Check if different first page is enabled
      if (sectPr['w:titlePg'] != null) meta.headerFooter.differentFirst = true;
      for (const ref of asArray(sectPr['w:headerReference'])) {
        const type = ref['@_w:type'] || 'default'; // default, first, even
        const rId = ref['@_r:id'];
        if (rId) {
          if (!meta.headerFooter.headers) meta.headerFooter.headers = {};
          meta.headerFooter.headers[type] = rId;
        }
      }
      for (const ref of asArray(sectPr['w:footerReference'])) {
        const type = ref['@_w:type'] || 'default';
        const rId = ref['@_r:id'];
        if (rId) {
          if (!meta.headerFooter.footers) meta.headerFooter.footers = {};
          meta.headerFooter.footers[type] = rId;
        }
      }
    }
  }

  // If no font size from styles, scan the document body for the most common w:sz
  if (!meta.mainFontSize && docXmlRaw) {
    /** @type {Record<string, number>} */
    const szCounts = {};
    const szRe = /<w:sz\s+w:val="(\d+)"/g;
    let szm;
    while ((szm = szRe.exec(docXmlRaw))) {
      const pt = String(parseInt(szm[1]) / 2);
      szCounts[pt] = (szCounts[pt] || 0) + 1;
    }
    // Pick the most frequent size (likely body text)
    let maxCount = 0, mostCommon = '';
    for (const [pt, count] of Object.entries(szCounts)) {
      if (count > maxCount) { maxCount = count; mostCommon = pt; }
    }
    if (mostCommon) meta.mainFontSize = mostCommon;
  }

  // Paragraph styles — extract formatting properties (indent, spacing, italic, bold)
  // so the paragraph emitter can inherit them when not overridden by direct formatting.
  meta.paragraphStyles = {};
  for (const style of asArray(styles['w:style'])) {
    if (style['@_w:type'] !== 'paragraph') continue;
    const psId = style['@_w:styleId'];
    if (!psId) continue;
    /** @type {any} */
    const info = {};
    const basedOnVal = style['w:basedOn']?.['@_w:val'];
    if (basedOnVal) info.basedOn = basedOnVal;
    const pPr = style['w:pPr'];
    if (pPr) {
      const ind = pPr['w:ind'];
      if (ind) {
        if (ind['@_w:left']) info.indLeft = parseInt(ind['@_w:left']) || 0;
        if (ind['@_w:right']) info.indRight = parseInt(ind['@_w:right']) || 0;
        if (ind['@_w:firstLine']) info.indFirstLine = parseInt(ind['@_w:firstLine']) || 0;
        if (ind['@_w:hanging']) info.indHanging = parseInt(ind['@_w:hanging']) || 0;
      }
      const sp = pPr['w:spacing'];
      if (sp?.['@_w:line']) info.spacingLine = parseInt(sp['@_w:line']) || 0;
      const jcVal = pPr['w:jc']?.['@_w:val'];
      if (jcVal) info.jc = jcVal;
    }
    const rPr = style['w:rPr'];
    if (rPr) {
      if (boolProp(rPr, 'w:i')) info.italic = true;
      if (boolProp(rPr, 'w:b')) info.bold = true;
      if (boolProp(rPr, 'w:caps')) info.allCaps = true;
      if (boolProp(rPr, 'w:smallCaps')) info.smallCaps = true;
    }
    meta.paragraphStyles[psId] = info;
  }
  // Resolve single-level basedOn inheritance for indent/spacing/formatting
  for (const [, info] of Object.entries(meta.paragraphStyles)) {
    if (!info.basedOn) continue;
    const parent = meta.paragraphStyles[info.basedOn];
    if (!parent) continue;
    if (info.indLeft == null && parent.indLeft) info.indLeft = parent.indLeft;
    if (info.indRight == null && parent.indRight) info.indRight = parent.indRight;
    if (info.indFirstLine == null && parent.indFirstLine) info.indFirstLine = parent.indFirstLine;
    if (info.indHanging == null && parent.indHanging) info.indHanging = parent.indHanging;
    if (info.spacingLine == null && parent.spacingLine) info.spacingLine = parent.spacingLine;
    // italic/bold/caps/jc only inherit if not explicitly set
    if (info.italic == null && parent.italic) info.italic = parent.italic;
    if (info.bold == null && parent.bold) info.bold = parent.bold;
    if (info.allCaps == null && parent.allCaps) info.allCaps = parent.allCaps;
    if (info.smallCaps == null && parent.smallCaps) info.smallCaps = parent.smallCaps;
    if (info.jc == null && parent.jc) info.jc = parent.jc;
  }

  // Character styles — extract run formatting (bold, italic, smallCaps, etc.)
  // so emitRunOrdered can inherit them when a run references w:rStyle.
  meta.characterStyles = {};
  for (const style of asArray(styles['w:style'])) {
    if (style['@_w:type'] !== 'character') continue;
    const csId = style['@_w:styleId'];
    if (!csId) continue;
    const rPr = style['w:rPr'];
    if (!rPr) continue;
    const info = {};
    if (boolProp(rPr, 'w:b')) info.bold = true;
    if (boolProp(rPr, 'w:i')) info.italic = true;
    if (boolProp(rPr, 'w:smallCaps')) info.smallCaps = true;
    if (boolProp(rPr, 'w:caps')) info.allCaps = true;
    if (boolProp(rPr, 'w:u')) info.underline = true;
    if (boolProp(rPr, 'w:strike')) info.strike = true;
    meta.characterStyles[csId] = info;
  }

  // Table styles — extract border definitions from named table styles
  meta.tableStyles = {};
  for (const style of asArray(styles['w:style'])) {
    if (style['@_w:type'] !== 'table') continue;
    const styleId = style['@_w:styleId'];
    if (!styleId) continue;
    const tblPr = style['w:tblPr'];
    if (!tblPr?.['w:tblBorders']) continue;
    const borders = tblPr['w:tblBorders'];
    const parseSide = (/** @type {any} */ el) => {
      if (!el) return undefined;
      const val = el['@_w:val'] || '';
      if (!val || val === 'none' || val === 'nil') return false;
      return { style: val, sz: parseInt(el['@_w:sz'] || '4') || 4, color: el['@_w:color'] || 'auto' };
    };
    meta.tableStyles[styleId] = {
      top: parseSide(borders['w:top']),
      bottom: parseSide(borders['w:bottom']),
      left: parseSide(borders['w:left']),
      right: parseSide(borders['w:right']),
      insideH: parseSide(borders['w:insideH']),
      insideV: parseSide(borders['w:insideV']),
    };
  }

  return meta;
}

/**
 * @param {any} body
 */
function findSectPrInParagraphs(body) {
  if (!body) return null;
  for (const p of asArray(body['w:p']).reverse()) {
    if (p['w:pPr']?.['w:sectPr']) return p['w:pPr']['w:sectPr'];
  }
  return null;
}

/**
 * Extract structured content from a header or footer XML file.
 * Returns { segments: string[], hasPageNum: boolean } for each non-empty paragraph,
 * where segments are split by tabs (typically [left, center, right]).
 * The combined result is an array of paragraph objects.
 * @param {any} xml
 */
function extractHeaderFooterContent(xml) {
  if (!xml) return [];
  const root = xml['w:hdr'] || xml['w:ftr'];
  if (!root) return [];
  const paragraphs = [];
  for (const p of asArray(root['w:p'])) {
    const segments = ['']; // tab-separated segments
    let inField = false;
    let hasPageNum = false;
    for (const r of asArray(p['w:r'])) {
      // Check for tab
      if (r['w:tab'] != null) {
        segments.push('');
        continue;
      }
      // Field handling: detect PAGE fields
      const fldChar = r['w:fldChar'];
      if (fldChar) {
        const fldType = fldChar['@_w:fldCharType'];
        if (fldType === 'begin') inField = true;
        else if (fldType === 'end') inField = false;
        else if (fldType === 'separate') continue; // skip display value
        continue;
      }
      const instr = r['w:instrText'];
      if (instr) {
        const instrText = typeof instr === 'string' ? instr : instr['#text'] || '';
        if (/PAGE/i.test(instrText)) hasPageNum = true;
        continue;
      }
      // Skip display text inside fields (between separate and end)
      if (inField) continue;
      // Regular text
      for (const t of asArray(r['w:t'])) {
        const text = typeof t === 'string' ? t : (t?.['#text'] != null ? String(t['#text']) : '');
        if (text) segments[segments.length - 1] += text;
      }
    }
    if (hasPageNum) segments[segments.length - 1] += '\\thepage';
    const nonEmpty = segments.some(s => s.trim());
    if (nonEmpty) paragraphs.push({ segments, hasPageNum });
  }
  return paragraphs;
}

// ── Relationships ────────────────────────────────────────────────────────────

/**
 * @param {any} relsXml
 */
function parseRelationships(relsXml) {
  const map = new Map();
  if (!relsXml) return map;
  const rels = relsXml['Relationships'];
  if (!rels) return map;
  for (const rel of asArray(rels['Relationship'])) {
    const id = rel['@_Id'];
    const type = rel['@_Type'] || '';
    const target = rel['@_Target'] || '';
    if (type.includes('/image')) {
      map.set(id, { type: 'image', target: target.replace(/^word\//, '') });
    } else if (type.includes('/hyperlink') || (rel['@_TargetMode'] === 'External')) {
      map.set(id, { type: 'hyperlink', target });
    } else if (type.includes('/header') || type.includes('/footer')) {
      map.set(id, { type: type.includes('/header') ? 'header' : 'footer', target });
    }
  }
  return map;
}

// ── Numbering ────────────────────────────────────────────────────────────────

/**
 * @param {any} numberingXml
 */
function parseNumbering(numberingXml) {
  const result = { abstracts: new Map(), nums: new Map() };
  if (!numberingXml?.['w:numbering']) return result;
  const num = numberingXml['w:numbering'];
  for (const abs of asArray(num['w:abstractNum'])) {
    const absId = abs['@_w:abstractNumId'];
    const levels = new Map();
    for (const lvl of asArray(abs['w:lvl'])) {
      levels.set(lvl['@_w:ilvl'] || '0', { format: lvl['w:numFmt']?.['@_w:val'] || 'bullet' });
    }
    result.abstracts.set(absId, levels);
  }
  for (const n of asArray(num['w:num'])) {
    const absId = n['w:abstractNumId']?.['@_w:val'];
    if (absId) result.nums.set(n['@_w:numId'], absId);
  }
  return result;
}

/**
 * @param {any} numbering
 * @param {any} numId
 * @param {any} ilvl
 */
function getListType(numbering, numId, ilvl) {
  const absId = numbering.nums.get(numId);
  const levels = absId ? numbering.abstracts.get(absId) : null;
  const lvl = levels?.get(ilvl) || levels?.get('0');
  return (lvl?.format === 'bullet' || lvl?.format === 'none' || !lvl) ? 'itemize' : 'enumerate';
}

// ── Footnotes / Endnotes ─────────────────────────────────────────────────────

/**
 * @param {any} footnotesXml
 * @param {any} rels
 * @param {any} numbering
 * @param {any} metadata
 */
function parseFootnotes(footnotesXml, rels, numbering, metadata) {
  const map = new Map();
  if (!footnotesXml?.['w:footnotes']) return map;
  for (const note of asArray(footnotesXml['w:footnotes']['w:footnote'])) {
    const id = note['@_w:id'];
    if (id === '0' || id === '-1') continue;
    const buf = new LatexBuffer();
    const noteCtx = { metadata, rels, numbering, footnoteMap: new Map(), endnoteMap: new Map(), buf, trackedChanges: [], usedPackages: new Set(), listStack: [] };
    for (const p of asArray(note['w:p'])) {
      emitInlineContentParsed(p, noteCtx);
      buf.write(' ');
    }
    map.set(id, buf.toString().trim());
  }
  return map;
}

/**
 * @param {any} endnotesXml
 * @param {any} rels
 * @param {any} numbering
 * @param {any} metadata
 */
function parseEndnotes(endnotesXml, rels, numbering, metadata) {
  const map = new Map();
  if (!endnotesXml?.['w:endnotes']) return map;
  for (const note of asArray(endnotesXml['w:endnotes']['w:endnote'])) {
    const id = note['@_w:id'];
    if (id === '0' || id === '-1') continue;
    const buf = new LatexBuffer();
    const noteCtx = { metadata, rels, numbering, footnoteMap: new Map(), endnoteMap: new Map(), buf, trackedChanges: [], usedPackages: new Set(), listStack: [] };
    for (const p of asArray(note['w:p'])) {
      emitInlineContentParsed(p, noteCtx);
      buf.write(' ');
    }
    map.set(id, buf.toString().trim());
  }
  return map;
}

// ── Landscape section scanning ───────────────────────────────────────────────

/**
 * Check if a preserveOrder sectPr element specifies landscape orientation.
 * In preserveOrder mode, w:sectPr children are an array of element wrappers.
 * @param {any} sectPrChildren
 */
function isSectPrLandscape(sectPrChildren) {
  if (!Array.isArray(sectPrChildren)) return false;
  const pgSz = findChild(sectPrChildren, 'w:pgSz');
  if (!pgSz) return false;
  return (pgSz[':@'] || {})['@_w:orient'] === 'landscape';
}

/**
 * Extract the section break type from a preserveOrder sectPr element.
 * Returns 'oddPage', 'evenPage', 'nextPage', 'continuous', or 'nextPage' (default).
 * @param {any} sectPrChildren
 */
function getSectPrBreakType(sectPrChildren) {
  if (!Array.isArray(sectPrChildren)) return 'nextPage';
  const typeEl = findChild(sectPrChildren, 'w:type');
  if (!typeEl) return 'nextPage';
  return (typeEl[':@'] || {})['@_w:val'] || 'nextPage';
}

/**
 * Pre-scan body children to build a set of paragraph indices where landscape
 * transitions happen. Returns { landscapeStartIndices, landscapeEndIndices }
 * where start means "emit \begin{landscape} BEFORE this index" and end means
 * "emit \end{landscape} AFTER this index".
 *
 * OOXML rule: w:sectPr inside w:pPr describes the section that ENDS at that
 * paragraph. The body-level w:sectPr describes the final section.
 * @param {any} children
 */
function scanLandscapeSections(children) {
  if (!Array.isArray(children)) return null;

  // Collect section break positions and their orientations
  // Each entry: { index, landscape, breakType }  where index is the paragraph that ENDS the section
  const sections = [];
  let bodyLandscape = false;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child['w:p']) {
      const pChildren = child['w:p'];
      if (Array.isArray(pChildren)) {
        const pPrChild = findChild(pChildren, 'w:pPr');
        if (pPrChild) {
          const pPrArr = pPrChild['w:pPr'];
          if (Array.isArray(pPrArr)) {
            const sectPrEl = findChild(pPrArr, 'w:sectPr');
            if (sectPrEl) {
              sections.push({
                index: i,
                landscape: isSectPrLandscape(sectPrEl['w:sectPr']),
                breakType: getSectPrBreakType(sectPrEl['w:sectPr']),
              });
            }
          }
        }
      }
    } else if (child['w:sectPr']) {
      // Body-level sectPr (last section)
      bodyLandscape = isSectPrLandscape(child['w:sectPr']);
    }
  }

  if (sections.length === 0 && !bodyLandscape) return null;

  // Build ranges: section i covers from (previous section end + 1) to (this section end)
  // Then the final section covers from (last section end + 1) to document end
  const landscapeRanges = []; // [startIdx, endIdx] inclusive
  let sectionStart = 0;
  for (const sec of sections) {
    if (sec.landscape) {
      landscapeRanges.push([sectionStart, sec.index]);
    }
    sectionStart = sec.index + 1;
  }
  // Final section (body-level sectPr)
  if (bodyLandscape) {
    landscapeRanges.push([sectionStart, children.length - 1]);
  }

  // Build section break map: index → breakType (for emitting \newpage / \cleardoublepage)
  const sectionBreaks = new Map();
  for (const sec of sections) {
    sectionBreaks.set(sec.index, sec.breakType);
  }

  if (landscapeRanges.length === 0 && sectionBreaks.size === 0) return null;

  // Merge adjacent ranges and convert to start/end index sets
  const starts = new Set();
  const ends = new Set();
  for (const [s, e] of landscapeRanges) {
    starts.add(s);
    ends.add(e);
  }
  return { starts, ends, sectionBreaks };
}

// ── Body emission (preserveOrder) ────────────────────────────────────────────

/**
 * @param {any} children
 * @param {any} ctx
 */
function emitOrderedBody(children, ctx) {
  if (!Array.isArray(children)) return;
  const landscape = scanLandscapeSections(children);
  if ((landscape?.starts.size ?? 0) > 0) ctx.usedPackages.add('pdflscape');

  // Pre-scan: identify Caption paragraphs that will be consumed by lookahead
  const consumedIndices = new Set();
  // Map of table index → caption pChildren for captions that precede tables
  const captionBeforeTable = new Map();

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Open landscape environment before this element if needed
    if (landscape?.starts.has(i) && !ctx.inLandscape) {
      closeAllLists(ctx);
      ctx.buf.write('\n\\begin{landscape}\n');
      ctx.inLandscape = true;
    }

    // Skip indices consumed by lookahead (e.g., caption paragraphs)
    if (consumedIndices.has(i)) {
      // Still handle landscape close
      if (landscape?.ends.has(i) && ctx.inLandscape) {
        closeAllLists(ctx);
        ctx.buf.write('\\end{landscape}\n\n');
        ctx.inLandscape = false;
      }
      continue;
    }

    if (child['w:p']) {
      const pChildren = child['w:p'];
      const styleId = getParagraphStyleId(pChildren);

      // Standalone image paragraph: check if next is a Caption paragraph
      if (paragraphHasImage(pChildren) && !isCaptionStyle(styleId)) {
        const captionIdx = findNextCaptionIndex(children, i + 1);
        if (captionIdx !== -1) {
          closeAllLists(ctx);
          const captionPChildren = children[captionIdx]['w:p'];
          emitStandaloneFigure(pChildren, captionPChildren, ctx);
          consumedIndices.add(captionIdx);
          // Handle landscape close for both indices
          if (landscape?.ends.has(i) && ctx.inLandscape) {
            closeAllLists(ctx);
            ctx.buf.write('\\end{landscape}\n\n');
            ctx.inLandscape = false;
          }
          continue;
        }
      }

      // Caption paragraph not consumed by lookahead — check if it precedes a table
      if (isCaptionStyle(styleId)) {
        // Check if previous was a table — if so, it should have been consumed
        if (i > 0 && children[i - 1]?.['w:tbl']) {
          continue;
        }
        // Look ahead for a table — caption-before-table pattern (common for table captions)
        const nextTableIdx = findNextTableIndex(children, i + 1);
        if (nextTableIdx !== -1) {
          // Store this caption for the upcoming table and mark consumed
          captionBeforeTable.set(nextTableIdx, pChildren);
          continue;
        }
        // Orphaned caption — emit as italic text
        const capStart = ctx.buf.pos();
        emitInlineContentOrdered(pChildren, ctx);
        const capContent = extractSince(ctx.buf, capStart);
        if (capContent.trim()) {
          ctx.buf.write(`\\emph{${capContent.trim()}}\n\n`);
        }
        continue;
      }

      emitParagraphOrdered(pChildren, child[':@'] || {}, ctx);
    } else if (child['w:tbl']) {
      closeAllLists(ctx);
      // Check for caption-before-table (from earlier lookahead) or caption-after-table
      let externalCaption = captionBeforeTable.get(i) || null;
      let captionPos = 'above'; // before-table captions go above
      if (!externalCaption) {
        const captionIdx = findNextCaptionIndex(children, i + 1);
        if (captionIdx !== -1) {
          externalCaption = children[captionIdx]['w:p'];
          consumedIndices.add(captionIdx);
          captionPos = 'below'; // after-table captions go below
        }
      }
      emitTableOrdered(child['w:tbl'], ctx, externalCaption, captionPos);
    } else if (child['w:sdt']) {
      // Structured doc tag — unwrap content
      const sdtContent = findChild(child['w:sdt'], 'w:sdtContent');
      if (sdtContent) emitOrderedBody(sdtContent['w:sdtContent'], ctx);
    } else if (child['w:ins']) {
      // Block-level insertion — entire paragraphs/tables inserted as tracked change
      const insAttrs = child[':@'] || {};
      const author = insAttrs['@_w:author'] || 'Unknown';
      const date = insAttrs['@_w:date'] || '';
      const insChildren = Array.isArray(child['w:ins']) ? child['w:ins'] : [child['w:ins']];
      for (const ic of insChildren) {
        if (ic['w:p']) {
          const startPos = ctx.buf.pos();
          emitParagraphOrdered(ic['w:p'], ic[':@'] || {}, ctx);
          const endPos = ctx.buf.pos();
          if (endPos > startPos) {
            const text = ctx.buf.toString().slice(startPos, endPos);
            if (text.trim()) {
              ctx.trackedChanges.push({ type: 'insert', text, from: startPos, to: endPos, author, date });
            }
          }
        } else if (ic['w:tbl']) {
          closeAllLists(ctx);
          emitTableOrdered(ic['w:tbl'], ctx);
        }
      }
    } else if (child['w:del']) {
      // Block-level deletion — entire paragraphs deleted as tracked change
      const delAttrs = child[':@'] || {};
      const author = delAttrs['@_w:author'] || 'Unknown';
      const date = delAttrs['@_w:date'] || '';
      const delChildren = Array.isArray(child['w:del']) ? child['w:del'] : [child['w:del']];
      for (const dc of delChildren) {
        if (dc['w:p']) {
          const startPos = ctx.buf.pos();
          emitParagraphOrdered(dc['w:p'], dc[':@'] || {}, ctx);
          const endPos = ctx.buf.pos();
          if (endPos > startPos) {
            const text = ctx.buf.toString().slice(startPos, endPos);
            if (text.trim()) {
              ctx.trackedChanges.push({ type: 'delete', text, from: startPos, to: endPos, author, date });
            }
          }
        }
      }
    }
    // Track comment ranges at body level (can span multiple paragraphs)
    if (child['w:commentRangeStart'] != null) {
      const id = (child[':@'] || {})['@_w:id'];
      if (id) ctx.commentStarts.set(id, ctx.buf.pos());
    }
    if (child['w:commentRangeEnd'] != null) {
      const id = (child[':@'] || {})['@_w:id'];
      if (id && ctx.commentStarts.has(id)) {
        const from = ctx.commentStarts.get(id);
        const to = ctx.buf.pos();
        const info = ctx.commentMap.get(id);
        if (info && info.text) {
          ctx.comments.push({ from, to, text: info.text, author: info.author, date: info.date });
        }
        ctx.commentStarts.delete(id);
      }
    }
    // Close landscape environment after this element if needed
    if (landscape?.ends.has(i) && ctx.inLandscape) {
      closeAllLists(ctx);
      ctx.buf.write('\\end{landscape}\n\n');
      ctx.inLandscape = false;
    }
    // Emit page break for section breaks not at landscape transitions
    // (landscape start/end already implies a page break)
    if (landscape?.sectionBreaks.has(i) && !landscape.starts.has(i + 1) && !landscape.ends.has(i)) {
      const breakType = landscape.sectionBreaks.get(i);
      if (breakType === 'oddPage' || breakType === 'evenPage') {
        ctx.buf.write('\\cleardoublepage\n');
      } else if (breakType !== 'continuous') {
        ctx.buf.write('\\newpage\n');
      }
    }
    // Skip w:sectPr, bookmarks, etc.
  }
  closeAllLists(ctx);
}

// ── Paragraph (preserveOrder) ────────────────────────────────────────────────

/**
 * @param {any} pChildren
 * @param {any} pAttrs
 * @param {any} ctx
 */
function emitParagraphOrdered(pChildren, pAttrs, ctx) {
  if (!Array.isArray(pChildren)) return;

  // Extract paragraph properties
  let styleId = '', jc = '', numId = null, ilvl = '0';
  let paraIsInserted = false, paraInsAuthor = '', paraInsDate = '';
  let indLeft = 0, indRight = 0, indFirstLine = 0, indHanging = 0;
  let spacingLine = null;
  let pageBreakBefore = false;
  let dropCap = null; // 'drop' or 'margin', with lines count
  const pPrChild = findChild(pChildren, 'w:pPr');
  if (pPrChild) {
    const pPrArr = pPrChild['w:pPr'];
    if (Array.isArray(pPrArr)) {
      for (const item of pPrArr) {
        // In preserveOrder mode, attributes are on item[':@'], not on the child element
        if (item['w:pStyle'] != null) {
          styleId = item[':@']?.['@_w:val'] || '';
        }
        if (item['w:jc'] != null) {
          jc = item[':@']?.['@_w:val'] || '';
        }
        if (item['w:numPr'] != null) {
          const npArr = Array.isArray(item['w:numPr']) ? item['w:numPr'] : [item['w:numPr']];
          for (const np of npArr) {
            if (np['w:numId'] != null) numId = np[':@']?.['@_w:val'] || null;
            if (np['w:ilvl'] != null) ilvl = np[':@']?.['@_w:val'] || '0';
          }
        }
        // Indentation
        if (item['w:ind'] != null) {
          const a = item[':@'] || {};
          indLeft = parseInt(a['@_w:left'] || '0') || 0;
          indRight = parseInt(a['@_w:right'] || '0') || 0;
          indFirstLine = parseInt(a['@_w:firstLine'] || '0') || 0;
          indHanging = parseInt(a['@_w:hanging'] || '0') || 0;
        }
        // Spacing overrides
        if (item['w:spacing'] != null) {
          const a = item[':@'] || {};
          if (a['@_w:line']) spacingLine = parseInt(a['@_w:line']);
        }
        // Page break before
        if (item['w:pageBreakBefore'] != null) {
          const val = item[':@']?.['@_w:val'];
          if (val !== 'false' && val !== '0') pageBreakBefore = true;
        }
        // Drop cap (w:framePr with w:dropCap)
        if (item['w:framePr'] != null) {
          const a = item[':@'] || {};
          const dcType = a['@_w:dropCap'];
          if (dcType === 'drop' || dcType === 'margin') {
            dropCap = { type: dcType, lines: parseInt(a['@_w:lines'] || '3') || 3 };
          }
        }
        // Paragraph-level insertion: w:rPr contains w:ins (paragraph mark was inserted)
        if (item['w:rPr'] != null) {
          const rPrItems = Array.isArray(item['w:rPr']) ? item['w:rPr'] : [item['w:rPr']];
          for (const rp of rPrItems) {
            if (rp['w:ins'] != null) {
              paraIsInserted = true;
              // In preserveOrder mode, w:ins attrs are on the element that has ['w:ins']
              paraInsAuthor = rp[':@']?.['@_w:author'] || 'Unknown';
              paraInsDate = rp[':@']?.['@_w:date'] || '';
            }
          }
        }
        // Also check w:ins directly under w:pPr (alternative structure)
        if (item['w:ins'] != null) {
          paraIsInserted = true;
          paraInsAuthor = item[':@']?.['@_w:author'] || 'Unknown';
          paraInsDate = item[':@']?.['@_w:date'] || '';
        }
      }
    }
  }

  // Inherit paragraph-style properties (indent, spacing, italic, bold) when
  // not set by direct formatting on the paragraph itself.
  // Skip indent inheritance for list items — their indentation comes from the list environment.
  let styleItalic = false, styleBold = false, styleAllCaps = false;
  const styleInfo = ctx.metadata.paragraphStyles?.[styleId];
  if (styleInfo) {
    if (!numId && !indLeft && !indRight && !indFirstLine && !indHanging) {
      if (styleInfo.indLeft) indLeft = styleInfo.indLeft;
      if (styleInfo.indRight) indRight = styleInfo.indRight;
      if (styleInfo.indFirstLine) indFirstLine = styleInfo.indFirstLine;
      if (styleInfo.indHanging) indHanging = styleInfo.indHanging;
    }
    if (spacingLine == null && styleInfo.spacingLine) spacingLine = styleInfo.spacingLine;
    if (!jc && styleInfo.jc) jc = styleInfo.jc;
    if (styleInfo.italic) styleItalic = true;
    if (styleInfo.bold) styleBold = true;
    if (styleInfo.allCaps) styleAllCaps = true;
  }

  // Skip TOC entries — they are just table-of-contents text from Word
  if (isTocStyle(styleId)) return;

  const headingLevel = getHeadingLevel(styleId);
  const isTitle = isTitleStyle(styleId);
  const isQuote = isQuoteStyle(styleId);
  const isVerse = isVerseStyle(styleId);
  const isCode = isCodeStyle(styleId);

  // Handle list/heading environment changes BEFORE emitting inline content,
  // so \begin{itemize}/\end{itemize}/\section{} don't leak into extractSince range.
  if (headingLevel || isTitle) {
    closeAllLists(ctx);
  } else if (numId) {
    const listType = getListType(ctx.numbering, numId, ilvl);
    handleListItem(ctx, listType, parseInt(ilvl));
  } else {
    closeAllLists(ctx);
  }

  // If we're suppressing free-form bibliography text, skip all non-heading paragraphs
  if (ctx.skipUntilNextHeading && !headingLevel) return;

  // Write inline content directly to buffer
  // Set current paragraph style so emitRunOrdered can inherit paragraph-level run props
  ctx.currentParaStyleId = styleId;
  const inlineStart = ctx.buf.pos();
  emitInlineContentOrdered(pChildren, ctx);
  const inlineEnd = ctx.buf.pos();
  const hasContent = inlineEnd > inlineStart;

  // Paragraph-level insertion: w:pPr > w:rPr > w:ins means the paragraph mark
  // (and often its entire content) was inserted. Record runs that aren't already
  // covered by inline w:ins tracked changes.
  if (paraIsInserted && hasContent) {
    const fullText = ctx.buf.toString().slice(inlineStart, inlineEnd);
    if (fullText.trim()) {
      // Check if there are any delete TCs within this paragraph range.
      // If so, the paragraph has mixed old/new text and we need gap-filling.
      // If not, the entire paragraph is new and we can use a single TC.
      const hasDeletes = ctx.trackedChanges.some((/** @type {any} */ tc) =>
        tc.type === 'delete' && tc.from >= inlineStart && tc.to <= inlineEnd);
      if (!hasDeletes) {
        // Pure insertion — remove inline insert TCs and use a single paragraph TC
        const before = ctx.trackedChanges.filter((/** @type {any} */ tc) =>
          !(tc.type === 'insert' && tc.from >= inlineStart && tc.to <= inlineEnd));
        ctx.trackedChanges.length = 0;
        ctx.trackedChanges.push(...before);
        ctx.trackedChanges.push({ type: 'insert', text: fullText, from: inlineStart, to: inlineEnd, author: paraInsAuthor, date: paraInsDate });
      } else {
        // Mixed paragraph — has both inline inserts and deletes.
        // The w:pPr > w:rPr > w:ins flag means the paragraph MARK was inserted
        // (e.g., a paragraph break was added), NOT that all content is new.
        // The gaps between inline tracked changes are the original unchanged text
        // and should NOT be marked as insertions.
      }
    }
  }

  if (!hasContent && !isTitle) {
    // Skip empty paragraphs — including Word's "Chapter N" number-only headings
    // that have numId but no actual text content
    return;
  }

  // Drop cap paragraph: Word puts just the drop letter in a framePr paragraph,
  // then the rest follows as the next paragraph. Emit \lettrine{X}{} with no
  // trailing \par so it merges with the next paragraph.
  if (dropCap && hasContent) {
    const content = extractSince(ctx.buf, inlineStart);
    // Strip formatting wrappers to get the raw letter(s)
    const stripped = content
      .replace(/\\fontsize\{[^}]*\}\{[^}]*\}\\selectfont\s*/g, '')
      .replace(/\\text(?:bf|it|sc)\{([^}]*)\}/g, '$1')
      .replace(/\\setstretch\{[^}]*\}\s*/g, '')
      .replace(/[{}]/g, '')
      .trim();
    const firstChar = stripped.charAt(0);
    const rest = stripped.slice(1);
    ctx.usedPackages.add('lettrine');
    // For drop caps, use the *style's* spacing — the direct w:spacing on the drop cap
    // paragraph is frame-specific (e.g. lineRule="exact" for the large letter) and
    // doesn't represent the actual content line spacing.
    const dcStyleSpacing = ctx.metadata.paragraphStyles?.[styleId]?.spacingLine;
    const dcDocDefault = ctx.metadata.defaultLineSpacing || 360;
    const dcSpacingDiffers = dcStyleSpacing && Math.abs(dcStyleSpacing - dcDocDefault) > 20;
    const dcStretch = dcSpacingDiffers ? (dcStyleSpacing / 240).toFixed(2).replace(/\.?0+$/, '') : '';
    const dcPrefix = dcSpacingDiffers ? `{\\setstretch{${dcStretch}}\n` : '';
    const output = `${dcPrefix}\\lettrine[lines=${dropCap.lines}]{${firstChar}}{${rest}}`;
    adjustTrackedChangePositions(ctx, inlineStart, output.length);
    ctx.buf.write(output);
    // No \n\n — let it join with the next paragraph.
    // Flag so the next paragraph skips {\setstretch{...}...\par} wrapping
    // which would insert a \par that terminates lettrine prematurely.
    ctx.afterDropCap = true;
    ctx.afterDropCapSingleSpacing = dcSpacingDiffers;
    return;
  }

  if (isTitle) {
    const content = extractSince(ctx.buf, inlineStart);
    if (/^Subtitle$/i.test(styleId)) {
      // Subtitle: emit as centered text below title
      const prefix = '{\\centering ';
      const suffix = '\\par}\n\n';
      adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
      ctx.buf.write(prefix + content + suffix);
    } else {
      // Title style: emit \title{...}\maketitle
      const prefix = '\\title{';
      const suffix = '}\n\\maketitle\n\n';
      adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
      ctx.buf.write(prefix + content + suffix);
    }
    return;
  }

  if (headingLevel) {
    let content = extractSince(ctx.buf, inlineStart);
    // Clean heading content: remove line breaks (\\) which break titlesec,
    // and move \footnote{} outside the heading argument
    // Remove \\, \newpage, and leading/trailing whitespace
    content = content.replace(/\\newpage\s*/g, '').replace(/\s*\\\\\s*/g, ' ').trim();

    // Replace TOC/LoF/LoT headings with proper LaTeX commands
    if (/^(Heading1PreTOC|Heading1NoChapNo)$/i.test(styleId)) {
      const plainContent = content.replace(/\\text(?:bf|it|sc)\{([^}]*)\}/g, '$1').replace(/[{}]/g, '').trim().toLowerCase();
      const tocCmd = getTocReplacementCommand(plainContent);
      if (tocCmd) {
        ctx.buf.write(tocCmd);
        return;
      }
    }

    // Emit \frontmatter before the first unnumbered chapter heading (pre-content),
    // and \mainmatter before the first numbered chapter heading
    if (headingLevel === 1 && ctx.docClass === 'book' && !ctx.emittedMainmatter) {
      // Determine if this heading should be numbered
      let isNum = false;
      if (styleId && ctx.metadata.headingStyleNumbered?.[styleId] !== undefined) {
        isNum = ctx.metadata.headingStyleNumbered[styleId];
      } else {
        isNum = !!ctx.metadata.headingStyles?.[headingLevel]?.numbered;
      }
      if (numId === '0') isNum = false;

      if (isNum) {
        ctx.buf.write('\\mainmatter\n');
        ctx.emittedMainmatter = true;
      } else if (!ctx.emittedFrontmatter) {
        ctx.buf.write('\\frontmatter\n');
        ctx.emittedFrontmatter = true;
      }
    }

    // Extract \footnote{...} with proper nested brace matching
    let footnotes = '';
    let fnIdx;
    while ((fnIdx = content.indexOf('\\footnote{')) !== -1) {
      const braceStart = fnIdx + '\\footnote'.length;
      let depth = 0;
      let pos = braceStart;
      while (pos < content.length) {
        if (content[pos] === '{') depth++;
        else if (content[pos] === '}') { depth--; if (depth === 0) break; }
        pos++;
      }
      if (depth === 0) {
        footnotes += content.substring(fnIdx, pos + 1);
        content = content.substring(0, fnIdx) + content.substring(pos + 1);
      } else {
        break; // malformed — stop trying
      }
    }
    const hasChapter = ctx.docClass === 'book' || ctx.docClass === 'report';
    const cmds = hasChapter
      ? ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph']
      : ['section', 'subsection', 'subsubsection', 'paragraph'];
    const cmd = cmds[headingLevel - 1] || 'paragraph';
    // Determine if this heading should be numbered:
    // 1. Check the specific style variant (e.g. Heading1NoChapNo has numId="0")
    // 2. Check paragraph-level numId override
    // 3. Fall back to the base heading level's numbered property
    let isNumbered = false;
    if (styleId && ctx.metadata.headingStyleNumbered?.[styleId] !== undefined) {
      isNumbered = ctx.metadata.headingStyleNumbered[styleId];
    } else {
      isNumbered = !!ctx.metadata.headingStyles?.[headingLevel]?.numbered;
    }
    // Paragraph-level numId="0" overrides to unnumbered
    if (numId === '0') isNumbered = false;
    // Strip inline \fontsize wrappers from heading content — clean-output
    // mode leaves heading styling to LaTeXs default. Per-run size and font
    // overrides from the docx source shouldnt leak into the section title.
    content = stripFontsizeWrappers(content);
    content = stripInlineFontspec(content);
    // Drop \MakeUppercase / \textsc / \color wrappers too: the heading
    // visual aesthetic is whatever the LaTeX section style produces. The
    // style ID from Word still picks the *level* (\section vs \subsection),
    // it just no longer dictates the *look*.
    const star = isNumbered ? '' : '*';
    const prefix = `\\${cmd}${star}{`;
    const suffix = `}${footnotes}\n\n`;
    adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
    // Detect "References" / "Bibliography" heading — if bib entries exist, suppress
    // the free-form reference text that follows (it's replaced by \bibliography{})
    const plainHeading = content.replace(/\\text(?:bf|it|sc)\{([^}]*)\}/g, '$1').replace(/[{}\\]/g, '').trim().toLowerCase();
    if (/^(references|bibliography|works cited|literature|literaturverzeichnis)$/.test(plainHeading)) {
      if (ctx.bibEntries && ctx.bibEntries.size > 0) {
        ctx.skipUntilNextHeading = true;
      }
    } else {
      ctx.skipUntilNextHeading = false;
    }
    ctx.buf.write(prefix + content + suffix);
    return;
  }

  if (numId) {
    const content = extractSince(ctx.buf, inlineStart);
    const prefix = '\\item ';
    adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
    ctx.buf.write(prefix + content + '\n');
    return;
  }

  if (jc === 'center' || jc === 'right' || jc === 'end') {
    const content = extractSince(ctx.buf, inlineStart);
    const cmd = jc === 'center' ? 'centering' : 'raggedleft';
    const prefix = `{\\${cmd} `;
    const suffix = '\\par}\n\n';
    adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
    ctx.buf.write(prefix + content + suffix);
    return;
  }

  // Block quote styles — emit a plain quote environment with no
  // per-style font-size / setstretch wrapper. Clean-output mode means
  // \begin{quote} ... \end{quote} reads as-is; users who want a
  // visually different quote can swap to quotation, verse, or a custom
  // env themselves.
  if (isQuote) {
    const content = extractSince(ctx.buf, inlineStart);
    const prefix = '\\begin{quote}\n';
    const suffix = '\n\\end{quote}\n\n';
    adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
    ctx.buf.write(prefix + content + suffix);
    return;
  }

  // Verse / poetry styles → verse environment.
  if (isVerse) {
    const content = extractSince(ctx.buf, inlineStart);
    const prefix = '\\begin{verse}\n';
    const suffix = '\n\\end{verse}\n\n';
    adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
    ctx.buf.write(prefix + content + suffix);
    return;
  }

  // Code / preformatted styles → verbatim. Strip the inline content
  // back to plain text because verbatim cant nest LaTeX commands; any
  // tracked-change mark in the middle is therefore intentionally
  // flattened here (rare edge case for code blocks).
  if (isCode) {
    const content = extractSince(ctx.buf, inlineStart);
    const plain = content
      .replace(/\\[A-Za-z]+\*?(?:\{[^}]*\})?/g, '')
      .replace(/[{}]/g, '');
    const prefix = '\\begin{verbatim}\n';
    const suffix = '\n\\end{verbatim}\n\n';
    adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
    ctx.buf.write(prefix + plain + suffix);
    return;
  }

  // Page break before
  if (pageBreakBefore) {
    const content = extractSince(ctx.buf, inlineStart);
    const prefix = '\\newpage\n';
    adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
    ctx.buf.write(prefix + content);
  }

  // After a drop cap, the next paragraph must merge with \lettrine — skip
  // all group wrappers ({\setstretch{...}...\par}) that would insert a \par
  // and prematurely end the lettrine paragraph.
  if (ctx.afterDropCap) {
    ctx.afterDropCap = false;
    const content = extractSince(ctx.buf, inlineStart);
    adjustTrackedChangePositions(ctx, inlineStart, 0);
    // Close the setstretch group opened by the drop cap if single-spacing was active
    const closeBrace = ctx.afterDropCapSingleSpacing ? '\\par}\n\n' : '\n\n';
    ctx.afterDropCapSingleSpacing = false;
    ctx.buf.write(content + closeBrace);
    return;
  }

  // Paragraph indentation and spacing adjustments
  const hasIndent = indLeft > 0 || indRight > 0 || indFirstLine > 0 || indHanging > 0;
  // Detect paragraph spacing that differs from document default (240=single, 360=1.5×, 480=double)
  const docDefaultSpacing = ctx.metadata.defaultLineSpacing || 360; // fallback: 1.5× if not detected
  const paraSpacingDiffers = spacingLine && Math.abs(spacingLine - docDefaultSpacing) > 20;
  const paraStretch = paraSpacingDiffers ? (spacingLine / 240).toFixed(2).replace(/\.?0+$/, '') : '';
  if (hasIndent || paraSpacingDiffers) {
    let content = extractSince(ctx.buf, inlineStart);
    // Apply paragraph-level formatting from style definition
    if (styleAllCaps && content.trim()) content = `\\MakeUppercase{${content}}`;
    if (styleItalic && content.trim()) content = `\\emph{${content}}`;
    if (styleBold && content.trim()) content = `\\textbf{${content}}`;
    let prefix = '';
    let suffix = '';
    // Hanging indent (used by bibliography): leftmargin=total, itemindent=-hanging
    if (indHanging > 0) {
      const leftIn = ((indLeft || indHanging) / 1440).toFixed(2);
      const hangIn = (indHanging / 1440).toFixed(2);
      prefix = `{\\setlength{\\leftskip}{${leftIn}in}\\setlength{\\parindent}{-${hangIn}in}`;
      if (indRight > 0) prefix += `\\setlength{\\rightskip}{${(indRight / 1440).toFixed(2)}in}`;
      if (paraSpacingDiffers) prefix += `\\setstretch{${paraStretch}}`;
      prefix += '\n';
      suffix = '\\par}\n\n';
    } else if (indLeft > 0 || indRight > 0 || indFirstLine > 0) {
      prefix = '{';
      if (indLeft > 0) prefix += `\\setlength{\\leftskip}{${(indLeft / 1440).toFixed(2)}in}`;
      if (indRight > 0) prefix += `\\setlength{\\rightskip}{${(indRight / 1440).toFixed(2)}in}`;
      if (indFirstLine > 0) prefix += `\\setlength{\\parindent}{${(indFirstLine / 1440).toFixed(2)}in}`;
      if (paraSpacingDiffers) prefix += `\\setstretch{${paraStretch}}`;
      prefix += '\n';
      suffix = '\\par}\n\n';
    } else if (paraSpacingDiffers) {
      prefix = `{\\setstretch{${paraStretch}}\n`;
      suffix = '\\par}\n\n';
    }
    if (prefix) {
      adjustTrackedChangePositions(ctx, inlineStart, prefix.length);
      ctx.buf.write(prefix + content + suffix);
      return;
    }
  }

  // Paragraph-level italic/bold/allCaps from style (no indent case)
  if ((styleItalic || styleBold || styleAllCaps) && !headingLevel && !isTitle) {
    const content = extractSince(ctx.buf, inlineStart);
    if (content.trim()) {
      let wrapped = content;
      if (styleAllCaps) wrapped = `\\MakeUppercase{${wrapped}}`;
      if (styleItalic) wrapped = `\\emph{${wrapped}}`;
      if (styleBold) wrapped = `\\textbf{${wrapped}}`;
      adjustTrackedChangePositions(ctx, inlineStart, 0);
      ctx.buf.write(wrapped + '\n\n');
      return;
    }
  }

  // Regular paragraph
  ctx.buf.write('\n\n');
}

/** Strip {\fontspec{Name}...} wrappers, keeping the inner content. Used
 *  to keep heading content clean — fontspec on a section title is loud
 * @param {any} str
 *  and almost never what the LaTeX user wants. */
function stripInlineFontspec(str) {
  let result = str;
  let idx;
  while ((idx = result.indexOf('{\\fontspec{')) !== -1) {
    // Find the closing brace of \fontspec{...}
    const fsOpenBraceIdx = idx + '{\\fontspec'.length; // points at the next '{'
    let depth = 1;
    let pos = fsOpenBraceIdx + 1;
    while (pos < result.length && depth > 0) {
      if (result[pos] === '{') depth++;
      else if (result[pos] === '}') depth--;
      pos++;
    }
    if (depth !== 0) break;
    // `pos` is now just past the closing `}` of \fontspec{Name}. The inner
    // content of the outer `{...}` starts here. Find that outer closing `}`.
    let innerStart = pos;
    let outerDepth = 1;
    let outerPos = innerStart;
    while (outerPos < result.length && outerDepth > 0) {
      if (result[outerPos] === '{') outerDepth++;
      else if (result[outerPos] === '}') outerDepth--;
      outerPos++;
    }
    if (outerDepth !== 0) break;
    const inner = result.substring(innerStart, outerPos - 1);
    result = result.substring(0, idx) + inner + result.substring(outerPos);
  }
  return result;
}

/** Extract text written since position `from` by removing it from the buffer end. */
/**
 * Strip {\fontsize{N}{M}\selectfont ...} wrappers, keeping the inner content.
 * @param {any} str
 */
function stripFontsizeWrappers(str) {
  let result = str;
  let idx;
  while ((idx = result.indexOf('{\\fontsize{')) !== -1) {
    // Find the \selectfont that closes the preamble
    const sfIdx = result.indexOf('\\selectfont ', idx);
    if (sfIdx === -1) break;
    const innerStart = sfIdx + '\\selectfont '.length;
    // Find matching closing brace
    let depth = 1, pos = innerStart;
    while (pos < result.length && depth > 0) {
      if (result[pos] === '{') depth++;
      else if (result[pos] === '}') depth--;
      pos++;
    }
    if (depth === 0) {
      const inner = result.substring(innerStart, pos - 1);
      result = result.substring(0, idx) + inner + result.substring(pos);
    } else {
      break;
    }
  }
  return result;
}

/**
 * @param {any} buf
 * @param {any} from
 */
function extractSince(buf, from) {
  // Reconstruct what was written since `from`
  const full = buf.toString();
  const content = full.slice(from);
  // Reset buffer to position `from`
  buf.parts = [full.slice(0, from)];
  buf.length = from;
  return content;
}

/**
 * After extractSince + re-write with a prefix, shift tracked change positions that fall in the extracted range.
 * @param {any} ctx
 * @param {any} rangeStart
 * @param {any} prefixLen
 */
function adjustTrackedChangePositions(ctx, rangeStart, prefixLen) {
  for (const tc of ctx.trackedChanges) {
    if (tc.from >= rangeStart) {
      tc.from += prefixLen;
      tc.to += prefixLen;
    }
  }
}

/**
 * Remap tracked change positions after a deletion-only string transformation
 * (e.g. mergeAdjacentFontSizeRuns which only removes characters like }\emph{ between blocks).
 *
 * Builds a character-level position map from oldLatex to newLatex using a two-pointer scan.
 * Since the merge only removes characters (never inserts or reorders), every character in
 * newLatex has a unique source position in oldLatex, preserving relative order.
 * @param {any} trackedChanges
 * @param {any} oldLatex
 * @param {any} newLatex
 */
function remapTrackedChangePositions(trackedChanges, oldLatex, newLatex) {
  // Build old→new position map via two-pointer scan
  // map[i] = position in newLatex of the character that was at position i in oldLatex, or -1 if removed
  const map = new Int32Array(oldLatex.length + 1);
  let j = 0;
  for (let i = 0; i < oldLatex.length; i++) {
    if (j < newLatex.length && oldLatex[i] === newLatex[j]) {
      map[i] = j;
      j++;
    } else {
      map[i] = -1;
    }
  }
  map[oldLatex.length] = newLatex.length;

  // Snap a position forward to the next surviving character
  /**
   * @param {any} pos
   */
  function remapPos(pos) {
    if (pos >= map.length) return newLatex.length;
    if (map[pos] !== -1) return map[pos];
    for (let i = pos + 1; i < map.length; i++) {
      if (map[i] !== -1) return map[i];
    }
    return newLatex.length;
  }

  for (const tc of trackedChanges) {
    const newFrom = remapPos(tc.from);
    const newTo = remapPos(tc.to);
    tc.from = newFrom;
    tc.to = newTo;
    tc.text = newLatex.slice(newFrom, newTo);
  }
}

// ── Inline content (preserveOrder) ───────────────────────────────────────────

/**
 * @param {any} pChildren
 * @param {any} ctx
 */
function emitInlineContentOrdered(pChildren, ctx) {
  if (!Array.isArray(pChildren)) return;

  // Field code state: tracks begin/separate/end for Word field codes
  // (e.g., EndNote citations, cross-references, SEQ fields).
  // Only emit text between "separate" and "end" (the display text).
  let fieldDepth = 0;    // nested field depth
  let fieldState = 'none'; // 'none' | 'instr' | 'display' | 'citation' (skip display for cite)
  let currentFieldInstr = ''; // accumulated instrText for current field
  let citationFieldDepth = 0; // depth at which citation was detected (to handle nested fields)

  for (const child of pChildren) {
    if (child['w:pPr']) continue; // skip paragraph props

    // Handle field codes: w:fldChar begin/separate/end
    if (child['w:r']) {
      const rArr = child['w:r'];
      if (Array.isArray(rArr)) {
        // Check if this run contains a field character or instrText
        for (const rc of rArr) {
          if (rc['w:fldChar'] != null) {
            const fldType = (rc[':@'] || {})['@_w:fldCharType'] || '';
            if (fldType === 'begin') {
              fieldDepth++;
              // Only reset to instr if not already in citation state
              // (nested fields inside citation should stay suppressed)
              if (fieldState !== 'citation') {
                fieldState = 'instr';
                currentFieldInstr = '';
              }
            } else if (fldType === 'separate') {
              if (fieldDepth > 0 && fieldState !== 'citation') {
                // Check if this is an EndNote citation field
                if (/ADDIN EN\.CITE/i.test(currentFieldInstr)) {
                  const citeInfos = parseEndNoteCitations(currentFieldInstr, ctx);
                  if (citeInfos.length > 0) {
                    ctx.usedPackages.add('natbib');
                    ctx.buf.write(buildCiteCommand(citeInfos));
                    citationFieldDepth = fieldDepth;
                    fieldState = 'citation'; // skip display text
                  } else {
                    fieldState = 'display';
                  }
                } else {
                  fieldState = 'display';
                }
              }
              // else: stay in citation state for nested field separators
            } else if (fldType === 'end') {
              fieldDepth--;
              if (fieldDepth <= 0) {
                fieldDepth = 0;
                fieldState = 'none';
                citationFieldDepth = 0;
              } else if (citationFieldDepth > 0 && fieldDepth >= citationFieldDepth) {
                // Still inside the citation field — stay in citation state
                fieldState = 'citation';
              } else {
                citationFieldDepth = 0;
                fieldState = 'display';
              }
              currentFieldInstr = '';
            }
          }
          // Collect instrText when in instruction state
          if (fieldState === 'instr' && rc['w:instrText'] != null) {
            currentFieldInstr += getPreserveOrderText(rc['w:instrText']);
          }
        }
        // Skip instrText runs and citation display runs
        if (fieldState === 'instr' || fieldState === 'citation') continue;
      }
      emitRunOrdered(child['w:r'], child[':@'] || {}, ctx);
    }

    if (child['w:ins']) {
      const insAttrs = child[':@'] || {};
      const author = insAttrs['@_w:author'] || 'Unknown';
      const date = insAttrs['@_w:date'] || '';
      const startPos = ctx.buf.pos();
      const insChildren = Array.isArray(child['w:ins']) ? child['w:ins'] : [child['w:ins']];
      for (const ic of insChildren) {
        if (ic['w:r']) {
          const icArr = Array.isArray(ic['w:r']) ? ic['w:r'] : [ic['w:r']];
          for (const rc of icArr) {
            if (rc['w:fldChar'] != null) {
              const fldType = (rc[':@'] || {})['@_w:fldCharType'] || '';
              if (fldType === 'begin') {
                fieldDepth++;
                if (fieldState !== 'citation') { fieldState = 'instr'; currentFieldInstr = ''; }
              } else if (fldType === 'separate') {
                if (fieldDepth > 0 && fieldState !== 'citation') {
                  if (/ADDIN EN\.CITE/i.test(currentFieldInstr)) {
                    const citeInfos = parseEndNoteCitations(currentFieldInstr, ctx);
                    if (citeInfos.length > 0) { ctx.usedPackages.add('natbib'); ctx.buf.write(buildCiteCommand(citeInfos)); citationFieldDepth = fieldDepth; fieldState = 'citation'; }
                    else fieldState = 'display';
                  } else fieldState = 'display';
                }
              } else if (fldType === 'end') {
                fieldDepth--;
                if (fieldDepth <= 0) { fieldDepth = 0; fieldState = 'none'; citationFieldDepth = 0; }
                else if (citationFieldDepth > 0 && fieldDepth >= citationFieldDepth) fieldState = 'citation';
                else { citationFieldDepth = 0; fieldState = 'display'; }
                currentFieldInstr = '';
              }
            }
            if (fieldState === 'instr' && rc['w:instrText'] != null) currentFieldInstr += getPreserveOrderText(rc['w:instrText']);
          }
          if (fieldState !== 'instr' && fieldState !== 'citation') emitRunOrdered(ic['w:r'], ic[':@'] || {}, ctx);
        }
      }
      const endPos = ctx.buf.pos();
      if (endPos > startPos) {
        const text = ctx.buf.toString().slice(startPos, endPos);
        if (text.trim()) {
          ctx.trackedChanges.push({ type: 'insert', text, from: startPos, to: endPos, author, date });
        }
      }
    }

    if (child['w:del']) {
      const delAttrs = child[':@'] || {};
      const author = delAttrs['@_w:author'] || 'Unknown';
      const date = delAttrs['@_w:date'] || '';
      const startPos = ctx.buf.pos();
      const delChildren = Array.isArray(child['w:del']) ? child['w:del'] : [child['w:del']];
      for (const dc of delChildren) {
        if (dc['w:r']) {
          const dcArr = Array.isArray(dc['w:r']) ? dc['w:r'] : [dc['w:r']];
          for (const rc of dcArr) {
            if (rc['w:fldChar'] != null) {
              const fldType = (rc[':@'] || {})['@_w:fldCharType'] || '';
              if (fldType === 'begin') {
                fieldDepth++;
                if (fieldState !== 'citation') { fieldState = 'instr'; currentFieldInstr = ''; }
              } else if (fldType === 'separate') {
                if (fieldDepth > 0 && fieldState !== 'citation') {
                  if (/ADDIN EN\.CITE/i.test(currentFieldInstr)) {
                    const citeInfos = parseEndNoteCitations(currentFieldInstr, ctx);
                    if (citeInfos.length > 0) { ctx.usedPackages.add('natbib'); ctx.buf.write(buildCiteCommand(citeInfos)); citationFieldDepth = fieldDepth; fieldState = 'citation'; }
                    else fieldState = 'display';
                  } else fieldState = 'display';
                }
              } else if (fldType === 'end') {
                fieldDepth--;
                if (fieldDepth <= 0) { fieldDepth = 0; fieldState = 'none'; citationFieldDepth = 0; }
                else if (citationFieldDepth > 0 && fieldDepth >= citationFieldDepth) fieldState = 'citation';
                else { citationFieldDepth = 0; fieldState = 'display'; }
                currentFieldInstr = '';
              }
            }
            if (fieldState === 'instr' && rc['w:instrText'] != null) currentFieldInstr += getPreserveOrderText(rc['w:instrText']);
          }
          if (fieldState !== 'instr' && fieldState !== 'citation') emitRunDeletionOrdered(dc['w:r'], dc[':@'] || {}, ctx);
        }
      }
      const endPos = ctx.buf.pos();
      if (endPos > startPos) {
        const text = ctx.buf.toString().slice(startPos, endPos);
        if (text.trim()) {
          ctx.trackedChanges.push({ type: 'delete', text, from: startPos, to: endPos, author, date });
        }
      }
    }

    // Skip hyperlinks and field codes inside citation fields
    if (child['w:hyperlink'] && fieldState !== 'citation' && fieldState !== 'instr') {
      emitHyperlinkOrdered(child['w:hyperlink'], child[':@'] || {}, ctx);
    }

    // Simple field codes: w:fldSimple wraps display content directly
    if (child['w:fldSimple'] != null && fieldState !== 'citation' && fieldState !== 'instr') {
      const fldChildren = Array.isArray(child['w:fldSimple']) ? child['w:fldSimple'] : [child['w:fldSimple']];
      for (const fc of fldChildren) {
        if (fc['w:r']) emitRunOrdered(fc['w:r'], fc[':@'] || {}, ctx);
      }
    }

    // Track comment ranges
    if (child['w:commentRangeStart'] != null) {
      const id = (child[':@'] || {})['@_w:id'];
      if (id) ctx.commentStarts.set(id, ctx.buf.pos());
    }
    if (child['w:commentRangeEnd'] != null) {
      const id = (child[':@'] || {})['@_w:id'];
      if (id && ctx.commentStarts.has(id)) {
        const from = ctx.commentStarts.get(id);
        const to = ctx.buf.pos();
        const info = ctx.commentMap.get(id);
        if (info && info.text) {
          ctx.comments.push({ from, to, text: info.text, author: info.author, date: info.date });
        }
        ctx.commentStarts.delete(id);
      }
    }
  }
}

// ── Run emission (preserveOrder) ─────────────────────────────────────────────

/**
 * @param {any} rChildren
 * @param {any} rAttrs
 * @param {any} ctx
 */
function emitRunOrdered(rChildren, rAttrs, ctx) {
  if (!Array.isArray(rChildren)) return;

  // Extract formatting from w:rPr in preserveOrder mode
  // Each formatting prop is { "w:b": [], ":@": { "@_w:val": "..." } } or just { "w:b": [] }
  let bold = false, italic = false, underline = false, vertAlign = '';
  let smallCaps = false, allCaps = false, strike = false;
  let fontSize = 0; // half-points (w:sz val), 0 = inherit
  const rPrChild = findChild(rChildren, 'w:rPr');
  if (rPrChild) {
    const rPr = Array.isArray(rPrChild['w:rPr']) ? rPrChild['w:rPr'] : [rPrChild['w:rPr']];
    // First, inherit formatting from character style (w:rStyle) if present
    for (const prop of rPr) {
      if (prop['w:rStyle'] != null) {
        const styleId = prop[':@']?.['@_w:val'];
        const csInfo = styleId && ctx.metadata.characterStyles?.[styleId];
        if (csInfo) {
          if (csInfo.bold) bold = true;
          if (csInfo.italic) italic = true;
          if (csInfo.smallCaps) smallCaps = true;
          if (csInfo.allCaps) allCaps = true;
          if (csInfo.underline) underline = true;
          if (csInfo.strike) strike = true;
        }
        break;
      }
    }
    // Then apply direct formatting (overrides character style)
    for (const prop of rPr) {
      if (prop['w:b'] != null) {
        const val = prop[':@']?.['@_w:val'];
        if (val === 'false' || val === '0') bold = false;
        else bold = true;
      }
      if (prop['w:i'] != null) {
        const val = prop[':@']?.['@_w:val'];
        if (val === 'false' || val === '0') italic = false;
        else italic = true;
      }
      if (prop['w:u'] != null) {
        const val = prop[':@']?.['@_w:val'];
        if (val === 'none') underline = false;
        else underline = true;
      }
      if (prop['w:vertAlign'] != null) {
        vertAlign = prop[':@']?.['@_w:val'] || '';
      }
      if (prop['w:smallCaps'] != null) {
        const val = prop[':@']?.['@_w:val'];
        if (val === 'false' || val === '0') smallCaps = false;
        else smallCaps = true;
      }
      if (prop['w:caps'] != null) {
        const val = prop[':@']?.['@_w:val'];
        if (val === 'false' || val === '0') allCaps = false;
        else allCaps = true;
      }
      if (prop['w:strike'] != null) {
        const val = prop[':@']?.['@_w:val'];
        if (val === 'false' || val === '0') strike = false;
        else strike = true;
      }
      if (prop['w:sz'] != null) {
        fontSize = parseInt(prop[':@']?.['@_w:val'] || '0') || 0;
      }
    }
  }

  // Inherit smallCaps/allCaps from paragraph style if not set by direct or char style
  if (!smallCaps && !allCaps && ctx.currentParaStyleId) {
    const psInfo = ctx.metadata.paragraphStyles?.[ctx.currentParaStyleId];
    if (psInfo?.smallCaps) smallCaps = true;
    if (psInfo?.allCaps) allCaps = true;
  }

  // Collect raw text content first
  let rawText = '';

  for (const child of rChildren) {
    if (child['w:t'] != null) {
      const tArr = Array.isArray(child['w:t']) ? child['w:t'] : [child['w:t']];
      for (const t of tArr) {
        if (typeof t === 'string') rawText += escapeLatex(t);
        else if (t['#text'] != null) rawText += escapeLatex(String(t['#text']));
        else {
          // Empty t element — may have space preserved
          const text = t?.['#text'];
          if (text != null) rawText += escapeLatex(String(text));
        }
      }
    }
    if (child['w:noBreakHyphen'] != null) { rawText += '-'; }
    if (child['w:tab'] != null) { rawText += '\\hspace{0.5in}'; }
    if (child['w:br'] != null) {
      const type = child[':@']?.['@_w:type'] || '';
      rawText += type === 'page' ? '\\newpage\n' : '\\\\\n';
    }
    if (child['w:footnoteReference'] != null) {
      const fnId = child[':@']?.['@_w:id'];
      const content = ctx.footnoteMap?.get(fnId);
      if (content) rawText += `\\footnote{${content}}`;
    }
    if (child['w:endnoteReference'] != null) {
      const enId = child[':@']?.['@_w:id'];
      const content = ctx.endnoteMap?.get(enId);
      if (content) { ctx.usedPackages.add('endnotes'); rawText += `\\endnote{${content}}`; }
    }
    if (child['w:drawing'] != null) {
      const drawArr = Array.isArray(child['w:drawing']) ? child['w:drawing'] : [child['w:drawing']];
      for (const d of drawArr) {
        rawText += emitDrawing(d, ctx);
      }
    }
  }

  if (!rawText) return;

  // Apply formatting wrappers
  let text = rawText;
  if (vertAlign === 'superscript') text = `\\textsuperscript{${text}}`;
  else if (vertAlign === 'subscript') text = `\\textsubscript{${text}}`;
  if (strike) { ctx.usedPackages.add('ulem'); text = `\\sout{${text}}`; }
  if (underline) { ctx.usedPackages.add('ulem'); text = `\\uline{${text}}`; }
  if (smallCaps) text = `\\textsc{${text}}`;
  if (allCaps) text = `\\MakeUppercase{${text}}`;
  if (italic) text = `\\emph{${text}}`;
  if (bold) text = `\\textbf{${text}}`;
  // Font size override: emit \fontsize when run size differs from document default
  if (fontSize > 0) {
    const ptSize = fontSize / 2;
    const docSize = parseFloat(ctx.metadata.mainFontSize || '12');
    if (Math.abs(ptSize - docSize) >= 1) {
      const lead = Math.round(ptSize * 1.2);
      text = `{\\fontsize{${ptSize}}{${lead}}\\selectfont ${text}}`;
    }
  }

  ctx.buf.write(text);
}

/**
 * Emit a deletion run (uses w:delText).
 * @param {any} rChildren
 * @param {any} rAttrs
 * @param {any} ctx
 */
function emitRunDeletionOrdered(rChildren, rAttrs, ctx) {
  if (!Array.isArray(rChildren)) return;

  let bold = false, italic = false;
  const rPrChild = findChild(rChildren, 'w:rPr');
  if (rPrChild) {
    const rPr = Array.isArray(rPrChild['w:rPr']) ? rPrChild['w:rPr'] : [rPrChild['w:rPr']];
    for (const prop of rPr) {
      if (boolProp(prop, 'w:b')) bold = true;
      if (boolProp(prop, 'w:i')) italic = true;
    }
  }

  let rawText = '';
  for (const child of rChildren) {
    if (child['w:delText'] != null) {
      const dtArr = Array.isArray(child['w:delText']) ? child['w:delText'] : [child['w:delText']];
      for (const dt of dtArr) {
        if (typeof dt === 'string') rawText += escapeLatex(dt);
        else if (dt['#text'] != null) rawText += escapeLatex(String(dt['#text']));
      }
    }
  }

  if (!rawText) return;

  let text = rawText;
  if (italic) text = `\\emph{${text}}`;
  if (bold) text = `\\textbf{${text}}`;

  ctx.buf.write(text);
}

// ── Inline content (regular parsed format, for footnotes) ────────────────────

/**
 * @param {any} p
 * @param {any} ctx
 */
function emitInlineContentParsed(p, ctx) {
  for (const r of asArray(p['w:r'])) {
    emitRunParsed(r, ctx);
  }
  for (const ins of asArray(p['w:ins'])) {
    for (const r of asArray(ins['w:r'])) emitRunParsed(r, ctx);
  }
  for (const hl of asArray(p['w:hyperlink'])) {
    const rId = hl['@_r:id'];
    const rel = ctx.rels.get(rId);
    const url = rel?.target || '';
    const start = ctx.buf.pos();
    for (const r of asArray(hl['w:r'])) emitRunParsed(r, ctx);
    if (url) {
      const content = extractSince(ctx.buf, start);
      ctx.usedPackages.add('hyperref');
      ctx.buf.write(`\\href{${url}}{${content}}`);
    }
  }
}

/**
 * @param {any} r
 * @param {any} ctx
 */
function emitRunParsed(r, ctx) {
  const rPr = r['w:rPr'];
  const bold = boolProp(rPr, 'w:b');
  const italic = boolProp(rPr, 'w:i');

  let text = '';
  for (const t of asArray(r['w:t'])) {
    const val = typeof t === 'string' ? t : (t['#text'] || '');
    text += escapeLatex(val);
  }
  if (r['w:tab'] != null) text += '\\hspace{0.5in}';
  for (const br of asArray(r['w:br'])) {
    text += (br?.['@_w:type'] === 'page') ? '\\newpage\n' : '\\\\\n';
  }
  for (const fn of asArray(r['w:footnoteReference'])) {
    const content = ctx.footnoteMap?.get(fn['@_w:id']);
    if (content) text += `\\footnote{${content}}`;
  }

  if (!text) return;
  if (italic) text = `\\emph{${text}}`;
  if (bold) text = `\\textbf{${text}}`;
  ctx.buf.write(text);
}

// ── Hyperlinks (preserveOrder) ───────────────────────────────────────────────

/**
 * @param {any} hlChildren
 * @param {any} hlAttrs
 * @param {any} ctx
 */
function emitHyperlinkOrdered(hlChildren, hlAttrs, ctx) {
  const rId = hlAttrs['@_r:id'];
  const rel = ctx.rels.get(rId);
  const url = rel?.target || '';
  const start = ctx.buf.pos();

  if (Array.isArray(hlChildren)) {
    for (const child of hlChildren) {
      if (child['w:r']) emitRunOrdered(child['w:r'], child[':@'] || {}, ctx);
    }
  }

  if (url && ctx.buf.pos() > start) {
    const content = extractSince(ctx.buf, start);
    ctx.usedPackages.add('hyperref');
    ctx.buf.write(`\\href{${url}}{${content}}`);
  }
}

// ── Image emission ───────────────────────────────────────────────────────────

/**
 * @param {any} drawing
 * @param {any} ctx
 */
function emitDrawing(drawing, ctx) {
  ctx.usedPackages.add('graphicx');
  const blipId = findDeep(drawing, '@_r:embed');
  if (!blipId) return '';
  const rel = ctx.rels.get(blipId);
  if (!rel || rel.type !== 'image') return '';

  const imgExt = rel.target.split('.').pop().toLowerCase();

  // Check if this image couldn't be converted — use a visible placeholder, not a
  // % comment, because the caller may wrap this in \textbf{} and a % would
  // comment out the closing brace.
  if (ctx.unconvertible && ctx.unconvertible.has(rel.target)) {
    return `\\fbox{\\small Image not available: ${rel.target.replace(/_/g, '\\_')} (${imgExt.toUpperCase()})}`;
  }

  // Formats converted at extraction time: SVG→PDF, GIF/TIFF/BMP→PNG, WMF/EMF→PDF
  let target = rel.target;
  if (imgExt === 'svg') target = target.replace(/\.svg$/i, '.pdf');
  else if (['tiff', 'tif', 'gif', 'bmp'].includes(imgExt)) target = target.replace(/\.\w+$/, '.png');
  else if (['wmf', 'emf'].includes(imgExt)) target = target.replace(/\.\w+$/, '.pdf');

  const cx = findDeep(drawing, '@_cx');
  let widthOpt = 'width=0.8\\textwidth';
  if (cx) {
    const widthIn = (parseInt(cx) / 914400).toFixed(2);
    widthOpt = parseFloat(widthIn) > 6 ? 'width=\\textwidth' : `width=${widthIn}in`;
  }
  return `\\includegraphics[${widthOpt}]{${target}}`;
}

/**
 * @param {any} obj
 * @param {string} key
 * @returns {any}
 */
function findDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[key] != null) return obj[key];
  for (const k of Object.keys(obj)) {
    if (k === key) return obj[k];
    const val = obj[k];
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = findDeep(item, key);
        if (found) return found;
      }
    } else if (typeof val === 'object') {
      const found = findDeep(val, key);
      if (found) return found;
    }
  }
  return null;
}

// ── Table emission (preserveOrder) ───────────────────────────────────────────

/**
 * Extract column widths (in inches) from `w:tblGrid`/`w:gridCol`.
 * @param {any[]} tblChildren - ordered children of a `w:tbl` element.
 * @returns {number[]} array of column widths in inches; empty if none defined.
 */
function parseTableGrid(tblChildren) {
  const colWidths = [];
  const gridChild = findChild(tblChildren, 'w:tblGrid');
  if (gridChild?.['w:tblGrid']) {
    const gridItems = Array.isArray(gridChild['w:tblGrid']) ? gridChild['w:tblGrid'] : [gridChild['w:tblGrid']];
    for (const item of gridItems) {
      if (item['w:gridCol'] != null) {
        const w = attrs(item)['@_w:w'];
        if (w) colWidths.push(parseInt(w) / 1440);
      }
    }
  }
  return colWidths;
}

/**
 * Pre-parse all rows of a table: cell content, gridSpan, vMerge, text rotation,
 * alignment, borders, plus per-row height/header markers.
 * @param {any[]} rowChildren - array of `w:tr` wrapper objects from `findChildren`.
 * @returns {Array<{cells: any[], rowHeight: ({twips:number,rule:string}|null), isHeader: boolean}>}
 *   one entry per row; `cells` is an array of
 *   `{tcContent, gridSpan, vMerge, textRotation, borders, align}`.
 */
function parseTableRows(rowChildren) {
  const parsedRows = [];
  for (let ri = 0; ri < rowChildren.length; ri++) {
    const trChildren = rowChildren[ri]['w:tr'];
    if (!Array.isArray(trChildren)) continue;

    // Parse row properties from w:trPr
    let rowHeight = null;
    let isHeader = false;
    const trPr = findChild(trChildren, 'w:trPr');
    if (trPr?.['w:trPr']) {
      const prArr = Array.isArray(trPr['w:trPr']) ? trPr['w:trPr'] : [trPr['w:trPr']];
      for (const prop of prArr) {
        if (prop['w:trHeight'] != null) {
          const a = attrs(prop);
          const ht = a['@_w:val'];
          const rule = a['@_w:hRule'] || 'atLeast';
          if (ht && parseInt(ht) > 100) { // skip trivial default heights (< 5pt)
            rowHeight = { twips: parseInt(ht), rule };
          }
        }
        // DOCX marks header rows with w:tblHeader
        if (prop['w:tblHeader'] != null) isHeader = true;
      }
    }

    const cellWrappers = findChildren(trChildren, 'w:tc');
    const cells = [];
    for (const cellWrapper of cellWrappers) {
      const tcContent = cellWrapper['w:tc'];
      let gridSpan = 1;
      let vMerge = null; // null = no merge, 'restart' = start of merge, 'continue' = continuation
      let textRotation = 0; // 0 = normal, 90 = CCW, -90 = CW
      if (Array.isArray(tcContent)) {
        const tcPr = findChild(tcContent, 'w:tcPr');
        if (tcPr?.['w:tcPr']) {
          const prArr = Array.isArray(tcPr['w:tcPr']) ? tcPr['w:tcPr'] : [tcPr['w:tcPr']];
          for (const prop of prArr) {
            if (prop['w:gridSpan'] != null) gridSpan = parseInt(attrs(prop)['@_w:val']) || 1;
            if (prop['w:vMerge'] != null) {
              const vmVal = attrs(prop)['@_w:val'];
              vMerge = vmVal === 'restart' ? 'restart' : 'continue';
            }
            // Detect rotated text: btLr = 90° CCW, tbRl = 90° CW
            if (prop['w:textDirection'] != null) {
              const tdVal = attrs(prop)['@_w:val'] || '';
              if (tdVal === 'btLr') textRotation = 90;
              else if (tdVal === 'tbRl' || tdVal === 'tbRlV') textRotation = -90;
            }
          }
        }
      }
      // Detect cell text alignment from first paragraph's w:jc
      let cellAlign = 'l'; // default left
      if (Array.isArray(tcContent)) {
        const firstP = findChild(tcContent, 'w:p');
        if (firstP?.['w:p']) {
          const pPr = findChild(firstP['w:p'], 'w:pPr');
          if (pPr?.['w:pPr']) {
            const pPrArr = Array.isArray(pPr['w:pPr']) ? pPr['w:pPr'] : [pPr['w:pPr']];
            for (const pp of pPrArr) {
              if (pp['w:jc'] != null) {
                const jcVal = attrs(pp)['@_w:val'] || '';
                if (jcVal === 'center') cellAlign = 'c';
                else if (jcVal === 'right' || jcVal === 'end') cellAlign = 'r';
              }
            }
          }
        }
      }
      cells.push({ tcContent, gridSpan, vMerge, textRotation, borders: parseCellBorders(tcContent), align: cellAlign });
    }
    parsedRows.push({ cells, rowHeight, isHeader });
  }
  return parsedRows;
}

/**
 * For each `vMerge: 'restart'` cell, compute how many subsequent rows continue
 * the merge at the same grid column, and stamp `vMergeSpan` onto that cell.
 * @param {any[]} parsedRows - output of `parseTableRows`; mutated in place.
 * @returns {boolean} true if any merge with span > 1 exists (caller should add `multirow` package).
 */
function computeVMergeSpans(parsedRows) {
  let needsMultirow = false;
  for (let ri = 0; ri < parsedRows.length; ri++) {
    let colIdx = 0;
    for (const cell of parsedRows[ri].cells) {
      if (cell.vMerge === 'restart') {
        let span = 1;
        for (let rj = ri + 1; rj < parsedRows.length; rj++) {
          let cIdx = 0;
          let found = false;
          for (const c2 of parsedRows[rj].cells) {
            if (cIdx === colIdx && c2.vMerge === 'continue') {
              span++;
              found = true;
            }
            cIdx += c2.gridSpan;
          }
          if (!found) break;
        }
        cell.vMergeSpan = span;
        if (span > 1) needsMultirow = true;
      }
      colIdx += cell.gridSpan;
    }
  }
  return needsMultirow;
}

/**
 * Build a LaTeX `tabular` column spec string and per-column widths.
 *
 * Picks `p{Wcm}` columns when DOCX provides explicit widths or when cell text
 * is long enough to overflow, otherwise uses majority-vote alignment letters.
 * @param {object} args
 * @param {number[]} args.colWidths - DOCX grid widths in inches (may be empty).
 * @param {any[]} args.parsedRows - rows from `parseTableRows`.
 * @param {number} args.numCols - resolved column count.
 * @param {boolean} args.hasLeft
 * @param {boolean} args.hasRight
 * @param {boolean} args.hasInsideV
 * @param {boolean} args.inLandscape
 * @param {{ left: number, right: number } | null} args.margins - `{left, right}` in inches, or null.
 * @returns {{colSpec: string, colWidthsCm: (number[]|null), colBaseAlign: string[]}}
 */
function buildColumnSpec({ colWidths, parsedRows, numCols, hasLeft, hasRight, hasInsideV, inLandscape, margins }) {
  // Determine base alignment per column: majority alignment from data cells
  const colBaseAlign = Array(numCols).fill('l');
  for (let ci = 0; ci < numCols; ci++) {
    /** @type {Record<string, number>} */
    const counts = { l: 0, c: 0, r: 0 };
    for (const row of parsedRows) {
      let col = 0;
      for (const cell of row.cells) {
        if (col === ci && cell.gridSpan === 1) {
          counts[cell.align || 'l']++;
        }
        col += cell.gridSpan;
      }
    }
    if (counts.c >= counts.l && counts.c >= counts.r) colBaseAlign[ci] = 'c';
    else if (counts.r >= counts.l) colBaseAlign[ci] = 'r';
  }

  let colSpec;
  let colWidthsCm = null;

  if (colWidths.length > 1) {
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    const pageWidthIn = inLandscape ? 11.69 : 8.27; // A4 landscape vs portrait
    const textWidthIn = margins ? (pageWidthIn - margins.left - margins.right) : (inLandscape ? 9.5 : 6.3);
    const nRules = (hasLeft ? 1 : 0) + (hasRight ? 1 : 0) + (hasInsideV ? numCols - 1 : 0);
    const overheadPt = 12 * numCols + 0.4 * nRules;
    const overheadIn = overheadPt / 72;
    const availableIn = textWidthIn - overheadIn;
    const contentW = totalW - overheadIn;
    const scale = contentW > availableIn ? availableIn / contentW : 1;
    colWidthsCm = colWidths.map((w) => {
      const deductIn = (w / totalW) * overheadIn;
      const contentIn = (w - deductIn) * scale;
      return parseFloat((contentIn * 2.54).toFixed(2));
    });
    const cols = colWidthsCm.map(cm => `p{${cm.toFixed(2)}cm}`);
    let specParts = hasLeft ? '|' : '';
    for (let ci = 0; ci < cols.length; ci++) {
      specParts += cols[ci];
      if (ci < cols.length - 1) specParts += (hasInsideV ? '|' : '');
    }
    specParts += hasRight ? '|' : '';
    colSpec = specParts;
  } else {
    // No column widths from DOCX — use alignment letters.
    // For single-column tables or tables with long cell text, use p{} to prevent overflow.
    let useParagraphCols = false;
    if (numCols <= 2) {
      for (const row of parsedRows) {
        for (const cell of row.cells) {
          if (!Array.isArray(cell.tcContent)) continue;
          let textLen = 0;
          for (const el of cell.tcContent) {
            if (el['w:p']) {
              const pArr = Array.isArray(el['w:p']) ? el['w:p'] : [el['w:p']];
              for (const r of pArr) {
                if (r['w:r']) {
                  const rArr = Array.isArray(r['w:r']) ? r['w:r'] : [r['w:r']];
                  for (const t of rArr) {
                    if (t['w:t']) {
                      const tArr = Array.isArray(t['w:t']) ? t['w:t'] : [t['w:t']];
                      for (const tv of tArr) textLen += (typeof tv === 'string' ? tv : (tv['#text'] || '')).length;
                    }
                  }
                }
              }
            }
          }
          if (textLen > 80) { useParagraphCols = true; break; }
        }
        if (useParagraphCols) break;
      }
    }

    if (useParagraphCols) {
      const pgW = inLandscape ? 11.69 : 8.27;
      const textWidthIn = margins ? (pgW - margins.left - margins.right) : (inLandscape ? 9.5 : 6.3);
      const nRules = (hasLeft ? 1 : 0) + (hasRight ? 1 : 0) + (hasInsideV ? numCols - 1 : 0);
      const overheadPt = 12 * numCols + 0.4 * nRules;
      const availCm = (textWidthIn - overheadPt / 72) * 2.54;
      const colCm = (availCm / numCols).toFixed(2);
      let specParts = hasLeft ? '|' : '';
      for (let ci = 0; ci < numCols; ci++) {
        specParts += `p{${colCm}cm}`;
        if (ci < numCols - 1) specParts += (hasInsideV ? '|' : '');
      }
      specParts += hasRight ? '|' : '';
      colSpec = specParts;
    } else {
      let specParts = hasLeft ? '|' : '';
      for (let ci = 0; ci < numCols; ci++) {
        specParts += colBaseAlign[ci];
        if (ci < numCols - 1) specParts += (hasInsideV ? '|' : '');
      }
      specParts += hasRight ? '|' : '';
      colSpec = specParts;
    }
  }
  return { colSpec, colWidthsCm, colBaseAlign };
}

/**
 * Estimate the rendered table height (in points) by summing per-row height
 * estimates derived from text length and per-column wrap width.
 * @param {object} args
 * @param {any[]} args.parsedRows - rows from `parseTableRows`.
 * @param {number} args.dataRowCount - number of rows to count (excludes any caption row).
 * @param {(number[]|null)} args.colWidthsCm - resolved column widths in cm, or null.
 * @param {number[]} args.colWidths - raw DOCX column widths in inches (fallback).
 * @param {number} args.numCols
 * @param {number} args.tableFontPt - body font size for the table, in points.
 * @returns {number} estimated total height in points.
 */
function estimateTableHeight({ parsedRows, dataRowCount, colWidthsCm, colWidths, numCols, tableFontPt }) {
  const baselineSkip = tableFontPt * 1.2 * 1.3; // baselineskip * arraystretch
  const colWidthsPt = colWidthsCm
    ? colWidthsCm.map(cm => cm / 2.54 * 72) // cm to pt
    : colWidths.length > 1
      ? colWidths.map(w => w * 72) // inches to pt (fallback to raw DOCX widths)
      : Array(numCols).fill(200);  // fallback: assume ~200pt (~7cm) per column
  const charsPerLine = colWidthsPt.map(wPt => Math.max(1, Math.floor(wPt / (tableFontPt * 0.5))));

  let totalEstHeight = 0;
  for (let ri = 0; ri < dataRowCount; ri++) {
    const row = parsedRows[ri];
    let maxLines = 1;
    let colOff = 0;
    for (const cell of row.cells) {
      if (cell.vMerge === 'continue') { colOff += cell.gridSpan; continue; }
      let textLen = 0;
      if (Array.isArray(cell.tcContent)) {
        for (const el of cell.tcContent) {
          if (el['w:p']) {
            const pArr = Array.isArray(el['w:p']) ? el['w:p'] : [el['w:p']];
            for (const r of pArr) {
              if (r['w:r']) {
                const rArr = Array.isArray(r['w:r']) ? r['w:r'] : [r['w:r']];
                for (const t of rArr) {
                  if (t['w:t']) {
                    const tArr = Array.isArray(t['w:t']) ? t['w:t'] : [t['w:t']];
                    for (const tv of tArr) textLen += (typeof tv === 'string' ? tv : (tv['#text'] || '')).length;
                  }
                }
              }
            }
          }
        }
      }
      const availChars = charsPerLine[colOff] || 20;
      const estLines = Math.max(1, Math.ceil(textLen / availChars));
      if (estLines > maxLines) maxLines = estLines;
      colOff += cell.gridSpan;
    }
    totalEstHeight += maxLines * baselineSkip + 4; // +4pt for rules/padding
  }
  return totalEstHeight;
}

/**
 * Detect a table-cell line-spacing override (returns the `\setstretch` ratio
 * as a string, or '' to use the document default).
 * Samples the first non-merged cell of the first body row.
 * @param {object} args
 * @param {any[]} args.parsedRows
 * @param {number} args.headerRowCount
 * @param {number} args.tableFontPt
 * @param {any} args.metadata - `ctx.metadata`; uses `lineSpacing` and `styleLineSpacing`.
 * @returns {string} stretch ratio formatted to 1-2 decimals, or '' if none.
 */
function detectTableLineSpacing({ parsedRows, headerRowCount, tableFontPt, metadata }) {
  const docLine = metadata.lineSpacing === '2' ? 2.0 : metadata.lineSpacing === '1.5' ? 1.5 : 1.0;
  const sampleRow = parsedRows[headerRowCount > 0 ? headerRowCount : 0] || parsedRows[0];
  if (!sampleRow) return '';

  for (const cell of sampleRow.cells) {
    if (cell.vMerge === 'continue') continue;
    if (!Array.isArray(cell.tcContent)) continue;
    const pw = findChild(cell.tcContent, 'w:p');
    if (!pw?.['w:p']) continue;
    const pArr = Array.isArray(pw['w:p']) ? pw['w:p'] : [pw['w:p']];

    // Check direct paragraph formatting first (overrides style)
    let spacingLine = 0, spacingRule = 'auto';
    const pPr = findChild(pArr, 'w:pPr');
    if (pPr?.['w:pPr']) {
      const prArr = Array.isArray(pPr['w:pPr']) ? pPr['w:pPr'] : [pPr['w:pPr']];
      for (const prop of prArr) {
        if (prop['w:spacing'] != null) {
          const a = attrs(prop);
          if (a['@_w:line']) spacingLine = parseInt(a['@_w:line']) || 0;
          if (a['@_w:lineRule']) spacingRule = a['@_w:lineRule'];
        }
      }
    }

    // Fall back to style-level spacing
    if (!spacingLine && metadata.styleLineSpacing) {
      const sid = getParagraphStyleId(pArr);
      if (sid && metadata.styleLineSpacing[sid]) {
        spacingLine = metadata.styleLineSpacing[sid].line;
        spacingRule = metadata.styleLineSpacing[sid].rule;
      }
    }

    if (spacingLine > 0) {
      let ratio;
      if (spacingRule === 'auto') {
        ratio = spacingLine / 240;
      } else {
        // exact or atLeast: value is in twips (1/20 pt)
        const exactPt = spacingLine / 20;
        ratio = exactPt / (tableFontPt * 1.2);
      }
      if (Math.abs(ratio - docLine) >= 0.1) {
        return ratio % 1 === 0 ? ratio.toFixed(1) : ratio.toFixed(2);
      }
    }
    return ''; // only sample first non-continue cell
  }
  return '';
}

/**
 * @param {any} tblChildren
 * @param {any} ctx
 * @param {any} externalCaptionPChildren
 * @param {any} captionPosition
 */
function emitTableOrdered(tblChildren, ctx, externalCaptionPChildren = null, captionPosition = 'below') {
  if (!Array.isArray(tblChildren)) return;

  // Detect single-column tables that wrap an image (figure containers)
  const rowChildren0 = findChildren(tblChildren, 'w:tr');
  const gridChild0 = findChild(tblChildren, 'w:tblGrid');
  const gridCols = gridChild0?.['w:tblGrid']
    ? (Array.isArray(gridChild0['w:tblGrid']) ? gridChild0['w:tblGrid'] : [gridChild0['w:tblGrid']])
        .filter(item => item['w:gridCol'] != null).length
    : 0;
  if (gridCols <= 1 && rowChildren0.length <= 3) {
    // Check if any cell contains a drawing (image)
    let hasImage = false, captionText = '';
    for (const rw of rowChildren0) {
      const trC = rw['w:tr'];
      if (!Array.isArray(trC)) continue;
      for (const cw of findChildren(trC, 'w:tc')) {
        const tcC = cw['w:tc'];
        if (!Array.isArray(tcC)) continue;
        for (const pw of findChildren(tcC, 'w:p')) {
          const pC = pw['w:p'];
          if (!Array.isArray(pC)) continue;
          for (const el of pC) {
            if (el['w:r']) {
              const rArr = Array.isArray(el['w:r']) ? el['w:r'] : [el['w:r']];
              for (const rc of rArr) {
                if (rc['w:drawing'] != null) hasImage = true;
              }
            }
          }
        }
      }
    }
    if (hasImage) {
      // Check if table has visible borders
      const figBorders = resolveTableBorders(tblChildren, ctx);
      const hasBorders = !!(figBorders?.top || figBorders?.bottom || figBorders?.left || figBorders?.right);

      // Emit as figure environment instead of tabular
      ctx.buf.write('\n\\begin{figure}[htbp]\n\\centering\n');
      if (hasBorders) ctx.buf.write('\\fbox{\\begin{minipage}{0.95\\textwidth}\\centering\n');
      for (const rw of rowChildren0) {
        const trC = rw['w:tr'];
        if (!Array.isArray(trC)) continue;
        for (const cw of findChildren(trC, 'w:tc')) {
          const tcC = cw['w:tc'];
          if (!Array.isArray(tcC)) continue;
          const pWrappers = findChildren(tcC, 'w:p');
          for (const pw of pWrappers) {
            const cellStart = ctx.buf.pos();
            emitInlineContentOrdered(pw['w:p'] || [], ctx);
            const cellContent = extractSince(ctx.buf, cellStart);
            if (cellContent.includes('\\includegraphics')) {
              ctx.buf.write(cellContent + '\n');
            } else if (cellContent.trim()) {
              // Caption text (e.g. "Figure 1. Research Model")
              captionText = cellContent.trim();
            }
          }
        }
      }
      if (hasBorders) ctx.buf.write('\\end{minipage}}\n');
      if (captionText) {
        ctx.buf.write(buildCaption(stripCaptionPrefix(captionText)) + '\n');
      }
      ctx.buf.write('\\end{figure}\n\n');
      return;
    }

    // Single-column text-box table (no images) — emit as a minipage/framed block
    // so lists, paragraphs, and other block content render properly.
    if (!hasImage && rowChildren0.length === 1) {
      const trC = rowChildren0[0]['w:tr'];
      if (Array.isArray(trC)) {
        const cells = findChildren(trC, 'w:tc');
        if (cells.length === 1) {
          const tcC = cells[0]['w:tc'];
          if (Array.isArray(tcC)) {
            const figBorders = resolveTableBorders(tblChildren, ctx);
            const hasBorders = !!(figBorders?.top || figBorders?.bottom || figBorders?.left || figBorders?.right);
            ctx.buf.write('\n');
            if (hasBorders) { ctx.usedPackages.add('mdframed'); ctx.buf.write('\\begin{mdframed}\n'); }
            else ctx.buf.write('\\begin{quote}\n');
            const pWrappers = findChildren(tcC, 'w:p');
            for (const pw of pWrappers) {
              emitParagraphOrdered(pw['w:p'] || [], null, ctx);
            }
            closeAllLists(ctx);
            if (hasBorders) ctx.buf.write('\\end{mdframed}\n');
            else ctx.buf.write('\\end{quote}\n');
            ctx.buf.write('\n');
            return;
          }
        }
      }
    }
  }

  // Parse table-level borders — check direct borders first, then fall back to style
  const tblBorders = resolveTableBorders(tblChildren, ctx);
  const hasLeft = !!tblBorders?.left;
  const hasRight = !!tblBorders?.right;
  const hasInsideV = !!tblBorders?.insideV;
  const hasInsideH = !!tblBorders?.insideH;
  const hasTop = !!tblBorders?.top;
  const hasBottom = !!tblBorders?.bottom;

  // Extract column widths from w:tblGrid/w:gridCol
  const colWidths = parseTableGrid(tblChildren);

  // Collect rows and pre-parse cell borders for each cell
  const rowChildren = findChildren(tblChildren, 'w:tr');
  if (rowChildren.length === 0) return;

  const numCols = colWidths.length || guessNumColsOrdered(rowChildren);
  if (numCols < 1) return;

  // Pre-parse all rows (cell content, gridSpan, vMerge, rotation, alignment, borders)
  // and resolve vertical-merge spans.
  const parsedRows = parseTableRows(rowChildren);
  if (computeVMergeSpans(parsedRows)) ctx.usedPackages.add('multirow');

  /**
   * Resolve whether a horizontal border exists between rows ri and ri+1
   * at grid column gc. OOXML resolves conflicts: the border exists if
   * EITHER the bottom of the upper cell OR the top of the lower cell
   * specifies a visible border. If both specify, the wider one wins;
   * if equal, the top cell wins. We simplify: visible if either says so,
   * falling back to the table-level insideH (or top/bottom for edges).
   * @param {any} ri
   * @param {any} gc
   */
  function resolveHBorder(ri, gc) {
    // Find which cell covers gc in row ri (bottom side)
    const upperBdr = getCellBorderAtCol(ri, gc, 'bottom');
    // Find which cell covers gc in row ri+1 (top side)
    const lowerBdr = getCellBorderAtCol(ri + 1, gc, 'top');

    // Explicit visible on either side → border
    if (upperBdr || lowerBdr) return true;
    // Explicit none on either side → no border (cell override)
    if (upperBdr === false || lowerBdr === false) return false;
    // Both undefined → use table default
    if (ri === -1) return hasTop; // above first row
    if (ri + 1 >= parsedRows.length) return hasBottom; // below last row
    return hasInsideH;
  }

  /**
   * Get a cell's border for a given grid column. Returns border obj, false, or undefined.
   * @param {any} ri
   * @param {any} gc
   * @param {any} side
   */
  function getCellBorderAtCol(ri, gc, side) {
    if (ri < 0 || ri >= parsedRows.length) return undefined;
    const row = parsedRows[ri];
    let col = 0;
    for (const cell of row.cells) {
      if (gc >= col && gc < col + cell.gridSpan) {
        return cell.borders?.[side]; // border obj | false | undefined
      }
      col += cell.gridSpan;
    }
    return undefined;
  }

  /**
   * Resolve vertical border between column gc-1 and gc in row ri.
   * @param {any} ri
   * @param {any} gc
   */
  function resolveVBorder(ri, gc) {
    if (gc === 0) {
      // Left edge — check cell left override, fallback to table left
      const bdr = getCellBorderAtCol(ri, 0, 'left');
      if (bdr !== undefined) return !!bdr;
      return hasLeft;
    }
    if (gc >= numCols) {
      // Right edge — check cell right override, fallback to table right
      const bdr = getCellBorderAtCol(ri, numCols - 1, 'right');
      if (bdr !== undefined) return !!bdr;
      return hasRight;
    }
    // Inside — check right of left cell and left of right cell
    const rightOfLeft = getCellBorderAtCol(ri, gc - 1, 'right');
    const leftOfRight = getCellBorderAtCol(ri, gc, 'left');
    if (rightOfLeft || leftOfRight) return true;
    if (rightOfLeft === false || leftOfRight === false) return false;
    return hasInsideV;
  }

  // Build LaTeX tabular column spec, per-column widths (cm), and base alignment.
  const { colSpec, colWidthsCm, colBaseAlign } = buildColumnSpec({
    colWidths, parsedRows, numCols,
    hasLeft, hasRight, hasInsideV,
    inLandscape: ctx.inLandscape,
    margins: ctx.metadata.margins,
  });

  // Detect caption from: (1) external Caption paragraph, (2) last row with caption pattern
  let captionText = '';
  let dataRowCount = parsedRows.length;

  // First check external caption paragraph (from lookahead in body emission)
  if (externalCaptionPChildren) {
    const capStart = ctx.buf.pos();
    emitInlineContentOrdered(externalCaptionPChildren, ctx);
    const capContent = extractSince(ctx.buf, capStart);
    captionText = stripCaptionPrefix(capContent.trim());
  }

  // Then check for caption row inside the table
  if (!captionText && parsedRows.length > 1) {
    const lastRow = parsedRows[parsedRows.length - 1];
    if (lastRow.cells.length === 1) {
      const totalSpan = lastRow.cells[0].gridSpan;
      if (totalSpan >= numCols) {
        // Pre-render to check for caption pattern
        const capStart = ctx.buf.pos();
        const tc = lastRow.cells[0].tcContent;
        if (Array.isArray(tc)) {
          for (const pw of findChildren(tc, 'w:p')) {
            emitInlineContentOrdered(pw['w:p'] || [], ctx);
          }
        }
        const capContent = extractSince(ctx.buf, capStart);
        // Strip LaTeX formatting to check for "Table N." or "Table 1-1." pattern
        const plain = capContent.replace(/\\textbf\{([^}]*)\}/g, '$1').replace(/[{}]/g, '');
        if (/^\s*(Table|Figure)\s*[\d][\d\-.]*/i.test(plain)) {
          captionText = stripCaptionPrefix(capContent.trim());
          dataRowCount = parsedRows.length - 1;
        }
      }
    }
  }

  // Determine how many rows are header rows (marked with w:tblHeader, or fallback to row 0)
  let headerRowCount = 0;
  for (let ri = 0; ri < dataRowCount; ri++) {
    if (parsedRows[ri].isHeader) headerRowCount = ri + 1;
    else break;
  }

  // Use longtable for tables that would overflow a page.
  // Estimate table height: each row ~baselineskip * arraystretch, plus wrapping in p{} columns.
  // Detect the predominant font size from cell paragraph styles.
  let tableFontPt = parseFloat(ctx.metadata.mainFontSize || '12');
  if (ctx.metadata.styleFontSizes) {
    // Check first data row for a table-specific paragraph style
    const firstDataRow = parsedRows[headerRowCount > 0 ? headerRowCount : 1] || parsedRows[0];
    if (firstDataRow) {
      for (const cell of firstDataRow.cells) {
        if (Array.isArray(cell.tcContent)) {
          const pw = findChild(cell.tcContent, 'w:p');
          if (pw?.['w:p']) {
            const sid = getParagraphStyleId(pw['w:p']);
            if (sid && ctx.metadata.styleFontSizes[sid]) {
              tableFontPt = ctx.metadata.styleFontSizes[sid] / 2;
              break;
            }
          }
        }
      }
    }
  }
  // Estimate total rendered table height; switch to longtable if it would overflow a page.
  const totalEstHeight = estimateTableHeight({
    parsedRows, dataRowCount, colWidthsCm, colWidths, numCols, tableFontPt,
  });
  // In landscape mode the usable text height is much shorter (A4: ~6.3in vs ~9.5in portrait)
  const textHeight = ctx.inLandscape ? 450 : 600; // pt, conservative estimates
  const useLongtable = totalEstHeight > textHeight;
  if (useLongtable) ctx.usedPackages.add('longtable');

  // Helper: emit a single data row
  const emitRow = (/** @type {number} */ ri) => {
    const row = parsedRows[ri];
    const cellParts = [];
    let colIdx = 0;
    const heightStr = row.rowHeight ? `\\rule{0pt}{${(row.rowHeight.twips / 20).toFixed(1)}pt}` : '';

    for (let ci = 0; ci < row.cells.length; ci++) {
      const cell = row.cells[ci];
      const { tcContent, gridSpan } = cell;
      const cellLeft = resolveVBorder(ri, colIdx);
      const cellRight = resolveVBorder(ri, colIdx + gridSpan);

      if (cell.vMerge === 'continue') {
        cellParts.push('');
        colIdx += gridSpan;
        continue;
      }

      const cellStart = ctx.buf.pos();
      let cellStyleFontSize = 0; // half-points from paragraph style, 0 = inherit
      if (Array.isArray(tcContent)) {
        const pWrappers = findChildren(tcContent, 'w:p');
        for (let pi = 0; pi < pWrappers.length; pi++) {
          if (pi > 0) ctx.buf.write(' ');
          const pChildren = pWrappers[pi]['w:p'] || [];
          // Detect paragraph style font size for table cell sizing
          if (!cellStyleFontSize && ctx.metadata.styleFontSizes) {
            const styleId = getParagraphStyleId(pChildren);
            if (styleId && ctx.metadata.styleFontSizes[styleId]) {
              cellStyleFontSize = ctx.metadata.styleFontSizes[styleId];
            }
          }
          emitInlineContentOrdered(pChildren, ctx);
        }
      }
      let content = extractSince(ctx.buf, cellStart);

      // Apply style-level font size if different from document default
      if (cellStyleFontSize > 0 && content.trim()) {
        const ptSize = cellStyleFontSize / 2;
        const docSize = parseFloat(ctx.metadata.mainFontSize || '12');
        if (Math.abs(ptSize - docSize) >= 1) {
          const lead = Math.round(ptSize * 1.2);
          content = `{\\fontsize{${ptSize}}{${lead}}\\selectfont ${content}}`;
        }
      }

      // Wrap rotated text (btLr = 90° CCW, tbRl = 90° CW)
      if (cell.textRotation && content.trim()) {
        content = `\\rotatebox{${cell.textRotation}}{${content.trim()}}`;
      }

      if (ci === 0 && heightStr) content = heightStr + content;

      if (cell.vMerge === 'restart' && cell.vMergeSpan > 1) {
        // Always use '=' (column width) so text wraps within p{} columns.
        // '*' (natural width) ignores column width and overflows into adjacent cells.
        content = `\\multirow{${cell.vMergeSpan}}{=}{${content}}`;
      }

      const cellAlign = cell.align || 'l';
      if (gridSpan > 1) {
        // When underlying columns use p{}, combine widths for wrapping; add \tabcolsep for spanned separators
        let mcAlign = cellAlign;
        if (colWidthsCm && colWidthsCm.length > 0) {
          let combinedCm = 0;
          for (let g = colIdx; g < colIdx + gridSpan && g < colWidthsCm.length; g++) combinedCm += colWidthsCm[g];
          // Add back the inter-column space from spanned separators: 2×\tabcolsep (12pt) + rule per internal boundary
          const internalSeps = gridSpan - 1;
          const extraCm = internalSeps * (12 / 72) * 2.54 + (hasInsideV ? internalSeps * (0.4 / 72) * 2.54 : 0);
          combinedCm += extraCm;
          mcAlign = `p{${combinedCm.toFixed(2)}cm}`;
        }
        const mcBorders = (cellLeft ? '|' : '') + mcAlign + (cellRight ? '|' : '');
        content = `\\multicolumn{${gridSpan}}{${mcBorders}}{${content}}`;
      } else if (cellAlign !== colBaseAlign[colIdx]) {
        const mcBorders = (cellLeft ? '|' : '') + cellAlign + (cellRight ? '|' : '');
        content = `\\multicolumn{1}{${mcBorders}}{${content}}`;
      }
      cellParts.push(content);
      colIdx += gridSpan;
    }

    if (cellParts.length > 0) {
      ctx.buf.write(cellParts.join(' & ') + ' \\\\\n');

      const isLastDataRow = ri === dataRowCount - 1;
      const hBorders = Array.from({ length: numCols }, (_, gc) => {
        if (isLastDataRow && captionText) {
          const cellBdr = getCellBorderAtCol(ri, gc, 'bottom');
          if (cellBdr !== undefined) return !!cellBdr;
          return hasBottom;
        }
        return resolveHBorder(ri, gc);
      });

      // Suppress horizontal borders on columns occupied by an active multirow span
      // (drawing \hline through a multirow cell looks wrong)
      if (!isLastDataRow) {
        const nextRow = parsedRows[ri + 1];
        if (nextRow) {
          let gc = 0;
          for (const cell of nextRow.cells) {
            if (cell.vMerge === 'continue') {
              for (let g = gc; g < gc + cell.gridSpan && g < numCols; g++) {
                hBorders[g] = false;
              }
            }
            gc += cell.gridSpan;
          }
        }
      }

      if (hBorders.every(b => b)) {
        ctx.buf.write('\\hline\n');
      } else if (hBorders.some(b => b)) {
        emitClines(hBorders, ctx);
      }
    }
  };

  // Helper: emit the top border
  const emitTopBorder = () => {
    const topBorders = Array.from({ length: numCols }, (_, gc) => resolveHBorder(-1, gc));
    if (topBorders.every(b => b)) {
      ctx.buf.write('\\hline\n');
    } else if (topBorders.some(b => b)) {
      emitClines(topBorders, ctx);
    }
  };

  // Detect table-cell line spacing override (OOXML: direct pPr > style > doc default).
  const tableStretch = detectTableLineSpacing({
    parsedRows, headerRowCount, tableFontPt, metadata: ctx.metadata,
  });

  if (useLongtable) {
    // ── longtable: no table float wrapper, caption inside ──
    const stretchPrefix = tableStretch ? `\\setstretch{${tableStretch}}` : '';
    ctx.buf.write(`\n{${stretchPrefix}\\renewcommand{\\arraystretch}{1.3}\n\\begin{longtable}{${colSpec}}\n`);

    // Caption + first head
    if (captionText) {
      ctx.buf.write(buildCaption(captionText) + ' \\\\\n');
    }
    emitTopBorder();

    // Emit header rows for first page
    const hdrEnd = headerRowCount > 0 ? headerRowCount : 1; // at least row 0 as header
    for (let ri = 0; ri < hdrEnd; ri++) emitRow(ri);
    ctx.buf.write('\\endfirsthead\n');

    // Continuation header (repeated on subsequent pages)
    ctx.buf.write(`\\multicolumn{${numCols}}{l}{\\small\\tablename\\ \\thetable\\ -- continued from previous page} \\\\\n`);
    emitTopBorder();
    for (let ri = 0; ri < hdrEnd; ri++) emitRow(ri);
    ctx.buf.write('\\endhead\n');

    // Footer on each page except last
    ctx.buf.write('\\hline\n');
    ctx.buf.write(`\\multicolumn{${numCols}}{r}{\\small Continued on next page} \\\\\n`);
    ctx.buf.write('\\endfoot\n');

    // Last page footer — just the bottom border
    ctx.buf.write('\\hline\n');
    ctx.buf.write('\\endlastfoot\n');

    // Body rows (skip header rows already emitted)
    for (let ri = hdrEnd; ri < dataRowCount; ri++) emitRow(ri);

    ctx.buf.write('\\end{longtable}}\n');
  } else {
    // ── Standard table + tabular ──
    ctx.buf.write('\n\\begin{table}[htbp]\n\\centering\n');

    if (captionText && captionPosition === 'above') {
      ctx.buf.write(buildCaption(captionText) + '\n');
    }

    const stretchPrefix2 = tableStretch ? `\\setstretch{${tableStretch}}` : '';
    ctx.buf.write(`{${stretchPrefix2}\\renewcommand{\\arraystretch}{1.3}\n\\begin{tabular}{${colSpec}}\n`);
    emitTopBorder();

    for (let ri = 0; ri < dataRowCount; ri++) emitRow(ri);

    ctx.buf.write('\\end{tabular}}\n');

    if (captionText && captionPosition !== 'above') {
      ctx.buf.write(buildCaption(captionText) + '\n');
    }
    ctx.buf.write('\\end{table}\n');
  }
  ctx.buf.write('\n');
}

/**
 * Emit \\cline commands for partial horizontal borders.
 * @param {any} borderArray
 * @param {any} ctx
 */
function emitClines(borderArray, ctx) {
  let ci = 0;
  while (ci < borderArray.length) {
    if (borderArray[ci]) {
      const start = ci + 1;
      while (ci < borderArray.length && borderArray[ci]) ci++;
      ctx.buf.write(`\\cline{${start}-${ci}}\n`);
    } else {
      ci++;
    }
  }
}

/**
 * @param {any} rowChildren
 */
function guessNumColsOrdered(rowChildren) {
  let maxCols = 0;
  for (const rowWrapper of rowChildren) {
    const trChildren = rowWrapper['w:tr'];
    if (!Array.isArray(trChildren)) continue;
    let cols = 0;
    for (const cw of findChildren(trChildren, 'w:tc')) {
      let span = 1;
      const tcContent = cw['w:tc'];
      if (Array.isArray(tcContent)) {
        const tcPr = findChild(tcContent, 'w:tcPr');
        if (tcPr?.['w:tcPr']) {
          const prArr = Array.isArray(tcPr['w:tcPr']) ? tcPr['w:tcPr'] : [tcPr['w:tcPr']];
          for (const prop of prArr) {
            if (prop['w:gridSpan'] != null) span = parseInt(attrs(prop)['@_w:val']) || 1;
          }
        }
      }
      cols += span;
    }
    if (cols > maxCols) maxCols = cols;
  }
  return maxCols;
}

// ── List handling ────────────────────────────────────────────────────────────

/**
 * @param {any} ctx
 * @param {any} listType
 * @param {any} depth
 */
function handleListItem(ctx, listType, depth) {
  while (ctx.listStack.length > depth + 1) {
    ctx.buf.write(`\\end{${ctx.listStack.pop()}}\n`);
  }
  if (ctx.listStack.length === depth + 1 && ctx.listStack[depth] !== listType) {
    ctx.buf.write(`\\end{${ctx.listStack.pop()}}\n`);
  }
  while (ctx.listStack.length <= depth) {
    ctx.listStack.push(listType);
    ctx.buf.write(`\\begin{${listType}}\n`);
  }
}

/**
 * @param {any} ctx
 */
function closeAllLists(ctx) {
  while (ctx.listStack.length > 0) {
    ctx.buf.write(`\\end{${ctx.listStack.pop()}}\n`);
  }
}

/**
 * Map TOC/LoF/LoT heading text to a LaTeX command replacement.
 * @param {any} plainText
 */
function getTocReplacementCommand(plainText) {
  if (/table\s*of\s*contents/i.test(plainText)) {
    return '\\begin{spacing}{1}\\tableofcontents\\end{spacing}\n\n';
  }
  if (/list\s*of\s*figures/i.test(plainText)) {
    return '\\begin{spacing}{1}\\listoffigures\\end{spacing}\n\n';
  }
  if (/list\s*of\s*tables/i.test(plainText)) {
    return '\\begin{spacing}{1}\\listoftables\\end{spacing}\n\n';
  }
  // List of Abbreviations — no standard LaTeX command, keep as chapter heading
  return null;
}

// ── Heading ──────────────────────────────────────────────────────────────────

/**
 * @param {any} styleId
 */
function getHeadingLevel(styleId) {
  if (!styleId) return 0;
  // Match Heading1, Heading1NoChapNo, Heading1PreTOC, etc.
  const m = styleId.match(/^[Hh]eading(\d)/);
  return m ? parseInt(m[1]) : 0;
}

/**
 * Style IDs that represent TOC/LoF/LoT entries (should be skipped).
 * @param {any} styleId
 */
function isTocStyle(styleId) {
  return /^(TOC\d|TableofFigures)$/i.test(styleId);
}

/** Style IDs that represent block quotes. Recognises Words built-in
 *  quote styles plus common author conventions (PullQuote, BlockQuote,
 *  Aside, Epigraph, …). Whitespace and hyphens are tolerated, matching
 * @param {any} styleId
 *  is case-insensitive. All map to \begin{quotation} on the LaTeX side. */
function isQuoteStyle(styleId) {
  if (!styleId) return false;
  return /^(?:Block ?-? ?Quote|Intense ?-? ?Quote|Pull ?-? ?Quote|Quote|Quotation|QuoteTempStyle|paperquote|Aside|Epigraph)$/i.test(styleId);
}

/**
 * Style IDs that represent verse / line-broken poetry.
 * @param {any} styleId
 */
function isVerseStyle(styleId) {
  if (!styleId) return false;
  return /^(?:Verse|Poetry|Poem)$/i.test(styleId);
}

/** Style IDs that represent monospace / code blocks. Matches common
 *  author conventions; the inline-font heuristic in resolveCodeBlock
 * @param {any} styleId
 *  catches the rest. */
function isCodeStyle(styleId) {
  if (!styleId) return false;
  return /^(?:Code|CodeBlock|SourceCode|Listing|Preformatted|Verbatim|HTMLPreformatted)$/i.test(styleId);
}

/**
 * @param {any} styleId
 */
function isTitleStyle(styleId) {
  if (!styleId) return false;
  return /^(Title|Subtitle)$/i.test(styleId);
}

// ── Caption style helpers ─────────────────────────────────────────────────────

/**
 * Check if a style ID is a Caption style.
 * @param {any} styleId
 */
function isCaptionStyle(styleId) {
  return /^Caption$/i.test(styleId);
}

/**
 * Extract paragraph style ID from preserveOrder paragraph children.
 * @param {any} pChildren
 */
function getParagraphStyleId(pChildren) {
  if (!Array.isArray(pChildren)) return '';
  const pPrChild = findChild(pChildren, 'w:pPr');
  if (!pPrChild?.['w:pPr']) return '';
  const pPrArr = Array.isArray(pPrChild['w:pPr']) ? pPrChild['w:pPr'] : [pPrChild['w:pPr']];
  for (const item of pPrArr) {
    if (item['w:pStyle'] != null) return item[':@']?.['@_w:val'] || '';
  }
  return '';
}

/**
 * Check if a preserveOrder paragraph contains an image (w:drawing).
 * @param {any} pChildren
 */
function paragraphHasImage(pChildren) {
  if (!Array.isArray(pChildren)) return false;
  for (const child of pChildren) {
    if (child['w:r']) {
      const rArr = Array.isArray(child['w:r']) ? child['w:r'] : [child['w:r']];
      for (const rc of rArr) {
        if (rc['w:drawing'] != null) return true;
      }
    }
  }
  return false;
}

/**
 * Find the next table (w:tbl) index starting from `from`. Skips empty paragraphs.
 * @param {any} children
 * @param {any} from
 */
function findNextTableIndex(children, from) {
  for (let i = from; i < children.length && i < from + 3; i++) {
    if (children[i]['w:tbl']) return i;
    if (!children[i]['w:p']) break; // stop at non-paragraph/non-table
    // Allow skipping empty paragraphs between caption and table
    const hasContent = children[i]['w:p']?.some?.((/** @type {any} */ c) => c['w:r']);
    if (hasContent) break; // non-empty paragraph — no table follows
  }
  return -1;
}

/**
 * Find the next Caption paragraph index starting from `from`. Skips empty paragraphs.
 * @param {any} children
 * @param {any} from
 */
function findNextCaptionIndex(children, from) {
  for (let i = from; i < children.length && i < from + 3; i++) {
    if (!children[i]['w:p']) break; // stop at non-paragraph
    const styleId = getParagraphStyleId(children[i]['w:p']);
    if (isCaptionStyle(styleId)) return i;
    // Allow skipping one empty paragraph between image/table and caption
    const hasContent = children[i]['w:p']?.some?.((/** @type {any} */ c) => c['w:r']);
    if (hasContent && !isCaptionStyle(styleId)) break;
  }
  return -1;
}

/**
 * Strip "Figure 1-1." or "Table 3." prefix from caption text (handles compound numbers).
 * @param {any} text
 */
function stripCaptionPrefix(text) {
  if (!text) return text;
  // Handle \textbf-wrapped fragments: \textbf{Table }\textbf{1}\textbf{-}\textbf{1}\textbf{. }
  let stripped = text
    .replace(/^(?:\\textbf\{)?\s*(?:Table|Figure)\s*(?:\}\\textbf\{)?\s*[\d]+(?:[-.][\d]+)*\s*(?:\}\\textbf\{)?\s*[.:]\s*\}?\s*/i, '')
    .replace(/^(?:Table|Figure)\s*[\d]+(?:[-.][\d]+)*\s*[.:]\s*/i, '')
    .trim();
  // Fix unbalanced braces left over from stripping \textbf{Figure N. ...}
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  while (depth < 0) { stripped = stripped.replace(/\}\s*$/, ''); depth++; }
  return stripped || text;
}

/**
 * Build a \caption command. If the text contains fragile commands (\cite, \ref,
 * etc.) that break when written to .lof/.lot, emit \caption[short]{long} with
 * a sanitized short caption for the list entries.
 * @param {any} text
 */
function buildCaption(text) {
  if (!text) return '';
  // Check if caption contains any commands that are fragile in LoF/LoT moving args
  const hasFragile = /\\(?:cite[pt]?|parencite|textcite|autocite|nocite|ref|eqref|pageref|hyperref|url|href|emph|textbf|textit|textsc|footnote)\{/.test(text);
  if (hasFragile) {
    // Build a plain-text short caption safe for .lof/.lot
    const short = text
      .replace(/\\(?:cite[pt]?|parencite|textcite|autocite|nocite|cite)\{[^}]*\}/g, '')
      .replace(/\\(?:ref|eqref|pageref)\{[^}]*\}/g, '')
      .replace(/\\(?:hyperref|url|href)\{[^}]*\}(?:\{[^}]*\})?/g, '')
      .replace(/\\footnote\{[^}]*\}/g, '')
      .replace(/\\(?:emph|textbf|textit|textsc)\{([^}]*)\}/g, '$1')
      .replace(/[{}]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      // Escape ] in short caption to avoid closing the optional arg
      .replace(/\]/g, '{]}');
    return `\\caption[${short}]{${text}}`;
  }
  return `\\caption{${text}}`;
}

/**
 * Emit a standalone figure (image paragraph + caption paragraph).
 * @param {any} imgPChildren
 * @param {any} captionPChildren
 * @param {any} ctx
 */
function emitStandaloneFigure(imgPChildren, captionPChildren, ctx) {
  ctx.buf.write('\n\\begin{figure}[htbp]\n\\centering\n');
  // Emit image
  const imgStart = ctx.buf.pos();
  emitInlineContentOrdered(imgPChildren, ctx);
  const imgContent = extractSince(ctx.buf, imgStart);
  ctx.buf.write(imgContent + '\n');
  // Emit caption
  if (captionPChildren) {
    const capStart = ctx.buf.pos();
    emitInlineContentOrdered(captionPChildren, ctx);
    const capContent = extractSince(ctx.buf, capStart);
    const stripped = stripCaptionPrefix(capContent.trim());
    if (stripped) ctx.buf.write(buildCaption(stripped) + '\n');
  }
  ctx.buf.write('\\end{figure}\n\n');
}

// ── Text extraction helpers ──────────────────────────────────────────────────

/**
 * Extract text content from a preserveOrder element's children array.
 * @param {any} elemChildren
 */
function getPreserveOrderText(elemChildren) {
  if (!Array.isArray(elemChildren)) {
    if (typeof elemChildren === 'string') return elemChildren;
    return '';
  }
  let text = '';
  for (const c of elemChildren) {
    if (typeof c === 'string') text += c;
    else if (c?.['#text'] != null) text += String(c['#text']);
  }
  return text;
}

// ── EndNote citation parsing ─────────────────────────────────────────────────

/**
 * Parse EndNote citation XML from a field instruction text.
 * Returns array of cite keys. Adds bib entries to ctx.bibEntries.
 * @param {any} instrText
 * @param {any} ctx
 */
function parseEndNoteCitations(instrText, ctx) {
  const xmlMatch = instrText.match(/<EndNote>([\s\S]*)<\/EndNote>/);
  if (!xmlMatch) return [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: false,
    trimValues: false,
    // JJ2 (audit round 21): match the entity-expansion caps used by
    // the other DOCX parsers in this file (createParser /
    // createOrderedParser). A crafted DOCX with billion-laughs-style
    // nested entity declarations in an EndNote citation could
    // otherwise trigger quadratic blowup. Caps generous enough for
    // any legitimate citation; cheap enough that we shouldn't notice.
    processEntities: { maxEntityCount: 100000, maxTotalExpansions: 100000 },
  });
  let parsed;
  try {
    parsed = parser.parse(`<EndNote>${xmlMatch[1]}</EndNote>`);
  } catch { return []; }

  const cites = asArray(parsed?.EndNote?.Cite);
  /** @type {Array<any>} */
  const keys = [];

  for (const cite of cites) {
    const author = typeof cite?.Author === 'string' ? cite.Author : '';
    const year = String(cite?.Year || '');
    const recNum = String(cite?.RecNum || '');

    // Generate a cite key: AuthorYear or refN
    // Use only the first surname from the author field for the key
    const firstSurname = author.split(/[,;&]| and /)[0].trim().split(/\s+/).pop() || '';
    const authorKey = firstSurname.replace(/[^a-zA-Z]/g, '');
    // Treat "in press", "forthcoming", "submitted", "n.d." etc. as non-numeric year
    const yearTrimmed = year.trim();
    const isRealYear = /^\d{4}$/.test(yearTrimmed);
    const yearKey = isRealYear ? yearTrimmed : yearTrimmed.replace(/[^a-zA-Z0-9]/g, '');
    const key = authorKey ? `${authorKey}${yearKey || 'nd'}` : `ref${recNum || keys.length}`;

    if (!ctx.bibEntries.has(key)) {
      const record = cite?.record;
      const entry = {
        key,
        type: 'article',
        author: '',
        title: '',
        year,
        journal: '',
        volume: '',
        pages: '',
        publisher: '',
        booktitle: '',
      };

      if (record) {
        // Determine entry type from ref-type
        const refTypeName = (record['ref-type']?.['@_name'] || '').toLowerCase();
        if (/book\s*section/i.test(refTypeName)) entry.type = 'incollection';
        else if (/book/i.test(refTypeName)) entry.type = 'book';
        else if (/conference|proceedings/i.test(refTypeName)) entry.type = 'inproceedings';
        else if (/thesis/i.test(refTypeName)) entry.type = 'phdthesis';
        else if (/report/i.test(refTypeName)) entry.type = 'techreport';

        // Authors
        const authors = asArray(record?.contributors?.authors?.author);
        entry.author = authors.map(a => typeof a === 'string' ? a : (a?.['#text'] || String(a || ''))).join(' and ');

        // Titles
        const titles = record?.titles;
        entry.title = extractTextField(titles?.title) || '';
        const secTitle = extractTextField(titles?.['secondary-title']) || '';
        if (entry.type === 'article') entry.journal = secTitle || extractTextField(record?.periodical?.['full-title']) || '';
        else entry.booktitle = secTitle;

        // Other fields
        entry.year = extractTextField(record?.dates?.year) || year;
        entry.volume = extractTextField(record?.volume) || '';
        entry.pages = extractTextField(record?.pages) || '';
        entry.publisher = extractTextField(record?.publisher) || '';
      }

      ctx.bibEntries.set(key, entry);
    }

    // Extract per-citation page reference (from <Pages> in the Cite element,
    // NOT from the record's pages field which is the article's page range)
    const citePages = typeof cite?.Pages === 'string' ? cite.Pages.trim()
      : (typeof cite?.Pages === 'number' ? String(cite.Pages) : '');
    keys.push({ key, pages: citePages });
  }

  return keys;
}

/**
 * Build a \cite command from an array of { key, pages } objects.
 * - Single citation without pages: \cite{key}
 * - Single citation with pages: \cite[p.~175]{key}
 * - Multiple citations, none with pages: \cite{key1,key2}
 * - Multiple citations, some with pages: emit separate \cite commands
 * @param {any} citeInfos
 */
function buildCiteCommand(citeInfos) {
  if (citeInfos.length === 0) return '';
  // If no citations have pages, emit a single \cite{key1,key2,...}
  const anyPages = citeInfos.some((/** @type {any} */ c) => c.pages);
  if (!anyPages) {
    return `\\cite{${citeInfos.map((/** @type {any} */ c) => c.key).join(',')}}`;
  }
  // If single citation with pages
  if (citeInfos.length === 1) {
    const c = citeInfos[0];
    if (c.pages) return `\\cite[p.~${c.pages}]{${c.key}}`;
    return `\\cite{${c.key}}`;
  }
  // Multiple citations, some with pages — group consecutive no-page cites together,
  // emit page-specific ones separately
  const parts = [];
  let batch = [];
  for (const c of citeInfos) {
    if (c.pages) {
      if (batch.length) { parts.push(`\\cite{${batch.join(',')}}`); batch = []; }
      parts.push(`\\cite[p.~${c.pages}]{${c.key}}`);
    } else {
      batch.push(c.key);
    }
  }
  if (batch.length) parts.push(`\\cite{${batch.join(',')}}`);
  return parts.join('');
}

/**
 * Extract text from an EndNote XML field that may be a string or an object with #text.
 * @param {any} val
 */
function extractTextField(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (val['#text'] != null) return String(val['#text']);
  return '';
}

/**
 * Generate .bib file content from collected bib entries.
 * @param {any} bibEntries
 */
function generateBibContent(bibEntries) {
  if (!bibEntries || bibEntries.size === 0) return '';
  // Escape special BibTeX characters in field values
  const esc = (/** @type {string | undefined} */ v) => v ? v.replace(/&/g, '\\&') : v;
  /** @type {string[]} */
  const lines = [];
  for (const [key, entry] of bibEntries) {
    lines.push(`@${entry.type}{${key},`);
    if (entry.author) lines.push(`  author = {${esc(entry.author)}},`);
    if (entry.title) lines.push(`  title = {${esc(entry.title)}},`);
    if (entry.year) lines.push(`  year = {${entry.year}},`);
    if (entry.journal && (entry.type === 'article')) lines.push(`  journal = {${esc(entry.journal)}},`);
    if (entry.booktitle && (entry.type === 'inproceedings' || entry.type === 'incollection')) lines.push(`  booktitle = {${esc(entry.booktitle)}},`);
    if (entry.volume) lines.push(`  volume = {${entry.volume}},`);
    if (entry.pages) lines.push(`  pages = {${entry.pages}},`);
    if (entry.publisher) lines.push(`  publisher = {${esc(entry.publisher)}},`);
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

// ── Preamble ─────────────────────────────────────────────────────────────────

// FONT_ALIAS_MAP / aliasFont() were removed when clean-output mode
// stopped emitting \setmainfont — without fontspec in the preamble
// the substitute table has no consumer. If a future mode needs to
// preserve the docxs font, the alias map should be restored at the
// same time as the fontspec line.

/**
 * @param {any} metadata
 * @param {any} usedPackages
 * @param {any} docClass
 */
function buildPreamble(metadata, usedPackages, docClass = 'article') {
  const lines = [];
  let fontOpt = '12pt';
  if (metadata.mainFontSize) {
    const sz = parseFloat(metadata.mainFontSize);
    fontOpt = sz >= 12 ? '12pt' : sz >= 11 ? '11pt' : '10pt';
  }
  const classOpts = docClass === 'book' ? `${fontOpt},openany,oneside` : fontOpt;
  lines.push(`\\documentclass[${classOpts}]{${docClass}}`);

  if (metadata.margins) {
    const m = metadata.margins;
    lines.push(`\\usepackage[top=${m.top}in,bottom=${m.bottom}in,left=${m.left}in,right=${m.right}in]{geometry}`);
  }
  // No \usepackage{fontspec} / \setmainfont: the generated LaTeX is meant
  // to be a clean starting point (Computer Modern, the LaTeX default). If
  // the user wants the original Word font, they can add the two lines
  // themselves. Keeping fontspec out also lets the doc compile under
  // pdflatex, not just xelatex/lualatex.
  lines.push('\\usepackage{setspace}');
  if (metadata.lineSpacing) {
    lines.push(metadata.lineSpacing === '2' ? '\\doublespacing' : '\\onehalfspacing');
  }
  lines.push('\\usepackage{graphicx}');
  lines.push('\\usepackage{caption}');
  lines.push('\\captionsetup{labelfont=bf}');
  if (usedPackages.has('hyperref')) lines.push('\\usepackage{hyperref}');
  if (usedPackages.has('ulem')) lines.push('\\usepackage[normalem]{ulem}');
  if (usedPackages.has('endnotes')) lines.push('\\usepackage{endnotes}');
  if (usedPackages.has('multirow')) lines.push('\\usepackage{multirow}');
  if (usedPackages.has('longtable')) lines.push('\\usepackage{longtable}');
  if (usedPackages.has('pdflscape')) lines.push('\\usepackage{pdflscape}');
  if (usedPackages.has('lettrine')) lines.push('\\usepackage{lettrine}');
  if (usedPackages.has('natbib')) lines.push('\\usepackage[round]{natbib}');
  if (usedPackages.has('mdframed')) lines.push('\\usepackage{mdframed}');

  // Paragraph spacing from docx defaults
  if (metadata.defaultParSpacing) {
    const { before, after } = metadata.defaultParSpacing;
    if (after > 0 || before > 0) {
      lines.push(`\\setlength{\\parskip}{${after || before}pt}`);
      lines.push('\\setlength{\\parindent}{0pt}');
    }
  }

  // No `\titleformat` / `\titlespacing` / per-heading color or font: the
  // headingStyles map (from styles.xml) is still consulted by the body
  // emitter to pick the right LaTeX sectioning *command* for each Word
  // heading level — but the *visual* formatting is whatever LaTeX's
  // built-in section styling produces. Word's heading aesthetics are
  // chosen for screen reading inside Word; LaTeX's defaults look at
  // home in a typeset PDF, and the user almost always wants the LaTeX
  // look on a fresh import.
  //
  // Likewise no custom `\maketitle` override — `\title{...}` + a plain
  // `\maketitle` is enough. The user can drop a titlepage class option
  // or roll their own if they want something fancier.

  // Headers and footers via fancyhdr
  const hf = metadata.headerFooter;
  const hasHF = hf && (
    Object.values(hf.resolvedHeaders || {}).some(v => v?.length > 0) ||
    Object.values(hf.resolvedFooters || {}).some(v => v?.length > 0)
  );
  if (hasHF) {
    lines.push('\\usepackage{fancyhdr}');
    lines.push('\\pagestyle{fancy}');
    lines.push('\\fancyhf{}'); // clear defaults

    // Helper: convert structured paragraphs to fancyhdr commands
    const emitHFCommands = (/** @type {any[]} */ paragraphs, /** @type {string} */ prefix, /** @type {string} */ indent) => {
      if (!paragraphs || paragraphs.length === 0) return;
      for (const para of paragraphs) {
        const segs = para.segments.map((/** @type {string} */ s) => {
          // Escape text but preserve \thepage
          return s.replace(/\\thepage/g, '\x00TP\x00')
            .replace(/[&%$#_{}~^\\]/g, (/** @type {string} */ ch) => LATEX_ESCAPE_MAP[ch] || ch)
            // eslint-disable-next-line no-control-regex
            .replace(/\x00TP\x00/g, '\\thepage');
        });
        if (segs.length >= 3) {
          // Three segments: left, center, right (tab-separated layout)
          const left = segs[0].trim();
          const center = segs[1].trim();
          const right = segs[2].trim();
          if (left) lines.push(`${indent}\\${prefix}[L]{\\small ${left}}`);
          if (center) lines.push(`${indent}\\${prefix}[C]{\\small ${center}}`);
          if (right) lines.push(`${indent}\\${prefix}[R]{\\small ${right}}`);
        } else if (segs.length === 2) {
          const left = segs[0].trim();
          const right = segs[1].trim();
          if (left) lines.push(`${indent}\\${prefix}[L]{\\small ${left}}`);
          if (right) lines.push(`${indent}\\${prefix}[R]{\\small ${right}}`);
        } else {
          const text = segs[0].trim();
          if (text) lines.push(`${indent}\\${prefix}[C]{\\small ${text}}`);
        }
      }
    };

    emitHFCommands(hf.resolvedHeaders?.default, 'fancyhead', '');
    emitHFCommands(hf.resolvedFooters?.default, 'fancyfoot', '');
    lines.push('\\renewcommand{\\headrulewidth}{0pt}');
    lines.push('\\renewcommand{\\footrulewidth}{0pt}');

    // Different first page
    if (hf.differentFirst) {
      lines.push('\\fancypagestyle{plain}{');
      lines.push('  \\fancyhf{}');
      emitHFCommands(hf.resolvedHeaders?.first, 'fancyhead', '  ');
      emitHFCommands(hf.resolvedFooters?.first, 'fancyfoot', '  ');
      lines.push('  \\renewcommand{\\headrulewidth}{0pt}');
      lines.push('  \\renewcommand{\\footrulewidth}{0pt}');
      lines.push('}');
    }
  } else if (docClass === 'book' || docClass === 'report') {
    // No explicit headers/footers — suppress default running headers which
    // overflow the page with long chapter titles.  Use plain (page number only).
    lines.push('\\pagestyle{plain}');
  }

  return lines.join('\n');
}
