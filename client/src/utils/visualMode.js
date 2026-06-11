// @ts-check
/**
 * Visual Mode — WYSIWYG-like decorations for the LaTeX editor.
 *
 * Hides LaTeX markup (\textbf{, \begin{...}, preamble, comments, etc.)
 * and renders content with visual formatting via CM6 Decoration API.
 * The source text is never modified — all changes are decorations only.
 *
 * Toggle on/off via a Compartment in Editor.jsx.
 */

import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, hoverTooltip } from '@codemirror/view';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { parse as parseLatex, N, parseTable, TABLE_ENVS, findMatchingBrace } from './latexParser.js';
import { isSafeWebUrl } from './urlSafety.js';

// ── Formatting command → CSS class map ──────────────────────────────────────

const FORMAT_COMMANDS = {
  textbf: 'cm-vm-bold',
  emph: 'cm-vm-italic',
  textit: 'cm-vm-italic',
  textsc: 'cm-vm-smallcaps',
  underline: 'cm-vm-underline',
  texttt: 'cm-vm-monospace',
  textsl: 'cm-vm-italic',
  textsf: 'cm-vm-sansserif',
  textrm: 'cm-vm-serif',
  MakeUppercase: 'cm-vm-uppercase',
  MakeLowercase: 'cm-vm-lowercase',
  textsuperscript: 'cm-vm-superscript',
  textsubscript: 'cm-vm-subscript',
};

const SECTION_COMMANDS = {
  part: 'cm-vm-part',
  'part*': 'cm-vm-part',
  chapter: 'cm-vm-chapter',
  'chapter*': 'cm-vm-chapter',
  section: 'cm-vm-section',
  'section*': 'cm-vm-section',
  subsection: 'cm-vm-subsection',
  'subsection*': 'cm-vm-subsection',
  subsubsection: 'cm-vm-subsubsection',
  'subsubsection*': 'cm-vm-subsubsection',
  paragraph: 'cm-vm-paragraph',
  'paragraph*': 'cm-vm-paragraph',
};

// Commands whose ALL args are non-text parameters — hide entirely.
// Commands with a text-bearing last arg are NOT listed here; the universal
// fallback at the end of decorateCommand shows their content automatically.
const NON_TEXT_COMMANDS = new Set([
  'label', 'index', 'pagestyle', 'thispagestyle', 'pagenumbering',
  'setlength', 'addtolength', 'setcounter', 'addtocounter',
  'newcommand', 'renewcommand', 'providecommand',
  'newcommand*', 'renewcommand*', 'providecommand*',
  'newenvironment', 'renewenvironment',
  'newlength', 'newcounter', 'newtheorem', 'newtheorem*',
  'hypersetup', 'graphicspath', 'captionsetup',
  'titleformat', 'titlespacing', 'titlespacing*',
  'geometry', 'usepackage', 'RequirePackage',
  'bibliographystyle', 'addbibresource',
  // Spacing with args (values, not text)
  'hspace', 'hspace*', 'vspace', 'vspace*', 'vskip',
  'fontsize', 'fontspec', 'setstretch', 'setmainfont', 'setsansfont', 'setmonofont',
  'rule', 'phantom', 'hphantom', 'vphantom', 'sethlcolor',
  // Hidden metadata (not user-editable)
  'authornote', 'authornotemark', 'additionalaffiliation',
  'titlenote', 'subtitlenote', 'orcid',
  // ACM / conference metadata
  'acmDOI', 'acmYear', 'acmConference', 'acmISBN', 'acmPrice',
  'acmJournal', 'acmVolume', 'acmNumber', 'acmArticle', 'acmMonth',
  'terms', 'copyrightyear', 'received',
  'ccsdesc', 'CopyrightYear', 'setcopyright',
]);

// Bare commands (no brace args) that represent displayable text.
// These are replaced with their Unicode/text equivalents instead of being hidden.
const TEXT_COMMANDS = {
  // TeX logos
  LaTeX: 'LaTeX', TeX: 'TeX', BibTeX: 'BibTeX', XeTeX: 'XeTeX',
  LuaTeX: 'LuaTeX', pdfTeX: 'pdfTeX', LuaLaTeX: 'LuaLaTeX', XeLaTeX: 'XeLaTeX',
  // Ellipses & dots
  dots: '\u2026', ldots: '\u2026', cdots: '\u22EF', vdots: '\u22EE', ddots: '\u22F1',
  // Text-mode symbols
  textbackslash: '\\', textasciitilde: '~', textasciicircum: '^',
  textbar: '|', textless: '<', textgreater: '>',
  textendash: '\u2013', textemdash: '\u2014',
  // Common symbols
  copyright: '\u00A9', dag: '\u2020', ddag: '\u2021', S: '\u00A7', P: '\u00B6',
  pounds: '\u00A3', euro: '\u20AC', yen: '\u00A5', cent: '\u00A2',
  registered: '\u00AE', trademark: '\u2122', checkmark: '\u2713',
  times: '\u00D7', div: '\u00F7', pm: '\u00B1', mp: '\u2213',
  infty: '\u221E', degree: '\u00B0',
  // Spacing (render as appropriate whitespace instead of hiding)
  quad: '\u2003', qquad: '\u2003\u2003',
  enspace: '\u2002', thinspace: '\u2009',
  space: ' ', nbsp: '\u00A0',
  // Spacing — visual gaps
  smallskip: '', medskip: '', bigskip: '',
  // Greek (text-mode)
  alpha: '\u03B1', beta: '\u03B2', gamma: '\u03B3', delta: '\u03B4',
  epsilon: '\u03B5', zeta: '\u03B6', eta: '\u03B7', theta: '\u03B8',
  lambda: '\u03BB', mu: '\u03BC', pi: '\u03C0', sigma: '\u03C3',
  omega: '\u03C9', Omega: '\u03A9', Delta: '\u0394', Sigma: '\u03A3',
  // Dashes & breaks (show nothing — line break is implicit)
  par: '\n', linebreak: '', nopagebreak: '',
  newline: '', noindent: '',
};

// ── Escaped special characters → Unicode ─────────────────────────────────────
const ESCAPED_CHARS = {
  '&': '&', '%': '%', '$': '$', '#': '#', '_': '_',
  '{': '{', '}': '}',
};

// ── Accent commands → precomposed Unicode ────────────────────────────────────
// Single-char accent modifiers: \'e → é, \"u → ü, etc.
const ACCENT_MAP = {
  "'": { a:'á',e:'é',i:'í',o:'ó',u:'ú',y:'ý',A:'Á',E:'É',I:'Í',O:'Ó',U:'Ú',Y:'Ý',c:'ć',C:'Ć',n:'ń',N:'Ń',s:'ś',S:'Ś',z:'ź',Z:'Ź',l:'ĺ',L:'Ĺ',r:'ŕ',R:'Ŕ' },
  '`': { a:'à',e:'è',i:'ì',o:'ò',u:'ù',A:'À',E:'È',I:'Ì',O:'Ò',U:'Ù' },
  '"': { a:'ä',e:'ë',i:'ï',o:'ö',u:'ü',y:'ÿ',A:'Ä',E:'Ë',I:'Ï',O:'Ö',U:'Ü',Y:'Ÿ' },
  '^': { a:'â',e:'ê',i:'î',o:'ô',u:'û',A:'Â',E:'Ê',I:'Î',O:'Ô',U:'Û' },
  '~': { a:'ã',n:'ñ',o:'õ',A:'Ã',N:'Ñ',O:'Õ' },
  '=': { a:'ā',e:'ē',i:'ī',o:'ō',u:'ū',A:'Ā',E:'Ē',I:'Ī',O:'Ō',U:'Ū' },
  '.': { a:'ȧ',e:'ė',z:'ż',Z:'Ż',I:'İ' },
};

// Multi-char accent commands: \v{c} → č, \c{c} → ç, etc.
const ACCENT_CMD_MAP = {
  v: { c:'č',C:'Č',s:'š',S:'Š',z:'ž',Z:'Ž',r:'ř',R:'Ř',e:'ě',d:'ď',t:'ť',n:'ň',N:'Ň',a:'ǎ' },
  u: { a:'ă',g:'ğ',G:'Ğ',u:'ŭ' },
  c: { c:'ç',C:'Ç',s:'ş',S:'Ş',t:'ţ',T:'Ţ' },
  H: { o:'ő',O:'Ő',u:'ű',U:'Ű' },
  r: { a:'å',A:'Å',u:'ů' },
  k: { a:'ą',e:'ę',A:'Ą',E:'Ę' },
};

// ── Font size/switch commands → CSS class ────────────────────────────────────
// These are scope-affecting: {\large text} makes "text" large.
const FONT_SIZE_COMMANDS = {
  tiny: 'cm-vm-tiny', scriptsize: 'cm-vm-scriptsize',
  footnotesize: 'cm-vm-footnotesize', small: 'cm-vm-small',
  normalsize: '', large: 'cm-vm-large', Large: 'cm-vm-Large',
  LARGE: 'cm-vm-LARGE', huge: 'cm-vm-huge', Huge: 'cm-vm-Huge',
};

const FONT_SWITCH_COMMANDS = {
  bfseries: 'cm-vm-bold', mdseries: '', itshape: 'cm-vm-italic',
  slshape: 'cm-vm-italic', scshape: 'cm-vm-smallcaps', upshape: '',
  rmfamily: 'cm-vm-serif', sffamily: 'cm-vm-sansserif', ttfamily: 'cm-vm-monospace',
};

// Commands that render as page/section breaks (horizontal rule widget)
const BREAK_COMMANDS = new Set(['newpage', 'clearpage', 'cleardoublepage', 'pagebreak']);

// Editable metadata commands — hide markup (\cmd{ and }), show styled content
const EDITABLE_META = {
  title: 'cm-vm-edit-title',
  subtitle: 'cm-vm-edit-subtitle',
  author: 'cm-vm-edit-author',
  date: 'cm-vm-edit-date',
  email: 'cm-vm-edit-email',
  institution: 'cm-vm-edit-institution',
  department: 'cm-vm-edit-institution',
  city: 'cm-vm-edit-affil-detail',
  country: 'cm-vm-edit-affil-detail',
  state: 'cm-vm-edit-affil-detail',
  streetaddress: 'cm-vm-edit-affil-detail',
  postcode: 'cm-vm-edit-affil-detail',
};


// Cite-family commands. Used both as a subset of BADGE_COMMANDS and as the
// `isCite` test inside RefBadgeWidget so authors can render them as natural
// "Author (Year)" instead of `[key]`.
const CITE_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'autocite', 'parencite', 'textcite',
  'citeauthor', 'citeyear',
]);

// Commands that display as inline badges
const BADGE_COMMANDS = new Set([
  'ref', 'eqref', 'pageref',
  ...CITE_COMMANDS,
]);

// Environments to hide entirely (begin, content, and end)
const HIDDEN_ENVS = new Set([
  'CCSXML', 'IEEEkeywords',
]);

const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);
const QUOTE_ENVS = new Set(['quote', 'quotation', 'displayquote', 'blockquote']);

// Standard LaTeX/xcolor named colors → CSS
const LATEX_COLORS = {
  red: '#e53935', blue: '#1e88e5', green: '#43a047', yellow: '#fdd835',
  orange: '#fb8c00', purple: '#8e24aa', cyan: '#00acc1', magenta: '#d81b60',
  brown: '#6d4c41', lime: '#c0ca33', olive: '#827717', pink: '#ec407a',
  teal: '#00897b', violet: '#7b1fa2', gray: '#757575', grey: '#757575',
  darkgray: '#616161', lightgray: '#bdbdbd', black: '#000000', white: '#ffffff',
  // dvipsnames
  BrickRed: '#c62828', Maroon: '#800000', Red: '#f44336', OrangeRed: '#e64a19',
  RawSienna: '#a1887f', BurntOrange: '#e65100', Apricot: '#ffab91',
  Melon: '#ef9a9a', YellowOrange: '#ff9800', Orange: '#ff9800', Dandelion: '#fdd835',
  Goldenrod: '#fbc02d', Gold: '#ffd600', GreenYellow: '#cddc39', Yellow: '#ffeb3b',
  SpringGreen: '#00e676', LimeGreen: '#76ff03', YellowGreen: '#9e9d24',
  ForestGreen: '#2e7d32', OliveGreen: '#558b2f', SeaGreen: '#2e7d32',
  Emerald: '#00c853', JungleGreen: '#00695c', Aquamarine: '#64ffda',
  Cyan: '#00bcd4', Turquoise: '#26c6da', TealBlue: '#00838f',
  SkyBlue: '#4fc3f7', NavyBlue: '#1565c0', MidnightBlue: '#1a237e',
  CadetBlue: '#546e7a', CornflowerBlue: '#42a5f5', Blue: '#2196f3',
  RoyalBlue: '#283593', BlueViolet: '#651fff', Periwinkle: '#7986cb',
  Plum: '#ce93d8', Orchid: '#ba68c8', DarkOrchid: '#7b1fa2',
  Purple: '#9c27b0', Violet: '#7c4dff', RoyalPurple: '#6a1b9a',
  Fuchsia: '#d500f9', Magenta: '#e91e63', VioletRed: '#c2185b',
  Rhodamine: '#e91e63', Mulberry: '#880e4f', RedViolet: '#ad1457',
  RubineRed: '#d50000', WildStrawberry: '#ff1744',
  Salmon: '#ff8a65', Lavender: '#b39ddb', Thistle: '#ce93d8',
  ProcessBlue: '#039be5', Tan: '#d7ccc8',
  Gray: '#9e9e9e', Black: '#000000', White: '#ffffff',
};

// Case-insensitive color lookup (builds lowercase index once)
const _colorLower = {};
for (const [k, v] of Object.entries(LATEX_COLORS)) _colorLower[k.toLowerCase()] = v;
/**
 * @param {any} name
 */
function resolveColor(name) {
  return LATEX_COLORS[name] || _colorLower[name.toLowerCase()] || name;
}

// Commands whose content arg may contain nested markup that needs re-parsing
const REPARSE_COMMANDS = new Set([
  ...Object.keys(FORMAT_COMMANDS),
  ...Object.keys(SECTION_COMMANDS),
  'textcolor', 'colorbox', 'hl',
  'href', 'url',
  'caption', 'caption*',
  'affiliation', // re-parse so nested \institution, \city, \country get decorated
  // Box-style containers: their argument is rendered prose. Without re-parsing,
  // a nested \includegraphics or \cite inside e.g. \fbox{\begin{minipage}{...}…
  // \includegraphics{x.pdf}…} would be invisible to the AST walker.
  'fbox', 'framebox', 'mbox', 'parbox', 'makebox', 'raisebox', 'savebox', 'sbox',
]);

const BUFFER = 12000;

// ── Project files for image resolution (set by visualModeExtension) ─────────
let _projectFiles = [];

// ── Bibliography data for citation display (set by visualModeExtension) ─────
let _bibMap = {}; // cite key → { author, year, title }

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico']);

/**
 * Resolve an \includegraphics path to a file ID from the project file list.
 * @param {any} texPath
 */
