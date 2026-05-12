// Track-changes V1 — sidecar data layer.
//
// See TRACK-CHANGES-RULES.md for the full spec. This file owns:
//   - TcMarkValue (RangeValue with the side semantics from §1.3)
//   - tcMarksField (StateField holding the RangeSet)
//   - effects: addTcMarks, removeTcMark, setTcMarks
//   - skip annotation (used by hydration, accept/reject, remote OT)
//   - serialize / deserialize (§1.6 persistence shape)
//   - hydration validation (§6.5)
//   - listMarks helper for read-only enumeration
//
// This file does NOT own decorations or the input filter — those land in
// tcMarksDecorations.js and tcMarksInput.js once the data layer is solid.
//
// Invariants enforced here (§1.4):
//   - ins entries are non-empty after mapping (zero-length filtered)
//   - del entries are zero-width points
//   - all positions are CodeMirror doc offsets (UTF-16 code units)
//
// The doc text NEVER carries TC information — see §1.1.

import { Annotation, RangeSet, RangeValue, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view';
import { invertedEffects } from '@codemirror/commands';

// ─── Effects ────────────────────────────────────────────────────────────

/** Add one or more entries. Effect value: array of validated entry specs. */
export const addTcMarks = StateEffect.define();

/** Remove an entry by id. Effect value: id string. */
export const removeTcMark = StateEffect.define();

/**
 * Replace the entire RangeSet (used for hydration only — see §6.5).
 * Effect value: array of entry specs (will be validated before installation).
 */
export const setTcMarks = StateEffect.define();

// ─── Annotations ────────────────────────────────────────────────────────

/**
 * Marks a transaction as "don't run the input filter on this." Used for:
 *   - Hydration (setTcMarks at file load)
 *   - Accept/reject doc surgery
 *   - Remote OT applies
 * See §0 vocabulary in the spec.
 */
export const tcMarkSkipAnnotation = Annotation.define();

// ─── RangeValue with the side semantics from §1.3 ───────────────────────

/**
 * The RangeValue stored in the RangeSet. Side configuration is the
 * correctness contract (§1.3) — do NOT change without updating the
 * corresponding tests in tcMarks.test.js.
 *
 * Both ins and del are RANGES over real chars in the doc (M2 model,
 * §1.1). They share side semantics:
 *   startSide=1, endSide=-1
 *     - Insertion at start: new chars go LEFT of range (boundary-insert
 *       becomes a new adjacent entry, rule §3.2.b).
 *     - Insertion at end: new chars stay RIGHT of range.
 *     - Insertion strictly inside: range expands (default mapping).
 */
class TcMarkValue extends RangeValue {
  constructor(spec) {
    super();
    this.spec = spec;
    this.startSide = 1;
    this.endSide = -1;
  }
  eq(other) {
    return this.spec.id === other.spec.id;
  }
}

/** Wrap a spec in the RangeValue. Exposed for tests. */
export function tcMark(spec) {
  return new TcMarkValue(spec);
}

// ─── ID generation ──────────────────────────────────────────────────────

/** 8-hex-char id. Unique enough for per-file scope; not cryptographic. */
export function shortId() {
  return Math.random().toString(16).slice(2, 10).padStart(8, '0');
}

// ─── Hydration validation (§6.5) ────────────────────────────────────────

/**
 * Validate one persisted entry against the loaded doc. Returns true if the
 * entry is well-formed and within doc bounds; false otherwise. Caller is
 * responsible for the dedupe-by-id pass.
 */
export function isValidEntry(e, docLen) {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (e.type !== 'ins' && e.type !== 'del') return false;
  if (typeof e.from !== 'number' || !Number.isFinite(e.from) || e.from < 0) return false;
  if (typeof e.to !== 'number' || !Number.isFinite(e.to)) return false;
  // M2: both ins and del are real ranges over doc chars.
  if (!(e.from < e.to) || e.to > docLen) return false;
  return true;
}

/**
 * Run the hydration pipeline on a list of persisted entries:
 *   1. Drop entries that fail isValidEntry (drops unknown type, OOB, etc.)
 *   2. Dedupe by id, keeping the first occurrence (insertion order wins).
 *
 * Returns the validated specs ready to be wrapped in TcMarkValue.
 */
export function validateHydration(entries, docLen) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (!isValidEntry(e, docLen)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// ─── StateField ─────────────────────────────────────────────────────────

/**
 * Returns a sorted list of {entry, range} pairs ready to be turned into
 * RangeSet additions. Sorted by `from` ascending then `to` ascending so
 * that at the same position, a del (to===from) precedes an ins (to>from)
 * — matches the §3.5 / §9.9 render-order invariant.
 */
function specsToSortedRanges(specs) {
  const sorted = specs.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  return sorted.map((s) => tcMark(s).range(s.from, s.to));
}

export const tcMarksField = StateField.define({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    // 1. Map existing ranges through any doc changes. CM6 walks every
    //    range and shifts it through tr.changes per the side config.
    let next = value.map(tr.changes);

    // 2. Filter ins ranges that collapsed to zero length under mapping
    //    (e.g. user backspaced their entire own ins → range is now
    //    [P, P), no longer a valid ins). §1.4 + §9.2.
    if (tr.docChanged) {
      next = next.update({
        filter: (from, to, val) => !(val.spec.type === 'ins' && from === to),
      });
    }

    // 3. Apply effects in transaction order.
    for (const e of tr.effects) {
      if (e.is(setTcMarks)) {
        // Hydration / replacement. Validate against the new doc length.
        const validated = validateHydration(e.value, tr.newDoc.length);
        const ranges = specsToSortedRanges(validated);
        next = RangeSet.of(ranges, /* sort */ true);
      } else if (e.is(addTcMarks)) {
        const ranges = specsToSortedRanges(e.value);
        next = next.update({ add: ranges, sort: true });
      } else if (e.is(removeTcMark)) {
        const targetId = e.value;
        next = next.update({ filter: (_from, _to, val) => val.spec.id !== targetId });
      }
    }

    return next;
  },
});

// ─── Read helpers ───────────────────────────────────────────────────────

/**
 * Return all entries in document order. Each item:
 *   { id, type, from, to, authorId, authorName, timestamp, text? }
 * For ins, `to > from`. For del, `to === from` and `text` is set.
 */
export function listMarks(state) {
  const out = [];
  const set = state.field(tcMarksField, /* require */ false) || RangeSet.empty;
  set.between(0, state.doc.length, (from, to, value) => {
    // Spread spec FIRST so the iteration's `from`/`to` (the live, mapped
    // positions) overwrite the spec's stale stored positions. The spec's
    // `from`/`to` are only valid at creation time; after any
    // RangeSet.map they're out of date.
    out.push({ ...value.spec, from, to });
  });
  return out;
}

// ─── Serialization (§1.6 persistence shape) ─────────────────────────────

/**
 * Serialize all entries to a JSON-friendly array suitable for the
 * `tcMarks` field of a save payload. Position values are CM doc offsets.
 *
 * Round-trip property: `deserializeMarks(serializeMarks(state))`
 * passed to `setTcMarks` reproduces an equivalent RangeSet (modulo
 * out-of-bounds entries which would be dropped by hydration).
 */
export function serializeMarks(state) {
  return listMarks(state).map((e) => ({
    id: e.id,
    type: e.type,
    from: e.from,
    to: e.to,
    authorId: e.authorId,
    authorName: e.authorName,
    timestamp: e.timestamp,
  }));
}

/**
 * Inverse of serializeMarks. Returns the array of specs to pass to
 * `setTcMarks.of(...)`. Validation happens inside the StateField on
 * setTcMarks application — this is just shape massaging.
 */
export function deserializeMarks(serialized) {
  if (!Array.isArray(serialized)) return [];
  return serialized.map((m) => ({ ...m }));
}

// ─── Decorations (§3 visual rendering) ──────────────────────────────────

/**
 * Compute the decoration set from the marks field. Re-runs whenever the
 * marks field changes (adds, removes, or auto-mapped through doc edits).
 *
 * M2 model (§1.1): both ins and del entries are real ranges over chars
 * in the doc. We render them as Mark decorations with CSS classes; the
 * cursor naturally traverses everything.
 *
 *   ins → `cm-tc-insert` (underline) on the inserted chars in the doc.
 *   del → `cm-tc-delete` (strikethrough) on the still-in-doc chars
 *         awaiting accept (which removes them) or reject (which removes
 *         only the mark).
 *
 * Defensive: skip ranges where `to <= from` or `to > docLen` (shouldn't
 * happen post-mapping; rendering must not crash).
 */
const tcMarksDecorations = EditorView.decorations.compute([tcMarksField], (state) => {
  const set = state.field(tcMarksField, /* require */ false);
  if (!set) return Decoration.none;
  const decos = [];
  const docLen = state.doc.length;
  set.between(0, docLen, (from, to, value) => {
    const spec = value.spec;
    if (to <= from || to > docLen) return;
    const cls = spec.type === 'ins' ? 'cm-tc-insert' : 'cm-tc-delete';
    const verb = spec.type === 'ins' ? 'Inserted' : 'Deleted';
    const authorSuffix = spec.authorName ? ` by ${spec.authorName}` : '';
    decos.push(
      Decoration.mark({
        class: cls,
        attributes: {
          'data-tc-id': spec.id,
          'data-tc-type': spec.type,
          // Author info is preserved as a data attribute and shown on
          // hover via `title`. Coloring is type-only (blue ins, red del)
          // — per-author hues were too noisy for review.
          'data-tc-author': spec.authorName || '',
          'data-tc-author-id': spec.authorId || '',
          title: `${verb}${authorSuffix}`,
          'aria-label': `${verb}${authorSuffix}`,
        },
      }).range(from, to),
    );
  });
  return Decoration.set(decos, /* sort */ true);
});

// ─── Undo / Redo (§5) — invertedEffects ────────────────────────────────

/**
 * Tell CM6's history extension how to invert our mark effects so undo
 * works correctly:
 *   addTcMarks([spec, ...])  → removeTcMark for each id
 *   removeTcMark(id)         → addTcMarks([snapshot of the mark before removal])
 *
 * Without this, Ctrl-Z on a backspace (which produces a transaction with
 * no doc change but an addTcMarks effect for the new del entry) would
 * not register on the undo stack, and history would skip back to an
 * earlier transaction whose changes would now corrupt the marked-deleted
 * text. See spec §5.
 */
const tcMarksInvertedEffects = invertedEffects.of((tr) => {
  const out = [];
  const handledIds = new Set();
  let hasSetTcMarks = false;
  for (const e of tr.effects) {
    if (e.is(addTcMarks)) {
      for (const spec of e.value) {
        out.push(removeTcMark.of(spec.id));
        handledIds.add(spec.id);
      }
    } else if (e.is(removeTcMark)) {
      // Look up the mark in the pre-tr sidecar and re-add on undo.
      const oldSet = tr.startState.field(tcMarksField, /* require */ false);
      if (!oldSet) continue;
      oldSet.between(0, tr.startState.doc.length, (from, to, val) => {
        if (val.spec.id === e.value) {
          out.push(addTcMarks.of([{ ...val.spec, from, to }]));
          handledIds.add(val.spec.id);
        }
      });
    } else if (e.is(setTcMarks)) {
      // Hydration-only; never gets undone. Don't synthesize inverses for
      // marks the replacement dropped.
      hasSetTcMarks = true;
    }
  }

  // Additional case: a doc change can silently eat a mark via RangeSet
  // mapping with no explicit removeTcMark effect. Example: user A inserts
  // with TC on (ins mark), user B (TC off) deletes that text. The delete
  // collapses the ins range to zero width and the field's filter drops it
  // — no effect, so the loop above didn't produce an inverse, and undoing
  // B's delete would restore the text without A's ins mark, surfacing
  // pending text as plain. Diff the pre/post sidecars and re-add anything
  // that disappeared without an explicit removal.
  if (tr.docChanged && !hasSetTcMarks) {
    const oldSet = tr.startState.field(tcMarksField, /* require */ false);
    const newSet = tr.state.field(tcMarksField, /* require */ false);
    if (oldSet) {
      const stillPresent = new Set();
      if (newSet) {
        newSet.between(0, tr.state.doc.length, (_from, _to, val) => {
          stillPresent.add(val.spec.id);
        });
      }
      oldSet.between(0, tr.startState.doc.length, (from, to, val) => {
        if (!stillPresent.has(val.spec.id) && !handledIds.has(val.spec.id)) {
          out.push(addTcMarks.of([{ ...val.spec, from, to }]));
        }
      });
    }
  }
  return out;
});

// ─── Gutter markers (per-line ins/del bars) ─────────────────────────────

class TcInsGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-tc-gutter-bar cm-tc-gutter-bar-ins';
    return el;
  }
}
class TcDelGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-tc-gutter-bar cm-tc-gutter-bar-del';
    return el;
  }
}
class TcBothGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-tc-gutter-bar cm-tc-gutter-bar-both';
    return el;
  }
}
const insMarker = new TcInsGutterMarker();
const delMarker = new TcDelGutterMarker();
const bothMarker = new TcBothGutterMarker();

