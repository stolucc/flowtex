import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { serialize as serializeMarker } from '@shared/tcMarkers.js';
import { buildMarkerDecorations } from '../tcMarkerDecorations.js';

const ins = (id, text, author = 'u1') => serializeMarker({ type: 'ins', id, author, text });
const del = (id, text, author = 'u1') => serializeMarker({ type: 'del', id, author, text });

function decoStateFor(content) {
  return EditorState.create({ doc: content });
}

function decoListFor(content) {
  const set = buildMarkerDecorations(decoStateFor(content));
  const out = [];
  set.between(0, content.length, (from, to, deco) => {
    out.push({ from, to, spec: deco.spec });
  });
  return out;
}

describe('buildMarkerDecorations', () => {
  it('returns empty set for marker-free content', () => {
    const set = buildMarkerDecorations(decoStateFor('plain content'));
    let count = 0;
    set.between(0, 13, () => { count++; });
    expect(count).toBe(0);
  });

  it('hides metadata + end sentinel and marks the inner text for an insertion', () => {
    const m = ins('a', 'hello');
    const decos = decoListFor(m);
    // 3 decorations: leading hide, inner mark, trailing hide.
    expect(decos).toHaveLength(3);
    // The inner mark is the only non-replace one — its class is cm-tc-insert.
    const innerMark = decos.find((d) => d.spec.class === 'cm-tc-insert');
    expect(innerMark).toBeTruthy();
    // The leading hide ends where the inner mark begins; the trailing
    // hide begins where the inner mark ends.
    const leadHide = decos.find((d) => d.from === 0);
    expect(leadHide.to).toBe(innerMark.from);
    const tailHide = decos.find((d) => d.to === m.length);
    expect(tailHide.from).toBe(innerMark.to);
  });

  it('uses cm-tc-delete for a deletion marker', () => {
    const decos = decoListFor(del('d1', 'gone'));
    const innerMark = decos.find((d) => d.spec.class);
    expect(innerMark.spec.class).toBe('cm-tc-delete');
  });

  it('sets data-tc-id, data-tc-type, data-tc-author and title on the inner mark', () => {
    const decos = decoListFor(ins('abc', 'world', 'Alice'));
    const innerMark = decos.find((d) => d.spec.class);
    expect(innerMark.spec.attributes).toMatchObject({
      'data-tc-id': 'abc',
      'data-tc-type': 'ins',
      'data-tc-author': 'Alice',
    });
    expect(innerMark.spec.attributes.title).toMatch(/Inserted by Alice/);
  });

  it('handles two adjacent markers (replace operation: insert + delete)', () => {
    const a = ins('a', 'NEW');
    const b = del('b', 'OLD');
    const content = `pre ${a}${b} post`;
    const decos = decoListFor(content);
    // Two markers → 6 decorations (3 each).
    expect(decos).toHaveLength(6);
    const insMark = decos.find((d) => d.spec.attributes?.['data-tc-id'] === 'a');
    const delMark = decos.find((d) => d.spec.attributes?.['data-tc-id'] === 'b');
    expect(insMark.spec.class).toBe('cm-tc-insert');
    expect(delMark.spec.class).toBe('cm-tc-delete');
  });

  it('emits no inner mark for an empty-text marker but still hides the sentinels', () => {
    const m = ins('a', '');
    const decos = decoListFor(m);
    // No inner mark (empty text → nothing to style); just 2 hides.
    const innerMarks = decos.filter((d) => d.spec.class);
    expect(innerMarks).toHaveLength(0);
    // Hides cover the entire marker.
    const total = decos.reduce((sum, d) => sum + (d.to - d.from), 0);
    expect(total).toBe(m.length);
  });

  it('does not extend across an unrelated trailing sentinel', () => {
    // A bare  in the middle of the doc shouldn't affect the
    // earlier marker's decorations — parseAll just skips the lone
    // sentinel.
    const m = ins('a', 'X');
    const content = `${m} STRAY  trailing`;
    const decos = decoListFor(content);
    // Only the real marker contributes decorations.
    expect(decos.filter((d) => d.spec.class)).toHaveLength(1);
  });
});
