import { describe, it, expect } from 'vitest';
import {
  TC_START,
  TC_END,
  serialize,
  parseAt,
  parseAll,
  stripAll,
  acceptAll,
  rejectAll,
  resolveOne,
  countMarkers,
} from '../tcMarkers.js';

const ins = (id, text, author = 'u1') => serialize({ type: 'ins', id, author, text });
const del = (id, text, author = 'u1') => serialize({ type: 'del', id, author, text });

describe('serialize', () => {
  it('round-trips an insertion', () => {
    const s = ins('a1', 'hello');
    const m = parseAt(s, 0);
    expect(m).toMatchObject({ type: 'ins', id: 'a1', author: 'u1', text: 'hello', from: 0, to: s.length });
  });

  it('round-trips a deletion', () => {
    const s = del('d1', 'gone');
    const m = parseAt(s, 0);
    expect(m).toMatchObject({ type: 'del', id: 'd1', author: 'u1', text: 'gone' });
  });

  it('preserves text containing colons, newlines, sentinels, and backslashes', () => {
    const tricky = `colon: yes\n${TC_START}\n${TC_END}\\backslash`;
    const s = ins('id', tricky);
    expect(parseAt(s, 0).text).toBe(tricky);
  });

  it('handles empty text', () => {
    const s = ins('id', '');
    const m = parseAt(s, 0);
    expect(m.text).toBe('');
    expect(m.textFrom).toBe(m.textTo);
  });

  it('handles empty id and author', () => {
    const s = serialize({ type: 'ins', id: '', author: '', text: 'x' });
    const m = parseAt(s, 0);
    expect(m.id).toBe('');
    expect(m.author).toBe('');
    expect(m.text).toBe('x');
  });

  it('rejects bad type', () => {
    expect(() => serialize({ type: 'wat', id: 'x', author: 'u', text: 't' })).toThrow();
  });

  it('rejects ids containing the field separator', () => {
    expect(() => serialize({ type: 'ins', id: 'a:b', author: 'u', text: 't' })).toThrow();
  });
});

describe('parseAt', () => {
  it('returns null when not at a sentinel', () => {
    expect(parseAt('plain text', 0)).toBeNull();
  });

  it('returns null on a malformed marker (missing colons)', () => {
    expect(parseAt(`${TC_START}ins:no:fields${TC_END}`, 0)).toBeNull();
  });

  it('returns null when length field is not an integer', () => {
    expect(parseAt(`${TC_START}ins:a:b:NaN:abc${TC_END}`, 0)).toBeNull();
  });

  it('returns null when length runs past end of content', () => {
    expect(parseAt(`${TC_START}ins:a:b:99:tiny${TC_END}`, 0)).toBeNull();
  });
});

describe('parseAll', () => {
  it('returns [] for empty or marker-free content', () => {
    expect(parseAll('')).toEqual([]);
    expect(parseAll('plain text with no markers')).toEqual([]);
  });

  it('finds multiple markers in document order', () => {
    const content = `before ${ins('a', 'X')}middle${del('b', 'Y')} after`;
    const ms = parseAll(content);
    expect(ms).toHaveLength(2);
    expect(ms[0].id).toBe('a');
    expect(ms[0].type).toBe('ins');
    expect(ms[1].id).toBe('b');
    expect(ms[1].type).toBe('del');
  });

  it('treats a stray unpaired sentinel as plain text and continues', () => {
    const content = `lone ${TC_START} stuff ${ins('a', 'real')} end`;
    const ms = parseAll(content);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('real');
  });

  it('finds adjacent markers without space between', () => {
    const content = `${ins('a', 'eee')}${del('b', 'Header 2')}`;
    const ms = parseAll(content);
    expect(ms.map((m) => [m.type, m.text])).toEqual([
      ['ins', 'eee'],
      ['del', 'Header 2'],
    ]);
  });

  it('handles a marker whose text contains another would-be sentinel', () => {
    // The length-prefix means an inner sentinel-looking sequence is just data.
    const inner = `${TC_START}fake:nope`;
    const content = ins('a', inner);
    const ms = parseAll(content);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe(inner);
  });
});

describe('stripAll', () => {
  it('drops markers AND their text entirely', () => {
    const content = `pre ${ins('a', 'X')}mid ${del('b', 'Y')}suf`;
    expect(stripAll(content)).toBe('pre mid suf');
  });

  it('is a no-op on marker-free content', () => {
    expect(stripAll('hello world')).toBe('hello world');
  });
});

describe('acceptAll / rejectAll', () => {
  it('acceptAll keeps insertions, removes deletions', () => {
    const content = `Header 1 & ${ins('i1', 'eee')}${del('d1', 'Header 2')} & Header 3`;
    expect(acceptAll(content)).toBe('Header 1 & eee & Header 3');
  });

  it('rejectAll removes insertions, keeps deletions', () => {
    const content = `Header 1 & ${ins('i1', 'eee')}${del('d1', 'Header 2')} & Header 3`;
    expect(rejectAll(content)).toBe('Header 1 & Header 2 & Header 3');
  });

  it('acceptAll on insertion-only content keeps inserted text', () => {
    expect(acceptAll(`hi ${ins('x', 'world')}`)).toBe('hi world');
  });

  it('rejectAll on deletion-only content keeps deleted text', () => {
    expect(rejectAll(`hi ${del('x', 'kept')}`)).toBe('hi kept');
  });

  it('acceptAll on deletion-only content removes the deleted text', () => {
    expect(acceptAll(`a ${del('x', 'gone')}b`)).toBe('a b');
  });

  it('rejectAll on insertion-only content removes the inserted text', () => {
    expect(rejectAll(`a ${ins('x', 'gone')}b`)).toBe('a b');
  });
});

describe('resolveOne', () => {
  it('resolves a single insertion (accept) and leaves the rest alone', () => {
    const content = `${ins('a', 'X')}${del('b', 'Y')}${ins('c', 'Z')}`;
    const out = resolveOne(content, 'a', 'accept');
    // 'a' resolved → just the text 'X'. The other markers stay raw.
    const ms = parseAll(out);
    expect(out.startsWith('X')).toBe(true);
    expect(ms.map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('resolves a single deletion (accept) by removing the text', () => {
    const content = `pre ${del('d1', 'gone')}post`;
    expect(resolveOne(content, 'd1', 'accept')).toBe('pre post');
  });

  it('resolves a single insertion (reject) by removing the text', () => {
    const content = `pre ${ins('i1', 'unwanted')}post`;
    expect(resolveOne(content, 'i1', 'reject')).toBe('pre post');
  });

  it('returns content unchanged when id is not found', () => {
    const content = `${ins('a', 'X')}`;
    expect(resolveOne(content, 'nope', 'accept')).toBe(content);
  });

  it('rejects an unknown decision', () => {
    expect(() => resolveOne('any', 'id', 'maybe')).toThrow();
  });
});

describe('countMarkers', () => {
  it('counts every marker', () => {
    const content = `${ins('a', 'X')} mid ${del('b', 'Y')} ${ins('c', 'Z')}`;
    expect(countMarkers(content)).toBe(3);
  });

  it('returns 0 for marker-free content', () => {
    expect(countMarkers('plain')).toBe(0);
  });
});