function resolveImageFile(texPath) {
  if (!_projectFiles || _projectFiles.length === 0) return null;
  // Normalize: strip leading ./ or /
  let needle = texPath.replace(/^\.\//, '').replace(/^\//, '');
  // Try exact match first
  let found = _projectFiles.find(f => f.path === needle || f.path === '/' + needle);
  if (found) return found;
  // Try with common extensions appended
  for (const ext of ['png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg', 'gif', 'bmp', 'webp']) {
    found = _projectFiles.find(f => f.path === needle + '.' + ext || f.path === '/' + needle + '.' + ext);
    if (found) return found;
  }
  // Try basename match (file might be in a subfolder referenced without path)
  const base = needle.split('/').pop();
  found = _projectFiles.find(f => {
    const fBase = f.path.split('/').pop();
    return fBase === base || fBase === base + '.png' || fBase === base + '.jpg' || fBase === base + '.jpeg' || fBase === base + '.pdf';
  });
  return found || null;
}

const PDF_EXTS = new Set(['pdf']);

/**
 * Check if a file path has a renderable extension (image or PDF)
 * @param {any} path
 */
function isRenderableFile(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  return IMAGE_EXTS.has(ext) || PDF_EXTS.has(ext);
}

// ── Widget Types ────────────────────────────────────────────────────────────

class RefBadgeWidget extends WidgetType {
  constructor(label, cmdName) {
    super();
    this.label = label;
    this.cmdName = cmdName;
    this.isCite = CITE_COMMANDS.has(cmdName);
  }
  eq(other) { return other.label === this.label && other.cmdName === this.cmdName; }
  toDOM(view) {
    const span = document.createElement('span');
    if (this.isCite) {
      // Render citations naturally: "Author (Year)" or "[key]"
      const keys = this.label.split(',').map(k => k.trim());
      const parts = keys.map(key => {
        const bib = _bibMap[key];
        if (!bib) return key;
        if (this.cmdName === 'citeauthor') return bib.author || key;
        if (this.cmdName === 'citeyear') return bib.year || key;
        if (this.cmdName === 'citet' || this.cmdName === 'textcite') {
          return bib.author + (bib.year ? ` (${bib.year})` : '');
        }
        // parenthetical style: citep, cite, autocite, parencite
        return (bib.author || key) + (bib.year ? ', ' + bib.year : '');
      });
      const isParenthetical = this.cmdName !== 'citet' && this.cmdName !== 'textcite'
        && this.cmdName !== 'citeauthor' && this.cmdName !== 'citeyear';
      span.className = 'cm-vm-cite';
      span.textContent = isParenthetical ? `(${parts.join('; ')})` : parts.join('; ');
      span.title = keys.map(k => {
        const b = _bibMap[k];
        return b?.title ? `${k}: ${b.title}` : k;
      }).join('\n');
      attachCiteHoverPopup(span, this.label, this.cmdName, view);
    } else {
      // \ref, \eqref, \pageref — keep as badge
      span.className = 'cm-vm-ref-badge';
      span.textContent = this.label;
      span.title = `\\${this.cmdName}{${this.label}}`;
      // Hover popup with the labelled element's kind + caption / title.
      // Lives on document.body so it isn't clipped by the editor scroll area.
      attachRefHoverPopup(span, this.label, this.cmdName, view);
    }
    return span;
  }
  ignoreEvent() { return false; }
}

/**
 * Wire a hover popup onto a `\ref`-style badge. On mouseenter, look up
 * the label in the current document and pop up a styled card; on
 * mouseleave (or scroll), remove it.
 */
/**
 * Generic widget-DOM hover popup. `buildContent` is called when the popup is
 * about to be shown and should return a DocumentFragment / element to mount.
 * The popup lives on document.body so it isn't clipped by editor scrollbars.
 * @param {any} el
 * @param {any} buildContent
 */
function attachHoverPopup(el, buildContent) {
  let popup = null;
  let timer = 0;
  const hide = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (popup) { popup.remove(); popup = null; }
  };
  const show = () => {
    if (popup) return;
    const content = buildContent();
    if (!content) return;
    popup = document.createElement('div');
    popup.className = 'cm-vm-ref-tooltip';
    popup.appendChild(content);
    document.body.appendChild(popup);
    const r = el.getBoundingClientRect();
    const pr = popup.getBoundingClientRect();
    const top = r.top - pr.height - 6;
    const left = Math.min(window.innerWidth - pr.width - 8, Math.max(8, r.left));
    popup.style.position = 'fixed';
    popup.style.top = (top < 8 ? r.bottom + 6 : top) + 'px';
    popup.style.left = left + 'px';
    popup.style.zIndex = '1000';
    el.dataset.vmTitle = el.title;
    el.title = '';
  };
  el.addEventListener('mouseenter', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(show, 250);
  });
  el.addEventListener('mouseleave', () => {
    if (el.dataset.vmTitle != null) { el.title = el.dataset.vmTitle; delete el.dataset.vmTitle; }
    hide();
  });
}

/**
 * @param {any} el
 * @param {any} rawLabel
 * @param {any} cmdName
 * @param {any} view
 */
function attachRefHoverPopup(el, rawLabel, cmdName, view) {
  attachHoverPopup(el, () => {
    if (!view) return null;
    const text = view.state.doc.toString();
    const keys = rawLabel.split(',').map((k) => k.trim()).filter(Boolean);
    const frag = document.createDocumentFragment();
    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'cm-vm-ref-tooltip-row';
      const head = document.createElement('div');
      head.className = 'cm-vm-ref-tooltip-head';
      const cmd = document.createElement('span');
      cmd.className = 'cm-vm-ref-tooltip-cmd';
      cmd.textContent = '\\' + cmdName;
      const k = document.createElement('span');
      k.className = 'cm-vm-ref-tooltip-key';
      k.textContent = key;
      head.appendChild(cmd);
      head.appendChild(k);
      row.appendChild(head);
      const desc = describeLabel(text, key);
      const body = document.createElement('div');
      body.className = 'cm-vm-ref-tooltip-body';
      if (!desc) {
        body.classList.add('cm-vm-ref-tooltip-missing');
        body.textContent = 'Label not found in document';
      } else {
        const kindEl = document.createElement('span');
        kindEl.className = 'cm-vm-ref-tooltip-kind';
        kindEl.textContent = desc.kind;
        body.appendChild(kindEl);
        if (desc.title) {
          const titleEl = document.createElement('span');
          titleEl.className = 'cm-vm-ref-tooltip-title';
          titleEl.textContent = desc.title.length > 200 ? desc.title.slice(0, 200) + '…' : desc.title;
          body.appendChild(document.createTextNode(' · '));
          body.appendChild(titleEl);
        }
      }
      row.appendChild(body);
      frag.appendChild(row);
    }
    return frag;
  });
}

/**
 * @param {any} el
 * @param {any} rawLabel
 * @param {any} cmdName
 */
function attachCiteHoverPopup(el, rawLabel, cmdName) {
  attachHoverPopup(el, () => {
    const keys = rawLabel.split(',').map((k) => k.trim()).filter(Boolean);
    const frag = document.createDocumentFragment();
    for (const key of keys) frag.appendChild(buildCiteTooltipRow(cmdName, key));
    return frag;
  });
}

/** Renders an inline image or PDF preview from the project files */
class ImageWidget extends WidgetType {
  constructor(fileId, filePath) {
    super();
    this.fileId = fileId;
    this.filePath = filePath;
  }
  eq(other) { return other.fileId === this.fileId; }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-vm-image-wrap';
    const rawUrl = `/api/projects/files/${this.fileId}/raw`;
    const ext = (this.filePath || '').split('.').pop().toLowerCase();
    const fileName = this.filePath.split('/').pop();

    const showBadgeFallback = () => {
      wrap.textContent = '';
      const badge = document.createElement('span');
      badge.className = 'cm-vm-ref-badge';
      badge.textContent = fileName;
      badge.title = `\\includegraphics{${this.filePath}}`;
      wrap.appendChild(badge);
    };

    if (ext === 'pdf') {
      // Render PDF first page via canvas using pdf.js (already bundled)
      const canvas = document.createElement('canvas');
      canvas.className = 'cm-vm-image';
      canvas.title = this.filePath;
      wrap.appendChild(canvas);
      // Async render — pdf.js is loaded dynamically
      import('pdfjs-dist').then(async (pdfjsLib) => {
        try {
          const resp = await fetch(rawUrl, { credentials: 'include' });
          if (!resp.ok) { showBadgeFallback(); return; }
          const buf = await resp.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
          const page = await pdf.getPage(1);
          const vp = page.getViewport({ scale: 1 });
          const maxW = 600;
          const scale = Math.min(maxW / vp.width, 2);
          const viewport = page.getViewport({ scale });
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = viewport.width + 'px';
          canvas.style.height = viewport.height + 'px';
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          await page.render({ canvas, viewport }).promise;
        } catch { showBadgeFallback(); }
      }).catch(() => showBadgeFallback());
    } else {
      const img = document.createElement('img');
      img.className = 'cm-vm-image';
      img.src = rawUrl;
      img.alt = fileName;
      img.title = this.filePath;
      img.loading = 'lazy';
      img.onerror = showBadgeFallback;
      wrap.appendChild(img);
    }
    return wrap;
  }
  ignoreEvent() { return false; }
}

/** Map section CSS class → matching font size from baseTheme */
const SEC_FONT_SIZES = {
  'cm-vm-part': '20pt',
  'cm-vm-chapter': '18pt',
  'cm-vm-section': '16pt',
  'cm-vm-subsection': '14pt',
  'cm-vm-subsubsection': '13pt',
  'cm-vm-paragraph': '12pt',
};

class SectionNumberWidget extends WidgetType {
  constructor(label, secClass) {
    super();
    this.label = label;
    this.secClass = secClass;
  }
  eq(other) { return other.label === this.label && other.secClass === this.secClass; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-vm-section-number';
    span.style.fontWeight = 'bold';
    span.style.fontSize = SEC_FONT_SIZES[this.secClass] || 'inherit';
    span.textContent = this.label + '\u2002'; // en-space after number
    return span;
  }
  ignoreEvent() { return false; }
}

/** Replaces a bare LaTeX command with its text equivalent (e.g. \LaTeX → "LaTeX") */
class TextWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement('span');
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return false; }
}

class ListMarkerWidget extends WidgetType {
  constructor(marker, depth = 0) {
    super();
    this.marker = marker;
    this.depth = depth;
  }
  eq(other) { return other.marker === this.marker && other.depth === this.depth; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-vm-list-marker';
    span.textContent = this.marker;
    if (this.depth > 0) {
      span.style.marginLeft = `${this.depth * 1.5}em`;
    }
    return span;
  }
  ignoreEvent() { return false; }
}

/**
 * Convert integer to Roman numeral
 * @param {any} n
 */
function toRoman(n) {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

// ── Section numbering ───────────────────────────────────────────────────────

/** Hierarchy: part > chapter > section > subsection > subsubsection */
const SECTION_LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };

/**
 * Scan the full document text for section commands and build a Map<position, label>.
 * Starred variants (e.g. \section*) are not numbered.
 * @param {any} doc
 * @param {any} preambleEnd
 * @param {any} endDocFrom
 */
function buildSectionNumbers(doc, preambleEnd, endDocFrom) {
  const text = doc.sliceString(preambleEnd, endDocFrom ?? doc.length);
  const re = /\\(part|chapter|section|subsection|subsubsection)(\*?)\{/g;
  const counters = [0, 0, 0, 0, 0]; // part, chapter, section, subsection, subsubsection
  const labels = new Map(); // absolute position → label string

  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const starred = m[2] === '*';
    const absPos = preambleEnd + m.index;

    if (starred) continue; // starred sections aren't numbered

    const level = SECTION_LEVELS[name];
    counters[level]++;
    // Reset all deeper counters
    for (let i = level + 1; i < counters.length; i++) counters[i] = 0;

    // Build label: skip levels with 0 count (e.g. no part/chapter in articles)
    const parts = [];
    for (let i = 0; i <= level; i++) {
      if (counters[i] > 0) parts.push(counters[i]);
    }
    labels.set(absPos, parts.join('.'));
  }

  return labels;
}

// ── Find editable metadata command spans in a text range ─────────────────────

// Pre-compile regexes once at module load — `findEditableSpansInRange` is hot
// (called per visual-mode redecorate) and rebuilding RegExps per call is wasteful.
const EDITABLE_META_REGEXES = Object.keys(EDITABLE_META).map((cmd) => ({
  cmd,
  re: new RegExp('\\\\' + cmd + '\\s*(?:\\[[^\\]]*\\]\\s*)?\\{', 'g'),
}));

/**
 * @param {any} text
 * @param {any} baseOffset
 */
function findEditableSpansInRange(text, baseOffset) {
  const spans = [];
  for (const { cmd, re } of EDITABLE_META_REGEXES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const braceIdx = m.index + m[0].length - 1;
      const content = extractBraceContent(text, braceIdx);
      if (content === null) continue;
      const contentFrom = braceIdx + 1;
      const contentTo = contentFrom + content.length;
      const cmdEnd = contentTo + 1; // after }
      spans.push({
        from: baseOffset + m.index,
        contentFrom: baseOffset + contentFrom,
        contentTo: baseOffset + contentTo,
        cmdEnd: baseOffset + cmdEnd,
        style: EDITABLE_META[cmd],
        cmd,
      });
    }
  }
  spans.sort((a, b) => a.from - b.from);
  // Remove spans that are fully contained inside other spans (nested commands)
  const filtered = [];
  for (const span of spans) {
    const parent = filtered.find(p => span.from >= p.from && span.cmdEnd <= p.cmdEnd);
    if (!parent) filtered.push(span);
  }
  return filtered;
}

// ── Preamble metadata extraction ────────────────────────────────────────────

/**
 * @param {any} text
 * @param {any} startIdx
 */
function extractBraceContent(text, startIdx) {
  // Extract content of {...} starting at the { at startIdx, handling nested braces
  if (text[startIdx] !== '{') return null;
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(startIdx + 1, i); }
  }
  return null;
}

// ── Preamble detection ──────────────────────────────────────────────────────

/**
 * @param {any} doc
 */
function findBeginDocument(doc) {
  const scanLen = Math.min(doc.length, 30000);
  const text = doc.sliceString(0, scanLen);
  const m = text.match(/\\begin\{document\}/);
  if (!m) return null;
  return { from: 0, to: m.index + m[0].length };
}

/**
 * @param {any} doc
 */
function findEndDocument(doc) {
  const tailLen = Math.min(doc.length, 2000);
  const startPos = doc.length - tailLen;
  const text = doc.sliceString(startPos, doc.length);
  const m = text.match(/\\end\{document\}/);
  if (!m) return null;
  return { from: startPos + m.index, to: startPos + m.index + m[0].length };
}

// ── StateEffect to trigger decoration rebuild on viewport change ────────────

const viewportChanged = StateEffect.define();

// ── "Expanded" tables: the user clicked one to drop into source-edit mode ──
// `from` is the document position of the table env's `\begin{...}`. At most one
// table is expanded at a time; expanding a different one replaces the value.
const setExpandedTable = StateEffect.define();
const expandedTableField = StateField.define({
  create() { return -1; },
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setExpandedTable)) next = e.value;
    }
    if (next !== -1 && tr.docChanged) {
      // Map the position through any document changes so it stays on the table.
      next = tr.changes.mapPos(next);
    }
    return next;
  },
});

// ── Decoration builder (used by StateField) ────────────────────────────────

// Threaded through buildDecorations into the table branch of decorateEnvironment
// (passed via module-level state because the call chain is deep — keeps the
// signature changes localised).
let _expandedTableFrom = -1;

/**
 * @param {any} state
 * @param {any} visibleRanges
 */