const tcGutterMarkersField = StateField.define({
  create(state) {
    return computeGutterMarkers(state);
  },
  update(value, tr) {
    if (!tr.docChanged && tr.effects.length === 0) return value;
    return computeGutterMarkers(tr.state);
  },
});

function computeGutterMarkers(state) {
  const set = state.field(tcMarksField, /* require */ false);
  if (!set) return RangeSet.empty;
  const lineKinds = new Map(); // lineStart -> 'ins' | 'del' | 'both'
  set.between(0, state.doc.length, (from, to, value) => {
    if (to <= from) return;
    const startLine = state.doc.lineAt(from).number;
    const endLine = state.doc.lineAt(Math.min(to, state.doc.length)).number;
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n);
      const prev = lineKinds.get(line.from);
      const cur = value.spec.type;
      if (!prev) lineKinds.set(line.from, cur);
      else if (prev !== cur) lineKinds.set(line.from, 'both');
    }
  });
  if (lineKinds.size === 0) return RangeSet.empty;
  const ranges = [];
  for (const [lineStart, kind] of [...lineKinds.entries()].sort((a, b) => a[0] - b[0])) {
    const m = kind === 'ins' ? insMarker : kind === 'del' ? delMarker : bothMarker;
    ranges.push(m.range(lineStart));
  }
  return RangeSet.of(ranges);
}

const tcGutter = gutter({
  class: 'cm-tc-gutter',
  markers: (view) => view.state.field(tcGutterMarkersField),
});

/**
 * The editor-wide TC machinery that should ALWAYS be active even when
 * the user has hidden the inline decorations: the StateField (so marks
 * stay in sync), invertedEffects (so undo works), and the gutter line
 * markers (so the user can see *where* changes are even with the inline
 * decorations off).
 */
export function tcMarksExtensions() {
  return [
    tcMarksField,
    tcMarksInvertedEffects,
    tcGutterMarkersField,
    tcGutter,
  ];
}

/**
 * The inline decorations (underline / strikethrough). Wrap this in a
 * Compartment in Editor.jsx so the user can toggle "show changes
 * inline" without remounting the editor.
 */
export const tcMarksInlineDecorations = tcMarksDecorations;
