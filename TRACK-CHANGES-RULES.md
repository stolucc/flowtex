# Track Changes — Behavior Rules (draft v2)

> Living spec. Every rule is a future test. Edit freely; we test-drive from here.
> Written after ripping out two failed implementations. Rules that bit us are
> marked **★** — these MUST have explicit failing tests before implementation.

## 0. Vocabulary

- **TC entry** (or just *entry*): a structured record of a pending edit. One of: `ins`, `del`. Stored in the **sidecar**.
- **Sidecar**: CM6 `StateField` holding a `RangeSet<TcMarkValue>`. Lives outside the doc text.
- **Doc text**: the editable live document — the **current/final text** with pending insertions present and pending deletions absent. This is what CM6 owns. (See §1.1 for the formal invariant; this is the most important point of the spec.)
- **Decoration**: the visual rendering layer. `Decoration.mark` for ins ranges, `Decoration.widget` for del points. Distinct from "TC entry" — entries are the data, decorations are how we draw them.
- **Pending**: an entry that hasn't been accepted or rejected yet. V1: every entry is pending until removed.
- **Self-retraction**: deleting text covered by your **own** pending ins → just remove from doc; do NOT record a del. (V1 single-author makes this trivial; V2 requires authorId comparison.)
- **Skip annotation**: a CM6 annotation marking a transaction as "don't run input filter on this." Used for hydration, accept/reject doc surgery, and remote OT.
- **Position**: a CodeMirror document offset (UTF-16 code unit, NOT UTF-8 byte). Same convention CM6 uses everywhere.

## 1. Data Model

### 1.1 The single most important invariant

**The CM6 doc contains BOTH pending insertions and pending deletions as real characters.** Pending deletions are NOT removed from the doc — they stay in place and are visually marked with a strikethrough decoration. This is the same model MS Word uses for revision tracking: deleted text remains in the document with strikethrough until accepted.

Consequences:

- The cursor naturally traverses pending deletions (right arrow steps across each strikethrough char).
- Selection, copy, search all see pending deletions as part of the doc — same as Word.
- "Doc length" includes pending deletions.
- Accept ins → drop the entry. Doc unchanged. (Text was already there.)
- Reject ins → delete the doc range AND drop the entry.
- Accept del → DELETE the doc range AND drop the entry.
- Reject del → drop the entry. Doc unchanged. (Text stays — it never went away.)
- The compile pipeline (server) is responsible for stripping pending-del ranges before sending to LaTeX. (Comparable to how Word renders "Final" view by hiding strikethroughs.)

### 1.2 Entry shape

Both ins and del are RANGES over chars that exist in the doc. The doc text itself contains every char (insertions and pending deletions alike); the entry says "treat this range as inserted/deleted for review."

```js
// ins: covers chars in the doc, marked as a pending insertion
{ id, type: 'ins', from, to, authorId, authorName, timestamp }

// del: covers chars in the doc, marked as a pending deletion
{ id, type: 'del', from, to, authorId, authorName, timestamp }
```

- `id`: stable string (8 hex chars, generated on creation). Unique within a file. Survives accept/reject by id.
- `authorId`: stable user id. Used for self-retraction comparison and any future per-author logic. Never mutated.
- `authorName`: display-name snapshot at creation. Shown in tooltips. Never mutated. Display names can change, but historical attribution should not.
- `timestamp`: ISO-8601 string at creation. Never mutated.
- The doc has NO inline marker bytes. Position drift on edits is handled by `RangeSet.map(tr.changes)` — built into CM6.

### 1.3 RangeValue side semantics — formal invariant ★

Side configuration is part of the correctness contract. Both ins and del are real ranges over doc chars — same side semantics for both. Insertions at either boundary do NOT extend the range (boundary-insert becomes a new adjacent mark per §3.2.b):