function buildDecorations(state, visibleRanges) {
  const doc = state.doc;
  const decos = [];
  _expandedTableFrom = state.field(expandedTableField, false) ?? -1;

  // 1. Hide preamble with gaps for editable metadata (\title, \author, \date)
  const beginDoc = findBeginDocument(doc);
  let preambleEnd = 0;
  if (beginDoc) {
    const line = doc.lineAt(beginDoc.to);
    preambleEnd = line.to;
  }
  if (preambleEnd > 0) {
    const preambleText = doc.sliceString(0, preambleEnd);
    const editableSpans = findEditableSpansInRange(preambleText, 0);

    if (editableSpans.length === 0) {
      decos.push(Decoration.replace({ block: true }).range(0, preambleEnd));
    } else {
      let hideFrom = 0;
      for (const span of editableSpans) {
        // Hide gap before this editable command
        if (hideFrom < span.from) {
          decos.push(Decoration.replace({ block: true }).range(hideFrom, span.from));
        }
        // Hide \cmd{ markup
        if (span.from < span.contentFrom) {
          decos.push(Decoration.replace({}).range(span.from, span.contentFrom));
        }
        // Style content
        if (span.contentFrom < span.contentTo) {
          decos.push(Decoration.mark({ class: span.style }).range(span.contentFrom, span.contentTo));
        }
        // Hide }
        if (span.contentTo < span.cmdEnd) {
          decos.push(Decoration.replace({}).range(span.contentTo, span.cmdEnd));
        }
        hideFrom = span.cmdEnd;
      }
      // Hide from last span to preambleEnd
      if (hideFrom < preambleEnd) {
        decos.push(Decoration.replace({ block: true }).range(hideFrom, preambleEnd));
      }
    }
  }

  // Extract metadata for non-rendering purposes (no longer used for widget)
  const preambleMeta = null;

  // 3. Find \end{document} (added to final decoration set AFTER overlap filter)
  const endDoc = findEndDocument(doc);
  let endDocDeco = null;
  if (endDoc) {
    const line = doc.lineAt(endDoc.from);
    if (line.from < doc.length) {
      endDocDeco = Decoration.replace({ block: true }).range(line.from, doc.length);
    }
  }

  // 3b. Build section numbering from full document (cached — only rebuilds on doc change)
  const sectionNumbers = getCachedSectionNumbers(doc, preambleEnd, endDoc?.from);

  // 3. Process visible ranges
  for (const { from: vFrom, to: vTo } of visibleRanges) {
    // Expand to line boundaries with buffer
    const expandedFrom = Math.max(preambleEnd, doc.lineAt(Math.max(0, vFrom - BUFFER)).from);
    const expandedTo = Math.min(
      endDoc ? endDoc.from : doc.length,
      doc.lineAt(Math.min(doc.length, vTo + BUFFER)).to
    );
    if (expandedFrom >= expandedTo) continue;

    const slice = doc.sliceString(expandedFrom, expandedTo);
    let tree;
    try {
      tree = parseLatex(slice);
    } catch {
      continue;
    }

    walkAndDecorate(tree, expandedFrom, decos, doc, sectionNumbers, preambleMeta);
  }

  // 4. Strip leading whitespace from content lines so source indentation
  //    doesn't appear as paragraph indentation in visual mode. Blank lines
  //    are left at full height — line numbers are visible in visual mode,
  //    so every source line should map 1:1 to a visible row.
  for (const { from: vFrom, to: vTo } of visibleRanges) {
    const expandedFrom = Math.max(preambleEnd, doc.lineAt(Math.max(0, vFrom - BUFFER)).from);
    const expandedTo = Math.min(
      endDoc ? endDoc.from : doc.length,
      doc.lineAt(Math.min(doc.length, vTo + BUFFER)).to
    );
    for (let pos = expandedFrom; pos <= expandedTo;) {
      const line = doc.lineAt(pos);
      const lineText = doc.sliceString(line.from, line.to);
      if (line.from >= preambleEnd && !/^\s*$/.test(lineText)) {
        const wsMatch = lineText.match(/^[ \t]+/);
        if (wsMatch) {
          const wsEnd = line.from + wsMatch[0].length;
          decos.push(Decoration.replace({}).range(line.from, wsEnd));
        }
      }
      pos = line.to + 1;
      if (pos <= line.from) break;
    }
  }

  // Overlap resolution for replace decorations.
  // Strategy: collect all replace ranges, merge overlapping ones into a single
  // replace per contiguous region, then interleave marks/lines back in.
  // This avoids the watermark problem where a small replace blocks a later larger one.
  const marks = [];     // mark + line decorations (always kept)
  const replaces = [];  // replace decorations (need dedup)
  for (const d of decos) {
    const spec = d.value?.spec;
    const isMark = spec && (spec.class != null || spec.attributes != null) && spec.widget == null && !spec.block;
    const isLine = d.from === d.to && spec && !spec.widget;
    if (isMark || isLine) {
      marks.push(d);
    } else {
      replaces.push(d);
    }
  }

  // Sort replaces: by from ascending, then by to descending (prefer larger ranges)
  replaces.sort((a, b) => a.from - b.from || b.to - a.to);

  // Keep non-overlapping replaces. When two overlap, prefer the one that was
  // added first (which is the one at the earlier sort position = larger range).
  const keptReplaces = [];
  let lastTo = -1;
  for (const d of replaces) {
    if (d.from >= lastTo) {
      keptReplaces.push(d);
      lastTo = d.to;
    }
    // else: overlaps with a previously kept replace — skip
  }

  // Combine marks + kept replaces, re-sort for Decoration.set
  const cleaned = [...marks, ...keptReplaces];
  cleaned.sort((a, b) => a.from - b.from || a.to - b.to);

  // 6. Final safety net (runs AFTER overlap filter): scan for ANY remaining
  // LaTeX markup that isn't covered by the cleaned decoration set.
  // Build merged intervals from cleaned replaces.
  const coveredIntervals = [];
  for (const d of cleaned) {
    const spec = d.value?.spec;
    const isMark = spec && (spec.class != null || spec.attributes != null) && spec.widget == null && !spec.block;
    if (!isMark && d.from < d.to) {
      coveredIntervals.push([d.from, d.to]);
    }
  }
  coveredIntervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of coveredIntervals) {
    if (merged.length > 0 && iv[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }
  /**
   * @param {any} from
   * @param {any} to
   */
  function isCovered(from, to) {
    let lo = 0, hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid][1] <= from) lo = mid + 1;
      else if (merged[mid][0] > from) hi = mid - 1;
      else return merged[mid][1] >= to;
    }
    return false;
  }

  // Collect safety-net decorations in a separate array.
  //
  // Strategy: NEVER match command + brace content as one unit. Instead:
  //  1. Find bare \begin{...} and \end{...} tags — hide entirely
  //  2. Find \commandname (just the name, no args) — hide the command name
  //  3. Find orphan braces { and } that are LaTeX markup — hide them
  //
  // This ensures we NEVER accidentally hide text content inside braces.
  const safetyDecos = [];
  for (const { from: vFrom, to: vTo } of visibleRanges) {
    const scanFrom = Math.max(preambleEnd, doc.lineAt(Math.max(0, vFrom - BUFFER)).from);
    const scanTo = Math.min(
      endDoc ? endDoc.from : doc.length,
      doc.lineAt(Math.min(doc.length, vTo + BUFFER)).to
    );
    if (scanFrom >= scanTo) continue;
    const text = doc.sliceString(scanFrom, scanTo);

    // Pass 1: \begin{...} and \end{...} — these are always entirely markup
    const envRe = /\\(?:begin|end)\{[^}]*\}/g;
    let m;
    while ((m = envRe.exec(text)) !== null) {
      const mFrom = scanFrom + m.index;
      const mTo = scanFrom + m.index + m[0].length;
      if (mTo <= mFrom || mTo > doc.length) continue;
      if (!isCovered(mFrom, mTo)) {
        safetyDecos.push(Decoration.replace({}).range(mFrom, mTo));
      }
    }

    // Pass 2: \commandname*? — just the command token (NO brace args consumed).
    // Also consume any immediately following optional args [...].
    // Then if followed by {, hide only the { (not its content).
    const cmdRe = /\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])*/g;
    while ((m = cmdRe.exec(text)) !== null) {
      const mFrom = scanFrom + m.index;
      let mTo = scanFrom + m.index + m[0].length;
      if (mTo <= mFrom || mTo > doc.length) continue;

      // Check if the command name part is already covered
      if (isCovered(mFrom, mTo)) continue;

      // Extract command name
      const cmdName = m[0].match(/^\\([a-zA-Z@]+)/)?.[1] || '';

      // Apply formatting mark if this is a formatting command and followed by {content}
      const fmtClass = FORMAT_COMMANDS[cmdName];

      // Look ahead for opening brace immediately after the command
      const afterCmd = mTo - scanFrom;
      let braceCount = 0;
      let pos = afterCmd;
      // Skip whitespace between command and {
      while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n')) pos++;

      if (pos < text.length && text[pos] === '{') {
        // Hide from \command through the opening {
        const openBracePos = scanFrom + pos;
        const hideEnd = openBracePos + 1;
        if (!isCovered(mFrom, hideEnd) && hideEnd <= doc.length) {
          safetyDecos.push(Decoration.replace({}).range(mFrom, hideEnd));
        }
        // Find the matching closing brace (respecting nesting)
        braceCount = 1;
        let j = pos + 1;
        const contentStart = scanFrom + j;
        while (j < text.length && braceCount > 0) {
          if (text[j] === '{') braceCount++;
          else if (text[j] === '}') braceCount--;
          j++;
        }
        if (braceCount === 0) {
          // j is now one past the closing }
          const closeBrace = scanFrom + j - 1;
          if (!isCovered(closeBrace, closeBrace + 1) && closeBrace + 1 <= doc.length) {
            safetyDecos.push(Decoration.replace({}).range(closeBrace, closeBrace + 1));
          }
          // Apply formatting mark to content between braces
          const contentEnd = closeBrace;
          if (fmtClass && contentStart < contentEnd) {
            safetyDecos.push(Decoration.mark({ class: fmtClass }).range(contentStart, contentEnd));
          }
          // Advance regex past the closing brace so we don't re-match inside
          cmdRe.lastIndex = j;
        }
      } else {
        // Bare command with no brace arg — just hide the command name
        safetyDecos.push(Decoration.replace({}).range(mFrom, mTo));
      }
    }

    // Pass 3: Escaped special characters (\&, \%, \$, \#, \_, \{, \})
    const escRe = /\\([&%$#_{}])/g;
    while ((m = escRe.exec(text)) !== null) {
      const mFrom = scanFrom + m.index;
      const mTo = scanFrom + m.index + m[0].length;
      if (mTo <= mFrom || mTo > doc.length) continue;
      if (!isCovered(mFrom, mTo)) {
        const ch = ESCAPED_CHARS[m[1]];
        if (ch) {
          safetyDecos.push(Decoration.replace({ widget: new TextWidget(ch) }).range(mFrom, mTo));
        }
      }
    }

    // Pass 4: Accent commands — \'e, \"{u}, \^o, \`a, \~n, \=a, \.z
    const accentRe = /\\(['"`^~=.])(?:\{([a-zA-Z])\}|([a-zA-Z]))/g;
    while ((m = accentRe.exec(text)) !== null) {
      const mFrom = scanFrom + m.index;
      const mTo = scanFrom + m.index + m[0].length;
      if (mTo <= mFrom || mTo > doc.length) continue;
      if (!isCovered(mFrom, mTo)) {
        const accent = m[1];
        const letter = m[2] || m[3];
        const map = ACCENT_MAP[accent];
        if (map && map[letter]) {
          safetyDecos.push(Decoration.replace({ widget: new TextWidget(map[letter]) }).range(mFrom, mTo));
        }
      }
    }
  }

  // Add \end{document} hide and safety-net decorations
  if (endDocDeco) safetyDecos.push(endDocDeco);

  if (safetyDecos.length > 0) {
    // For each safety deco, check if it's already fully inside an existing replace.
    // If not, we need to add it. If it partially overlaps, we need to handle that.
    // Strategy: remove any existing replaces that are fully CONTAINED within a
    // safety deco, then add the safety deco.
    const safetyReplaces = safetyDecos.filter(d => d.from < d.to);
    for (const sd of safetyReplaces) {
      // Remove cleaned replaces that are inside this safety deco's range
      for (let i = cleaned.length - 1; i >= 0; i--) {
        const d = cleaned[i];
        if (d.from >= sd.from && d.to <= sd.to && d.from < d.to) {
          // Check it's a replace, not a mark
          const spec = d.value?.spec;
          const isMark = spec && (spec.class != null || spec.attributes != null) && spec.widget == null && !spec.block;
          const isLine = d.from === d.to;
          if (!isMark && !isLine) {
            cleaned.splice(i, 1);
          }
        }
      }
    }
    cleaned.push(...safetyDecos);
  }

  // Final sort and dedup — greedy interval merge for replaces.
  // When a replace extends further than any overlapping predecessor, it wins
  // and the predecessors it subsumes are removed.
  cleaned.sort((a, b) => a.from - b.from || b.to - a.to);
  const finalMarks = [];   // marks + lines (always kept)
  const finalReplaces = []; // replaces (need dedup)
  for (const d of cleaned) {
    const spec = d.value?.spec;
    const isMark = spec && (spec.class != null || spec.attributes != null) && spec.widget == null && !spec.block;
    const isLine = d.from === d.to && spec && !spec.widget;
    if (isMark || isLine) {
      finalMarks.push(d);
    } else {
      finalReplaces.push(d);
    }
  }
  // Greedy: for each replace, if it overlaps with the last kept one but extends
  // further, replace the last kept one (and any others it subsumes).
  const keptR = [];
  for (const d of finalReplaces) {
    if (keptR.length === 0 || d.from >= keptR[keptR.length - 1].to) {
      // No overlap — just add
      keptR.push(d);
    } else if (d.to > keptR[keptR.length - 1].to) {
      // Overlaps but extends further — this one is more important.
      // Pop any replaces it fully subsumes, then add it.
      while (keptR.length > 0 && keptR[keptR.length - 1].to <= d.to && keptR[keptR.length - 1].from >= d.from) {
        keptR.pop();
      }
      // If still overlapping with the remaining last, we can't have both.
      // Keep the earlier one (it started first) and drop this one IF the earlier
      // one doesn't end before this one starts. But since d.from < last.to,
      // they overlap. CM6 can't handle partial overlap, so keep whichever covers more.
      if (keptR.length > 0 && d.from < keptR[keptR.length - 1].to) {
        const last = keptR[keptR.length - 1];
        if ((d.to - d.from) > (last.to - last.from)) {
          keptR.pop();
          keptR.push(d);
        }
        // else: last covers more or equal — keep last, drop d
      } else {
        keptR.push(d);
      }
    }
    // else: fully contained in the last replace — skip
  }
  const final = [...finalMarks, ...keptR];
  final.sort((a, b) => a.from - b.from || a.to - b.to);

  try {
    return Decoration.set(final, true);
  } catch (e) {
    console.error('[VisualMode] Decoration.set failed:', e.message);
    return Decoration.none;
  }
}

/**
 * @param {any} tree
 * @param {any} offset
 * @param {any} decos
 * @param {any} doc
 * @param {any} sectionNumbers
 * @param {any} preambleMeta
 * @param {any} listDepth
 */
function walkAndDecorate(tree, offset, decos, doc, sectionNumbers, preambleMeta, listDepth = 0) {
  /**
   * @param {any} node
   * @param {any} depth
   */
  function visit(node, depth) {
    const from = node.from + offset;
    const to = node.to + offset;

    // Bounds check
    if (from < 0 || to > doc.length || from >= to) return;

    // ── Comments: hide entire line content from % to EOL ──
    if (node.type === N.COMMENT) {
      const end = Math.min(to, doc.length);
      if (from < end) {
        decos.push(Decoration.replace({}).range(from, end));
      }
      return; // skip children
    }

    // ── Text nodes: replace LaTeX quotes with Unicode curly quotes ──
    if (node.type === N.TEXT) {
      const text = doc.sliceString(from, to);
      // Replace `` → " and '' → " and ` → ' (only backticks, not apostrophes)
      const quoteRe = /``|`/g;
      let qm;
      while ((qm = quoteRe.exec(text)) !== null) {
        const qFrom = from + qm.index;
        const qTo = qFrom + qm[0].length;
        const replacement = qm[0] === '``' ? '\u201C' : '\u2018';
        decos.push(Decoration.replace({ widget: new TextWidget(replacement) }).range(qFrom, qTo));
      }
      return; // TEXT nodes have no children
    }

    // ── Brace groups: hide { and } ──
    // Standalone scoping groups like {\bfseries text} or {\fontsize{10}{12}\selectfont text}
    // appear as GROUP children. Hide the braces so only the content shows.
    // Special case: if the group contains ONLY non-text commands (layout/spacing directives),
    // hide the entire group as one atomic replace instead of piecemeal.
    if (node.type === N.GROUP) {
      if (to - from >= 2) {
        // Check if ALL children are non-text commands (layout/spacing only, no prose)
        const children = node.children || [];
        const allNonText = children.length > 0 && children.every(c => {
          if (c.type === N.COMMAND) {
            return NON_TEXT_COMMANDS.has(c.name) || TEXT_COMMANDS[c.name] === '' || TEXT_COMMANDS[c.name] === '\n';
          }
          // Whitespace-only text nodes are fine
          if (c.type === N.TEXT) {
            const t = doc.sliceString(c.from + offset, c.to + offset);
            return /^\s*$/.test(t);
          }
          return false;
        });
        if (allNonText) {
          // Hide entire group as one decoration — covers {\setlength{...}\setstretch{...}} etc.
          decos.push(Decoration.replace({}).range(from, to));
          return; // skip children
        }
        decos.push(Decoration.replace({}).range(from, from + 1)); // hide {
        decos.push(Decoration.replace({}).range(to - 1, to));     // hide }
      }
      // Continue into children below
    }

    // ── Math: style but don't hide (no KaTeX yet) ──
    if (node.type === N.MATH_INLINE) {
      decos.push(Decoration.mark({ class: 'cm-vm-math-inline' }).range(from, to));
      return;
    }
    if (node.type === N.MATH_DISPLAY) {
      decos.push(Decoration.mark({ class: 'cm-vm-math-display' }).range(from, to));
      return;
    }

    // ── Commands ──
    if (node.type === N.COMMAND) {
      const result = decorateCommand(node, from, to, offset, decos, doc, sectionNumbers, preambleMeta, depth);
      if (result === false) return; // skip children
      // Args are raw tokens, not parsed AST nodes — re-parse the content
      // GROUP arg so nested commands (e.g. \textbf{\textcolor{red}{x}}) get decorated.
      // Only do this for commands whose visible arg may contain further markup.
      if (REPARSE_COMMANDS.has(node.name)) {
        // Find the "content" arg (last GROUP arg — skips color-name args etc.)
        const groups = (node.args || []).filter(a => a.type === N.GROUP);
        const contentArg = groups.length > 0 ? groups[groups.length - 1] : null;
        if (contentArg && contentArg.text && contentArg.text.includes('\\')) {
          const argContentFrom = contentArg.from + 1;
          try {
            const subTree = parseLatex(contentArg.text);
            walkAndDecorate(subTree, offset + argContentFrom, decos, doc, sectionNumbers, preambleMeta, depth);
          } catch { /* ignore parse errors in fragments */ }
        }
      }
      // Also continue into node.children below
    }

    // ── Environments ──
    else if (node.type === N.ENVIRONMENT) {
      const isListEnv = LIST_ENVS.has(node.name);
      const childDepth = isListEnv ? depth + 1 : depth;
      const result = decorateEnvironment(node, from, to, offset, decos, doc, depth);
      if (result === false) return;
      // Continue into children with updated depth
      if (node.children) {
        for (const child of node.children) {
          visit(child, childDepth);
        }
      }
      return; // already visited children
    }

    // ── Verbatim: style as code block ──
    else if (node.type === N.VERBATIM) {
      decos.push(Decoration.mark({ class: 'cm-vm-verbatim' }).range(from, to));
      return;
    }

    // Continue into children
    if (node.children) {
      for (const child of node.children) {
        visit(child, depth);
      }
    }
  }

  visit(tree, listDepth);
}

// Sentinel returned by per-command helpers to mean "didn't apply, continue dispatch".
// Distinct from `undefined` (which means "handled, recurse into children") and
// `false` (which means "handled, skip children").
const DISPATCH_FALLTHROUGH = Symbol('vm.command.fallthrough');

/**
 * Decorate \affiliation{...} — hide wrapper markup, re-parse content for nested cmds.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 */
function decorateAffiliation(node, from, to, offset, decos /* doc */) {
  const arg = node.args.find(a => a.type === N.GROUP);
  if (arg && !arg.unclosed) {
    const contentFrom = arg.from + offset + 1;
    const contentTo = arg.to + offset - 1;
    // Hide \affiliation{
    if (from < contentFrom) {
      decos.push(Decoration.replace({}).range(from, contentFrom));
    }
    // Hide }
    if (contentTo < to) {
      decos.push(Decoration.replace({}).range(contentTo, to));
    }
    // Content is re-parsed via REPARSE_COMMANDS so nested \institution etc. get decorated
    return undefined;
  }
  return DISPATCH_FALLTHROUGH;
}

/**
 * Decorate \item — both inside a parsed list (already marked) and standalone (preamble-out-of-slice case).
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 * @param {any} doc
 * @param {any} _sectionNumbers
 * @param {any} _preambleMeta
 * @param {any} listDepth
 */
function decorateItem(node, from, to, offset, decos, doc, _sectionNumbers, _preambleMeta, listDepth) {
  // Inside a parsed list — marker already placed by decorateEnvironment.
  if (listDepth > 0) {
    return undefined;
  }
  // Standalone: scan backwards to find the enclosing list type and count siblings.
  const beforeText = doc.sliceString(Math.max(0, from - 3000), from);
  let listType = 'itemize'; // default to bullet
  let itemIndex = 1;
  const envMatch = beforeText.match(/\\begin\{(itemize|enumerate|description)\}[^]*$/);
  if (envMatch) {
    listType = envMatch[1];
    const afterBegin = envMatch[0];
    const itemMatches = afterBegin.match(/\\item\b/g);
    itemIndex = itemMatches ? itemMatches.length : 1;
  }
  let marker;
  if (listType === 'enumerate') {
    marker = `${itemIndex}.`;
  } else if (listType === 'description') {
    marker = '▸';
  } else {
    marker = ITEMIZE_BULLETS[0];
  }
  if (from < to && to <= doc.length) {
    decos.push(
      Decoration.replace({
        widget: new ListMarkerWidget(marker, 0),
      }).range(from, to)
    );
  }
  return undefined; // continue into children
}

/**
 * Decorate \footnote{text} → superscript numbered marker with tooltip.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 * @param {any} doc
 */
function decorateFootnote(node, from, to, offset, decos, doc) {
  if (node.args.length === 0) return DISPATCH_FALLTHROUGH;
  const arg = node.args.find(a => a.type === N.GROUP);
  if (!arg) return DISPATCH_FALLTHROUGH;
  // Count footnotes before this one to assign a number
  const docText = doc.sliceString(0, from);
  const fnMatches = docText.match(/\\footnote\s*\{/g);
  const fnNum = (fnMatches ? fnMatches.length : 0) + 1;
  // Extract footnote text for tooltip
  const fnText = doc.sliceString(arg.from + offset + 1, arg.to + offset - 1)
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1') // strip simple commands
    .replace(/\\[a-zA-Z]+/g, '')               // strip bare commands
    .replace(/[{}]/g, '').trim();
  decos.push(
    Decoration.replace({
      widget: new FootnoteWidget(String(fnNum), fnText),
    }).range(from, to)
  );
  return false;
}

/**
 * Decorate \keywords{...} → "Keywords: " label + editable content.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 */
function decorateKeywords(node, from, to, offset, decos /* doc */) {
  const arg = node.args.find(a => a.type === N.GROUP);
  if (!arg || arg.unclosed) return DISPATCH_FALLTHROUGH;
  const contentFrom = arg.from + offset + 1;
  const contentTo = arg.to + offset - 1;
  // Replace \keywords{ with a label widget
  decos.push(Decoration.replace({
    widget: new KeywordsLabelWidget(),
  }).range(from, contentFrom));
  // Style the content
  if (contentFrom < contentTo) {
    decos.push(Decoration.mark({ class: 'cm-vm-keywords-content' }).range(contentFrom, contentTo));
  }
  // Hide closing brace
  if (contentTo < to) {
    decos.push(Decoration.replace({}).range(contentTo, to));
  }
  return false;
}

/**
 * Decorate \lettrine{X}{rest} → show both args as plain text.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 */
function decorateLettrine(node, from, to, offset, decos /* doc */) {
  const groups = (node.args || []).filter(a => a.type === N.GROUP);
  if (groups.length < 2) return DISPATCH_FALLTHROUGH;
  // Hide \lettrine{ up to first arg content
  const firstContentFrom = groups[0].from + offset + 1;
  const firstContentTo = groups[0].to + offset - 1;
  const secondContentFrom = groups[1].from + offset + 1;
  const secondContentTo = groups[1].to + offset - 1;
  decos.push(Decoration.replace({}).range(from, firstContentFrom));
  // Hide }{ between args
  decos.push(Decoration.replace({}).range(firstContentTo, secondContentFrom));
  // Hide trailing }
  if (secondContentTo < to) {
    decos.push(Decoration.replace({}).range(secondContentTo, to));
  }
  return false;
}

/**
 * Decorate \textcolor{color}{text} or \colorbox{color}{text}.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 */
function decorateColorWrap(node, from, to, offset, decos /* doc */) {
  const name = node.name;
  if (node.args.length < 2) return DISPATCH_FALLTHROUGH;
  const colorArg = node.args[0];
  const textArg = node.args[1];
  if (!colorArg || !textArg || textArg.type !== N.GROUP || textArg.unclosed) {
    return DISPATCH_FALLTHROUGH;
  }
  const colorName = (colorArg.text || '').trim();
  const cssColor = resolveColor(colorName);
  const textFrom = textArg.from + offset + 1;
  const textTo = textArg.to + offset - 1;
  if (from < textFrom) {
    decos.push(Decoration.replace({}).range(from, textFrom));
  }
  if (textFrom < textTo) {
    const attrs = name === 'textcolor'
      ? { style: `color: ${cssColor}` }
      : { style: `background-color: ${cssColor}; padding: 1px 2px; border-radius: 2px` };
    decos.push(Decoration.mark({ attributes: attrs }).range(textFrom, textTo));
  }
  if (textTo < textArg.to + offset) {
    decos.push(Decoration.replace({}).range(textTo, textArg.to + offset));
  }
  // Recurse into the text arg's children to decorate nested commands
  return undefined;
}

/**
 * Decorate \hl{text} — yellow (or \sethlcolor-set) highlight.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 * @param {any} doc
 */
function decorateHl(node, from, to, offset, decos, doc) {
  if (node.args.length === 0) return DISPATCH_FALLTHROUGH;
  const arg = node.args.find(a => a.type === N.GROUP);
  if (!arg || arg.unclosed) return DISPATCH_FALLTHROUGH;
  const contentFrom = arg.from + offset + 1;
  const contentTo = arg.to + offset - 1;
  // Check for preceding \sethlcolor{color} to determine highlight color
  const before = doc.sliceString(Math.max(0, from - 100), from);
  const hlcMatch = before.match(/\\sethlcolor\{([^}]+)\}\s*$/);
  const hlColor = hlcMatch ? resolveColor(hlcMatch[1].trim()) : '#ffff00';
  if (from < contentFrom) {
    decos.push(Decoration.replace({}).range(from, contentFrom));
  }
  if (contentFrom < contentTo) {
    decos.push(Decoration.mark({
      attributes: { style: `background-color: ${hlColor}; padding: 1px 2px; border-radius: 2px` },
    }).range(contentFrom, contentTo));
  }
  if (contentTo < arg.to + offset) {
    decos.push(Decoration.replace({}).range(contentTo, arg.to + offset));
  }
  return undefined;
}

/**
 * Decorate \href{url}{text} → show text only, styled as link.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 */
function decorateHref(node, from, to, offset, decos /* doc */) {
  if (node.args.length < 2) return DISPATCH_FALLTHROUGH;
  const urlArg = node.args[0];
  const textArg = node.args[1];
  if (!textArg || textArg.type !== N.GROUP || textArg.unclosed) {
    return DISPATCH_FALLTHROUGH;
  }
  const textFrom = textArg.from + offset + 1;
  const textTo = textArg.to + offset - 1;
  if (from < textFrom) {
    decos.push(Decoration.replace({}).range(from, textFrom));
  }
  if (textFrom < textTo) {
    // KK1: only stamp data-href (which the click handler dereferences
    // into window.open) when the URL passes the safe-scheme allowlist.
    // A collaborator-authored \href{javascript:...}{innocent text} would
    // otherwise turn into a click-to-execute trap. The title still shows
    // the raw URL so the reader can see something is off.
    const rawUrl = urlArg.text || '';
    const attributes = { title: `${rawUrl} (Ctrl+Click to open)` };
    if (isSafeWebUrl(rawUrl)) attributes['data-href'] = rawUrl;
    decos.push(Decoration.mark({
      class: 'cm-vm-link',
      attributes,
    }).range(textFrom, textTo));
  }
  if (textTo < textArg.to + offset) {
    decos.push(Decoration.replace({}).range(textTo, textArg.to + offset));
  }
  return false;
}

/**
 * Decorate \url{text} → show as link.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 */
function decorateUrl(node, from, to, offset, decos /* doc */) {
  if (node.args.length === 0) return DISPATCH_FALLTHROUGH;
  const arg = node.args.find(a => a.type === N.GROUP);
  if (!arg || arg.unclosed) return DISPATCH_FALLTHROUGH;
  const contentFrom = arg.from + offset + 1;
  const contentTo = arg.to + offset - 1;
  if (from < contentFrom) {
    decos.push(Decoration.replace({}).range(from, contentFrom));
  }
  if (contentFrom < contentTo) {
    decos.push(Decoration.mark({ class: 'cm-vm-link' }).range(contentFrom, contentTo));
  }
  if (contentTo < arg.to + offset) {
    decos.push(Decoration.replace({}).range(contentTo, arg.to + offset));
  }
  return false;
}

/**
 * Decorate \includegraphics[opts]{file} → render image or show filename badge.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} _offset
 * @param {any} decos
 */
function decorateIncludegraphics(node, from, to, _offset, decos /* doc */) {
  if (node.args.length === 0) return DISPATCH_FALLTHROUGH;
  const arg = node.args.find(a => a.type === N.GROUP);
  if (!arg) return DISPATCH_FALLTHROUGH;
  const texPath = (arg.text || '').trim();
  const resolved = resolveImageFile(texPath);
  if (resolved && isRenderableFile(resolved.path)) {
    decos.push(Decoration.replace({
      block: true,
      widget: new ImageWidget(resolved.id, resolved.path),
    }).range(from, to));
  } else {
    decos.push(Decoration.replace({
      widget: new RefBadgeWidget(texPath || 'image', 'includegraphics'),
    }).range(from, to));
  }
  return false;
}

/**
 * Decorate \caption{text} or \caption*{text} — show as styled text.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 */
function decorateCaption(node, from, to, offset, decos /* doc */) {
  if (node.args.length === 0) return DISPATCH_FALLTHROUGH;
  const arg = node.args.find(a => a.type === N.GROUP);
  if (!arg || arg.unclosed) return DISPATCH_FALLTHROUGH;
  const contentFrom = arg.from + offset + 1;
  const contentTo = arg.to + offset - 1;
  if (from < contentFrom) {
    decos.push(Decoration.replace({}).range(from, contentFrom));
  }
  if (contentFrom < contentTo) {
    decos.push(Decoration.mark({ class: 'cm-vm-caption' }).range(contentFrom, contentTo));
  }
  if (contentTo < to) {
    decos.push(Decoration.replace({}).range(contentTo, to));
  }
  return undefined;
}

/**
 * Decorate \smallskip / \medskip / \bigskip — visual gap widget.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} _offset
 * @param {any} decos
 */
function decorateSkip(node, from, to, _offset, decos /* doc */) {
  const name = node.name;
  const sz = name === 'smallskip' ? '6px' : name === 'medskip' ? '12px' : '24px';
  decos.push(Decoration.replace({ widget: new SpacingWidget(sz) }).range(from, to));
  return false;
}

// ── Exact-name dispatch table ───────────────────────────────────────────────
// Each entry is (node, from, to, offset, decos, doc, sectionNumbers, preambleMeta, listDepth) =>
//   `false` (handled, skip children) | `undefined` (handled, recurse) | `DISPATCH_FALLTHROUGH`.
const COMMAND_DECORATORS = {
  affiliation: decorateAffiliation,
  item: decorateItem,
  footnote: decorateFootnote,
  keywords: decorateKeywords,
  lettrine: decorateLettrine,
  textcolor: decorateColorWrap,
  colorbox: decorateColorWrap,
  hl: decorateHl,
  href: decorateHref,
  url: decorateUrl,
  includegraphics: decorateIncludegraphics,
  caption: decorateCaption,
  'caption*': decorateCaption,
  smallskip: decorateSkip,
  medskip: decorateSkip,
  bigskip: decorateSkip,
};

/**
 * Decorate a COMMAND node. Returns false to skip children, or undefined to continue.
 * @param {any} node
 * @param {any} from
 * @param {any} to
 * @param {any} offset
 * @param {any} decos
 * @param {any} doc
 * @param {any} sectionNumbers
 * @param {any} preambleMeta
 * @param {any} listDepth
 */
function decorateCommand(node, from, to, offset, decos, doc, sectionNumbers, preambleMeta, listDepth = 0) {
  const name = node.name;

  // ── Formatting commands: hide markup, style content ──
  const fmtClass = FORMAT_COMMANDS[name];
  if (fmtClass && node.args.length > 0) {
    const arg = node.args.find(a => a.type === N.GROUP);
    if (arg && !arg.unclosed) {
      const argFrom = arg.from + offset;
      const argTo = arg.to + offset;
      const contentFrom = argFrom + 1; // after {
      const contentTo = argTo - 1;     // before }

      // Hide \command{ ... }
      if (from < contentFrom) {
        decos.push(Decoration.replace({}).range(from, contentFrom));
      }
      if (contentFrom < contentTo) {
        decos.push(Decoration.mark({ class: fmtClass }).range(contentFrom, contentTo));
      }
      if (contentTo < argTo) {
        decos.push(Decoration.replace({}).range(contentTo, argTo));
      }
      // Continue into children for nested commands
      return undefined;
    }
  }

  // ── Section headings: hide command, style title, add numbering ──
  const secClass = SECTION_COMMANDS[name];
  if (secClass && node.args.length > 0) {
    const arg = node.args.find(a => a.type === N.GROUP);
    if (arg && !arg.unclosed) {
      const argFrom = arg.from + offset;
      const argTo = arg.to + offset;
      const contentFrom = argFrom + 1;
      const contentTo = argTo - 1;

      // Look up section number for this position
      const secNum = sectionNumbers?.get(from);

      if (from < contentFrom) {
        if (secNum) {
          decos.push(Decoration.replace({
            widget: new SectionNumberWidget(secNum, secClass),
          }).range(from, contentFrom));
        } else {
          decos.push(Decoration.replace({}).range(from, contentFrom));
        }
      }
      if (contentFrom < contentTo) {
        decos.push(Decoration.mark({ class: secClass }).range(contentFrom, contentTo));
        // Add line decoration so CM6 recalculates line height for the larger font
        const startLine = doc.lineAt(contentFrom);
        const endLine = doc.lineAt(Math.min(contentTo, doc.length));
        for (let ln = startLine.number; ln <= endLine.number; ln++) {
          const line = doc.line(ln);
          decos.push(Decoration.line({ class: secClass + '-line' }).range(line.from));
        }
      }
      if (contentTo < argTo) {
        decos.push(Decoration.replace({}).range(contentTo, argTo));
      }
      return undefined;
    }
  }

  // ── Badge commands: \ref, \cite, etc. → inline badge ──
  if (BADGE_COMMANDS.has(name) && node.args.length > 0) {
    const arg = node.args.find(a => a.type === N.GROUP);
    if (arg) {
      decos.push(
        Decoration.replace({
          widget: new RefBadgeWidget(arg.text, name),
        }).range(from, to)
      );
      return false;
    }
  }

  // ── Editable metadata: hide \cmd{ and }, show styled content ──
  if (EDITABLE_META[name]) {
    const arg = node.args.find(a => a.type === N.GROUP);
    if (arg && !arg.unclosed) {
      const contentFrom = arg.from + offset + 1;
      const contentTo = arg.to + offset - 1;
      if (from < contentFrom) {
        decos.push(Decoration.replace({}).range(from, contentFrom));
      }
      if (contentFrom < contentTo) {
        const metaClass = EDITABLE_META[name];
        decos.push(Decoration.mark({ class: metaClass }).range(contentFrom, contentTo));
        // Add line decoration for large-font metadata so CM6 measures line height correctly
        if (metaClass === 'cm-vm-edit-title' || metaClass === 'cm-vm-edit-subtitle') {
          const startLine = doc.lineAt(contentFrom);
          const endLine = doc.lineAt(Math.min(contentTo, doc.length));
          for (let ln = startLine.number; ln <= endLine.number; ln++) {
            decos.push(Decoration.line({ class: metaClass + '-line' }).range(doc.line(ln).from));
          }
        }
      }
      if (contentTo < to) {
        decos.push(Decoration.replace({}).range(contentTo, to));
      }
      return undefined; // continue to children for re-parsed content
    }
  }

  // ── Exact-name dispatch table ──
  const exactFn = COMMAND_DECORATORS[name];
  if (exactFn) {
    const r = exactFn(node, from, to, offset, decos, doc, sectionNumbers, preambleMeta, listDepth);
    if (r !== DISPATCH_FALLTHROUGH) return r;
    // else fall through to category checks / universal fallback
  }

  // ── Non-text commands: hide entirely (args are parameters, not prose) ──
  if (NON_TEXT_COMMANDS.has(name)) {
    decos.push(Decoration.replace({}).range(from, to));
    return false;
  }

  // ── Page break commands → horizontal rule widget ──
  if (BREAK_COMMANDS.has(name)) {
    decos.push(Decoration.replace({ widget: new PageBreakWidget() }).range(from, to));
    return false;
  }

  // ── Multi-char accent commands: \v{c} → č, \c{c} → ç, etc. ──
  if (ACCENT_CMD_MAP[name] && node.args && node.args.length > 0) {
    const arg = node.args.find(a => a.type === N.GROUP);
    if (arg) {
      const charText = doc.sliceString(arg.from + offset + 1, arg.to + offset - 1).trim();
      if (charText.length === 1 && ACCENT_CMD_MAP[name][charText]) {
        decos.push(Decoration.replace({
          widget: new TextWidget(ACCENT_CMD_MAP[name][charText]),
        }).range(from, to));
        return false;
      }
    }
  }

  // ── Font size/switch commands: {\large text} → hide command, style text ──
  const fontClass = FONT_SIZE_COMMANDS[name] || FONT_SWITCH_COMMANDS[name];
  if (fontClass !== undefined) {
    // Hide the command itself
    decos.push(Decoration.replace({}).range(from, to));
    if (fontClass) {
      // Apply style to text until end of enclosing scope
      // Look ahead from `to` to find the next unmatched `}`
      const docText = doc.toString();
      let depth = 0, end = to;
      while (end < docText.length) {
        if (docText[end] === '{') depth++;
        else if (docText[end] === '}') {
          if (depth === 0) break;
          depth--;
        }
        end++;
      }
      // Mark from after the command to the scope end (or paragraph end)
      const markEnd = Math.min(end, doc.length);
      if (to < markEnd) {
        decos.push(Decoration.mark({ class: fontClass }).range(to, markEnd));
      }
    }
    return false;
  }

  // ── Text-replacement commands: bare commands that represent displayable text ──
  const textReplacement = TEXT_COMMANDS[name];
  if (textReplacement !== undefined) {
    if (textReplacement === '' || textReplacement === '\n') {
      // Empty or line-break: just hide
      decos.push(Decoration.replace({}).range(from, to));
    } else {
      decos.push(Decoration.replace({
        widget: new TextWidget(textReplacement),
      }).range(from, to));
    }
    return false;
  }

  // ── Universal fallback: extract text from any unrecognized command ──
  // Commands with a brace arg: show the LAST group arg's content (the "text" arg),
  // hide everything else (\cmd{...}{, optional args, parameter args).
  // This handles \makecell{text}, \mbox{text}, \rotatebox{90}{text},
  // \adjustbox{...}{text}, \thanks{text}, etc. without needing explicit lists.
  if (node.args && node.args.length > 0) {
    const groups = node.args.filter(a => a.type === N.GROUP);
    if (groups.length > 0) {
      const lastGroup = groups[groups.length - 1];
      const contentFrom = lastGroup.from + offset + 1;
      const contentTo = lastGroup.to + offset - 1;
      if (from < contentFrom && contentFrom <= contentTo) {
        decos.push(Decoration.replace({}).range(from, contentFrom));
      }
      if (contentTo < to) {
        decos.push(Decoration.replace({}).range(contentTo, to));
      }
      return undefined; // continue into children for nested command decoration
    }
    // Command with args but no GROUP (only optional args) — hide entirely
    decos.push(Decoration.replace({}).range(from, to));
    return false;
  }

  // Bare unrecognized command (no args) — hide it
  decos.push(Decoration.replace({}).range(from, to));
  return false;
}

// Bullet styles per nesting depth for itemize
const ITEMIZE_BULLETS = ['\u2022', '\u2013', '\u2217', '\u00B7']; // •, –, ∗, ·

/**
 * Decorate an ENVIRONMENT node.
 * @param {number} listDepth — 0-based nesting depth for list environments
 */
function decorateEnvironment(node, from, to, offset, decos, doc, listDepth = 0) {
  const envName = node.name;

  // ── Table environments → visual table widget ──
  const isTableFloat = envName === 'table' || envName === 'table*' || envName === 'tabbox';
  if (TABLE_ENVS.has(envName) || isTableFloat) {
    // If this table is the one the user has clicked to source-edit, skip the
    // widget so the underlying LaTeX renders normally and is editable.
    if (_expandedTableFrom !== -1 && from === _expandedTableFrom) {
      return undefined;
    }
    // For table/table*/tabbox float wrappers, find the inner tabular
    let tableNode = node;
    let reParsed = false; // true if tableNode came from a re-parse (source-relative offsets)
    if (isTableFloat) {
      // 1) AST search: recursively descend through GROUP and ENVIRONMENT children
      const findTabular = (children) => {
        for (const c of children || []) {
          if (c.type === N.ENVIRONMENT && TABLE_ENVS.has(c.name)) return c;
          if (c.type === N.GROUP || c.type === N.ENVIRONMENT) {
            const found = findTabular(c.children);
            if (found) return found;
          }
        }
        return null;
      };
      let inner = findTabular(node.children);

      // 2) Fallback: regex search in source text — catches tabulars inside
      //    command args (\colorbox, \resizebox, \scalebox, \makebox, etc.)
      //    where the parser stores flat tokens instead of AST nodes.
      if (!inner) {
        const source = doc.sliceString(from, to);
        const TABLE_ENV_NAMES = [...TABLE_ENVS];
        const envPattern = TABLE_ENV_NAMES.map(n => n.replace('*', '\\*')).join('|');
        const re = new RegExp('\\\\begin\\{(' + envPattern + ')\\}');
        const m = source.match(re);
        if (m) {
          const innerName = m[1];
          const innerStart = m.index;
          const endTag = '\\end{' + innerName + '}';
          const endIdx = source.indexOf(endTag, innerStart);
          if (endIdx > innerStart) {
            const innerEnd = endIdx + endTag.length;
            const innerSource = source.slice(innerStart, innerEnd);
            try {
              const subTree = parseLatex(innerSource);
              // Find the environment node in the re-parsed sub-tree
              const findEnv = (n) => {
                if (n.type === N.ENVIRONMENT && n.name === innerName) return n;
                for (const c of n.children || []) {
                  const r = findEnv(c);
                  if (r) return r;
                }
                return null;
              };
              inner = findEnv(subTree);
              if (inner) {
                // Adjust offsets: inner positions are relative to innerSource,
                // shift to be relative to the table env source (0-based)
                inner = { ...inner, from: innerStart + inner.from, to: innerStart + inner.to };
                inner.args = (inner.args || []).map(a => ({
                  ...a, from: innerStart + a.from, to: innerStart + a.to, text: a.text
                }));
                reParsed = true;
              }
            } catch { /* parse error — skip */ }
          }
        }
      }

      if (!inner) {
        return undefined;
      }
      tableNode = inner;
    }
    // Build tableInfo for parseTable
    const source = doc.sliceString(from, to);
    const tableInfo = {
      inner: reParsed
        ? { ...tableNode }
        : { ...tableNode, from: tableNode.from + offset - from, to: tableNode.to + offset - from },
      outer: isTableFloat ? { ...node, from: 0, to: source.length } : null,
      from: 0,
      to: source.length,
    };
    // Copy name/args into the relative-offset copy
    tableInfo.inner.name = tableNode.name;
    if (!reParsed) {
      tableInfo.inner.args = (tableNode.args || []).map(a => ({
        ...a,
        from: a.from + offset - from,
        to: a.to + offset - from,
        text: a.text,
      }));
    }
    if (tableInfo.outer) {
      tableInfo.outer.name = node.name;
      tableInfo.outer.children = (node.children || []).map(c => ({
        ...c,
        from: c.from + offset - from,
        to: c.to + offset - from,
        name: c.name,
        args: (c.args || []).map(a => ({ ...a, from: a.from + offset - from, to: a.to + offset - from, text: a.text })),
        children: c.children,
      }));
    }
    try {
      const parsed = parseTable(tableInfo, source);
      if (parsed && parsed.rows > 0 && parsed.cols > 0) {
        const d = Decoration.replace({
          block: true,
          widget: new TableWidget(parsed, from),
        }).range(from, to);
        d._vmPriority = true; // mark as high-priority block widget
        decos.push(d);
        return false;
      }
    } catch {
      // If parsing fails, fall through to default handling
    }
  }

  // ── Completely hidden environments (metadata, XML, etc.) ──
  if (HIDDEN_ENVS.has(envName)) {
    if (from < to && to <= doc.length) {
      decos.push(Decoration.replace({ block: true }).range(from, to));
    }
    return false;
  }

  // ── Math environments: style but don't hide ──
  if (node.isMath) {
    decos.push(Decoration.mark({ class: 'cm-vm-math-display' }).range(from, to));
    return false;
  }

  // ── Quote environments: hide begin/end, apply block indent styling ──
  if (QUOTE_ENVS.has(envName)) {
    // Hide \begin{quote} line
    const beginLen = '\\begin{}'.length + envName.length;
    let beginActualEnd = from + beginLen;
    for (const arg of node.args || []) {
      const aTo = arg.to + offset;
      if (aTo > beginActualEnd) beginActualEnd = aTo;
    }
    const beginLinePos = Math.min(Math.max(beginActualEnd - 1, from), doc.length - 1);
    const beginLine = doc.lineAt(beginLinePos);
    const hideBeginEnd = Math.min(Math.max(beginLine.to, beginActualEnd), doc.length);
    if (from < hideBeginEnd) {
      decos.push(Decoration.replace({ block: true }).range(from, hideBeginEnd));
    }
    // Hide \end{quote} line
    const endLen = '\\end{}'.length + envName.length;
    const endFrom = to - endLen;
    if (endFrom > 0) {
      const endLine = doc.lineAt(Math.min(endFrom, doc.length));
      if (endLine.from < to) {
        decos.push(Decoration.replace({ block: true }).range(endLine.from, Math.min(to, doc.length)));
      }
    }
    // Apply indented block styling to the content between begin and end
    const contentFrom = hideBeginEnd;
    const contentTo = endFrom > 0 ? doc.lineAt(Math.min(endFrom, doc.length)).from : to;
    if (contentFrom < contentTo) {
      // Apply line decorations to each line in the quote
      for (let pos = contentFrom; pos < contentTo;) {
        const line = doc.lineAt(pos);
        if (line.from >= contentFrom && line.to <= contentTo) {
          decos.push(Decoration.line({ class: 'cm-vm-quote-line' }).range(line.from));
        }
        pos = line.to + 1;
        if (pos <= line.from) break; // safety
      }
    }
    return undefined; // continue into children for nested command decoration
  }

  // ── Universal: hide \begin{...}[args] and \end{...} for ALL environments ──
  // Extends through all args (which may span multiple lines), so constructs like
  // \begin{spacing}{1}\n{\setlength{...}} are fully hidden.
  const beginLen = '\\begin{}'.length + envName.length;
  let beginActualEnd = from + beginLen;
  for (const arg of node.args || []) {
    const aTo = arg.to + offset;
    if (aTo > beginActualEnd) beginActualEnd = aTo;
  }
  // Use beginActualEnd - 1 for lineAt to ensure we get the line containing the last arg char
  // (not the next line if beginActualEnd lands on a newline boundary)
  const beginLinePos = Math.min(Math.max(beginActualEnd - 1, from), doc.length - 1);
  const beginLine = doc.lineAt(beginLinePos);
  // Hide from env start through end of the line containing the last arg
  const hideEnd = Math.min(Math.max(beginLine.to, beginActualEnd), doc.length);
  if (from < hideEnd) {
    const replaceOpts = envName === 'abstract'
      ? { block: true, widget: new AbstractHeadingWidget() }
      : { block: true };
    decos.push(Decoration.replace(replaceOpts).range(from, hideEnd));
  }
  const endLen = '\\end{}'.length + envName.length;
  const endFrom = to - endLen;
  if (endFrom > 0) {
    const endLine = doc.lineAt(Math.min(endFrom, doc.length));
    if (endLine.from < to) {
      decos.push(Decoration.replace({ block: true }).range(endLine.from, Math.min(to, doc.length)));
    }
  }

  // ── Lists: additionally decorate \item children ──
  if (LIST_ENVS.has(envName)) {
    let itemCount = 0;
    for (const child of node.children || []) {
      if (child.type === N.COMMAND && child.name === 'item') {
        itemCount++;
        const itemFrom = child.from + offset;
        const itemTo = child.to + offset;
        let marker;
        if (envName === 'enumerate') {
          const idx = listDepth % 4;
          marker = idx === 0 ? `${itemCount}.`
            : idx === 1 ? `${String.fromCharCode(96 + itemCount)})`
            : idx === 2 ? `${toRoman(itemCount).toLowerCase()}.`
            : `${String.fromCharCode(64 + itemCount)})`;
        } else if (envName === 'description') {
          marker = '\u25B8'; // ▸
        } else {
          marker = ITEMIZE_BULLETS[listDepth % ITEMIZE_BULLETS.length];
        }
        if (itemFrom < itemTo && itemTo <= doc.length) {
          decos.push(
            Decoration.replace({
              widget: new ListMarkerWidget(marker, listDepth),
            }).range(itemFrom, itemTo)
          );
        }
      }
    }
  }

  return undefined;
}

// ── StateField for decorations (supports block decorations) ────────────────

// ── Section number cache (avoid full-doc scan on viewport-only changes) ─────

let _secNumCache = { doc: null, preambleEnd: 0, endDocFrom: 0, labels: new Map() };

/**
 * @param {any} doc
 * @param {any} preambleEnd
 * @param {any} endDocFrom
 */
function getCachedSectionNumbers(doc, preambleEnd, endDocFrom) {
  // CM6 Doc objects are immutable — same reference means same content
  if (_secNumCache.doc === doc &&
      _secNumCache.preambleEnd === preambleEnd &&
      _secNumCache.endDocFrom === (endDocFrom ?? doc.length)) {
    return _secNumCache.labels;
  }
  const labels = buildSectionNumbers(doc, preambleEnd, endDocFrom);
  _secNumCache = { doc, preambleEnd, endDocFrom: endDocFrom ?? doc.length, labels };
  return labels;
}

const visualModeField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    const effect = tr.effects.find(e => e.is(viewportChanged));
    if (effect) {
      return buildDecorations(tr.state, effect.value);
    }
    // On doc change, map positions through until the debounced rebuild fires
    if (tr.docChanged && value !== Decoration.none) {
      try { return value.map(tr.changes); } catch { return Decoration.none; }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── ViewPlugin: debounced viewport notifier with range tracking ─────────────
// Avoids cascade rebuilds by tracking what range we've already decorated and
// only dispatching when the viewport moves outside that range or the doc changes.

const viewportNotifier = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this._rafId = 0;
      this._decoratedFrom = -1;
      this._decoratedTo = -1;
      this._docLen = -1;
      // Initial build — use queueMicrotask so it runs before first paint
      queueMicrotask(() => {
        if (view.dom.isConnected) {
          this._dispatch(view);
        }
      });
    }
    update(update) {
      if (update.docChanged) {
        // Doc changed — always rebuild (debounced)
        this._decoratedFrom = -1; // invalidate range
        this._scheduleRaf(update.view);
        return;
      }
      // State-only changes that flip what gets decorated (e.g. a table being
      // expanded for source-edit). Force a full rebuild so the affected range
      // re-renders without the widget.
      for (const tr of update.transactions) {
        for (const e of tr.effects) {
          if (e.is(setExpandedTable)) {
            this._decoratedFrom = -1;
            this._scheduleRaf(update.view);
            return;
          }
        }
      }
      if (update.viewportChanged) {
        // Viewport scroll — only rebuild if we scrolled outside the decorated range
        const vr = update.view.visibleRanges;
        if (vr.length > 0) {
          const vFrom = vr[0].from;
          const vTo = vr[vr.length - 1].to;
          if (vFrom < this._decoratedFrom || vTo > this._decoratedTo) {
            this._scheduleRaf(update.view);
          }
          // else: still within decorated range, skip rebuild
        }
      }
    }
    _scheduleRaf(view) {
      if (this._rafId) return; // already scheduled
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        if (view.dom.isConnected) {
          this._dispatch(view);
        }
      });
    }
    _dispatch(view) {
      const vr = view.visibleRanges;
      // Track what we're about to decorate (including BUFFER)
      if (vr.length > 0) {
        this._decoratedFrom = Math.max(0, vr[0].from - BUFFER);
        this._decoratedTo = Math.min(view.state.doc.length, vr[vr.length - 1].to + BUFFER);
        this._docLen = view.state.doc.length;
      }
      view.dispatch({ effects: viewportChanged.of(vr) });
    }
    destroy() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
    }
  }
);

// ── Table widget ─────────────────────────────────────────────────────────────

class TableWidget extends WidgetType {
  constructor(parsed, tableFrom) {
    super();
    this.parsed = parsed;
    this.tableFrom = tableFrom;
  }
  eq(other) {
    if (other.tableFrom !== this.tableFrom) return false;
    if (other.parsed.rows !== this.parsed.rows || other.parsed.cols !== this.parsed.cols) return false;
    // Fast path: compare cell-by-cell instead of JSON.stringify
    const a = this.parsed.cells, b = other.parsed.cells;
    for (let r = 0; r < a.length; r++) {
      const ra = a[r], rb = b[r];
      if (!ra || !rb || ra.length !== rb.length) return false;
      for (let c = 0; c < ra.length; c++) {
        if (ra[c] !== rb[c]) return false;
      }
    }
    return true;
  }

  /** Strip LaTeX markup from cell text for display — universal approach */
  static cleanCell(text) {
    if (text == null) return '';
    let s = text;
    // 1. Known text-bearing commands → extract content
    s = s.replace(/\\(?:textbf|textit|emph|textsc|texttt|textrm|textsf|textsl|underline|mbox|makecell|multicolumn\{[^}]*\}\{[^}]*\})\{([^}]*)\}/g, '$1');
    // 2. MakeUppercase/MakeLowercase
    s = s.replace(/\\MakeUppercase\{([^}]*)\}/g, (_, c) => c.toUpperCase());
    s = s.replace(/\\MakeLowercase\{([^}]*)\}/g, (_, c) => c.toLowerCase());
    // 3. Citations and refs → bracketed
    s = s.replace(/\\cite[tp]?\{([^}]*)\}/g, '[$1]');
    s = s.replace(/\\ref\{([^}]*)\}/g, '$1');
    // 4. Commands to hide entirely (metadata, layout)
    s = s.replace(/\\label\{[^}]*\}/g, '');
    s = s.replace(/\\rule\{[^}]*\}\{[^}]*\}/g, '');
    s = s.replace(/\\fontsize\{[^}]*\}\{[^}]*\}\\selectfont\s*/g, '');
    // 5. Known symbol commands → Unicode
    s = s.replace(/\\LaTeX\b/g, 'LaTeX');
    s = s.replace(/\\TeX\b/g, 'TeX');
    s = s.replace(/\\(?:dots|ldots)\b/g, '\u2026');
    s = s.replace(/\\(?:textendash|endash)\b/g, '\u2013');
    s = s.replace(/\\(?:textemdash|emdash)\b/g, '\u2014');
    s = s.replace(/\\copyright\b/g, '\u00A9');
    s = s.replace(/\\times\b/g, '\u00D7');
    s = s.replace(/\\pm\b/g, '\u00B1');
    s = s.replace(/\\infty\b/g, '\u221E');
    s = s.replace(/\\degree\b/g, '\u00B0');
    s = s.replace(/\\checkmark\b/g, '\u2713');
    s = s.replace(/\\S\b/g, '\u00A7');
    // 6. Universal: any remaining \command{arg} → show arg (last resort)
    s = s.replace(/\\[a-zA-Z]+\*?\{([^}]*)\}/g, '$1');
    // 7. Any remaining bare \command → remove
    s = s.replace(/\\[a-zA-Z]+\*?\s*/g, '');
    // 8. Strip leftover braces
    s = s.replace(/[{}]/g, '');
    // 9. LaTeX quotes → Unicode quotes
    s = s.replace(/``/g, '\u201C');
    s = s.replace(/''/g, '\u201D');
    s = s.replace(/`/g, '\u2018');
    s = s.replace(/'/g, '\u2019');
    // 10. Clean up whitespace
    s = s.replace(/\\\\$/g, '');
    s = s.replace(/\s+/g, ' ');
    return s.trim();
  }

  toDOM(view) {
    const { parsed } = this;
    const wrap = document.createElement('div');
    wrap.className = 'cm-vm-table-wrap';
    wrap.title = 'Click to edit source';

    // Click anywhere on the widget switches this table to source-edit mode.
    // The decoration is suppressed for that table; raw LaTeX renders inline.
    wrap.addEventListener('mousedown', (e) => {
      if (!view) return;
      e.preventDefault();
      view.dispatch({
        effects: setExpandedTable.of(this.tableFrom),
        selection: { anchor: this.tableFrom },
      });
      view.focus();
    });

    // Floating "Edit source" hint button (top-right of the wrap)
    const hint = document.createElement('div');
    hint.className = 'cm-vm-table-edit-hint';
    hint.textContent = 'Edit source';
    wrap.appendChild(hint);

    // Caption (top)
    if (parsed.caption && parsed.captionPos === 'top') {
      const cap = document.createElement('div');
      cap.className = 'cm-vm-table-caption';
      cap.textContent = parsed.captionText ? `Table: ${TableWidget.cleanCell(parsed.captionText)}` : '';
      wrap.appendChild(cap);
    }

    const table = document.createElement('table');
    table.className = 'cm-vm-table';
    if (parsed.booktabs) table.classList.add('cm-vm-table-booktabs');
    if (parsed.borders === 'all') table.classList.add('cm-vm-table-bordered');

    // Build merge lookup: key "r,c" → { rowSpan, colSpan }
    const mergeMap = new Map();
    for (const m of parsed.merges || []) {
      mergeMap.set(`${m.row},${m.col}`, m);
    }
    // Track which cells are covered by merges
    const covered = new Set();
    for (const m of parsed.merges || []) {
      for (let dr = 0; dr < m.rowSpan; dr++) {
        for (let dc = 0; dc < m.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue;
          covered.add(`${m.row + dr},${m.col + dc}`);
        }
      }
    }

    for (let r = 0; r < parsed.rows; r++) {
      const tr = document.createElement('tr');
      const isHeader = r === 0 && parsed.headerRow;
      if (isHeader) tr.className = 'cm-vm-table-header';

      const row = parsed.cells[r] || [];
      for (let c = 0; c < parsed.cols; c++) {
        if (covered.has(`${r},${c}`)) continue;

        const cellTag = isHeader ? 'th' : 'td';
        const td = document.createElement(cellTag);
        const merge = mergeMap.get(`${r},${c}`);
        if (merge) {
          if (merge.colSpan > 1) td.colSpan = merge.colSpan;
          if (merge.rowSpan > 1) td.rowSpan = merge.rowSpan;
          if (merge.align) {
            const alignMap = { l: 'left', c: 'center', r: 'right' };
            td.style.textAlign = alignMap[merge.align] || '';
          }
        }

        // Column alignment
        if (!merge?.align && parsed.alignments[c]) {
          const a = parsed.alignments[c];
          if (a.align === 'l') td.style.textAlign = 'left';
          else if (a.align === 'c') td.style.textAlign = 'center';
          else if (a.align === 'r') td.style.textAlign = 'right';
        }

        const cellText = c < row.length ? row[c] : '';
        td.textContent = TableWidget.cleanCell(cellText);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    wrap.appendChild(table);

    // Caption (bottom)
    if (parsed.caption && parsed.captionPos !== 'top') {
      const cap = document.createElement('div');
      cap.className = 'cm-vm-table-caption';
      cap.textContent = parsed.captionText ? `Table: ${TableWidget.cleanCell(parsed.captionText)}` : '';
      wrap.appendChild(cap);
    }

    return wrap;
  }
  ignoreEvent() { return false; }
}

// ── Footnote widget ─────────────────────────────────────────────────────────

class FootnoteWidget extends WidgetType {
  constructor(num, text) {
    super();
    this.num = num || '*';
    this.text = text || '';
  }
  eq(other) { return other.num === this.num && other.text === this.text; }
  toDOM() {
    const span = document.createElement('sup');
    span.className = 'cm-vm-footnote';
    span.textContent = this.num;
    if (this.text) span.title = this.text;
    return span;
  }
  ignoreEvent() { return false; }
}

class PageBreakWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-vm-page-break';
    const hr = document.createElement('hr');
    div.appendChild(hr);
    const label = document.createElement('span');
    label.textContent = 'Page Break';
    div.appendChild(label);
    return div;
  }
  ignoreEvent() { return false; }
}

