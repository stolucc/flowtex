// Server-side parametrized + fuzz tests for the track-changes utilities
// used by the compile route:
//   - stripPendingDeletions: removes pending del ranges (Final view)
//   - wrapPendingChangesAsMacros: wraps with \TCadd / \TCdel (Markup view)
//   - injectTcMacros: injects \providecommand definitions after \documentclass
//
// These are the bridge between the editor's M2 sidecar and the LaTeX
// compiler. Tested from many angles: edge positions, overlapping ranges,
// out-of-bounds, mixed ins/del, idempotence, and ~300 random fuzz cases.

import { describe, it, expect } from 'vitest';
import {
  stripPendingDeletions,
  wrapPendingChangesAsMacros,
  injectTcMacros,
} from '../utils/tcMarks.js';

// ─── stripPendingDeletions ─────────────────────────────────────────────

describe('stripPendingDeletions: no-mark cases', () => {
  it.each([
    { content: 'hello', marks: null },
    { content: 'hello', marks: undefined },
    { content: 'hello', marks: [] },
    { content: 'hello', marks: 'not-an-array' },
    { content: '', marks: [{ type: 'del', from: 0, to: 1 }] },
    { content: null, marks: [{ type: 'del', from: 0, to: 1 }] },
  ])('input=$content marks=$marks → unchanged', ({ content, marks }) => {
    expect(stripPendingDeletions(content, marks)).toBe(content);
  });
});

describe('stripPendingDeletions: single del at various positions', () => {
  const content = 'abcdefghij'; // 10 chars
  const cases = [];
  for (let from = 0; from < 10; from++) {
    for (let to = from + 1; to <= 10; to++) {
      cases.push({ from, to, expected: content.slice(0, from) + content.slice(to) });
    }
  }
  it.each(cases)('del [$from, $to) → expected', ({ from, to, expected }) => {
    expect(stripPendingDeletions(content, [{ id: 'd', type: 'del', from, to }])).toBe(expected);
  });
});

describe('stripPendingDeletions: ins entries are ignored', () => {
  const cases = [
    { marks: [{ type: 'ins', from: 0, to: 5 }], expected: 'hello world' },
    { marks: [{ type: 'ins', from: 6, to: 11 }], expected: 'hello world' },
    {
      marks: [
        { type: 'ins', from: 0, to: 5 },
        { type: 'del', from: 6, to: 11 },
      ],
      expected: 'hello ',
    },
  ];
  it.each(cases)('marks=$marks', ({ marks, expected }) => {
    expect(stripPendingDeletions('hello world', marks)).toBe(expected);
  });
});

describe('stripPendingDeletions: overlapping del ranges merge', () => {
  const cases = [
    {
      name: 'two overlapping',
      marks: [{ type: 'del', from: 1, to: 3 }, { type: 'del', from: 2, to: 5 }],
      expected: 'af',
    },
    {
      name: 'three chained',
      marks: [
        { type: 'del', from: 0, to: 2 },
        { type: 'del', from: 1, to: 4 },
        { type: 'del', from: 3, to: 5 },
      ],
      expected: 'f',
    },
    {
      name: 'duplicate ranges',
      marks: [
        { type: 'del', from: 2, to: 4 },
        { type: 'del', from: 2, to: 4 },
      ],
      expected: 'abef',
    },
    {
      name: 'nested',
      marks: [
        { type: 'del', from: 0, to: 6 },
        { type: 'del', from: 2, to: 4 },
      ],
      expected: '',
    },
  ];
  it.each(cases)('$name', ({ marks, expected }) => {
    expect(stripPendingDeletions('abcdef', marks)).toBe(expected);
  });
});

describe('stripPendingDeletions: out-of-bounds ranges are clamped', () => {
  const cases = [
    { marks: [{ type: 'del', from: 0, to: 100 }], expected: '' },
    { marks: [{ type: 'del', from: 5, to: 100 }], expected: 'hello' },
    { marks: [{ type: 'del', from: -5, to: 3 }], expected: 'lo' },
    { marks: [{ type: 'del', from: -5, to: 100 }], expected: '' },
  ];
  it.each(cases)('marks=$marks', ({ marks, expected }) => {
    expect(stripPendingDeletions('hello', marks)).toBe(expected);
  });
});

describe('stripPendingDeletions: drops invalid entries', () => {
  it.each([
    { marks: [{ type: 'del', from: 0, to: 0 }], expected: 'abc' },
    { marks: [{ type: 'del', from: 3, to: 1 }], expected: 'abc' },
    { marks: [{ type: 'del' }], expected: 'abc' },
    { marks: [{ from: 0, to: 1 }], expected: 'abc' },
    { marks: [null], expected: 'abc' },
  ])('marks=$marks → no strip', ({ marks, expected }) => {
    expect(stripPendingDeletions('abc', marks)).toBe(expected);
  });
});

