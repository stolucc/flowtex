import { describe, it, expect } from 'vitest';
import latexLint from '../latexLint.js';

describe('latexLint', () => {
  describe('clean documents', () => {
    it('returns no diagnostics for valid LaTeX', () => {
      const tex = String.raw`\documentclass{article}
\begin{document}
Hello world.
\end{document}`;
      expect(latexLint(tex)).toEqual([]);
    });

    it('allows escaped special characters', () => {
      expect(latexLint(String.raw`Cost is 10\% and R\&D`)).toEqual([]);
    });

    it('allows subscripts and superscripts in math mode', () => {
      expect(latexLint(String.raw`$x_1^2$`)).toEqual([]);
      expect(latexLint(String.raw`\(a_n^k\)`)).toEqual([]);
      expect(latexLint(String.raw`\[x_i^j\]`)).toEqual([]);
    });

    it('allows & in tabular environments', () => {
      const tex = String.raw`\begin{tabular}{ll}
a & b \\
c & d
\end{tabular}`;
      expect(latexLint(tex)).toEqual([]);
    });

    it('allows & in align environments', () => {
      const tex = String.raw`\begin{align}
x &= y \\
a &= b
\end{align}`;
      expect(latexLint(tex)).toEqual([]);
    });

    it('allows # in macro definitions', () => {
      const tex = String.raw`\newcommand{\foo}[1]{Hello #1}`;
      expect(latexLint(tex)).toEqual([]);
    });

    it('allows #1-#9 parameter references', () => {
      expect(latexLint(String.raw`#1 and #2`)).toEqual([]);
    });

    it('ignores content in verbatim environments', () => {
      const tex = '\\begin{verbatim}\n& # _ ^ $\n\\end{verbatim}';
      expect(latexLint(tex)).toEqual([]);
    });

    it('ignores content in lstlisting', () => {
      const tex = '\\begin{lstlisting}\nx_1 & y^2 # z\n\\end{lstlisting}';
      expect(latexLint(tex)).toEqual([]);
    });

    it('ignores \\verb|...|', () => {
      expect(latexLint(String.raw`\verb|a_b & c#d|`)).toEqual([]);
    });

    it('ignores comments', () => {
      expect(latexLint('% This has _ and ^ and & and #')).toEqual([]);
    });

    it('handles math environments (equation, gather)', () => {
      const tex = String.raw`\begin{equation}
x_1^2 + y_2^3 = z
\end{equation}`;
      expect(latexLint(tex)).toEqual([]);
    });

    it('allows nested environments', () => {
      const tex = String.raw`\begin{align}
x &= \begin{cases} 1 & x > 0 \\ 0 & x \le 0 \end{cases}
\end{align}`;
      expect(latexLint(tex)).toEqual([]);
    });
  });

  describe('special character errors', () => {
    it('flags bare & outside alignment', () => {
      const diags = latexLint('Tom & Jerry');
      expect(diags).toHaveLength(1);
      expect(diags[0]).toMatchObject({ line: 1, severity: 'error' });
      expect(diags[0].message).toMatch(/&/);
    });

    it('flags bare _ outside math', () => {
      const diags = latexLint('file_name');
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/underscore/);
    });

    it('flags bare ^ outside math', () => {
      const diags = latexLint('x^2 is wrong here');
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/caret/);
    });

    it('flags bare # outside macro def', () => {
      const diags = latexLint('Issue #abc');
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/#/);
    });
  });

  describe('environment errors', () => {
    it('detects environment mismatch', () => {
      const tex = String.raw`\begin{itemize}
\item one
\end{enumerate}`;
      const diags = latexLint(tex);
      expect(diags.some((d) => d.message.includes('mismatch'))).toBe(true);
    });

    it('detects unclosed environment', () => {
      const tex = String.raw`\begin{itemize}
\item one`;
      const diags = latexLint(tex);
      expect(diags.some((d) => d.message.includes('never closed'))).toBe(true);
    });

    it('detects \\end without \\begin', () => {
      const diags = latexLint(String.raw`\end{itemize}`);
      expect(diags.some((d) => d.message.includes('without matching'))).toBe(true);
    });
  });

  describe('math mode errors', () => {
    it('detects unclosed inline math', () => {
      const diags = latexLint('$x + y');
      expect(diags.some((d) => d.message.includes('Unclosed inline math'))).toBe(true);
    });

    it('detects unclosed display math', () => {
      const diags = latexLint('$$x + y');
      expect(diags.some((d) => d.message.includes('Unclosed display math'))).toBe(true);
    });

    it('detects empty line in math environment', () => {
      const tex = String.raw`\begin{equation}
x = 1

y = 2
\end{equation}`;
      const diags = latexLint(tex);
      expect(diags.some((d) => d.message.includes('Empty line'))).toBe(true);
    });

    it('does not flag empty line outside math', () => {
      const tex = 'Hello\n\nWorld';
      const diags = latexLint(tex);
      expect(diags.some((d) => d.message.includes('Empty line'))).toBe(false);
    });
  });

  describe('brace errors', () => {
    it('detects unmatched closing brace', () => {
      const diags = latexLint('hello}');
      expect(diags.some((d) => d.message.includes('Unmatched "}"'))).toBe(true);
    });

    it('detects unclosed opening brace', () => {
      const diags = latexLint(String.raw`\textbf{hello`);
      expect(diags.some((d) => d.message.includes('unclosed "{"'))).toBe(true);
    });
  });

  describe('commands that skip brace arguments', () => {
    it('does not flag _ in \\label{}', () => {
      expect(latexLint(String.raw`\label{fig_one}`)).toEqual([]);
    });

    it('does not flag _ in \\ref{}', () => {
      expect(latexLint(String.raw`\ref{sec_intro}`)).toEqual([]);
    });

    it('does not flag _ in \\cite{}', () => {
      expect(latexLint(String.raw`\cite{smith_2024}`)).toEqual([]);
    });

    it('does not flag _ in \\url{}', () => {
      expect(latexLint(String.raw`\url{http://a_b.com}`)).toEqual([]);
    });

    it('does not flag _ in \\includegraphics{}', () => {
      expect(latexLint(String.raw`\includegraphics[width=1cm]{fig_one}`)).toEqual([]);
    });
  });
});