class SpacingWidget extends WidgetType {
  constructor(size) { super(); this.size = size; }
  eq(other) { return other.size === this.size; }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-vm-spacing';
    div.style.height = this.size;
    return div;
  }
  ignoreEvent() { return false; }
}

class AbstractHeadingWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-vm-abstract-heading';
    div.textContent = 'Abstract';
    return div;
  }
  ignoreEvent() { return false; }
}

class KeywordsLabelWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-vm-keywords-label';
    span.textContent = 'Keywords: ';
    return span;
  }
  ignoreEvent() { return false; }
}

// ── Base theme ──────────────────────────────────────────────────────────────

const visualModeBaseTheme = EditorView.theme({
  // ── Page-like container (Google Docs / Word feel) ──
  '&': {
    backgroundColor: '#f8f9fa',
  },
  '.cm-scroller': {
    fontFamily: "'Times New Roman', 'Georgia', 'Noto Serif', serif",
    fontSize: '12pt',
    lineHeight: '1.6',
    backgroundColor: '#ffffff',
    // Apply vertical "page margin" on the scroller (not on .cm-content), so the
    // gutter and the content drop together. Putting padding on .cm-content alone
    // shifts only the content down — the gutter rows then sit higher than their
    // text rows for the entire document.
    padding: '40px 60px',
  },
  '.cm-content': {
    padding: '0',
    textAlign: 'left !important',
    textIndent: '0 !important',
  },
  '.cm-line': {
    padding: '0 !important',
    textAlign: 'left !important',
    textIndent: '0 !important',
    marginLeft: '0 !important',
    paddingLeft: '0 !important',
    marginBottom: '0',
  },
  // Paragraph spacing: empty/blank lines get a reduced height class applied via decoration
  '.cm-vm-empty-line': {
    height: '0.5em !important',
    lineHeight: '0 !important',
    fontSize: '0 !important',
  },
  // Consecutive blank lines after the first collapse to zero
  '.cm-vm-extra-blank': {
    height: '0 !important',
    lineHeight: '0 !important',
    fontSize: '0 !important',
    overflow: 'hidden',
  },
  // Line numbers: keep the gutter visible in visual mode so the user can see
  // line positions just like in source mode. Lighten the styling. The gutter's
  // font-size is set dynamically by the same compartment that sizes .cm-content,
  // so the per-line heights match automatically — no per-row tweaking needed
  // here. The 40px vertical lift comes from .cm-scroller padding above, which
  // applies equally to gutter and content.
  '.cm-gutters': {
    background: 'transparent !important',
    border: 'none !important',
    color: 'rgba(0,0,0,0.35) !important',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 4px',
  },
  '.cm-cursor': {
    borderLeftColor: '#000 !important',
  },

  // ── Formatting ──
  '.cm-vm-bold': { fontWeight: 'bold' },
  '.cm-vm-italic': { fontStyle: 'italic' },
  '.cm-vm-smallcaps': { fontVariant: 'small-caps' },
  '.cm-vm-underline': { textDecoration: 'underline' },
  '.cm-vm-monospace': {
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    background: 'rgba(0, 0, 0, 0.04)',
    padding: '1px 4px',
    borderRadius: '3px',
    fontSize: '0.85em',
  },
  '.cm-vm-sansserif': { fontFamily: "'Helvetica Neue', Arial, sans-serif" },
  '.cm-vm-serif': { fontFamily: "'Times New Roman', 'Georgia', serif" },
  '.cm-vm-uppercase': { textTransform: 'uppercase' },
  '.cm-vm-lowercase': { textTransform: 'lowercase' },
  '.cm-vm-superscript': { verticalAlign: 'super', fontSize: '0.75em' },
  '.cm-vm-subscript': { verticalAlign: 'sub', fontSize: '0.75em' },
  '.cm-vm-caption': { fontStyle: 'italic', color: '#555', fontSize: '10pt' },

  // ── Block quotes (indented on both sides) ──
  '.cm-vm-quote-line': {
    paddingLeft: '40px !important',
    paddingRight: '40px !important',
    color: '#444',
    backgroundColor: '#fafafa',
  },

  // ── Headings (always left-aligned) ──
  '.cm-vm-part': { fontSize: '20pt', fontWeight: 'bold', lineHeight: '1.4', color: '#1a1a1a', textAlign: 'left' },
  '.cm-vm-chapter': { fontSize: '18pt', fontWeight: 'bold', lineHeight: '1.4', color: '#1a1a1a', textAlign: 'left' },
  '.cm-vm-section': { fontSize: '16pt', fontWeight: 'bold', lineHeight: '1.3', color: '#1a1a1a', textAlign: 'left' },
  '.cm-vm-subsection': { fontSize: '14pt', fontWeight: 'bold', lineHeight: '1.3', color: '#1a1a1a', textAlign: 'left' },
  '.cm-vm-subsubsection': { fontSize: '13pt', fontWeight: 'bold', lineHeight: '1.3', color: '#1a1a1a', textAlign: 'left' },
  '.cm-vm-paragraph': { fontWeight: 'bold', fontSize: '12pt', textAlign: 'left' },
  // Line-level classes — tell CM6 the true line height so click targets are correct
  '.cm-vm-part-line': { fontSize: '20pt', lineHeight: '1.4' },
  '.cm-vm-chapter-line': { fontSize: '18pt', lineHeight: '1.4' },
  '.cm-vm-section-line': { fontSize: '16pt', lineHeight: '1.3' },
  '.cm-vm-subsection-line': { fontSize: '14pt', lineHeight: '1.3' },
  '.cm-vm-subsubsection-line': { fontSize: '13pt', lineHeight: '1.3' },
  '.cm-vm-paragraph-line': { fontSize: '12pt' },
  '.cm-vm-section-number': { fontWeight: 'bold' },

  // Editable metadata (inline)
  '.cm-vm-edit-title': {
    fontSize: '22pt',
    fontWeight: 'bold',
    lineHeight: '1.3',
    color: '#1a1a1a',
    display: 'inline',
  },
  '.cm-vm-edit-title-line': { fontSize: '22pt', lineHeight: '1.3' },
  '.cm-vm-edit-subtitle': {
    fontSize: '16pt',
    fontWeight: 'bold',
    lineHeight: '1.3',
    color: '#444',
    display: 'inline',
  },
  '.cm-vm-edit-subtitle-line': { fontSize: '16pt', lineHeight: '1.3' },
  '.cm-vm-edit-author': {
    fontSize: '13pt',
    color: '#333',
    lineHeight: '1.4',
    display: 'inline',
  },
  '.cm-vm-edit-date': {
    fontSize: '11pt',
    color: '#666',
    lineHeight: '1.4',
    display: 'inline',
  },
  '.cm-vm-edit-email': {
    fontSize: '10pt',
    color: '#1a73e8',
    lineHeight: '1.3',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    display: 'inline',
  },
  '.cm-vm-edit-institution': {
    fontSize: '10pt',
    color: '#666',
    fontStyle: 'italic',
    lineHeight: '1.3',
    display: 'inline',
  },
  '.cm-vm-edit-affil-detail': {
    fontSize: '10pt',
    color: '#888',
    lineHeight: '1.3',
    display: 'inline',
  },
  // ── Abstract heading (replaces \begin{abstract}) ──
  '.cm-vm-abstract-heading': {
    fontWeight: 'bold',
    fontSize: '11pt',
    textAlign: 'left',
    margin: '8px 0 4px',
  },
  // ── Keywords (inline, editable) ──
  '.cm-vm-keywords-label': {
    fontWeight: 'bold',
    fontSize: '9.5pt',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    color: '#555',
  },
  '.cm-vm-keywords-content': {
    fontSize: '9.5pt',
    color: '#555',
  },

  // ── Tables ──
  '.cm-vm-table-wrap': {
    position: 'relative',
    margin: '12px 0',
    overflowX: 'auto',
    cursor: 'pointer',
    border: '1px dashed transparent',
  },
  '.cm-vm-table-wrap:hover': {
    border: '1px dashed rgba(26, 115, 232, 0.4)',
  },
  '.cm-vm-table-edit-hint': {
    position: 'absolute',
    top: '4px',
    right: '6px',
    fontSize: '10px',
    color: '#1a73e8',
    background: 'rgba(255,255,255,0.85)',
    padding: '2px 6px',
    borderRadius: '3px',
    opacity: '0',
    pointerEvents: 'none',
    transition: 'opacity 0.12s',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
  },
  '.cm-vm-table-wrap:hover .cm-vm-table-edit-hint': {
    opacity: '1',
  },
  '.cm-vm-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '10pt',
    lineHeight: '1.4',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
  },
  '.cm-vm-table td, .cm-vm-table th': {
    padding: '4px 8px',
    borderBottom: '1px solid #ddd',
  },
  '.cm-vm-table-header th': {
    fontWeight: 'bold',
    borderBottom: '2px solid #333',
    backgroundColor: '#f5f5f5',
  },
  '.cm-vm-table-booktabs td, .cm-vm-table-booktabs th': {
    borderLeft: 'none',
    borderRight: 'none',
  },
  '.cm-vm-table-booktabs tr:first-child th, .cm-vm-table-booktabs tr:first-child td': {
    borderTop: '2px solid #333',
  },
  '.cm-vm-table-booktabs tr:last-child td': {
    borderBottom: '2px solid #333',
  },
  '.cm-vm-table-bordered td, .cm-vm-table-bordered th': {
    border: '1px solid #999',
  },
  '.cm-vm-table-caption': {
    textAlign: 'center',
    fontSize: '10pt',
    color: '#555',
    fontStyle: 'italic',
    padding: '4px 0',
  },

  // ── Badges ──
  '.cm-vm-ref-badge': {
    display: 'inline',
    background: '#e8f0fe',
    color: '#1967d2',
    padding: '1px 6px',
    borderRadius: '3px',
    fontSize: '0.85em',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    cursor: 'default',
  },
  // Citations rendered inline like real text
  '.cm-vm-cite': {
    color: '#333',
    cursor: 'default',
  },

  // ── List markers ──
  '.cm-vm-list-marker': {
    display: 'inline-block',
    width: '1.5em',
    textAlign: 'right',
    marginRight: '0.5em',
    color: '#333',
  },

  // ── Images ──
  '.cm-vm-image-wrap': {
    textAlign: 'center',
    margin: '8px 0',
  },
  '.cm-vm-image': {
    maxWidth: '100%',
    maxHeight: '400px',
    objectFit: 'contain',
    borderRadius: '2px',
  },

  // ── Links ──
  '.cm-vm-link': {
    color: '#1a73e8',
    textDecoration: 'underline',
    cursor: 'pointer',
  },

  // ── Math ──
  '.cm-vm-math-inline': {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    color: '#7b2ff7',
    fontSize: '0.9em',
  },
  '.cm-vm-math-display': {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    color: '#7b2ff7',
    fontSize: '0.9em',
    display: 'block',
    textAlign: 'center',
    padding: '4px 0',
  },

  // ── Verbatim / code ──
  '.cm-vm-verbatim': {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    background: '#f1f3f4',
    fontSize: '0.85em',
    padding: '2px 4px',
    borderRadius: '3px',
  },

  // ── Footnote ──
  '.cm-vm-footnote': {
    color: '#1a73e8',
    cursor: 'help',
    fontSize: '0.75em',
  },

  // ── Font sizes ──
  '.cm-vm-tiny': { fontSize: '6pt' },
  '.cm-vm-scriptsize': { fontSize: '7pt' },
  '.cm-vm-footnotesize': { fontSize: '8pt' },
  '.cm-vm-small': { fontSize: '10pt' },
  '.cm-vm-large': { fontSize: '14pt' },
  '.cm-vm-Large': { fontSize: '16pt' },
  '.cm-vm-LARGE': { fontSize: '18pt' },
  '.cm-vm-huge': { fontSize: '20pt' },
  '.cm-vm-Huge': { fontSize: '24pt' },

  // ── Page break ──
  '.cm-vm-page-break': {
    textAlign: 'center',
    margin: '16px 0',
    position: 'relative',
  },
  '.cm-vm-page-break hr': {
    border: 'none',
    borderTop: '1px dashed #bbb',
    margin: '0',
  },
  '.cm-vm-page-break span': {
    position: 'relative',
    top: '-10px',
    background: '#fff',
    padding: '0 12px',
    color: '#999',
    fontSize: '9pt',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    letterSpacing: '0.05em',
  },

  // ── Vertical spacing ──
  '.cm-vm-spacing': {
    width: '100%',
  },
});

