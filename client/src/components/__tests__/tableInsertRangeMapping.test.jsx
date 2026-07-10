import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// Regression for the table-builder insert-position bug: the insert range
// is captured when the builder opens and MAPPED through subsequent edits.
// Adding a required package via the ⚠ button edits the preamble and moves
// the caret there, so reading the live caret would drop the table in the
// preamble. Mapping keeps it pinned to the original body position.

describe('table insert range survives a preamble package-add', () => {
  it('maps the captured body position forward; the table lands in the body', () => {
    const doc = '\\documentclass{article}\n\\begin{document}\nHERE\n\\end{document}';
    const cursor = doc.indexOf('HERE');
    let range = { from: cursor, to: cursor }; // captured at builder-open

    const dom = document.createElement('div');
    document.body.appendChild(dom);
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          // Same mapping Editor.jsx does on every doc change while the
          // builder is open.
          EditorView.updateListener.of((u) => {
            if (u.docChanged && range) {
              range = {
                from: u.changes.mapPos(range.from, -1),
                to: u.changes.mapPos(range.to, 1),
              };
            }
          }),
        ],
      }),
      parent: dom,
    });

    // Simulate onAddPackage: insert \usepackage in the preamble AND move
    // the caret there (as goToPosition does).
    const pkgAt = doc.indexOf('\\begin{document}');
    const pkg = '\\usepackage{booktabs}\n';
    view.dispatch({ changes: { from: pkgAt, to: pkgAt, insert: pkg }, selection: { anchor: pkgAt } });

    // Live caret is now in the preamble (this is what caused the bug)...
    expect(view.state.selection.main.from).toBeLessThan(range.from);
    // ...but the mapped range still points at the body text.
    expect(range.from).toBe(cursor + pkg.length);
    expect(view.state.doc.sliceString(range.from, range.from + 4)).toBe('HERE');

    // Inserting the table at the mapped range lands in the body, not the
    // preamble, and leaves the package intact.
    view.dispatch({ changes: { from: range.from, to: range.to, insert: '[TABLE]' } });
    expect(view.state.doc.sliceString(range.from, range.from + 7)).toBe('[TABLE]');
    const out = view.state.doc.toString();
    expect(out).toContain('\\usepackage{booktabs}');
    expect(out.indexOf('\\usepackage{booktabs}')).toBeLessThan(out.indexOf('[TABLE]'));
    expect(out).toContain('\\begin{document}');
    view.destroy();
  });
});