// ─── wrapPendingChangesAsMacros ────────────────────────────────────────

describe('wrapPendingChangesAsMacros: wraps ins / del with macros', () => {
  const cases = [
    {
      name: 'single ins',
      marks: [{ type: 'ins', from: 0, to: 3 }],
      expected: '\\TCadd{abc}def',
    },
    {
      name: 'single del',
      marks: [{ type: 'del', from: 3, to: 6 }],
      expected: 'abc\\TCdel{def}',
    },
    {
      name: 'ins + del',
      marks: [
        { type: 'ins', from: 0, to: 2 },
        { type: 'del', from: 4, to: 6 },
      ],
      expected: '\\TCadd{ab}cd\\TCdel{ef}',
    },
    {
      name: 'three non-overlapping',
      marks: [
        { type: 'ins', from: 0, to: 1 },
        { type: 'del', from: 2, to: 3 },
        { type: 'ins', from: 4, to: 5 },
      ],
      expected: '\\TCadd{a}b\\TCdel{c}d\\TCadd{e}f',
    },
  ];
  it.each(cases)('$name', ({ marks, expected }) => {
    expect(wrapPendingChangesAsMacros('abcdef', marks)).toBe(expected);
  });
});

// Regression: ulem's \uline / \sout (inside \TCadd / \TCdel) crash with
// fragile commands like \section in their argument ("File ended while
// scanning use of \@xdblarg"). The wrap function must move the markup
// macro INSIDE the section's argument so the section command itself
// stays at top level.
describe('wrapPendingChangesAsMacros: sectioning commands', () => {
  it('insert covering "\\section{Title}" wraps inside the section', () => {
    const content = '\\section{Title}';
    const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 0, to: content.length }]);
    expect(out).toBe('\\section{\\TCadd{Title}}');
  });

  it('handles \\subsection / \\chapter / \\paragraph', () => {
    for (const cmd of ['subsection', 'subsubsection', 'chapter', 'paragraph', 'part']) {
      const content = `\\${cmd}{Heading}`;
      const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 0, to: content.length }]);
      expect(out).toBe(`\\${cmd}{\\TCadd{Heading}}`);
    }
  });

  it('handles starred variant (\\section*)', () => {
    const content = '\\section*{Unnumbered}';
    const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 0, to: content.length }]);
    expect(out).toBe('\\section*{\\TCadd{Unnumbered}}');
  });

  it('handles optional short-title arg (\\section[short]{long})', () => {
    const content = '\\section[Short]{Long Title}';
    const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 0, to: content.length }]);
    expect(out).toBe('\\section[Short]{\\TCadd{Long Title}}');
  });

  it('preserves leading whitespace before the section command', () => {
    const content = '\n\\section{Title}';
    const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 0, to: content.length }]);
    expect(out).toBe('\n\\section{\\TCadd{Title}}');
  });

  it('del wraps similarly', () => {
    const content = '\\section{Old Title}';
    const out = wrapPendingChangesAsMacros(content, [{ type: 'del', from: 0, to: content.length }]);
    expect(out).toBe('\\section{\\TCdel{Old Title}}');
  });

  it('wraps trailing content after the section', () => {
    const content = '\\section{Title}\nbody text';
    const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 0, to: content.length }]);
    expect(out).toBe('\\section{\\TCadd{Title}}\\TCadd{\nbody text}');
  });

  it('non-sectioning ins still uses naive wrap', () => {
    const content = 'hello world';
    const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 0, to: content.length }]);
    expect(out).toBe('\\TCadd{hello world}');
  });

  it('mark covers ONLY the title text inside an existing section → naive wrap is correct', () => {
    // User typed inside an existing section's title; the mark covers just
    // the title chars (not the \section{ part), so the naive wrap is fine
    // and the section command isn't in the mark to begin with.
    const content = '\\section{old NEW}';
    // Mark covers " NEW" at positions 12-16
    const out = wrapPendingChangesAsMacros(content, [{ type: 'ins', from: 12, to: 16 }]);
    expect(out).toBe('\\section{old\\TCadd{ NEW}}');
  });
});

describe('wrapPendingChangesAsMacros: no-mark cases', () => {
  it.each([
    { content: 'abc', marks: null },
    { content: 'abc', marks: undefined },
    { content: 'abc', marks: [] },
    { content: '', marks: [{ type: 'ins', from: 0, to: 1 }] },
  ])('input=$content marks=$marks → unchanged', ({ content, marks }) => {
    expect(wrapPendingChangesAsMacros(content, marks)).toBe(content);
  });
});

