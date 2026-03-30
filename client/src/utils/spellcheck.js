import Typo from 'typo-js';

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

const LANG_KEY = 'flowtex-spell-language';
let currentLang = localStorage.getItem(LANG_KEY) || 'en_US';
let dictionary = null;
let loadedLang = null;
let loading = false;
const callbacks = [];

// Custom dictionary — words the user has added
const CUSTOM_DICT_KEY = 'flowtex-custom-dictionary';
let customWords;
try {
  customWords = new Set(JSON.parse(localStorage.getItem(CUSTOM_DICT_KEY) || '[]'));
} catch {
  customWords = new Set();
}

// Session-only ignored words
const ignoredWords = new Set();

export function getLanguage() {
  return currentLang;
}

export function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  // Reset dictionary so it reloads
  if (loadedLang !== lang) {
    dictionary = null;
    loadedLang = null;
    loading = false;
  }
}

export function addToCustomDictionary(word) {
  customWords.add(word.toLowerCase());
  localStorage.setItem(CUSTOM_DICT_KEY, JSON.stringify([...customWords]));
}

export function ignoreWord(word) {
  ignoredWords.add(word.toLowerCase());
}

export function isCustomOrIgnored(word) {
  const lower = word.toLowerCase();
  return customWords.has(lower) || ignoredWords.has(lower);
}

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
const SKIP_PATTERNS = /^\\[a-zA-Z]+|^[A-Z]{2,}$|^\d+$/;

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
  'mbox',
  'fbox',
  'parbox',
  'minipage',
  'thanks',
  'abstract',
  'quote',
  'quotation',
]);

function skipBracketGroup(line, i, open, close) {
  if (i >= line.length || line[i] !== open) return i;
  let depth = 1;
  i++;
  while (i < line.length && depth > 0) {
    if (line[i] === open) depth++;
    else if (line[i] === close) depth--;
    i++;
  }
  return i;
}

/**
 * Spellcheck text content, skipping LaTeX commands and their arguments.
 * Returns array of { from, to, word } for misspelled words.
 * `from` and `to` are character offsets in the full text.
 */
export function spellcheckText(text, dict) {
  if (!dict) return [];
  const results = [];
  const lines = text.split('\n');
  let offset = 0;

  for (const line of lines) {
    let i = 0;
    while (i < line.length) {
      const ch = line[i];

      // Skip comments
      if (ch === '%' && (i === 0 || line[i - 1] !== '\\')) {
        break;
      }

      // Skip inline math $...$
      if (ch === '$') {
        i++;
        if (i < line.length && line[i] === '$') {
          // $$...$$ display math
          i++;
          while (i < line.length - 1 && !(line[i] === '$' && line[i + 1] === '$')) i++;
          i += 2;
        } else {
          while (i < line.length && line[i] !== '$') {
            if (line[i] === '\\') i++; // skip escaped $
            i++;
          }
          if (i < line.length) i++; // skip closing $
        }
        continue;
      }

      // Skip LaTeX commands and their arguments
      if (ch === '\\') {
        i++;
        // Collect command name
        const cmdStart = i;
        while (i < line.length && /[a-zA-Z*]/.test(line[i])) i++;
        const cmd = line.slice(cmdStart, i);

        if (!cmd) {
          // Escaped character like \\ \$ \& — skip next char
          if (i < line.length) i++;
          continue;
        }

        const isProse = PROSE_COMMANDS.has(cmd);

        // Skip optional arguments [...]
        while (i < line.length && /\s/.test(line[i])) i++;
        if (i < line.length && line[i] === '[') {
          i = skipBracketGroup(line, i, '[', ']');
        }

        // Handle brace arguments {...}
        while (i < line.length && /\s/.test(line[i])) i++;
        if (isProse) {
          // Don't skip — let the brace content be spellchecked
          if (i < line.length && line[i] === '{') i++; // skip the opening brace only
        } else {
          // Skip all brace arguments for non-prose commands
          while (i < line.length && /\s/.test(line[i])) i++;
          if (i < line.length && line[i] === '{') {
            i = skipBracketGroup(line, i, '{', '}');
          }
        }
        continue;
      }

      // Skip braces, brackets, math delimiters, digits, punctuation
      if (!/[a-zA-Z\u00C0-\u024F]/.test(ch)) {
        i++;
        continue;
      }

      // Extract word — allow apostrophes and accented chars
      const wordStart = i;
      while (
        i < line.length &&
        (/[a-zA-Z\u00C0-\u024F]/.test(line[i]) ||
          (line[i] === "'" && i + 1 < line.length && /[a-zA-Z\u00C0-\u024F]/.test(line[i + 1])))
      )
        i++;
      const word = line.slice(wordStart, i);

      // Skip very short words, all-caps abbreviations
      if (word.length < 2) continue;
      if (SKIP_PATTERNS.test(word)) continue;

      // Check spelling
      if (!dict.check(word) && !isCustomOrIgnored(word)) {
        results.push({
          from: offset + wordStart,
          to: offset + i,
          word,
        });
      }
    }
    offset += line.length + 1; // +1 for \n
  }

  return results;
}
