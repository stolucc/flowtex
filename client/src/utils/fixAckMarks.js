// @ts-check
//
// Editor decorations + gutter marker for the "fix was applied here"
// acknowledgement UX. When a quick-fix dispatches an edit (e.g.
// adding \usepackage{soul} to the preamble), the orchestrator also
// calls editorRef.current.markFixApplied(from, to). That:
//   1. Adds a line-background "glow" highlight over the inserted text.
//   2. Renders a ✓ marker in the gutter next to the line.
//
// Clicking the ✓ -- or the line itself -- clears the mark. The set is
// also auto-cleared via markFixCleared() which the app calls when a
// fresh compile log lands (i.e. the user has compiled past the fix).

import { StateEffect, StateField, RangeSet, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, GutterMarker, gutter } from '@codemirror/view';

/**
 * StateEffect: add a new acknowledgement range.
 * @type {import('@codemirror/state').StateEffectType<{ from: number, to: number }>}
 */
export const addFixAckEffect = StateEffect.define();

/**
 * StateEffect: drop one acknowledgement range (the one containing pos).
 * @type {import('@codemirror/state').StateEffectType<{ pos: number }>}
 */
export const clearFixAckAtEffect = StateEffect.define();

/**
 * StateEffect: drop ALL acknowledgement ranges (called on fresh compile).
 * @type {import('@codemirror/state').StateEffectType<null>}
 */
export const clearAllFixAcksEffect = StateEffect.define();

/** Subtle line-background glow over the inserted range. */
const fixGlowDecoration = Decoration.mark({ class: 'cm-fix-glow' });

/**
 * Gutter marker class. Renders a small ✓ that the user can click to
 * dismiss the corresponding glow.
 */
class FixAckGutterMarker extends GutterMarker {
  /** @param {{ from: number, to: number }} ackRange */
  constructor(ackRange) {
    super();
    // Stored under `_ackRange` because GutterMarker's parent class
    // has an inherited `range(from, to?)` method we mustn't shadow.
    this._ackRange = ackRange;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-fix-ack-marker';
    el.textContent = '✓';
    el.title = 'Acknowledge this fix';
    el.dataset.fixFrom = String(this._ackRange.from);
    el.dataset.fixTo = String(this._ackRange.to);
    return el;
  }
}

/**
 * StateField holding the set of acknowledgement ranges. The field
 * value is a RangeSet of bare ranges; we derive both the glow
 * decoration and the gutter markers from it on read.
 *
 * @typedef {{ from: number, to: number }} AckRange
 */

/** @type {import('@codemirror/state').StateField<RangeSet<any>>} */
export const fixAckField = StateField.define({
  create() {
    return /** @type {any} */ (RangeSet.empty);
  },
  update(value, tr) {
    // Map existing ranges across document changes.
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFixAckEffect)) {
        const { from, to } = e.value;
        const builder = new RangeSetBuilder();
        // Re-emit existing ranges first.
        const cursor = next.iter();
        while (cursor.value) {
          builder.add(cursor.from, cursor.to, /** @type {any} */ (cursor.value));
          cursor.next();
        }
        // Append the new one.
        builder.add(from, to, /** @type {any} */ ({}));
        next = builder.finish();
      } else if (e.is(clearFixAckAtEffect)) {
        const { pos } = e.value;
        const builder = new RangeSetBuilder();
        const cursor = next.iter();
        while (cursor.value) {
          if (pos < cursor.from || pos > cursor.to) {
            builder.add(cursor.from, cursor.to, /** @type {any} */ (cursor.value));
          }
          cursor.next();
        }
        next = builder.finish();
      } else if (e.is(clearAllFixAcksEffect)) {
        next = /** @type {any} */ (RangeSet.empty);
      }
    }
    return next;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (set) => {
      // Render a glow mark for every range in the set.
      const builder = new RangeSetBuilder();
      const cursor = set.iter();
      while (cursor.value) {
        builder.add(cursor.from, cursor.to, fixGlowDecoration);
        cursor.next();
      }
      return /** @type {any} */ (builder.finish());
    }),
});

/**
 * Gutter extension that renders a ✓ on every line containing a fix-ack
 * range. One marker per ack range (in practice, ranges align with one
 * inserted line, so this reads naturally).
 */
export const fixAckGutterExtension = gutter({
  class: 'cm-fix-ack-gutter',
  markers: (view) => {
    const set = view.state.field(fixAckField, false);
    if (!set) return RangeSet.empty;
    const builder = new RangeSetBuilder();
    const cursor = set.iter();
    while (cursor.value) {
      // Anchor marker at the START of the range's line so it shows in
      // the gutter even if the range covers multiple lines.
      const line = view.state.doc.lineAt(cursor.from);
      builder.add(line.from, line.from, /** @type {any} */ (new FixAckGutterMarker({ from: cursor.from, to: cursor.to })));
      cursor.next();
    }
    return builder.finish();
  },
  domEventHandlers: {
    // Click the ✓ -> clear that one ack.
    click(view, _line, event) {
      const target = /** @type {HTMLElement | null} */ (/** @type {any} */ (event).target);
      if (!target?.classList?.contains('cm-fix-ack-marker')) return false;
      const from = Number(target.dataset.fixFrom);
      if (!Number.isFinite(from)) return false;
      view.dispatch({ effects: clearFixAckAtEffect.of({ pos: from }) });
      return true;
    },
  },
});
