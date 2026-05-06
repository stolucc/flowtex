import { describe, it, expect } from 'vitest';
import { findOrphanRanges } from '../tcMarkerSanitizer.js';
import { serialize, TC_START, TC_END } from '@shared/tcMarkers.js';

describe('findOrphanRanges', () => {
  it('returns nothing for a clean doc', () => {
    expect(findOrphanRanges('hello world')).toEqual([]);
  });

  it('returns nothing when every sentinel forms a valid marker', () => {
    const m = serialize({ type: 'ins', id: 'x', author: 'a', text: 'hi' });
    expect(findOrphanRanges(`pre${m}post`)).toEqual([]);
  });

  it('finds an orphan TC_START + apparent header', () => {
    const orphan = `${TC_START}del:abc:author:99:`; // length=99 won't match
    const doc = `pre${orphan}post`;
    const ranges = findOrphanRanges(doc);
    expect(ranges).toHaveLength(1);
    expect(doc.slice(ranges[0].from, ranges[0].to)).toBe(orphan);
  });

  it('finds an orphan TC_START whose closing TC_END is missing', () => {
    // Build a header that says length=2 but the next 2 chars are
    // followed by NO closing sentinel.
    const doc = `pre${TC_START}ins:x:a:2:hipost`;
    const ranges = findOrphanRanges(doc);
    expect(ranges).toHaveLength(1);
  });

  it('preserves valid markers AROUND an orphan', () => {
    const valid = serialize({ type: 'ins', id: 'v', author: 'a', text: 'OK' });
    const orphan = `${TC_START}del:bad:a:99:`;
    const doc = `${valid}prefix${orphan}suffix${valid}`;
    const ranges = findOrphanRanges(doc);
    expect(ranges).toHaveLength(1);
    expect(doc.slice(ranges[0].from, ranges[0].to)).toBe(orphan);
  });

  it('limits header scan so a stray sentinel without a header is stripped alone', () => {
    const doc = `abc${TC_START}xyz`;
    const ranges = findOrphanRanges(doc);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].to - ranges[0].from).toBe(1);
  });

  it('treats a stray closing TC_END as benign (only TC_STARTs are scanned)', () => {
    const doc = `abc${TC_END}def`;
    expect(findOrphanRanges(doc)).toEqual([]);
  });
});