// ── Environment auto-closer ─────────────────────────────────────────────────
// After any edit, verify that every \begin{itemize/enumerate/description} has
// a matching \end{...} and vice versa.  If one is missing, insert it so that
// hidden markup can never silently disappear and leave the document broken.

const LIST_ENV_NAMES = ['itemize', 'enumerate', 'description'];

const envAutoCloser = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;

  // Fast bail: only scan if the change is large enough to contain a list keyword.
  // Single-char edits (normal typing) can never contain \begin{itemize} etc.
  let totalInserted = 0, totalDeleted = 0;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    totalDeleted += toA - fromA;
    totalInserted += toB - fromB;
  });
  // Shortest keyword is \item (5 chars) — skip if both insert and delete are shorter
  if (totalInserted < 5 && totalDeleted < 5) return tr;

  // Check if the change involves list environment keywords
  let needsScan = false;
  const keywords = ['\\begin{itemize}', '\\end{itemize}', '\\begin{enumerate}', '\\end{enumerate}',
    '\\begin{description}', '\\end{description}', '\\item'];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (needsScan) return;
    const ins = inserted.toString();
    if (keywords.some(k => ins.includes(k))) { needsScan = true; return; }
    if (toA - fromA >= 5) {
      const deleted = tr.startState.doc.sliceString(fromA, toA);
      if (keywords.some(k => deleted.includes(k))) { needsScan = true; }
    }
  });
  if (!needsScan) return tr;

  const doc = tr.newDoc;
  const text = doc.toString();
  const fixes = [];

  for (const env of LIST_ENV_NAMES) {
    const beginTag = `\\begin{${env}}`;
    const endTag = `\\end{${env}}`;

    // Collect all begin/end positions
    const begins = [];
    const ends = [];
    let idx = 0;
    while ((idx = text.indexOf(beginTag, idx)) !== -1) {
      begins.push(idx);
      idx += beginTag.length;
    }
    idx = 0;
    while ((idx = text.indexOf(endTag, idx)) !== -1) {
      ends.push(idx);
      idx += endTag.length;
    }

    // Match begins with ends (greedy, left-to-right nesting)
    const usedEnds = new Set();
    const unmatchedBegins = [];
    for (const b of begins) {
      // Find the first unused \end that comes after this \begin
      let matched = false;
      // Need to respect nesting: count depth from b forward
      let depth = 1;
      for (let i = b + beginTag.length; i < text.length; ) {
        if (text.startsWith(beginTag, i)) {
          depth++;
          i += beginTag.length;
        } else if (text.startsWith(endTag, i)) {
          depth--;
          if (depth === 0 && !usedEnds.has(i)) {
            usedEnds.add(i);
            matched = true;
            break;
          }
          i += endTag.length;
        } else {
          i++;
        }
      }
      if (!matched) unmatchedBegins.push(b);
    }

    // Any \end not consumed is an unmatched end
    const unmatchedEnds = ends.filter(e => !usedEnds.has(e));

    // Fix unmatched \begin: append \end{env} after the last line of content
    for (const _b of unmatchedBegins) {
      // Insert \end{env} at the end of the document (before \end{document} if present)
      const endDocMatch = text.match(/\\end\{document\}/);
      const insertPos = endDocMatch ? endDocMatch.index : text.length;
      fixes.push({ from: insertPos, insert: `\n${endTag}\n` });
    }

    // Fix unmatched \end: remove the orphaned \end tag
    for (const e of unmatchedEnds) {
      const line = doc.lineAt(e + 1); // +1 to be inside the line
      // Remove entire line if it only contains the \end tag
      const lineText = line.text.trim();
      if (lineText === endTag) {
        const removeFrom = line.from > 0 ? line.from - 1 : line.from; // include preceding newline
        fixes.push({ from: removeFrom, to: line.to, insert: '' });
      }
    }

    // Remove matched environments that contain no \item
    // Re-match to find paired ranges
    const usedEnds2 = new Set();
    for (const b of begins) {
      let depth2 = 1;
      for (let i = b + beginTag.length; i < text.length; ) {
        if (text.startsWith(beginTag, i)) {
          depth2++;
          i += beginTag.length;
        } else if (text.startsWith(endTag, i)) {
          depth2--;
          if (depth2 === 0 && !usedEnds2.has(i)) {
            usedEnds2.add(i);
            // Check if content between this begin..end has any \item (excluding nested envs)
            const contentStart = b + beginTag.length;
            const contentEnd = i;
            const content = text.slice(contentStart, contentEnd);
            // Only count \item that are NOT inside a deeper nested env of the same type
            let innerDepth = 0;
            let hasItem = false;
            const itemRe = /\\begin\{(?:itemize|enumerate|description)\}|\\end\{(?:itemize|enumerate|description)\}|\\item\b/g;
            let im;
            while ((im = itemRe.exec(content)) !== null) {
              if (im[0].startsWith('\\begin{')) {
                innerDepth++;
              } else if (im[0].startsWith('\\end{')) {
                innerDepth--;
              } else if (im[0] === '\\item' && innerDepth === 0) {
                hasItem = true;
                break;
              }
            }
            if (!hasItem) {
              // Remove the entire environment (begin line through end line)
              const beginLine = doc.lineAt(b + 1);
              const endLine = doc.lineAt(Math.min(i + endTag.length, doc.length));
              const removeFrom = beginLine.from > 0 ? beginLine.from - 1 : beginLine.from;
              const removeTo = Math.min(endLine.to, doc.length);
              fixes.push({ from: removeFrom, to: removeTo, insert: '' });
            }
            break;
          }
          i += endTag.length;
        } else {
          i++;
        }
      }
    }
  }

  if (fixes.length === 0) return tr;

  // Apply fixes as a follow-up transaction
  return [tr, { changes: fixes, sequential: true }];
});

