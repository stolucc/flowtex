// @ts-check
/**
 * ACM TAPS compliance checker.
 * Checks project files against TAPS requirements.
 * Returns an array of { file, line, severity, message }.
 */
import { resolveUsedFiles } from '@shared/texDeps.js';

const APPROVED_PACKAGES = new Set([
  'abstract',
  'acronym',
  'algorithm',
  'algorithm2e',
  'algorithmic',
  'alltt',
  'amsbsy',
  'amscd',
  'amsfonts',
  'amsgen',
  'amsmath',
  'amsmidx',
  'amsopn',
  'amssymb',
  'amstext',
  'amsthm',
  'amsxtra',
  'apacite',
  'appendix',
  'auxhook',
  'balance',
  'bbding',
  'bbold',
  'bm',
  'bold-braces',
  'braket',
  'breakurl',
  'calc',
  'cancel',
  'ccicons',
  'centernot',
  'cgloss4e',
  'changes',
  'checkend',
  'CJK',
  'clean',
  'cleveref',
  'cmap',
  'color',
  'colortbl',
  'comma',
  'coollist',
  'coolstr',
  'crossreftools',
  'curves',
  'datenumber',
  'dcolumn',
  'decimal',
  'delarray',
  'dirtytalk',
  'draftwatermark',
  'enumitem',
  'epigraph',
  'epstopdf',
  'esdiff',
  'etex',
  'eucal',
  'eufrak',
  'fancybox',
  'fancyhdr',
  'fancyvrb',
  'fix-cm',
  'fixfoot',
  'fixltx2e',
  'fixme',
  'flafter',
  'float',
  'fontawesome',
  'fontawesome5',
  'fontenc',
  'forloop',
  'fp',
  'framed',
  'gb4e',
  'geometry',
  'glossaries',
  'graphics',
  'graphicx',
  'graphpap',
  'harmony',
  'html',
  'hyperref',
  'ifpdf',
  'ifthen',
  'index',
  'inputenc',
  'iopams',
  'keyval',
  'kvoptions',
  'listings',
  'lscape',
  'makecell',
  'makeidx',
  'maple2e',
  'mapleenv',
  'mapleplots',
  'maplestyle',
  'mapletab',
  'mapleutil',
  'mathabx',
  'mathptmx',
  'mathtool',
  'mathtools',
  'mciteplus',
  'microtype',
  'multirow',
  'natbib',
  'newlfont',
  'nicefrac',
  'nomencl',
  'nopageno',
  'oldlfont',
  'overword',
  'physics',
  'pifont',
  'rotating',
  'setspace',
  'shortvrb',
  'showidx',
  'SIunits',
  'siunitx',
  'stfloats',
  'stmaryrd',
  'soul',
  'subcaption',
  'subfig',
  'subfigure',
  'suffix',
  'tabular',
  'textcase',
  'textcomp',
  'textgreek',
  'tfrupee',
  'tipa',
  'tipx',
  'titlepage',
  'tloop',
  'totpages',
  'trimspaces',
  'units',
  'upmath',
  'url',
  'verbatim',
  'wrapfig',
  'xcolor',
  'xfrac',
  'xspace',
]);

// Packages loaded internally by acmart — always allowed
const ACMART_INTERNAL = new Set([
  'xkeyval',
  'xparse',
  'etoolbox',
  'iftex',
  'setspace',
  'caption',
  'float',
  'graphicx',
  'xcolor',
  'hyperref',
  'natbib',
  'booktabs',
  'libertine',
  'newtxmath',
  'inconsolata',
  'fancyhdr',
  'geometry',
  'microtype',
  'nccfoots',
  'totpages',
  'environ',
  'trimspaces',
  'manyfoot',
  'comment',
  'cmap',
  'fontenc',
  'textcomp',
]);

const USEPACKAGE_RE = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;

/** @param {Array<{ path: string, content?: string }>} files */
function checkPackages(files) {
  /** @type {Array<{ file: string, line: number, severity: string, message: string }>} */
  const diagnostics = [];

  for (const file of files) {
    if (!file.path.endsWith('.tex') && !file.path.endsWith('.sty')) continue;
    if (!file.content) continue;

    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip comments
      const commentIdx = line.indexOf('%');
      const activeLine = commentIdx >= 0 ? line.slice(0, commentIdx) : line;

      USEPACKAGE_RE.lastIndex = 0;
      let match;
      while ((match = USEPACKAGE_RE.exec(activeLine)) !== null) {
        // \usepackage can load multiple packages: {pkg1,pkg2,pkg3}
        const pkgList = match[1]
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        for (const pkg of pkgList) {
          if (!APPROVED_PACKAGES.has(pkg) && !ACMART_INTERNAL.has(pkg)) {
            diagnostics.push({
              file: file.path,
              line: i + 1,
              severity: 'error',
              message: `Package "${pkg}" is not on the ACM TAPS approved list`,
            });
          }
        }
      }
    }
  }

  return diagnostics;
}

/**
 * @param {Array<{ path: string, content: string, is_binary: boolean }>} files
 * @param {string} [mainFile]
 */
export default function tapsCheck(files, mainFile = 'main.tex') {
  const usedPaths = resolveUsedFiles(files, mainFile);
  const usedFiles = files.filter((/** @type {{ path: string }} */ f) => usedPaths.has(f.path));
  return [...checkPackages(usedFiles)];
}
