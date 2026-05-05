import Typo from 'typo-js';
import { findMatchingBrace } from './latexParser.js';
import { getSetting, setSetting, getJsonSetting, setJsonSetting } from './settings.js';

// Supported languages
export const LANGUAGES = [
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'fr_FR', label: 'French' },
  { code: 'de_DE', label: 'German' },
  { code: 'es_ES', label: 'Spanish' },
  { code: 'it_IT', label: 'Italian' },
  { code: 'pt_BR', label: 'Portuguese (BR)' },
  { code: 'nl_NL', label: 'Dutch' },
  { code: 'pl_PL', label: 'Polish' },
];

const LANG_KEY = 'spell-language';
let currentLang = getSetting(LANG_KEY) || 'en_US';
let dictionary = null;
let loadedLang = null;
let loading = false;
const callbacks = [];

// Custom dictionary — words the user has added
const CUSTOM_DICT_KEY = 'custom-dictionary';
const customWords = new Set(getJsonSetting(CUSTOM_DICT_KEY, []));

// Session-only ignored words
const ignoredWords = new Set();

/** @returns {string} Current spellcheck language code (e.g. 'en_US'). */
export function getLanguage() {
  return currentLang;
}

/**
 * Set the spellcheck language and reset the loaded dictionary.
 * @param {string} lang - Language code (e.g. 'en_US')
 */
export function setLanguage(lang) {
  currentLang = lang;
  setSetting(LANG_KEY, lang);
  // Reset dictionary so it reloads
  if (loadedLang !== lang) {
    dictionary = null;
    loadedLang = null;
    loading = false;
  }
}

/**
 * Add a word to the persistent custom dictionary.
 * @param {string} word
 */
export function addToCustomDictionary(word) {
  customWords.add(word.toLowerCase());
  setJsonSetting(CUSTOM_DICT_KEY, [...customWords]);
}

/**
 * Ignore a word for the current session only.
 * @param {string} word
 */
export function ignoreWord(word) {
  ignoredWords.add(word.toLowerCase());
}

/**
 * Check if a word is in the custom dictionary or session ignore list.
 * @param {string} word
 * @returns {boolean}
 */
export function isCustomOrIgnored(word) {
  const lower = word.toLowerCase();
  return customWords.has(lower) || ignoredWords.has(lower);
}

/**
 * Load and return the Hunspell dictionary for the current language.
 * Caches the result; concurrent callers receive the same promise.
 * @returns {Promise<Typo|null>}
 */
export async function getDictionary() {
  if (dictionary && loadedLang === currentLang) return dictionary;
  if (loading && loadedLang === currentLang) {
    return new Promise((resolve) => callbacks.push(resolve));
  }
  loading = true;
  loadedLang = currentLang;
  dictionary = null;
  try {
    const [affResp, dicResp] = await Promise.all([
      fetch(`/dictionaries/${currentLang}.aff`).then((r) => r.text()),
      fetch(`/dictionaries/${currentLang}.dic`).then((r) => r.text()),
    ]);
    dictionary = new Typo(currentLang, affResp, dicResp);
    for (const cb of callbacks) cb(dictionary);
    callbacks.length = 0;
    loading = false;
    return dictionary;
  } catch (e) {
    console.error('Failed to load dictionary:', e);
    loading = false;
    loadedLang = null;
    return null;
  }
}

// LaTeX commands and common terms to skip
const SKIP_PATTERNS = /^[A-Z]{2,}$|^\d+$/;

// Commands whose brace arguments contain prose (should be spellchecked)
const PROSE_COMMANDS = new Set([
  'title',
  'author',
  'date',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
  'chapter',
  'part',
  'caption',
  'footnote',
  'footnotetext',
  'text',
  'textbf',
  'textit',
  'texttt',
  'textrm',
  'textsf',
  'textsc',
  'emph',
  'underline',
  'hl',
  'mbox',
  'fbox',
  'parbox',
  'minipage',
  'thanks',
  'abstract',
  'quote',
  'quotation',
]);

// Environments whose body is not prose (math, code, etc.)
const SKIP_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'eqnarray',
  'eqnarray*',
  'math',
  'displaymath',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'Vmatrix',
  'cases',
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'alltt',
  'tikzpicture',
  'pgfpicture',
  'filecontents',
  'filecontents*',
]);

/**
 * Advance past a matched bracket group (e.g. {...} or [...]).
 * @param {string} text
 * @param {number} i - Index of the opening bracket
 * @param {string} open - Opening bracket character
 * @param {string} close - Closing bracket character
 * @returns {number} Index after the closing bracket
 */
function skipBracketGroup(text, i, open, close) {
  if (i >= text.length || text[i] !== open) return i;
  if (open === '{' && close === '}') {
    const closeIdx = findMatchingBrace(text, i);
    return closeIdx === -1 ? text.length : closeIdx + 1;
  }
  let depth = 1;
  i++;
  while (i < text.length && depth > 0) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    } // skip escaped chars
    if (text[i] === open) depth++;
    else if (text[i] === close) depth--;
    i++;
  }
  return i;
}