// ── Cursor style detection ──────────────────────────────────────────────────

/**
 * Detect the LaTeX context at the given cursor position.
 * Returns { block: string, inline: string[] } where:
 *   block: 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph'
 *          | 'itemize' | 'enumerate' | 'description' | 'quote' | 'abstract' | 'normal'
 *   inline: subset of ['bold', 'italic', 'underline', 'monospace', 'smallcaps', 'emphasis']
 * @param {any} doc
 * @param {any} pos
 */
export function getCursorStyle(doc, pos) {
  const text = typeof doc === 'string' ? doc : doc.toString();

  const result = { block: 'Normal', inline: [] };

  // ── Detect block style ──
  // Scan backwards from cursor to find enclosing \section{...}, \begin{env}, etc.

  // Check if cursor is inside a section/chapter heading command
  const HEADING_CMDS = [
    { re: /\\chapter\*?\{/g, label: 'Chapter' },
    { re: /\\section\*?\{/g, label: 'Section' },
    { re: /\\subsection\*?\{/g, label: 'Subsection' },
    { re: /\\subsubsection\*?\{/g, label: 'Subsubsection' },
    { re: /\\paragraph\*?\{/g, label: 'Paragraph' },
    { re: /\\part\*?\{/g, label: 'Part' },
  ];

  // Search a window around the cursor (headings are typically short)
  const searchStart = Math.max(0, pos - 500);
  const searchEnd = Math.min(text.length, pos + 500);
  const window = text.slice(searchStart, searchEnd);
  const windowOffset = searchStart;

  for (const { re, label } of HEADING_CMDS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(window)) !== null) {
      const cmdStart = windowOffset + m.index;
      const braceStart = windowOffset + m.index + m[0].length;
      // Find matching closing brace
      const closeIdx = findMatchingBrace(text, braceStart - 1);
      const braceEnd = closeIdx === -1 ? text.length : closeIdx + 1; // one past }
      if (pos >= cmdStart && pos < braceEnd) {
        result.block = label;
        break;
      }
    }
    if (result.block !== 'Normal') break;
  }

  // If not in a heading, check enclosing environments
  if (result.block === 'Normal') {
    // Find the innermost enclosing environment by scanning for \begin{env}...\end{env}
    const envRe = /\\begin\{(itemize|enumerate|description|quote|quotation|displayquote|blockquote|abstract)\}/g;
    let innerEnv = null;
    envRe.lastIndex = 0;
    let em;
    // Only look before cursor
    const beforeCursor = text.slice(0, pos);
    const envRe2 = /\\begin\{(itemize|enumerate|description|quote|quotation|displayquote|blockquote|abstract)\}/g;
    while ((em = envRe2.exec(beforeCursor)) !== null) {
      const envName = em[1];
      // Check that we haven't passed the corresponding \end{envName} before pos
      const endTag = `\\end{${envName}}`;
      const endIdx = text.indexOf(endTag, em.index + em[0].length);
      if (endIdx === -1 || endIdx >= pos) {
        // Cursor is inside this environment
        const normalized = (envName === 'quotation' || envName === 'displayquote' || envName === 'blockquote')
          ? 'quote' : envName;
        innerEnv = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      }
    }
    if (innerEnv) {
      result.block = innerEnv;
    }
  }

  // ── Detect inline formatting ──
  // Check if cursor is inside \textbf{...}, \emph{...}, etc.
  const INLINE_CMDS = [
    { re: /\\textbf\{/g, label: 'bold' },
    { re: /\\emph\{/g, label: 'italic' },
    { re: /\\textit\{/g, label: 'italic' },
    { re: /\\underline\{/g, label: 'underline' },
    { re: /\\texttt\{/g, label: 'monospace' },
    { re: /\\textsc\{/g, label: 'smallcaps' },
    { re: /\\textsl\{/g, label: 'italic' },
  ];

  // Helper: check if pos is inside a brace-delimited command found by regex
  /**
   * @param {any} re
   * @param {any} searchText
   * @param {any} searchOffset
   */
  function isInsideBraces(re, searchText, searchOffset) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(searchText)) !== null) {
      const braceStart = searchOffset + m.index + m[0].length;
      const closeIdx = findMatchingBrace(text, braceStart - 1);
      const j = closeIdx === -1 ? text.length : closeIdx + 1;
      if (pos >= braceStart && pos < j) return m;
    }
    return null;
  }

  const nearCursor = text.slice(Math.max(0, pos - 500), pos);
  const nearOffset = Math.max(0, pos - 500);
  for (const { re, label } of INLINE_CMDS) {
    if (isInsideBraces(re, nearCursor, nearOffset) && !result.inline.includes(label)) {
      result.inline.push(label);
    }
  }

  // ── Detect text color ──
  // \textcolor{colorname}{...} — cursor must be in the second brace group
  const colorRe = /\\textcolor\{([^}]*)\}\{/g;
  colorRe.lastIndex = 0;
  let cm;
  while ((cm = colorRe.exec(nearCursor)) !== null) {
    const textBraceStart = nearOffset + cm.index + cm[0].length;
    const closeIdx = findMatchingBrace(text, textBraceStart - 1);
    const j = closeIdx === -1 ? text.length : closeIdx + 1;
    if (pos >= textBraceStart && pos < j) {
      result.textColor = cm[1].trim();
      break;
    }
  }

  // ── Detect highlight ──
  // \hl{...}, {\sethlcolor{color}\hl{...}}, or \colorbox{colorname}{...}
  const hlRe = /\\hl\{/g;
  if (isInsideBraces(hlRe, nearCursor, nearOffset)) {
    // Check for preceding \sethlcolor{color} to get the actual color
    const beforeHl = text.slice(Math.max(0, pos - 200), pos);
    const shlMatch = beforeHl.match(/\\sethlcolor\{([^}]+)\}[^]*\\hl\{[^}]*$/);
    result.highlight = shlMatch ? shlMatch[1].trim() : 'yellow';
  } else {
    const cboxRe = /\\colorbox\{([^}]*)\}\{/g;
    cboxRe.lastIndex = 0;
    while ((cm = cboxRe.exec(nearCursor)) !== null) {
      const textBraceStart = nearOffset + cm.index + cm[0].length;
      const closeIdx = findMatchingBrace(text, textBraceStart - 1);
      const j = closeIdx === -1 ? text.length : closeIdx + 1;
      if (pos >= textBraceStart && pos < j) {
        result.highlight = cm[1].trim();
        break;
      }
    }
  }

  return result;
}

// ── Exported extension factory ──────────────────────────────────────────────

// Click handler for \href links — Ctrl+Click opens URL
const hrefClickHandler = EditorView.domEventHandlers({
  click(event, view) {
    if (!event.ctrlKey && !event.metaKey) return false;
    let el = event.target;
    while (el && el !== view.dom) {
      const href = el.getAttribute?.('data-href');
      if (href) {
        // KK1: belt-and-braces against a stale data-href that slipped
        // past decorateHref (e.g. extension re-ordering, future call
        // site). Same allowlist applied here so the unsafe URL can
        // never reach window.open even if the DOM somehow has it.
        if (isSafeWebUrl(href)) {
          window.open(href, '_blank', 'noopener');
        }
        event.preventDefault();
        return true;
      }
      el = el.parentElement;
    }
    return false;
  },
});

// ── Reference & citation hover tooltips ────────────────────────────────────
// On hover over `\ref{key}` (or `\eqref`, `\pageref`, `\autoref`, `\nameref`,
// `\cref`, `\Cref`), look up `\label{key}` in the document and show what kind
// of element it labels (figure / table / equation / section / list item) plus
// the most relevant nearby caption or heading text.
// On hover over `\cite{key}` (and the natbib/biblatex variants), look up the
// key in the bib map and show author / year / title.

const REF_CMD_RE = /\\(ref|eqref|pageref|autoref|nameref|cref|Cref)\*?\{([^}]+)\}/g;
const CITE_CMD_RE = /\\(cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|citealt|citealp|nocite)\*?(?:\[[^\]]*\](?:\[[^\]]*\])?)?\{([^}]+)\}/g;

/**
 * Find `\label{key}` in the doc and classify what it labels.
 * @param {any} text
 * @param {any} key
 */
function describeLabel(text, key) {
  const labelRe = new RegExp('\\\\label\\{' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}');
  const m = labelRe.exec(text);
  if (!m) return null;
  const labelPos = m.index;

  // Walk backwards looking for the nearest enclosing/preceding context.
  // Containers we care about (innermost wins): equation/align/figure/table/listing/lstlisting/algorithm/theorem/lemma/definition/itemize/enumerate
  const before = text.slice(Math.max(0, labelPos - 4000), labelPos);
  const envOpenRe = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|figure\*?|table\*?|listing|lstlisting|algorithm\*?|theorem|lemma|definition|proposition|corollary|enumerate|itemize|description)\}/g;
  const envEndRe = /\\end\{([^}]+)\}/g;
  // Track open envs by counting begin/end after each match
  let openEnv = null;
  let envText = '';
  let bm;
  envOpenRe.lastIndex = 0;
  // Find all begins and ends in `before`, build a stack
  const tokens = [];
  while ((bm = envOpenRe.exec(before)) !== null) tokens.push({ type: 'begin', name: bm[1], pos: bm.index });
  envEndRe.lastIndex = 0;
  while ((bm = envEndRe.exec(before)) !== null) tokens.push({ type: 'end', name: bm[1], pos: bm.index });
  tokens.sort((a, b) => a.pos - b.pos);
  const stack = [];
  for (const t of tokens) {
    if (t.type === 'begin') stack.push(t);
    else {
      // Pop the matching begin
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name.replace('*', '') === t.name.replace('*', '')) { stack.splice(i, 1); break; }
      }
    }
  }
  if (stack.length > 0) {
    openEnv = stack[stack.length - 1].name;
    envText = before.slice(stack[stack.length - 1].pos);
  }

  // Section heading (only if no enclosing env)
  if (!openEnv) {
    const headingRe = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/g;
    let hm, lastHeading = null;
    while ((hm = headingRe.exec(before)) !== null) lastHeading = hm;
    if (lastHeading) {
      return { kind: lastHeading[1], title: lastHeading[2].trim() };
    }
    return { kind: 'label', title: '' };
  }

  // For env-based labels, try to extract a caption or a snippet of contents
  let title = '';
  const capMatch = envText.match(/\\caption(?:\[[^\]]*\])?\{([^}]+)\}/);
  if (capMatch) {
    title = capMatch[1].trim();
  } else if (/^equation|^align|^gather|^multline/.test(openEnv)) {
    // Extract first ~80 chars of math content (after the \begin line)
    const mathStart = envText.indexOf('}') + 1;
    title = envText.slice(mathStart, mathStart + 80).replace(/\s+/g, ' ').trim();
  } else if (/^itemize|^enumerate|^description/.test(openEnv)) {
    // First \item content
    const itemMatch = envText.match(/\\item\s+(.{0,80})/);
    if (itemMatch) title = itemMatch[1].trim();
  }
  return { kind: openEnv.replace('*', ''), title };
}

