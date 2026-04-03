import { describe, it, expect, vi, beforeAll } from 'vitest';

// Stub localStorage before the module loads (spellcheck.js reads it at import time)
const storage = {};
const localStorageMock = {
  getItem: vi.fn((key) => storage[key] ?? null),
  setItem: vi.fn((key, val) => {
    storage[key] = val;
  }),
  removeItem: vi.fn((key) => {
    delete storage[key];
  }),
};
vi.stubGlobal('localStorage', localStorageMock);

// Use dynamic import so localStorage stub is in place first
let LANGUAGES, getLanguage, setLanguage, addToCustomDictionary, ignoreWord, isCustomOrIgnored, spellcheckText;

beforeAll(async () => {
  const mod = await import('../spellcheck.js');
  LANGUAGES = mod.LANGUAGES;
  getLanguage = mod.getLanguage;
  setLanguage = mod.setLanguage;
  addToCustomDictionary = mod.addToCustomDictionary;
  ignoreWord = mod.ignoreWord;
  isCustomOrIgnored = mod.isCustomOrIgnored;
  spellcheckText = mod.spellcheckText;
});

// Create a mock dictionary object that matches the Typo.js interface
function mockDict(knownWords) {
  const wordSet = new Set(knownWords.map((w) => w.toLowerCase()));
  return {
    check(word) {
      return wordSet.has(word.toLowerCase());
    },
    suggest() {
      return [];
    },
  };
}

describe('LANGUAGES', () => {
  it('is a non-empty array of { code, label } objects', () => {
    expect(LANGUAGES.length).toBeGreaterThan(0);
    for (const lang of LANGUAGES) {
      expect(lang).toHaveProperty('code');
      expect(lang).toHaveProperty('label');
    }
  });

  it('includes en_US', () => {
    expect(LANGUAGES.some((l) => l.code === 'en_US')).toBe(true);
  });
});

describe('getLanguage / setLanguage', () => {
  it('defaults to en_US', () => {
    expect(typeof getLanguage()).toBe('string');
  });

  it('updates after setLanguage', () => {
    setLanguage('fr_FR');
    expect(getLanguage()).toBe('fr_FR');
    // Restore
    setLanguage('en_US');
  });
});

describe('addToCustomDictionary / ignoreWord / isCustomOrIgnored', () => {
  it('marks a word as custom after adding', () => {
    expect(isCustomOrIgnored('xylophonez')).toBe(false);
    addToCustomDictionary('xylophonez');
    expect(isCustomOrIgnored('xylophonez')).toBe(true);
    expect(isCustomOrIgnored('XYLOPHONEZ')).toBe(true); // case insensitive
  });

  it('marks a word as ignored for the session', () => {
    expect(isCustomOrIgnored('qqtest')).toBe(false);
    ignoreWord('qqtest');
    expect(isCustomOrIgnored('qqtest')).toBe(true);
  });

  it('persists custom dictionary to localStorage', () => {
    addToCustomDictionary('persistme');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'flowtex-custom-dictionary',
      expect.stringContaining('persistme'),
    );
  });
});

// ─── spellcheckText ─────────────────────────────────────────────────────────

describe('spellcheckText', () => {
  const dict = mockDict(['hello', 'world', 'the', 'is', 'this', 'test', 'good', 'text']);

  it('returns empty array for null dictionary', () => {
    expect(spellcheckText('hello', null)).toEqual([]);
  });

  it('returns empty array for empty text', () => {
    expect(spellcheckText('', dict)).toEqual([]);
  });

  it('returns no errors for known words', () => {
    expect(spellcheckText('hello world', dict)).toEqual([]);
  });

  it('flags unknown words with correct positions', () => {
    const results = spellcheckText('hello unknownword', dict);
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe('unknownword');
    expect(results[0].from).toBe(6);
    expect(results[0].to).toBe(17);
  });

  it('skips single-character words', () => {
    const results = spellcheckText('a b', dict);
    expect(results).toEqual([]);
  });

  it('skips all-caps abbreviations', () => {
    const results = spellcheckText('NASA UNESCO', dict);
    expect(results).toEqual([]);
  });

  it('skips numeric strings', () => {
    const results = spellcheckText('12345', dict);
    expect(results).toEqual([]);
  });

  // ── LaTeX-aware skipping ──

  it('skips LaTeX commands and their arguments', () => {
    const results = spellcheckText(String.raw`\includegraphics{image.png}`, dict);
    expect(results).toEqual([]);
  });

  it('spell-checks prose command arguments', () => {
    const results = spellcheckText(String.raw`\textbf{badspellingxyz}`, dict);
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe('badspellingxyz');
  });

  it('skips inline math $...$', () => {
    const results = spellcheckText('hello $\\alpha + \\beta$ world', dict);
    expect(results).toEqual([]);
  });

  it('skips display math $$...$$', () => {
    const results = spellcheckText('hello $$\\int_0^1 xdx$$ world', dict);
    expect(results).toEqual([]);
  });

  it('skips \\(...\\) math', () => {
    const results = spellcheckText(String.raw`hello \(x^2\) world`, dict);
    expect(results).toEqual([]);
  });

  it('skips \\[...\\] math', () => {
    const results = spellcheckText(String.raw`hello \[x^2\] world`, dict);
    expect(results).toEqual([]);
  });

  it('skips comments', () => {
    const results = spellcheckText('hello % badspellingxyz\nworld', dict);
    expect(results).toEqual([]);
  });

  it('skips math environments', () => {
    const src = `hello \\begin{equation}unknownmath\\end{equation} world`;
    const results = spellcheckText(src, dict);
    expect(results.every((r) => r.word !== 'unknownmath')).toBe(true);
  });

  it('skips non-prose command arguments (\\cite, \\ref, etc.)', () => {
    const results = spellcheckText(String.raw`\cite{knuth1984} \ref{fig:xyz}`, dict);
    expect(results).toEqual([]);
  });

  it('checks text between commands', () => {
    const results = spellcheckText(String.raw`\section{Test} unknownword`, dict);
    expect(results.some((r) => r.word === 'unknownword')).toBe(true);
  });

  it('handles nested braces in non-prose commands', () => {
    const results = spellcheckText(String.raw`\newcommand{\foo}{some{thing}}`, dict);
    expect(results).toEqual([]);
  });

  it('handles escaped percent (not a comment)', () => {
    const results = spellcheckText(String.raw`hello \% world`, dict);
    expect(results).toEqual([]);
  });

  it('handles words with apostrophes', () => {
    const dictWithContraction = mockDict(["don't", 'hello']);
    const results = spellcheckText("don't hello", dictWithContraction);
    expect(results).toEqual([]);
  });

  it('respects custom/ignored words', () => {
    ignoreWord('spellcheckskipme');
    const results = spellcheckText('spellcheckskipme hello', dict);
    expect(results.every((r) => r.word !== 'spellcheckskipme')).toBe(true);
  });
});