/**
 * Spellcheck text content, skipping LaTeX commands and their arguments.
 * Works on the full text (not line-by-line) to correctly handle multi-line
 * commands, math environments, and brace groups.
 * Returns array of { from, to, word } for misspelled words.
 */
import { TC_START, parseAt as parseTcMarker } from '@shared/tcMarkers.js';

// At a tracked-change marker's leading sentinel, jump the scan cursor
// past the metadata header so the author name and other fields aren't
// spellchecked (the editor hides those, so a flagged misspelling there
// shows only as a gutter dot with no inline underline). The INNER text
// portion is still scanned normally on the way through — a typo inside
// an insertion still gets caught. The closing sentinel itself is
// naturally skipped because it's a non-letter char.
export function spellcheckText(text, dict) {
  if (!dict) return [];
  const results = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    // Tracked-change marker: jump past the metadata header so the
    // hidden author/type/length fields aren't spellchecked. The
    // marker's INNER text is still scanned normally; the closing
    // sentinel is a non-letter char so the loop skips it naturally.
    if (ch === TC_START) {
      const m = parseTcMarker(text, i);
      if (m) {
        i = m.textFrom;
        continue;
      }
      // Stray opening sentinel without a valid marker — fall through
      // and treat as a plain non-letter char.
    }

    // Skip comments (% to end of line, unless escaped)
    if (ch === '%' && (i === 0 || text[i - 1] !== '\\')) {
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // Skip inline math $...$  and display math $$...$$
    if (ch === '$') {
      i++;
      if (i < len && text[i] === '$') {
        // $$...$$
        i++;
        while (i < len - 1 && !(text[i] === '$' && text[i + 1] === '$')) {
          if (text[i] === '\\') i++;
          i++;
        }
        i += 2;
      } else {
        while (i < len && text[i] !== '$') {
          if (text[i] === '\\') i++;
          i++;
        }
        if (i < len) i++;
      }
      continue;
    }

    // Skip \(...\) and \[...\] math delimiters
    if (ch === '\\' && i + 1 < len && (text[i + 1] === '(' || text[i + 1] === '[')) {
      const closeChar = text[i + 1] === '(' ? ')' : ']';
      i += 2;
      while (i < len - 1 && !(text[i] === '\\' && text[i + 1] === closeChar)) i++;
      i += 2;
      continue;
    }

    // LaTeX commands
    if (ch === '\\') {
      i++;
      // Collect command name
      const cmdStart = i;
      while (i < len && /[a-zA-Z@*]/.test(text[i])) i++;
      const cmd = text.slice(cmdStart, i);

      if (!cmd) {
        // Escaped character like \\ \$ \& — skip next char
        if (i < len) i++;
        continue;
      }

      // \begin{env} / \end{env} — check if we should skip the environment body
      if (cmd === 'begin' || cmd === 'end') {
        // Skip whitespace
        while (i < len && /\s/.test(text[i])) i++;
        if (i < len && text[i] === '{') {
          const envStart = i + 1;
          i = skipBracketGroup(text, i, '{', '}');
          const envName = text.slice(envStart, i - 1);

          if (cmd === 'begin' && SKIP_ENVIRONMENTS.has(envName)) {
            // Skip everything until \end{envName}
            const endTag = `\\end{${envName}}`;
            const endIdx = text.indexOf(endTag, i);
            if (endIdx !== -1) {
              i = endIdx + endTag.length;
            }
          }
        }
        continue;
      }

      const isProse = PROSE_COMMANDS.has(cmd);

      // Skip optional arguments [...]
      while (i < len && /\s/.test(text[i])) i++;
      if (i < len && text[i] === '[') {
        i = skipBracketGroup(text, i, '[', ']');
      }

      if (isProse) {
        // Skip just the opening brace — let content be spellchecked
        while (i < len && /\s/.test(text[i])) i++;
        if (i < len && text[i] === '{') i++;
      } else {
        // Skip ALL consecutive brace arguments for non-prose commands
        // e.g. \newcommand{\foo}{body}, \setlength{\x}{10pt}
        while (i < len) {
          while (i < len && /\s/.test(text[i])) i++;
          if (i < len && text[i] === '{') {
            i = skipBracketGroup(text, i, '{', '}');
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Skip braces, brackets, digits, punctuation, symbols
    if (!/[a-zA-Z\u00C0-\u024F]/.test(ch)) {
      i++;
      continue;
    }

    // Extract word — allow apostrophes and accented chars
    const wordStart = i;
    while (
      i < len &&
      (/[a-zA-Z\u00C0-\u024F]/.test(text[i]) ||
        (text[i] === "'" && i + 1 < len && /[a-zA-Z\u00C0-\u024F]/.test(text[i + 1])))
    )
      i++;
    const word = text.slice(wordStart, i);

    // Skip very short words, all-caps abbreviations, numbers
    if (word.length < 2) continue;
    if (SKIP_PATTERNS.test(word)) continue;

    // Check spelling
    if (!dict.check(word) && !isCustomOrIgnored(word)) {
      results.push({
        from: wordStart,
        to: i,
        word,
      });
    }
  }

  return results;
}
