// Regression: large Y.js docs opened blank. y-codemirror's sync plugin only
// observes FUTURE Y.Text changes; it does not backfill an already-populated
// Y.Text into an empty editor. For big files the yjs-state applied before the
// yCollab extension was spliced in, so nothing observed the fill → blank view.
//
// Fix (Editor.jsx extraExtensions effect): when splicing yCollab in, seed the
// doc from the current Y.Text IN THE SAME transaction. The plugin is built
// after the change, so it sees doc === ytext (no backfill) and its update()
// never runs for that tx (nothing pushed back → no doubling).

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';

function mountEmpty() {
  const dom = document.createElement('div');
  document.body.appendChild(dom);
  const compartment = new Compartment();
  const view = new EditorView({
    state: EditorState.create({ doc: '', extensions: [compartment.of([])] }),
    parent: dom,
  });
  return { view, compartment };
}

describe('yCollab splice reconcile (large-doc blank fix)', () => {
  for (const n of [10, 100000, 602496]) {
    it(`seeds the view from an ALREADY-FULL Y.Text (${n} chars) without doubling`, () => {
      // Y.Doc already populated BEFORE the editor binds (the lost-race case).
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('content');
      ytext.insert(0, 'a'.repeat(n));

      const { view, compartment } = mountEmpty();
      expect(view.state.doc.length).toBe(0); // mounted empty

      // Splice yCollab in AND seed the doc to match ytext in one transaction.
      view.dispatch({
        effects: compartment.reconfigure([yCollab(ytext, null)]),
        changes: { from: 0, to: view.state.doc.length, insert: ytext.toString() },
      });

      // View now shows the full doc...
      expect(view.state.doc.length).toBe(n);
      // ...and the Y.Text was NOT doubled (the plugin didn't push the seed back).
      expect(ytext.length).toBe(n);

      // And forward sync still works: a later remote delta reaches the view.
      const peer = new Y.Doc();
      Y.applyUpdateV2(peer, Y.encodeStateAsUpdateV2(ydoc));
      peer.getText('content').insert(n, 'Z');
      Y.applyUpdateV2(ydoc, Y.encodeStateAsUpdateV2(peer));
      expect(view.state.doc.length).toBe(n + 1);
      expect(view.state.doc.sliceString(n)).toBe('Z');

      view.destroy();
    });
  }

  it('the pre-fix path (mount empty, no seed) leaves the view blank — documents the bug', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    ytext.insert(0, 'already here');
    const { view, compartment } = mountEmpty();
    // Splice WITHOUT seeding the doc (old behaviour).
    view.dispatch({ effects: compartment.reconfigure([yCollab(ytext, null)]) });
    // yCollab does not backfill → view stays empty even though ytext is full.
    expect(view.state.doc.length).toBe(0);
    expect(ytext.length).toBe(12);
    view.destroy();
  });
});
