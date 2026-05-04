// Targeted tests for trackedChangeMarkup.js's regex alternatives. The
// main test file covers structural behaviour; this one is purpose-built
// to kill mutation-testing survivors on each regex alternative
// (Stryker's Regex mutator drops one alternative at a time, so each
// alternative needs at least one input that depends on it).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({
  default: { all: vi.fn(), run: vi.fn() },
}));
vi.mock('../compiler.js', () => ({
  invalidateFile: vi.fn(),
}));
vi.mock('fs', () => ({
  default: { existsSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn() },
  existsSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(),
}));

import {
  buildPreamble,
  wrapSafe,
  applyMarkup,
  resolvePosition,
} from '../utils/trackedChangeMarkup.js';

describe('STRUCTURAL_RE: each alternative is honoured', () => {
  // The structural regex is what causes wrapSafe to flush its buffer
  // and emit the line unwrapped. Each alternative below is a line that
  // MUST appear unwrapped in the output.
  const cases = [
    ['\\begin{itemize}', 'begin env'],
    ['\\end{itemize}', 'end env'],
    ['\\section{x}', 'section'],
    ['\\subsection{x}', 'subsection'],
    ['\\subsubsection{x}', 'subsubsection'],
    ['\\chapter{x}', 'chapter'],
    ['\\paragraph{x}', 'paragraph'],
    ['\\subparagraph{x}', 'subparagraph'],
    ['\\toprule', 'toprule'],
    ['\\midrule', 'midrule'],
    ['\\bottomrule', 'bottomrule'],
    ['\\hline', 'hline'],
    ['\\cline{1-2}', 'cline'],
    ['\\endhead', 'endhead'],
    ['\\endfirsthead', 'endfirsthead'],
    ['\\endfoot', 'endfoot'],
    ['\\endlastfoot', 'endlastfoot'],
    ['\\caption{x}', 'caption'],
    ['\\label{x}', 'label'],
    ['\\centering', 'centering'],
    ['\\item one', 'item'],
    ['\\\\', 'double backslash row terminator'],
    ['\\&', 'escaped ampersand'],
  ];

  for (const [line, name] of cases) {
    it(`treats "${name}" as structural and emits it unwrapped`, () => {
      const out = wrapSafe(`text\n${line}\nmore`, '\\TCadd');
      // The structural line must appear without a TCadd wrapper around it.
      expect(out).toContain(line);
      expect(out).not.toContain(`\\TCadd{${line}}`);
      // Surrounding text WAS wrapped.
      expect(out).toContain('\\TCadd{text}');
      expect(out).toContain('\\TCadd{more}');
    });
  }
});