```js
class TcMarkValue extends RangeValue {
  constructor(spec) {
    super();
    this.spec = spec;
    // startSide=1: insertion AT the start position pushes new chars to
    //   the LEFT of the range (range stays). Boundary-inserts produce a
    //   new adjacent mark (§3.2.b), they do NOT extend this one.
    // endSide=-1: insertion AT the end position keeps new chars to the
    //   RIGHT of the range (range stays).
    // Insertion strictly INSIDE the range expands it (default mapping).
    this.startSide = 1;
    this.endSide = -1;
  }
}
```

Tests for this invariant live in §11; do not change side values without changing the relevant tests.

### 1.4 Core invariants

- All positions are CodeMirror document offsets (UTF-16 code units), not UTF-8 byte offsets.
- Both `ins` and `del` entries are non-empty ranges: `from < to`.
- The doc text covers ALL pending entries: `entry.from < entry.to <= doc.length`. The chars at those positions are real and visible to the user.
- `ins` and `del` entry IDs share one namespace; all IDs are unique within a file.
- **V1: pending entries (of any type) must not overlap each other.** Adjacent ranges are allowed (rule 3.2.b).

### 1.5 What the sidecar does NOT contain (yet)

- Format changes (bold, italic, etc.). V2.
- Comments. Already a separate feature; do not conflate.
- Replacement as a single op. V1 models replacement as `del + ins` at the same position. V2 may add a `replace` entry type for cleaner review UX.

### 1.6 Persistence shape

- Column kept dormant on `files`: `tc_marks JSONB NOT NULL DEFAULT '[]'`.
- Save body: `{ content, tcMarks: [...], baseVersion }` where `baseVersion` is the `updated_at` (or row version) the client last loaded. **V1 ignores `baseVersion` server-side (last-write-wins).** V2 will reject stale saves and surface a conflict.
- Hydration on file load: `view.dispatch({ effects: setTcMarks.of(loaded), annotations: tcMarkSkipAnnotation.of(true) })`. See §6.5 for hydration validation.

---

## 2. Editing Rules — TC OFF

The editor behaves like plain CM6.

| # | Rule |
|---|---|
| 2.1 | Typing creates no entries. |
| 2.2 | Backspace creates no entries. The chars are simply removed. |
| 2.3 | Existing pending entries remain visible and intact. Their positions auto-map through the user's edits. |
| 2.4 | A user CAN type into / delete around / over existing pending entries. Their positions and content shift via `RangeSet.map`. |

**V1 single-author** means there cannot be a foreign-author entry, so 2.4 only applies to your own existing entries. (V2 will define foreign-author behavior here.)

---

## 3. Editing Rules — TC ON

### 3.1 Each user-originated transaction

The input filter inspects every `iterChanges(fromA, toA, fromB, toB, inserted)`. The doc change goes through unchanged. Side effect: emit `addTcMarks` effect on the same transaction with new entries.

Decisions are based on `tr.startState` (the pre-transaction state and old document), NOT on the post-transaction state. Boundary detection compares `fromA`/`toA` against entries in the pre-transaction sidecar.

For each change tuple:

| Pattern | Rule |
|---|---|
| Pure insert (`fromA === toA`, `inserted.length > 0`) | Apply 3.2 sub-rules at `fromB` of length `inserted.length`. |
| Pure delete (`fromA < toA`, `inserted.length === 0`) | Apply 3.3 sub-rules over `[fromA, toA)`. |
| Replacement (`fromA < toA`, `inserted.length > 0`) | Apply 3.3 to `[fromA, toA)`, then 3.2 at `[fromB, fromB + inserted.length)`. Ordering invariant: §3.5. |

Multi-range transactions (multi-cursor, paste-over-multi-selection): `iterChanges` is called once per change. Each call independently decides via 3.2/3.3. All resulting `addTcMarks` effects are merged into a single sidecar transaction.

### 3.2 Insertion sub-rules

For an insertion of length N at position `fromB` (post-change coordinate):

