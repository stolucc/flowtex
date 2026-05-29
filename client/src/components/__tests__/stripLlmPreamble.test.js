// Pins the preamble-stripping regex set so a future tweak can't
// silently start mangling legitimate output. Each case represents a
// real LLM output shape observed in the wild — adding new ones is
// the right reaction when a model produces a preamble we miss.

import { describe, it, expect } from 'vitest';
import { stripLlmPreamble } from '../LlmActionDialog.jsx';

describe('stripLlmPreamble', () => {
  it('returns falsy inputs unchanged', () => {
    expect(stripLlmPreamble('')).toBe('');
    expect(stripLlmPreamble(null)).toBe(null);
    expect(stripLlmPreamble(undefined)).toBe(undefined);
  });

  it('strips a plain "Here is the rewritten text:" preamble', () => {
    const raw = 'Here is the rewritten text:\n\nThe quick brown fox jumps over the lazy dog.';
    expect(stripLlmPreamble(raw)).toBe('The quick brown fox jumps over the lazy dog.');
  });

  it('strips "Here\'s the paraphrased version:" with curly apostrophe', () => {
    const raw = 'Here’s the paraphrased version:\n\nA swift russet fox leaps over the indolent canine.';
    expect(stripLlmPreamble(raw)).toBe('A swift russet fox leaps over the indolent canine.');
  });

  it('strips "Sure!" / "Of course!" / "Certainly!" openers', () => {
    expect(stripLlmPreamble('Sure! Here is your rewritten paragraph:\n\nHello world.'))
      .toBe('Hello world.');
    expect(stripLlmPreamble('Of course! Below is the shortened version:\n\nHi.'))
      .toBe('Hi.');
    expect(stripLlmPreamble('Certainly, here it is rewritten:\n\nFoo.'))
      .toBe('Foo.');
  });

  it('strips "I rewrote/paraphrased/translated... as follows:" preambles', () => {
    const raw = 'I have rewritten your selection as follows:\n\nThe new text.';
    expect(stripLlmPreamble(raw)).toBe('The new text.');
  });

  it('strips trailing "Let me know if you\'d like..."', () => {
    const raw = 'The rewritten body.\n\nLet me know if you would like further changes.';
    expect(stripLlmPreamble(raw)).toBe('The rewritten body.');
  });

  it('strips trailing "I hope this helps!" sign-off', () => {
    const raw = 'New text here.\n\nI hope this helps!';
    expect(stripLlmPreamble(raw)).toBe('New text here.');
  });

  it('strips a markdown code fence wrapper', () => {
    const raw = '```latex\n\\textbf{Hello}\n```';
    expect(stripLlmPreamble(raw)).toBe('\\textbf{Hello}');
  });

  it('strips matching wrapping quotes', () => {
    expect(stripLlmPreamble('"The actual sentence."')).toBe('The actual sentence.');
    expect(stripLlmPreamble('“Curly-quoted content.”')).toBe('Curly-quoted content.');
  });

  it('leaves prose without preamble untouched', () => {
    const raw = 'This is just the rewritten text, no preamble at all.';
    expect(stripLlmPreamble(raw)).toBe(raw);
  });

  it('does not chew an embedded code fence in the middle of prose', () => {
    const raw = 'Here is what to do:\n\nUse \\textbf{this} for bold, like ```latex code ``` examples.';
    // Outer preamble stripped, inner backticks preserved.
    expect(stripLlmPreamble(raw)).toBe('Use \\textbf{this} for bold, like ```latex code ``` examples.');
  });

  it('only strips one preamble, never recursively eats prose', () => {
    // A defensive case: a paragraph that starts with "Here is" but
    // isn't a preamble (it's actually the rewritten content). The
    // regex requires a trailing colon / dash + blank line, so this
    // ISN'T matched.
    const raw = 'Here is the result of our analysis. We found three patterns.';
    expect(stripLlmPreamble(raw)).toBe(raw);
  });
});