describe('display math line markers', () => {
  it('flushes around \\[ on its own line', () => {
    const out = wrapSafe('text\n\\[\nmore', '\\TCadd');
    expect(out).toContain('\\[');
    expect(out).toContain('\\TCadd{text}');
    expect(out).toContain('\\TCadd{more}');
    expect(out).not.toContain('\\TCadd{\\[}');
  });

  it('flushes around \\] on its own line', () => {
    const out = wrapSafe('text\n\\]\nmore', '\\TCadd');
    expect(out).toContain('\\]');
    expect(out).not.toContain('\\TCadd{\\]}');
  });

  it('display-math lines may have leading whitespace', () => {
    const out = wrapSafe('text\n   \\[\nmore', '\\TCadd');
    expect(out).toContain('   \\[');
    expect(out).not.toMatch(/\\TCadd\{\s*\\\[\}/);
  });
});

describe('CITE_CMD_RE: each citation command is recognised', () => {
  const citations = ['\\cite{x}', '\\citep{x}', '\\citet{x}', '\\nocite{x}', '\\parencite{x}', '\\textcite{x}', '\\autocite{x}'];
  for (const c of citations) {
    it(`splits around ${c.split('{')[0]}`, () => {
      const out = wrapSafe(`a ${c} b`, '\\TCadd');
      // Citation appears unwrapped, surrounding text wrapped.
      expect(out).toContain(c);
      expect(out).toContain('\\TCadd{a }');
      expect(out).toContain('\\TCadd{ b}');
    });
  }
});

describe('fragile commands inside applyMarkup', () => {
  // Each fragileRe alternative must be honoured.
  const cmds = ['cite', 'parencite', 'textcite', 'autocite', 'citep', 'citet', 'nocite', 'ref', 'eqref', 'pageref', 'label', 'hyperref', 'url', 'href'];
  for (const cmd of cmds) {
    it(`skips a change inside \\${cmd}{...}`, () => {
      const content = `start \\${cmd}{abc} end`;
      const start = content.indexOf('abc');
      const changes = [{ inserted_text: 'abc', from_pos: start, to_pos: start + 3 }];
      const out = applyMarkup(content, changes);
      expect(out).toBe(content);
    });
  }
});

describe('TABLE_STRUCTURAL_RE: every alternative is matched', () => {
  // Each phrase below is a structural-table token. A change whose text
  // contains any of them MUST be silently accepted (deleted, not wrapped)
  // when it falls inside a tabular region.
  const wrap = (inner) => `\\begin{tabular}{ll} ${inner} \\end{tabular}`;
  const cases = [
    ['x & y', 'unescaped &'],
    ['a \\\\\n', 'row terminator \\\\ at line end'],
    ['\\hline', 'hline'],
    ['\\cline{1-2}', 'cline'],
    ['\\toprule', 'toprule'],
    ['\\midrule', 'midrule'],
    ['\\bottomrule', 'bottomrule'],
    ['\\multicolumn{2}{c}{x}', 'multicolumn'],
    ['\\multirow{2}{*}{x}', 'multirow'],
    ['\\caption{tab}', 'caption'],
    ['\\arraystretch{1.2}', 'arraystretch'],
    ['\\renewcommand{\\arraystretch}{1.2}', 'renewcommand'],
  ];
  for (const [token, name] of cases) {
    it(`silently removes structural-table change containing ${name}`, () => {
      const content = wrap(token);
      const idx = content.indexOf(token);
      const changes = [{ deleted_text: token, from_pos: idx, to_pos: idx + token.length }];
      const out = applyMarkup(content, changes);
      // Change is removed, no TCdel wrapper.
      expect(out).not.toContain('\\TCdel');
    });
  }
});

describe('buildPreamble package-detection regex alternatives', () => {
  it('detects \\usepackage[opt]{xcolor} (with options)', () => {
    expect(buildPreamble('\\usepackage[svgnames]{xcolor}'))
      .not.toContain('\\RequirePackage{xcolor}');
  });
  it('detects \\RequirePackage[opt]{ulem}', () => {
    expect(buildPreamble('\\RequirePackage[normalem]{ulem}'))
      .not.toContain('[normalem]{ulem}\n%%');  // not double-loaded
  });
  it('still requires both packages when options happen to match other names', () => {
    // Make sure the regex isn't too loose: a package called `xcolorish` should NOT count.
    const out = buildPreamble('\\usepackage{xcolorish}');
    expect(out).toContain('\\RequirePackage{xcolor}');
  });
});

describe('resolvePosition boundary conditions', () => {
  it('exact match at from..to with from === 0', () => {
    expect(resolvePosition('hello', 'hello', 0, 5)).toEqual({ from: 0, to: 5 });
  });

  it('exact match at end of string', () => {
    const c = 'aaaa hello';
    expect(resolvePosition(c, 'hello', 5, 10)).toEqual({ from: 5, to: 10 });
  });

  it('rejects mismatched stored range and uses from..from+len fallback', () => {
    expect(resolvePosition('hi world', 'world', 3, 99)).toEqual({ from: 3, to: 8 });
  });

  it('returns null when from > content.length and needle absent', () => {
    expect(resolvePosition('short', 'absent', 100, 200)).toBeNull();
  });

  it('window scales with needle length: long needle far from `from` is found', () => {
    const needle = 'abcdefghij'.repeat(3); // 30 chars → window = 600
    const padding = 'x'.repeat(500);
    const content = padding + needle + padding;
    const r = resolvePosition(content, needle, 0, 0);
    // 30 * 20 = 600, capped at 600. Distance from 0 → 500 fits, so found.
    expect(r).toEqual({ from: 500, to: 530 });
  });

  it('window does not exceed cap of 600 for very long needles', () => {
    const needle = 'X'.repeat(100); // window would be 100*20=2000, capped at 600
    const padding = 'y'.repeat(700); // 700 chars pad — outside the 600 cap
    const content = padding + needle;
    const r = resolvePosition(content, needle, 0, 0);
    expect(r).toBeNull(); // window of 600 doesn't reach pos 700
  });

  it('window has minimum of 100 for tiny needles', () => {
    const needle = 'X'; // window = max(100, min(600, 1*20)) = 100
    const content = 'a'.repeat(50) + 'X';
    const r = resolvePosition(content, needle, 0, 0);
    expect(r.from).toBe(50);
  });
});