export const refHoverTooltip = hoverTooltip((view, pos) => {
  // In visual mode, ref/cite source ranges are covered by replace decorations
  // and the badge widgets attach their own document.body-mounted popups. Two
  // tooltip systems firing on the same hover causes inconsistent shapes
  // depending on whether the hover lands on the widget DOM or the underlying
  // editor position — skip CM6's hover here when the position is inside a
  // visual-mode decoration so only the badge popup shows.
  const visualField = view.state.field(visualModeField, false);
  if (visualField && visualField.size > 0) {
    let covered = false;
    visualField.between(pos, pos, () => {
      covered = true;
      return false;
    });
    if (covered) return null;
  }
  // Scan a small window around pos for a ref command containing pos.
  const text = view.state.doc.toString();
  const winStart = Math.max(0, pos - 200);
  const winEnd = Math.min(text.length, pos + 200);
  const window = text.slice(winStart, winEnd);
  REF_CMD_RE.lastIndex = 0;
  let m;
  while ((m = REF_CMD_RE.exec(window)) !== null) {
    const cmdFrom = winStart + m.index;
    const cmdTo = cmdFrom + m[0].length;
    if (pos >= cmdFrom && pos <= cmdTo) {
      const cmdName = m[1];
      const keys = m[2].split(',').map((k) => k.trim()).filter(Boolean);
      return {
        pos: cmdFrom,
        end: cmdTo,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-vm-ref-tooltip';
          for (const key of keys) {
            const row = document.createElement('div');
            row.className = 'cm-vm-ref-tooltip-row';
            const head = document.createElement('div');
            head.className = 'cm-vm-ref-tooltip-head';
            const cmd = document.createElement('span');
            cmd.className = 'cm-vm-ref-tooltip-cmd';
            cmd.textContent = '\\' + cmdName;
            const k = document.createElement('span');
            k.className = 'cm-vm-ref-tooltip-key';
            k.textContent = key;
            head.appendChild(cmd);
            head.appendChild(k);
            row.appendChild(head);
            const desc = describeLabel(text, key);
            const body = document.createElement('div');
            body.className = 'cm-vm-ref-tooltip-body';
            if (!desc) {
              body.classList.add('cm-vm-ref-tooltip-missing');
              body.textContent = 'Label not found in document';
            } else {
              const kindEl = document.createElement('span');
              kindEl.className = 'cm-vm-ref-tooltip-kind';
              kindEl.textContent = desc.kind;
              body.appendChild(kindEl);
              if (desc.title) {
                const titleEl = document.createElement('span');
                titleEl.className = 'cm-vm-ref-tooltip-title';
                titleEl.textContent = desc.title.length > 200 ? desc.title.slice(0, 200) + '…' : desc.title;
                body.appendChild(document.createTextNode(' · '));
                body.appendChild(titleEl);
              }
            }
            row.appendChild(body);
            dom.appendChild(row);
          }
          return { dom };
        },
      };
    }
  }
  // Citation hover
  CITE_CMD_RE.lastIndex = 0;
  let cm;
  while ((cm = CITE_CMD_RE.exec(window)) !== null) {
    const cmdFrom = winStart + cm.index;
    const cmdTo = cmdFrom + cm[0].length;
    if (pos >= cmdFrom && pos <= cmdTo) {
      const cmdName = cm[1];
      const keys = cm[2].split(',').map((k) => k.trim()).filter(Boolean);
      return {
        pos: cmdFrom,
        end: cmdTo,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-vm-ref-tooltip';
          for (const key of keys) {
            dom.appendChild(buildCiteTooltipRow(cmdName, key));
          }
          return { dom };
        },
      };
    }
  }
  return null;
});