describe('wrapPendingChangesAsMacros: ranges at start/end/full doc', () => {
  it.each([
    { from: 0, to: 5, expected: '\\TCadd{hello}' },
    { from: 0, to: 1, expected: '\\TCadd{h}ello' },
    { from: 4, to: 5, expected: 'hell\\TCadd{o}' },
  ])('ins [$from, $to)', ({ from, to, expected }) => {
    expect(wrapPendingChangesAsMacros('hello', [{ type: 'ins', from, to }])).toBe(expected);
  });
});

describe('wrapPendingChangesAsMacros: overlapping ranges are skipped defensively', () => {
  it('first wins; second overlapping skipped', () => {
    expect(
      wrapPendingChangesAsMacros('abcdef', [
        { type: 'ins', from: 0, to: 3 },
        { type: 'del', from: 1, to: 4 }, // overlaps
      ]),
    ).toBe('\\TCadd{abc}def');
  });
});

// ─── injectTcMacros ────────────────────────────────────────────────────

describe('injectTcMacros: adds preamble after \\documentclass', () => {
  it.each([
    '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n',
    '\\documentclass[12pt,a4paper]{article}\n\\begin{document}\nbody\n\\end{document}',
    '\\documentclass{book}\n\n\\title{X}\n\\begin{document}\nbody\n\\end{document}',
  ])('input has \\documentclass → preamble injected', (src) => {
    const out = injectTcMacros(src);
    expect(out).toContain('\\providecommand{\\TCadd}');
    expect(out).toContain('\\providecommand{\\TCdel}');
    expect(out).toContain('\\usepackage[normalem]{ulem}');
    expect(out.indexOf('\\documentclass')).toBeLessThan(out.indexOf('\\providecommand{\\TCadd}'));
    // Body content preserved.
    expect(out).toContain('\\end{document}');
  });
});

describe('injectTcMacros: no-op cases', () => {
  it.each([
    { name: 'no documentclass', input: 'hello world' },
    { name: 'empty string', input: '' },
    { name: 'TCadd already defined via providecommand', input: '\\documentclass{article}\n\\providecommand{\\TCadd}[1]{x}\n' },
    { name: 'TCadd defined via newcommand', input: '\\documentclass{article}\n\\newcommand{\\TCadd}[1]{x}\n' },
  ])('$name → returned as-is', ({ input }) => {
    expect(injectTcMacros(input)).toBe(input);
  });
});

describe('injectTcMacros: idempotence (running twice equals running once)', () => {
  const src = '\\documentclass{article}\n\\begin{document}\nbody\n\\end{document}\n';
  it('idempotent on second call', () => {
    const once = injectTcMacros(src);
    const twice = injectTcMacros(once);
    expect(twice).toBe(once);
  });
});

// ─── Property-based fuzz: 300 random combinations ──────────────────────

function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 0x100000) / 0x100000;
  };
}

describe('Fuzz: 300 random (content × marks) → strip+wrap preserve content size', () => {
  it.each(Array.from({ length: 300 }, (_, i) => ({ seed: i + 1 })))(
    'seed=$seed: strip output ≤ content length; wrap output ≥ content length',
    ({ seed }) => {
      const r = rng(seed);
      const len = 5 + Math.floor(r() * 50);
      const content = Array.from({ length: len }, () =>
        String.fromCharCode(97 + Math.floor(r() * 26))
      ).join('');
      const markCount = Math.floor(r() * 5);
      const marks = [];
      for (let i = 0; i < markCount; i++) {
        const type = r() < 0.5 ? 'ins' : 'del';
        const from = Math.floor(r() * len);
        const to = Math.min(len, from + 1 + Math.floor(r() * 5));
        if (from < to) marks.push({ id: `m${i}`, type, from, to });
      }
      const stripped = stripPendingDeletions(content, marks);
      expect(stripped.length).toBeLessThanOrEqual(content.length);

      const wrapped = wrapPendingChangesAsMacros(content, marks);
      // Wrapped output has at minimum the original content; each mark
      // adds the macro overhead (e.g. "\TCadd{}" = 8 chars).
      expect(wrapped.length).toBeGreaterThanOrEqual(content.length);
    },
  );
});

describe('Fuzz: 100 random docs → injectTcMacros is safe', () => {
  it.each(Array.from({ length: 100 }, (_, i) => ({ seed: i + 1000 })))(
    'seed=$seed: arbitrary content survives injection',
    ({ seed }) => {
      const r = rng(seed);
      const hasDocClass = r() < 0.7;
      const prefix = hasDocClass ? '\\documentclass{article}\n' : '';
      const body = 'random body text ' + Math.floor(r() * 1000);
      const src = prefix + body;
      const out = injectTcMacros(src);
      // Output preserves the original body content.
      expect(out).toContain(body);
      if (hasDocClass) {
        expect(out).toContain('\\providecommand{\\TCadd}');
      } else {
        expect(out).toBe(src);
      }
    },
  );
});