| # | Situation | Rule |
|---|---|---|
| 3.2.a | Insert STRICTLY INSIDE own pending ins range (`r.from < fromA < r.to`) | Range expands via `RangeSet.map` (because `endSide = -1` means the end shifts with the insertion). No new entry. |
| 3.2.b ★ | Insert AT THE END BOUNDARY of own pending ins (`fromA === r.to`) | **Merge**: remove the existing entry and emit a combined entry covering both the old chars and the newly typed ones. Result: continuous typing produces ONE ins entry per editing run instead of one per keystroke. Cursor / undo / save behavior unchanged because the merge happens via `removeTcMark + addTcMarks` effects, both paired by `invertedEffects`. |
| 3.2.b' | Insert AT THE START BOUNDARY of own pending ins (`fromA === r.from`) | Create a NEW ins entry; old range shifts right via `RangeSet.map`. (Typing *before* an existing ins is treated as a separate edit run.) |
| 3.2.d | Insert at the position of a del entry | New ins entry at `fromB`; del entry stays. Visually: `[del-widget][new-ins]`. |
| 3.2.e | Insertion of zero length (impossible — defensive) | No entry created. |

V1 has no rule 3.2.c (foreign-author boundary) — see §7.

### 3.3 Deletion sub-rules over `[fromA, toA)` in the OLD doc

The doc edit is REWRITTEN by the input filter so chars are kept, not removed, when they should be marked-deleted instead.

For each contiguous sub-range of `[fromA, toA)`:

