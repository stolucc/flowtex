// Regression: a WS-connect race (confirmed live in CI — e2e/smoke.spec.js,
// e2e/reconnect.spec.js) let a user type into the editor BEFORE yCollab
// attached. Those keystrokes existed only in the plain CodeMirror doc,
// untracked by any CRDT. When yCollab finally attached (hydration completing
// late), Editor.jsx's reconcile UNCONDITIONALLY overwrote the doc with the
// canonical Y.Text — silently destroying the typed text. Confirmed via live
// diagnostics: the marker was visible in the DOM immediately after typing,
// gone 4 seconds later, never reached the DB.
//
// Fix (Editor.jsx's extraExtensions effect): compare the doc's CURRENT text
// to what it was MOUNTED with (mountedDocTextRef). If unchanged, the old
// behaviour is safe (nothing local to lose) — take the canonical Y.Text as
// before, which is what the sibling yjsLargeDocReconcile test file covers.
// If the doc has diverged, the user typed something locally: push the doc's
// current text INTO the Y.Doc (yjsSyncLocalText) instead, so it becomes the
// new canonical state and propagates once actually connected — never
// overwrite the doc itself in that branch.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';

function mountWith(text) {
  const dom = document.createElement('div');
  document.body.appendChild(dom);
  const compartment = new Compartment();
  const view = new EditorView({
    state: EditorState.create({ doc: text, extensions: [compartment.of([])] }),
    parent: dom,
  });
  return { view, compartment };
}

/** The exact branch Editor.jsx's reconcile effect runs. */
function reconcile({ view, compartment, ytext, mountedDocText, syncLocalText }) {
  const exts = [yCollab(ytext, null)];
  const spec = { effects: compartment.reconfigure(exts) };
  const currentDoc = view.state.doc.toString();
  const ytextStr = ytext.toString();
  if (ytextStr !== currentDoc) {
    if (currentDoc === mountedDocText) {
      spec.changes = { from: 0, to: view.state.doc.length, insert: ytextStr };
    } else {
      syncLocalText(currentDoc);
    }
  }
  view.dispatch(spec);
}

describe('reconcile preserves local edits typed before yCollab attached', () => {
  it('local edit survives: doc is UNTOUCHED, and the edit is pushed into ytext', () => {
    const mountedDocText = 'Hello FlowTex.';
    const { view, compartment } = mountWith(mountedDocText);

    // User types before yCollab attaches — doc now diverges from mount text.
    view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: '\nMARKER-123\n' } });
    const typedDoc = view.state.doc.toString();
    expect(typedDoc).not.toBe(mountedDocText);

    // Canonical Y.Text arrives LATE, and does NOT have the typed marker
    // (e.g. it's still the old pre-typing state, or another peer's state).
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    ytext.insert(0, mountedDocText);

    let syncedWith = null;
    reconcile({
      view, compartment, ytext, mountedDocText,
      syncLocalText: (text) => { syncedWith = text; ytext.delete(0, ytext.length); ytext.insert(0, text); },
    });

    // The doc keeps exactly what the user typed — NOT overwritten.
    expect(view.state.doc.toString()).toBe(typedDoc);
    // The local edit was pushed into the Y.Doc (preserved AND propagated).
    expect(syncedWith).toBe(typedDoc);
    expect(ytext.toString()).toBe(typedDoc);

    view.destroy();
  });

  it('no local edit: doc unchanged since mount -> canonical Y.Text wins as before (no regression)', () => {
    const mountedDocText = 'Hello FlowTex.';
    const { view, compartment } = mountWith(mountedDocText);
    // No typing happened.

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    ytext.insert(0, 'Hello FlowTex.\nEXTRA from another collaborator.');

    let syncCalled = false;
    reconcile({
      view, compartment, ytext, mountedDocText,
      syncLocalText: () => { syncCalled = true; },
    });

    // Canonical (larger/newer) content wins — the original large-doc-blank
    // fix's behaviour is preserved for the "nothing local to lose" case.
    expect(view.state.doc.toString()).toBe(ytext.toString());
    expect(syncCalled).toBe(false);

    view.destroy();
  });

  it('doc already matches canonical -> no-op either way', () => {
    const mountedDocText = 'same content';
    const { view, compartment } = mountWith(mountedDocText);
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    ytext.insert(0, 'same content');

    let syncCalled = false;
    reconcile({
      view, compartment, ytext, mountedDocText,
      syncLocalText: () => { syncCalled = true; },
    });

    expect(view.state.doc.toString()).toBe('same content');
    expect(syncCalled).toBe(false);
    view.destroy();
  });
});
