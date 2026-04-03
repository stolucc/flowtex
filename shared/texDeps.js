/**
 * Resolve the dependency graph of a LaTeX project starting from the main file.
 * Returns a Set of file paths (relative) that are actually referenced.
 */

const INPUT_RE = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
const GRAPHICS_RE = /\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const BIB_RE = /\\(?:bibliography|addbibresource)\s*\{([^}]+)\}/g;
const BIBSTYLE_RE = /\\bibliographystyle\s*\{([^}]+)\}/g;
const USEPACKAGE_RE = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const DOCUMENTCLASS_RE = /\\documentclass(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const MAKEINDEX_RE = /\\makeindex/g;
const LOADCLASS_RE = /\\LoadClass(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.gif', '.bmp', '.tiff'];
const TEX_EXTS = ['.tex', ''];

/**
 * @param {Array<{path: string, content: string, is_binary: boolean}>} files
 * @param {string} mainFile - e.g. 'main.tex'
 * @returns {Set<string>} set of used file paths
 */
export function resolveUsedFiles(files, mainFile) {
  const fileMap = new Map();
  for (const f of files) fileMap.set(f.path, f);

  const used = new Set();
  const queue = [mainFile];

  while (queue.length > 0) {
    const current = queue.shift();
    if (used.has(current)) continue;

    const file = fileMap.get(current);
    if (!file) continue;
    used.add(current);

    if (file.is_binary) continue;
    const content = file.content || '';

    // \input, \include, \subfile
    for (const m of content.matchAll(INPUT_RE)) {
      for (const candidate of resolveTexPath(m[1], fileMap)) {
        if (!used.has(candidate)) queue.push(candidate);
      }
    }

    // \includegraphics
    for (const m of content.matchAll(GRAPHICS_RE)) {
      for (const candidate of resolveGraphicsPath(m[1], fileMap)) {
        if (!used.has(candidate)) queue.push(candidate);
      }
    }

    // \bibliography, \addbibresource
    for (const m of content.matchAll(BIB_RE)) {
      // \bibliography can have comma-separated entries
      for (const bibName of m[1].split(',')) {
        const name = bibName.trim();
        for (const candidate of resolveBibPath(name, fileMap)) {
          if (!used.has(candidate)) queue.push(candidate);
        }
      }
    }

    // \bibliographystyle — the .bst file may be local
    for (const m of content.matchAll(BIBSTYLE_RE)) {
      const bst = m[1].endsWith('.bst') ? m[1] : m[1] + '.bst';
      if (fileMap.has(bst)) queue.push(bst);
    }

    // \usepackage / \RequirePackage — check for local .sty files
    for (const m of content.matchAll(USEPACKAGE_RE)) {
      for (const pkg of m[1].split(',')) {
        const name = pkg.trim();
        const sty = name.endsWith('.sty') ? name : name + '.sty';
        if (fileMap.has(sty)) queue.push(sty);
      }
    }

    // \documentclass — check for local .cls files
    for (const m of content.matchAll(DOCUMENTCLASS_RE)) {
      const cls = m[1].endsWith('.cls') ? m[1] : m[1] + '.cls';
      if (fileMap.has(cls)) queue.push(cls);
    }

    // \LoadClass — check for local .cls files
    for (const m of content.matchAll(LOADCLASS_RE)) {
      const cls = m[1].endsWith('.cls') ? m[1] : m[1] + '.cls';
      if (fileMap.has(cls)) queue.push(cls);
    }

    // \makeindex — include .ist files if present
    if (MAKEINDEX_RE.test(content)) {
      for (const [fpath] of fileMap) {
        if (fpath.endsWith('.ist') || fpath.endsWith('.idx')) queue.push(fpath);
      }
    }
  }

  return used;
}

function resolveTexPath(ref, fileMap) {
  const results = [];
  // Try exact match first
  if (fileMap.has(ref)) {
    results.push(ref);
    return results;
  }
  // Try adding .tex extension
  for (const ext of TEX_EXTS) {
    const candidate = ref + ext;
    if (fileMap.has(candidate)) results.push(candidate);
  }
  return results;
}

function resolveGraphicsPath(ref, fileMap) {
  const results = [];
  if (fileMap.has(ref)) {
    results.push(ref);
    return results;
  }
  // Try common image extensions
  for (const ext of IMAGE_EXTS) {
    const candidate = ref + ext;
    if (fileMap.has(candidate)) results.push(candidate);
  }
  return results;
}

function resolveBibPath(ref, fileMap) {
  const results = [];
  if (fileMap.has(ref)) {
    results.push(ref);
    return results;
  }
  const bib = ref.endsWith('.bib') ? ref : ref + '.bib';
  if (fileMap.has(bib)) results.push(bib);
  return results;
}