| # | Situation | Rule |
|---|---|---|
| 3.3.a ★ | Sub-range covered by current author's own pending ins | Self-retraction: actually delete those chars from the doc; the ins range auto-shrinks via `RangeSet.map`. No del entry. If the ins range collapses to zero length → drop the entry (§9.2). |
| 3.3.b | Sub-range NOT covered by any own pending ins | Do NOT delete from the doc. Add a del mark covering `[subFrom, subTo)`. The chars stay in the doc with strikethrough rendering until accept (which removes them) or reject (which removes only the mark). |
| 3.3.c ★ | Selection spans BOTH own ins AND original text | Walk the deletion range; for each maximal sub-range of own ins, apply 3.3.a (actually delete); for each maximal gap, apply 3.3.b (mark, don't delete). Result: ins range(s) shrink for the own-ins parts, del marks cover the original parts. |
| 3.3.e | `fromA === toA` (no actual deletion) | No entries. |

V1 has no rule 3.3.d (foreign-author deletion) — see §7.

### 3.4 Cursor rules ★

| # | Situation | Cursor lands |
|---|---|---|
| 3.4.a | After typing N chars at pos P | At P + N. |
| 3.4.b | After backspace into own ins (self-retraction at `r.to`) | At pos P − 1. No widget visible. |
| 3.4.c ★ | After backspace of original text | The doc keeps all chars; the deletion is rewritten to a no-op + del mark. Cursor moves to P − 1 (the position just before the marked-deleted char). Visual: `hell` cursor `~o~` (cursor between `l` and the struck-through `o`). The strikethrough sits to the cursor's right. |
| 3.4.d | Right arrow at a position with a strikethrough char to the right | Cursor advances one position into / past the strikethrough — same as plain text. The marked-deleted chars are real doc chars; the cursor traverses them naturally. |
| 3.4.g | Backspace of a typed char that follows a del-marked range | The typed char is part of an own ins range → self-retraction (actually deleted). The del-marked range to its left stays untouched. Cursor moves one position left. |
| 3.4.e | Arrow left/right | Normal CM6 traversal — one doc offset per keypress. Widgets are visual-only; cursor passes through their points without "sticking". |
| 3.4.f | Click on the del widget DOM | Cursor positions at the widget's point (effectively to its right). |

### 3.5 Replacement ordering invariant ★

For a replacement transaction (`fromA < toA`, `insert.length > 0`), the resulting `del` and `ins` share point `fromB`. Visual rendering must always be `[del-widget][ins-text]`, achieved by:

1. Decoration ordering: del widget at point with `side: -1` renders before any ins-mark range starting at the same position.
2. RangeSet ordering tie-break: when both share `from`, sort by `to` ascending → `del` (`to === from`) precedes `ins` (`to > from`).

Test §11.replacement-order verifies this regardless of which order the entries were added.

### 3.6 Input source rules

V1 operates at the transaction/change level via `iterChanges`. It does NOT distinguish input modality. The following all flow through the same rules:

| Source | Rule applied |
|---|---|
| Keystroke | 3.1–3.3 |
| Paste | One `iterChanges` per paste; one ins entry covers the whole pasted region (3.2). |
| Cut | One `iterChanges`; deletion sub-rules apply (3.3). |
| Drag/drop within the editor | One transaction with delete-then-insert; treated as replacement (3.1). |
| Multi-cursor insertion | Multiple `iterChanges` in one transaction; one ins entry per cursor. |
| IME / composition | CM6 emits `iterChanges` after composition commits. One ins entry per committed segment. V1 does NOT special-case in-progress composition (CM6's own composition handling applies). |
| Autocorrect | Same as IME — emits a replacement transaction; rules 3.1–3.3 apply. |

---

## 4. Accept / Reject

### 4.1 Accept

| Entry type | Effect |
|---|---|
| ins | Drop the entry. No doc change. **★ Save MUST trigger.** |
| del | Drop the entry. No doc change (text was already gone). **★ Save MUST trigger.** |

### 4.2 Reject

| Entry type | Effect |
|---|---|
| ins | Delete `[from, to)` AND drop the entry. Skip annotation. Save triggers (doc changed). |
| del | Re-insert `text` at `from` AND drop the entry. Skip annotation. Save triggers. |

### 4.3 Accept-all

- Single transaction.
- `effects: [...all removeTcMark.of(id)]`. Empty `changes` array.
- Skip annotation.
- **★ Save MUST trigger** even though `docChanged === false` (effects-only).

### 4.4 Reject-all

- Single transaction with the same skip annotation.
- Build a non-overlapping `ChangeSet` from all reject ops. Since V1 invariant §1.4 forbids overlapping pending ins ranges, this is well-defined: ins-rejects are deletions of disjoint ranges; del-rejects are insertions at points; the combined change spec is constructable in one CM6 `ChangeSet` without overlap.
- If at runtime an overlap is detected (invariant violation): log and refuse the bulk operation; surface a "review-needed" error. Defensive only — the invariant should make this unreachable.

### 4.5 No partial-accept

V1: the unit of accept/reject is one whole entry. No accepting half an ins range.

---

## 5. Undo / Redo ★

### 5.1 Inverted effects

`addTcMarks(specs)` ↔ `removeTcMark` for those ids. `removeTcMark(id)` ↔ `addTcMarks` with the original spec. We register an `EditorState.invertedEffects` pair on the marks field. CM6 history pairs the doc changes with the right entry effects automatically.

### 5.2 Grouping policy ★

We adopt **Option B** from the review:

> Continuous typing inside own ins expands one entry (rule 3.2.a). Undo shrinks the range per transaction. Each transaction's effect is its own undo unit.

Concretely: typing `abc` as three transactions and pressing Cmd-Z three times leaves the doc empty and the entry removed (transaction 1's create gets inverted on the third undo). Typing `abc` as one paste-like transaction and pressing Cmd-Z once does the same in one step.

### 5.3 Per-action expectations

| Action | Cmd-Z reverses |
|---|---|
| 5.3.a | Typed N chars TC on (created ins entry) → text removed AND ins entry removed. |
| 5.3.b | Backspaced original text TC on (created del entry) → text restored AND del entry removed. |
| 5.3.c | Self-retracted into own ins (no del created, ins shrunk) → text restored AND ins range restored to pre-shrink length. |
| 5.3.d | Accepted an entry → entry re-created. |
| 5.3.e | Rejected an ins → text restored AND entry re-created. |
| 5.3.f | Rejected a del → text removed again AND entry re-created. |

---

## 6. Persistence ★

| # | Rule |
|---|---|
| 6.1 | Save fires on ANY user-originated change to either doc text or sidecar (`docChanged \|\| marksChanged`). |
| 6.2 | `marksChanged` ≡ "this update has at least one `addTcMarks` or `removeTcMark` effect". `setTcMarks` (hydration) is INTENTIONALLY excluded — hydration must NOT trigger a re-save. |
| 6.3 | Save body always includes both `content` and `tcMarks` AND `baseVersion`. V1 server stores `baseVersion` but does not enforce it (last-write-wins). V2: server returns 409 on stale save; client re-fetches and prompts. |
| 6.4 | File switch / unmount: flush pending debounced save, pinned to the file id at edit time. |
| 6.5 | Hydration validation. On `setTcMarks` effect: drop entries that fail validation, log dev-only warnings: |

```js
function isValidEntry(e, docLen) {
  if (!e || typeof e.id !== 'string') return false;
  if (e.type !== 'ins' && e.type !== 'del') return false;
  if (typeof e.from !== 'number' || e.from < 0) return false;
  if (e.type === 'ins') {
    return typeof e.to === 'number' && e.from < e.to && e.to <= docLen;
  } else {
    return e.from === e.to && e.from <= docLen
      && typeof e.text === 'string' && e.text.length > 0;
  }
}
// + dedupe by id, keep first occurrence
```

---

## 7. Multi-author

**V1 is single-author. Do not implement, do not test, foreign-author behavior in V1.**

| # | Rule |
|---|---|
| 7.1 | Each entry records `authorId` + `authorName` at creation. Never mutated. |
| 7.2 | V1: `authorId` always equals the current user's id. Self-retraction (§3.3.a) compares `authorId` and is trivially always true. |
| 7.3 | Display: V1 uses one neutral color and shows `authorName` in hover tooltips. No per-author colors. |
| 7.4 | V2 will add: foreign-author rendering (per-author color), foreign-ins-deletion semantics with `displacedMarks` for lossless reject, and foreign accept/reject permissions. |

The data model is forward-compatible: existing `authorId` field becomes meaningful in V2, no migration needed.

---

## 8. Collaboration (V2)

| # | Rule |
|---|---|
| 8.1 | Local `addTcMarks` / `removeTcMark` effects must broadcast as part of the WS message alongside the doc changes. |
| 8.2 | Receivers apply with the skip annotation so their input filter doesn't re-track. |
| 8.3 | OT'd doc changes auto-map sidecar entries via `RangeSet.map`. No additional code needed for position drift. |
| 8.4 | Out-of-order arrival: entries are id-keyed. Add same id twice → idempotent. Remove unknown id → no-op. |

V1 ships without this; collaborators see each other's tracked changes only after a reload.

---

## 9. Edge Cases

| # | Case | Rule |
|---|---|---|
| 9.1 | Empty insert / empty delete | No entry created. Filter at `iterChanges` time. |
| 9.2 | Ins range collapses to zero length under `RangeSet.map` | Filtered out in `tcMarksField.update` (post-map, pre-effects). |
| 9.3 | Del entry's `from` exceeds doc length under `RangeSet.map` | Filtered out (defensive — shouldn't happen with correct side config). |
| 9.4 | Two consecutive self-retractions on the same ins | Range keeps shrinking. When range reaches zero → entry dropped (9.2). |
| 9.5 | Accept-all on N entries | Single transaction, single save. State field handler must use a Set-based filter for O(N) cost rather than N filter passes. |
| 9.6 | Saving while WS reconnecting | OT/save layers handle this orthogonally. Sidecar serialization is the same on every save. |
| 9.7 | LaTeX command spans (`\cite{...}`, math, etc.) | V1: no special handling. TC operates on raw chars. |
| 9.8 | Surrogate pairs / emoji / combining characters | V1: positions are CM offsets. Tests use `A🙂B` to verify positions remain valid through save/reload. We do NOT solve grapheme-aware UX. |
| 9.9 | Two entries at the same point in the same transaction | Sort by `to` ascending in the StateField update. Del (`to === from`) precedes ins (`to > from`). |
| 9.10 | Hydration with duplicate entry IDs | Keep first occurrence (insertion order); drop later. Log dev warning. |
| 9.11 | Hydration with unknown `type` | Drop. Log dev warning. |
| 9.12 | Accessibility | Del widget DOM has `role="deletion"` (or `<del>` element) plus `aria-label="deleted by {author}: {text}"` so screen readers announce the removed content. Ins ranges rely on visual styling + `data-tc-author` for now (V2: ARIA live regions for review walkthrough). |
| 9.13 | Copy / cut behavior | Copying a selection that overlaps entries: pending insertions are part of the doc text and ARE copied. Pending deletions are NOT in the doc and ARE NOT copied. (This is a free consequence of §1.1 — we don't override the clipboard.) |

---

## 10. Out-of-scope for V1

- Foreign-author entries and their behavior. (V2 §7.4.)
- `displacedMarks` lossless reject for cross-author deletions. (V2.)
- Format suggestions (bold, italic, font-size, etc.). (V2.)
- Comment integration with entries (comments stay separate).
- View modes ("show all markup" / "final" / "original"). V1 always shows pending entries inline.
- Mark merging UX (collapsing adjacent same-author ins ranges in the review panel).
- Right-click context menu on individual entries.
- Server-side TC rendering in the compiled PDF (`\TCadd`/`\TCdel` macros). (V2 once the sidecar is stable.)
- Save conflict resolution / optimistic locking. (V2 — server starts enforcing `baseVersion`.)
- Replace as a single entry type. (V2.)

---

## 11. Test Inventory

Each test corresponds to a rule. Don't write the implementation until the test exists and fails. ★ items are mandatory before any V1 code review.

### Data model + invariants

- [ ] §1.3 ★ TcMarkValue side semantics: `ins` has `startSide=1, endSide=-1`; `del` has `startSide=-1, endSide=-1`.
- [ ] §1.3 ★ Real `RangeSet.map` test: insertion at ins start boundary does NOT expand the range.
- [ ] §1.3 ★ Real `RangeSet.map` test: insertion at ins end boundary does NOT expand the range.
- [ ] §1.3 ★ Real `RangeSet.map` test: insertion strictly inside ins expands the range.
- [ ] §1.4 V1 invariant: pending ins ranges never overlap (defensive runtime assert + test).
- [ ] §6.5 ★ Hydration: invalid entries dropped, valid ones installed, duplicates collapsed by id (first wins).
- [ ] §6.5 Hydration: ins with `to > docLen` dropped; del with `from > docLen` dropped; empty `del.text` dropped.

### TC OFF

- [ ] §2.1 Typing TC off creates no entries.
- [ ] §2.4 Existing own-author ins survives plain typing before/after/inside it (positions auto-map).

### TC ON — insertions

- [ ] §3.2.a Insert strictly inside own ins → range expands, no new entry.
- [ ] §3.2.b ★ Insert at boundary of own ins → new entry. Old entry's `to` unchanged.
- [ ] §3.2.d Insert at del entry's point → new ins; del entry stays at the same point. Render order del-then-ins.
- [ ] §3.6 Paste TC on → one ins entry covering the pasted region.
- [ ] §3.6 Multi-cursor insert TC on → one ins entry per cursor.
- [ ] §3.6 IME-committed text TC on → one ins entry per committed segment, no duplicates.

### TC ON — deletions

- [ ] §3.3.a ★ Backspace into own ins → range shrinks, no del entry.
- [ ] §3.3.a Backspace entire own ins → ins entry vanishes (zero-length filter).
- [ ] §3.3.b Backspace original text → one del entry with text from `tr.startState.doc`. ★
- [ ] §3.3.c ★ Selection spans own ins + original → ins shrinks, del entries for each non-ins gap.
- [ ] §3.3.c ★ Mixed deletion producing two del entries at same final point preserves original order (left-of-doc gap first, right-of-doc gap second).
- [ ] §3.6 Cut original text TC on → del entry created.
- [ ] §3.6 Multi-range delete in one transaction → del entry per affected original span.
- [ ] §3.6 Multi-line paste TC on → one ins entry whose `to - from` equals the pasted string's CM6 length (newlines counted as one char each).

### TC ON — replacement

- [ ] §3.5 ★ Replacement of original text → del before ins at the same point, both rendered.
- [ ] §3.5 Replacement of own ins (selection inside) → self-retract old, create new ins for replacement text.

### Cursor (browser/integration)

- [ ] §3.4.a After typing, cursor at expected pos.
- [ ] §3.4.c ★ After backspace original, del widget renders LEFT of cursor.
- [ ] §3.4.d After typing past del widget, cursor past new chars; widget remains left.
- [ ] §3.4.e Arrow keys traverse one offset at a time across widgets and ranges.
- [ ] §3.4.f Click on del widget DOM positions cursor at the widget's point.

### Accept / reject

- [ ] §4.1 ★ Accept ins → entry gone, doc unchanged, save fires.
- [ ] §4.1 ★ Accept del → entry gone, doc unchanged, save fires.
- [ ] §4.2 Reject ins → text removed, entry gone, save fires.
- [ ] §4.2 Reject del → text restored, entry gone, save fires.
- [ ] §4.3 ★ Accept-all on N entries → single save fires (effects-only transaction must trigger save).
- [ ] §4.4 Reject-all on adjacent ins entries → no overlapping changes; final doc and sidecar correct.
- [ ] §4.4 ★ Reject-all when a del point sits exactly at an ins range boundary → deterministic result (del re-inserted at boundary, ins range deleted; both end up reverted without overlap).
- [ ] §4.4 ★ Runtime invariant: reject-all refuses if a del point lies strictly inside an ins range being rejected (logs + bails; should be unreachable given §1.4).

### Undo / redo

- [ ] §5.3.a ★ Cmd-Z after typing TC on → text gone AND ins entry gone (via invertedEffects).
- [ ] §5.3.b ★ Cmd-Z after backspace TC on → text restored AND del entry gone.
- [ ] §5.3.c Cmd-Z after self-retraction → text restored AND ins range restored to full length.
- [ ] §5.3.d Cmd-Z after accept → entry re-created.
- [ ] §5.3.e Cmd-Z after reject ins → text + entry restored.
- [ ] §5.3.f Cmd-Z after reject del → text removed again + entry restored.
- [ ] §5.2 Type "abc" as three transactions; press Cmd-Z three times → doc empty AND no entries.

### Persistence

- [ ] §6.1 ★ Edit then idle 1s → save fires with current sidecar.
- [ ] §6.2 ★ Hydration on file load does NOT trigger save.
- [ ] §6.3 Round-trip: create N entries → save → reload → entries identical (id, type, from, to, author, timestamp, text).
- [ ] §6.4 File switch with debounced save pending → save fires with old file's id.

### Edge cases

- [ ] §9.1 Empty insert / empty delete → no entries.
- [ ] §9.2 Ins range mapped to zero length → entry filtered.
- [ ] §9.4 Multi-step self-retraction → range shrinks then entry vanishes.
- [ ] §9.8 Doc with emoji `A🙂B`: ins at position covering 🙂 round-trips through save/reload with positions intact.
- [ ] §9.9 Same-position del + ins → render order del, then ins.
- [ ] §9.12 Accessibility: del widget exposes its deleted text to assistive tech (`role`/`aria-label` or equivalent on the widget DOM).
- [ ] §9.13 Copy behavior: copying a selection that crosses pending entries copies the doc text only — pending insertions ARE included (they're in the doc); pending deletions are NOT (they're not in the doc, only rendered as widgets).

### V2 (write `it.todo` placeholders so they show up in the report)

- [ ] §7.4 Foreign-author ins is preserved when current user types adjacent.
- [ ] §7.4 Foreign-author ins deletion creates own del with `displacedMarks` for lossless reject.
- [ ] §6.3 Stale save (`baseVersion` mismatch) returns 409; client surfaces conflict.
- [ ] §8.x WS broadcast of mark effects.

---

## 12. Implementation Order

1. **Test scaffolding**: this doc + empty test files with `it.todo` for each row above.
2. **Sidecar StateField + serialization**: types, side semantics, `RangeSet.map` mapping, serialize/deserialize roundtrip. Test §1.3, §1.4, §6.5.
3. **Decorations**: ins mark (`Decoration.mark`) + del widget (`Decoration.widget` with `side: -1`). Browser test §3.4.c.
4. **Input filter — insertions only** (§3.2). Tests §3.2.a, §3.2.b, §3.2.d, §3.6 paste/multi-cursor.
5. **Input filter — deletions** (§3.3). Tests §3.3.a, §3.3.b, §3.3.c, plus replacement (§3.5).
6. **Accept / reject + save plumbing** (§4, §6.1, §6.2). Tests §4.1–§4.4.
7. **Undo via invertedEffects** (§5). Tests §5.3.a–§5.3.f, §5.2.
8. **Hydration + persistence integration** (§6.3, §6.4). Round-trip tests.
9. **Manual browser smoke test**: type, backspace, accept, reject, reload, undo, paste, multi-cursor. All work as spec'd.
10. **Ship V1.** Then V2 additions stack on a stable base.

---

## 13. What killed the previous attempts

| Failure | Root cause | Rule(s) that prevent it |
|---|---|---|
| Cursor lands on wrong side of del widget | `Decoration.widget({ side: 0 })` | §3.4.c — explicit `side: -1` |
| Backspacing own typing creates a del for retracted text | No self-retraction concept | §3.3.a |
| Accept doesn't persist (reload restores entry) | Save gated on `docChanged`; effects-only transaction skipped | §6.1 + §4.3 |
| Foreign user's ins absorbs current user's typing | Wrong `startSide` for ins | §1.3 (and V1 has no foreign authors anyway, §7) |
| Cmd-Z leaves dangling entries | `invertedEffects` never wired | §5.1 |
| Past-doc-end stale entries survive reloads | Hydration didn't validate | §6.5 |
| Stale doc text definition ("plain UTF-8 the user sees") | Conflated final-text with marked-up view | §1.1 — explicit invariant |
| Replacement render order undefined | Unspecified ordering at same position | §3.5 + §9.9 |
| Mixed up "mark" (TC entry) and "mark decoration" | Naming overlap | §0 vocabulary — entry vs decoration |
| Author identity by display name | Display names are mutable | §1.2 — `authorId` is the identity |

---

## 14. Open questions for follow-up reviews

1. **Author colors palette** for V2 — match Overleaf, Word, or invent? (Out of scope for V1.)
2. **PDF rendering of pending entries** — V2 needs this for `\TCadd`/`\TCdel`. Reuse the deleted `trackedChangeMarkup` approach but driven by the sidecar instead of inline markers?
3. **Comment ↔ entry attachment** — V2 may want comments anchored to entries (e.g., "I rejected this insertion because…"). Worth defining the join model when we get there.
4. **Mobile / touch input** — the rules don't reference touch events, but `iterChanges` should make this transparent. Confirm with a touch-device smoke test before V1 ship.