/**
 * Build a single citation row for the tooltip popup.
 * @param {any} cmdName
 * @param {any} key
 */
function buildCiteTooltipRow(cmdName, key) {
  const row = document.createElement('div');
  row.className = 'cm-vm-ref-tooltip-row';
  const head = document.createElement('div');
  head.className = 'cm-vm-ref-tooltip-head';
  const cmd = document.createElement('span');
  cmd.className = 'cm-vm-ref-tooltip-cmd';
  cmd.textContent = '\\' + cmdName;
  const k = document.createElement('span');
  k.className = 'cm-vm-ref-tooltip-key';
  k.textContent = key;
  head.appendChild(cmd);
  head.appendChild(k);
  row.appendChild(head);
  const body = document.createElement('div');
  body.className = 'cm-vm-ref-tooltip-body';
  const bib = _bibMap[key];
  if (!bib) {
    body.classList.add('cm-vm-ref-tooltip-missing');
    body.textContent = 'Citation key not found in any .bib file';
  } else {
    // Title (if any) on its own line, then authors + year, then venue (italic).
    if (bib.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'cm-vm-ref-tooltip-title';
      const t = bib.title;
      titleEl.textContent = t.length > 200 ? t.slice(0, 200) + '…' : t;
      body.appendChild(titleEl);
    }
    const authorsLine = bib.authorsFull || bib.author || '';
    if (authorsLine || bib.year) {
      const meta = document.createElement('div');
      meta.className = 'cm-vm-ref-tooltip-authors';
      const authorYear = [authorsLine, bib.year ? `(${bib.year})` : ''].filter(Boolean).join(' ');
      meta.textContent = authorYear || 'Citation';
      body.appendChild(meta);
    }
    if (bib.venue) {
      const venueEl = document.createElement('div');
      venueEl.className = 'cm-vm-ref-tooltip-venue';
      // Only prefix with "In " for conference-style entries (booktitle source);
      // articles (journal) and books (publisher) read better without it.
      const isProceedings =
        bib.entryType === 'inproceedings' ||
        bib.entryType === 'incollection' ||
        bib.entryType === 'conference' ||
        bib.entryType === 'proceedings' ||
        bib.entryType === 'inbook';
      const prefix = isProceedings ? 'In ' : '';
      const v = bib.venue.length > 200 ? bib.venue.slice(0, 200) + '…' : bib.venue;
      venueEl.textContent = prefix + v;
      body.appendChild(venueEl);
    }
    if (!body.firstChild) {
      // Fallback when nothing was extracted from the bib entry.
      body.textContent = 'Citation';
    }
  }
  row.appendChild(body);
  return row;
}

/**
 * Populate the module-level bibliography lookup used by both visual-mode
 * cite badges and the source-mode hover tooltip. Call this whenever the
 * project's files or cite-key index change — independent of visual mode.
 */
// Strip outer braces and case-preservation braces ({A} → A), and trim.
// Used to clean up BibTeX field values for display.
/**
 * @param {any} s
 */
function _stripBibBraces(s) {
  if (!s) return '';
  return s.replace(/\{([^{}]*)\}/g, '$1').trim();
}

// Extract a single field value from a bib entry body, honoring balanced braces
// or quoted strings. The simpler regex `[^}"]+` breaks on titles like
// `title = {A {Special} Title}` or authors with embedded braces.
/**
 * @param {any} entryBody
 * @param {any} fieldName
 */
function _extractBibField(entryBody, fieldName) {
  const re = new RegExp(`\\b${fieldName}\\s*=\\s*`, 'i');
  const m = re.exec(entryBody);
  if (!m) return null;
  let i = m.index + m[0].length;
  const ch = entryBody[i];
  if (ch === '{') {
    let depth = 1;
    let j = i + 1;
    while (j < entryBody.length && depth > 0) {
      if (entryBody[j] === '{') depth++;
      else if (entryBody[j] === '}') depth--;
      if (depth > 0) j++;
    }
    return _stripBibBraces(entryBody.slice(i + 1, j));
  }
  if (ch === '"') {
    let j = i + 1;
    while (j < entryBody.length && entryBody[j] !== '"') {
      if (entryBody[j] === '\\') j++;
      j++;
    }
    return _stripBibBraces(entryBody.slice(i + 1, j));
  }
  // Unquoted (e.g. `year = 2020,`)
  let j = i;
  while (j < entryBody.length && entryBody[j] !== ',' && entryBody[j] !== '\n' && entryBody[j] !== '}') j++;
  return entryBody.slice(i, j).trim();
}

// Find the slice of `text` that contains a single bib entry, starting at the
// `@type{...,...}` opening matched at `entryStart`. Walks forward from the
// first `{` and returns the substring up to (but not including) the matching
// closing `}`, honoring nested braces and skipping quoted strings. Bounds
// `_extractBibField` so it can't accidentally read fields from the next entry.
/**
 * @param {any} text
 * @param {any} entryStart
 */
function _entryBodyAt(text, entryStart) {
  let i = text.indexOf('{', entryStart);
  if (i < 0) return '';
  let depth = 1;
  let j = i + 1;
  while (j < text.length && depth > 0) {
    const ch = text[j];
    if (ch === '"') {
      // Skip the contents of a "..."-quoted field value.
      j++;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  return text.slice(i, j);
}

// Format a BibTeX `author` field as a readable list. BibTeX separates authors
// with " and "; each name is "Last, First" or "First Last". We normalize each
// to "First Last" and join with commas + Oxford "and" for the final author.
/**
 * @param {any} raw
 */
function _formatBibAuthors(raw) {
  if (!raw) return '';
  const list = raw.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  const normalized = list.map((name) => {
    if (name.includes(',')) {
      const [last, ...firstParts] = name.split(',');
      const first = firstParts.join(',').trim();
      return first ? `${first} ${last.trim()}` : last.trim();
    }
    return name;
  });
  if (normalized.length === 0) return '';
  if (normalized.length === 1) return normalized[0];
  if (normalized.length === 2) return `${normalized[0]} and ${normalized[1]}`;
  return normalized.slice(0, -1).join(', ') + ', and ' + normalized[normalized.length - 1];
}

/**
 * @param {any} projectFiles
 * @param {any} bibEntries
 */
export function updateBibContext(projectFiles, bibEntries) {
  _projectFiles = projectFiles || [];
  // Build bib lookup: key → { author, authorsFull, year, title, venue, entryType }
  // - `author`: short form (e.g. "Smith et al.") used for inline visual-mode badges.
  // - `authorsFull`: full readable list for tooltips ("John Smith, Jane Doe, and Bob Roe").
  // - `venue`: booktitle (inproceedings/conference) or journal (article).
  _bibMap = {};
  if (bibEntries && bibEntries.length > 0) {
    for (const entry of bibEntries) {
      if (!entry.label) continue;
      _bibMap[entry.label] = {
        author: entry.detail?.split(' \u2014 ')[0] || entry.label,
        authorsFull: '',
        year: null,
        title: entry.detail?.split(' \u2014 ')[1] || '',
        venue: '',
        entryType: '',
      };
    }
  }
  // Parse the project .bib files for richer per-entry metadata.
  if (_projectFiles.length > 0) {
    for (const f of _projectFiles) {
      if (!f.path?.endsWith('.bib') || !f.content) continue;
      const entryRe = /@(\w+)\s*\{\s*([\w:.@/+-]+)/g;
      let m;
      while ((m = entryRe.exec(f.content)) !== null) {
        const entryType = m[1].toLowerCase();
        const key = m[2];
        // Bound the search to the current entry — otherwise a missing field
        // (e.g. no booktitle) would let _extractBibField read into the next
        // entry and pick up the wrong venue.
        const body = _entryBodyAt(f.content, m.index);
        if (!body) continue;
        const rawAuthor = _extractBibField(body, 'author');
        const rawTitle = _extractBibField(body, 'title');
        const rawYear = _extractBibField(body, 'year');
        const yearOnly = rawYear ? (rawYear.match(/\d{4}/) || [])[0] || null : null;
        // Pick the venue field that matches the entry type. No fuzzy fallback —
        // an inproceedings without booktitle, or an article without journal,
        // simply has no venue rather than us showing something misleading.
        let venue = '';
        if (entryType === 'article') {
          venue = _extractBibField(body, 'journal') || _extractBibField(body, 'journaltitle') || '';
        } else if (entryType === 'book' || entryType === 'booklet' || entryType === 'manual') {
          venue = _extractBibField(body, 'publisher') || '';
        } else {
          // inproceedings, incollection, conference, proceedings, inbook, etc.
          venue = _extractBibField(body, 'booktitle') || '';
        }
        const authorsFull = _formatBibAuthors(rawAuthor || '');
        // Short author form for inline display (e.g. "Smith" or "Smith et al.")
        let shortAuthor = key;
        if (rawAuthor) {
          const list = rawAuthor.split(/\s+and\s+/i);
          const first = list[0].trim();
          shortAuthor = first.split(',')[0].split(/\s+/).pop();
          if (list.length > 1) shortAuthor += ' et al.';
        }

        if (_bibMap[key]) {
          if (yearOnly) _bibMap[key].year = yearOnly;
          if (rawTitle) _bibMap[key].title = rawTitle;
          if (authorsFull) _bibMap[key].authorsFull = authorsFull;
          if (venue) _bibMap[key].venue = venue;
          if (entryType) _bibMap[key].entryType = entryType;
          // If we didn't already have a meaningful short author, set one.
          if (!_bibMap[key].author || _bibMap[key].author === key) _bibMap[key].author = shortAuthor;
        } else {
          _bibMap[key] = {
            author: shortAuthor,
            authorsFull,
            year: yearOnly,
            title: rawTitle || '',
            venue,
            entryType,
          };
        }
      }
    }
  }
}

/**
 * @param {any} projectFiles
 * @param {any} bibEntries
 */
export function visualModeExtension(projectFiles, bibEntries) {
  updateBibContext(projectFiles, bibEntries);
  return [
    visualModeField,
    expandedTableField,
    viewportNotifier,
    visualModeBaseTheme,
    envAutoCloser,
    hrefClickHandler,
    // Esc collapses any source-expanded table back to its visual widget.
    keymap.of([{
      key: 'Escape',
      run: (view) => {
        const cur = view.state.field(expandedTableField, false) ?? -1;
        if (cur === -1) return false;
        view.dispatch({ effects: setExpandedTable.of(-1) });
        return true;
      },
    }]),
    // Make all replace-decoration ranges atomic — the cursor skips over them
    // and they can't be partially deleted, preventing broken LaTeX markup.
    EditorView.atomicRanges.of((view) => {
      return view.state.field(visualModeField, false) || Decoration.none;
    }),
    // In visual mode, enable line wrapping for a more word-processor feel
    EditorView.lineWrapping,
  ];
}
