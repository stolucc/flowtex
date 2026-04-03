/**
 * Scenario-based tests for tracked changes — concrete editing examples.
 *
 * These tests simulate real document editing: typing words, deleting characters,
 * accepting/rejecting changes, and verifying the document ends up correct.
 *
 * We model a simple "document" as a string and a list of tracked changes,
 * then replay the same logic the client uses (merge insertions, handle
 * backspace within tracked text, accept/reject with position adjustment).
 */
import { describe, it, expect } from 'vitest';

// ── Pure-logic replicas of the client-side tracked changes engine ──────────
// These mirror the logic in useTrackedChanges.js but without React/API deps.

/**
 * Apply a document edit with track changes enabled.
 * Returns { doc, changes } — the updated document string and change list.
 *
 * Mirrors handleTrackChange logic:
 *  - Pure insertion within an existing pending insertion → merge
 *  - Backspace within an existing pending insertion → shrink or remove
 *  - Otherwise → create new tracked change
 */
function applyEdit(doc, changes, authorId, edit) {
  const { from, to, insert = '', remove = '' } = edit;
  const myPending = changes.filter((c) => c.status === 'pending' && c.author_id === authorId && c.inserted_text);

  // --- Deletion within own pending insertion ---
  if (remove && !insert) {
    for (const existing of myPending) {
      if (from >= existing.from_pos && from <= existing.to_pos) {
        const offset = from - existing.from_pos;
        const delLen = remove.length;
        const newInserted = existing.inserted_text.slice(0, offset) + existing.inserted_text.slice(offset + delLen);

        // Actually remove the text from the document
        const newDoc = doc.slice(0, from) + doc.slice(from + delLen);

        if (!newInserted && !existing.deleted_text) {
          // Change fully undone — remove it
          return {
            doc: newDoc,
            changes: changes.filter((c) => c.id !== existing.id),
          };
        }

        return {
          doc: newDoc,
          changes: changes.map((c) =>
            c.id === existing.id
              ? { ...c, to_pos: existing.from_pos + newInserted.length, inserted_text: newInserted }
              : c,
          ),
        };
      }
    }

    // Deletion outside any own pending insertion → new deletion change
    const newDoc = doc.slice(0, from) + doc.slice(to);
    // Don't actually remove from doc for tracked deletions — mark with strikethrough
    // In the real app, deletions keep the text visible but marked. For testing
    // we'll track the change but keep the doc unchanged (deleted text stays until accept).
    const newChange = {
      id: `change-${Date.now()}-${Math.random()}`,
      from_pos: from,
      to_pos: to,
      inserted_text: '',
      deleted_text: remove,
      author_id: authorId,
      status: 'pending',
    };
    return { doc, changes: [...changes, newChange] };
  }

  // --- Insertion within own pending insertion ---
  if (insert && !remove) {
    for (const existing of myPending) {
      if (from >= existing.from_pos && from <= existing.to_pos) {
        const offset = from - existing.from_pos;
        const newInserted = existing.inserted_text.slice(0, offset) + insert + existing.inserted_text.slice(offset);
        const newDoc = doc.slice(0, from) + insert + doc.slice(from);

        return {
          doc: newDoc,
          changes: changes.map((c) =>
            c.id === existing.id
              ? { ...c, to_pos: existing.from_pos + newInserted.length, inserted_text: newInserted }
              : c,
          ),
        };
      }
    }

    // New insertion not inside existing tracked change
    const newDoc = doc.slice(0, from) + insert + doc.slice(from);
    const newChange = {
      id: `change-${Date.now()}-${Math.random()}`,
      from_pos: from,
      to_pos: from + insert.length,
      inserted_text: insert,
      deleted_text: '',
      author_id: authorId,
      status: 'pending',
    };
    return { doc: newDoc, changes: [...changes, newChange] };
  }

  // --- Replacement (delete + insert) → new change ---
  const newDoc = doc.slice(0, from) + insert + doc.slice(to);
  const newChange = {
    id: `change-${Date.now()}-${Math.random()}`,
    from_pos: from,
    to_pos: from + insert.length,
    inserted_text: insert,
    deleted_text: remove,
    author_id: authorId,
    status: 'pending',
  };
  return { doc: newDoc, changes: [...changes, newChange] };
}

/**
 * Accept a tracked change — apply it permanently to the document.
 * - Insertion: already in the doc, just mark accepted.
 * - Deletion: remove the deleted text from the doc and shift other changes.
 */
function acceptChange(doc, changes, changeId) {
  const change = changes.find((c) => c.id === changeId);
  if (!change || change.status !== 'pending') return { doc, changes };

  let newDoc = doc;
  let updatedChanges = changes.map((c) => (c.id === changeId ? { ...c, status: 'accepted' } : c));

  // Pure deletion (no inserted replacement text): remove the deleted range from the doc
  // Replacement (has both inserted and deleted): doc already has the new text in place,
  // so accepting is just marking it accepted — no doc modification needed.
  if (change.deleted_text && !change.inserted_text) {
    newDoc = doc.slice(0, change.from_pos) + doc.slice(change.to_pos);
    const delta = change.from_pos - change.to_pos;
    updatedChanges = updatedChanges.map((c) => {
      if (c.id === changeId || c.status !== 'pending') return c;
      if (c.from_pos >= change.to_pos) {
        return { ...c, from_pos: c.from_pos + delta, to_pos: c.to_pos + delta };
      }
      return c;
    });
  }

  return { doc: newDoc, changes: updatedChanges };
}

/**
 * Reject a tracked change — undo it.
 * - Insertion: remove the inserted text from the doc and shift.
 * - Deletion: the deleted text was never removed, just unmark.
 */
function rejectChange(doc, changes, changeId) {
  const change = changes.find((c) => c.id === changeId);
  if (!change || change.status !== 'pending') return { doc, changes };

  let newDoc = doc;
  let updatedChanges = changes.map((c) => (c.id === changeId ? { ...c, status: 'rejected' } : c));

  if (change.inserted_text && change.deleted_text) {
    // Replacement: remove inserted text, restore deleted text
    newDoc = doc.slice(0, change.from_pos) + change.deleted_text + doc.slice(change.to_pos);
    const delta = change.deleted_text.length - change.inserted_text.length;
    updatedChanges = updatedChanges.map((c) => {
      if (c.id === changeId || c.status !== 'pending') return c;
      if (c.from_pos >= change.to_pos) {
        return { ...c, from_pos: c.from_pos + delta, to_pos: c.to_pos + delta };
      }
      return c;
    });
  } else if (change.inserted_text) {
    // Pure insertion: remove the inserted text
    newDoc = doc.slice(0, change.from_pos) + doc.slice(change.to_pos);
    const delta = change.from_pos - change.to_pos;
    updatedChanges = updatedChanges.map((c) => {
      if (c.id === changeId || c.status !== 'pending') return c;
      if (c.from_pos >= change.to_pos) {
        return { ...c, from_pos: c.from_pos + delta, to_pos: c.to_pos + delta };
      }
      return c;
    });
  }
  // Pure deletion: rejecting means keeping the text — no doc change needed

  return { doc: newDoc, changes: updatedChanges };
}

/** Delete a single character within a tracked insertion (like pressing Delete key). */
function deleteInsertionChar(doc, changes, pos) {
  const tc = changes.find((c) => c.status === 'pending' && c.inserted_text && pos >= c.from_pos && pos < c.to_pos);
  if (!tc) return { doc, changes };

  const offset = pos - tc.from_pos;
  const newInserted = tc.inserted_text.slice(0, offset) + tc.inserted_text.slice(offset + 1);
  const newDoc = doc.slice(0, pos) + doc.slice(pos + 1);

  if (!newInserted) {
    return { doc: newDoc, changes: changes.filter((c) => c.id !== tc.id) };
  }
  return {
    doc: newDoc,
    changes: changes.map((c) =>
      c.id === tc.id ? { ...c, to_pos: tc.from_pos + newInserted.length, inserted_text: newInserted } : c,
    ),
  };
}

function pending(changes) {
  return changes.filter((c) => c.status === 'pending');
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1: Type a word, then delete it character by character
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: type a word, then delete it', () => {
  it('document "x" → insert "abc" before x → delete a, b, c → back to "x"', () => {
    let doc = 'x';
    let changes = [];
    const userId = 'user-1';

    // Type 'a' at position 0
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 0, to: 0, insert: 'a' }));
    expect(doc).toBe('ax');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('a');
    expect(changes[0].from_pos).toBe(0);
    expect(changes[0].to_pos).toBe(1);

    // Type 'b' at position 1 (after 'a', inside the tracked insertion)
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 1, to: 1, insert: 'b' }));
    expect(doc).toBe('abx');
    expect(changes).toHaveLength(1); // merged!
    expect(changes[0].inserted_text).toBe('ab');
    expect(changes[0].to_pos).toBe(2);

    // Type 'c' at position 2
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 2, to: 2, insert: 'c' }));
    expect(doc).toBe('abcx');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('abc');
    expect(changes[0].to_pos).toBe(3);

    // Now backspace 'c' (delete at position 2 within tracked insertion)
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 2, to: 3, remove: 'c' }));
    expect(doc).toBe('abx');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('ab');

    // Backspace 'b'
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 1, to: 2, remove: 'b' }));
    expect(doc).toBe('ax');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('a');

    // Backspace 'a' — change should be fully removed
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 0, to: 1, remove: 'a' }));
    expect(doc).toBe('x');
    expect(changes).toHaveLength(0); // change fully undone
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2: Insert text, then accept it
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: insert and accept', () => {
  it('"Hello world" → insert " beautiful" after Hello → accept → "Hello beautiful world"', () => {
    let doc = 'Hello world';
    let changes = [];

    // Type " beautiful" at position 5
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 5,
      to: 5,
      insert: ' beautiful',
    }));
    expect(doc).toBe('Hello beautiful world');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe(' beautiful');

    // Accept the change
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('Hello beautiful world');
    expect(pending(changes)).toHaveLength(0);
    expect(changes[0].status).toBe('accepted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3: Insert text, then reject it
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: insert and reject', () => {
  it('"Hello world" → insert "WRONG " → reject → back to "Hello world"', () => {
    let doc = 'Hello world';
    let changes = [];

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 0,
      to: 0,
      insert: 'WRONG ',
    }));
    expect(doc).toBe('WRONG Hello world');

    // Reject it — inserted text is removed
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('Hello world');
    expect(changes[0].status).toBe('rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4: Delete text, then accept the deletion
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: delete and accept', () => {
  it('"Hello cruel world" → delete "cruel " → accept → "Hello world"', () => {
    let doc = 'Hello cruel world';
    let changes = [];

    // Track a deletion: "cruel " at positions 6-12
    // In tracked changes, deletion keeps text visible until accepted
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 6,
      to: 12,
      remove: 'cruel ',
    }));
    // Doc unchanged for deletions (text stays visible with strikethrough)
    expect(doc).toBe('Hello cruel world');
    expect(changes).toHaveLength(1);
    expect(changes[0].deleted_text).toBe('cruel ');
    expect(changes[0].from_pos).toBe(6);
    expect(changes[0].to_pos).toBe(12);

    // Accept the deletion — text is removed from document
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('Hello world');
    expect(changes[0].status).toBe('accepted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5: Delete text, then reject the deletion (keep the text)
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: delete and reject', () => {
  it('"Hello cruel world" → delete "cruel " → reject → text stays', () => {
    let doc = 'Hello cruel world';
    let changes = [];

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 6,
      to: 12,
      remove: 'cruel ',
    }));
    expect(doc).toBe('Hello cruel world'); // unchanged

    // Reject the deletion — text was never actually removed
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('Hello cruel world'); // still there
    expect(changes[0].status).toBe('rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6: Multiple changes, accept/reject affecting positions
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: multiple changes with position shifts', () => {
  it('two insertions, accepting first shifts second', () => {
    let doc = 'ABCDEF';
    let changes = [];

    // Insert "xx" at position 2 → "ABxxCDEF"
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', { from: 2, to: 2, insert: 'xx' }));
    expect(doc).toBe('ABxxCDEF');

    // Insert "yy" at position 6 → "ABxxCDyyEF"
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', { from: 6, to: 6, insert: 'yy' }));
    expect(doc).toBe('ABxxCDyyEF');
    expect(changes).toHaveLength(2);

    // Accept first insertion — it's already in the doc, no text removal needed
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('ABxxCDyyEF');
    // Second change positions should be unchanged (insertion accept doesn't shift)
    const pendingC = pending(changes);
    expect(pendingC).toHaveLength(1);
    expect(pendingC[0].inserted_text).toBe('yy');
  });

  it('two deletions, accepting first shifts second backward', () => {
    let doc = 'Hello beautiful cruel world';
    let changes = [];
    //       0123456789...

    // Delete "beautiful " (pos 6-16)
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 6,
      to: 16,
      remove: 'beautiful ',
    }));

    // Delete "cruel " (pos 16-22)
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 16,
      to: 22,
      remove: 'cruel ',
    }));

    expect(changes).toHaveLength(2);

    // Accept first deletion — removes "beautiful ", shifting second change backward by 10
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('Hello cruel world');

    const pendingC = pending(changes);
    expect(pendingC).toHaveLength(1);
    expect(pendingC[0].deleted_text).toBe('cruel ');
    expect(pendingC[0].from_pos).toBe(6); // was 16, shifted back by 10
    expect(pendingC[0].to_pos).toBe(12); // was 22, shifted back by 10

    // Accept second deletion
    ({ doc, changes } = acceptChange(doc, changes, pendingC[0].id));
    expect(doc).toBe('Hello world');
  });

  it('reject insertion, shifts later changes backward', () => {
    let doc = 'AB__CDEF';
    let changes = [];

    // First change: insertion "xx" at pos 2 (already in doc as __)
    // Simulate: the doc already has the tracked insertion
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', { from: 2, to: 2, insert: '__' }));
    // doc is now 'AB____CDEF' (double __ because we inserted __ into 'AB__CDEF')
    // Let's restart with a cleaner example
    doc = 'ABCDEF';
    changes = [];

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', { from: 2, to: 2, insert: 'xx' }));
    expect(doc).toBe('ABxxCDEF');

    ({ doc, changes } = applyEdit(doc, changes, 'user-2', { from: 6, to: 6, insert: 'yy' }));
    expect(doc).toBe('ABxxCDyyEF');

    // Reject first insertion — removes "xx", shifts "yy" back by 2
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('ABCDyyEF');

    const pendingC = pending(changes);
    expect(pendingC).toHaveLength(1);
    expect(pendingC[0].inserted_text).toBe('yy');
    expect(pendingC[0].from_pos).toBe(4); // was 6, shifted back by 2
    expect(pendingC[0].to_pos).toBe(6); // was 8, shifted back by 2
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 7: Consecutive typing merges into one change
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: consecutive typing merges', () => {
  it('typing "Hello" character by character produces one change', () => {
    let doc = '';
    let changes = [];
    const userId = 'user-1';

    for (const ch of 'Hello') {
      const pos = doc.length; // typing at end
      ({ doc, changes } = applyEdit(doc, changes, userId, { from: pos, to: pos, insert: ch }));
    }

    expect(doc).toBe('Hello');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('Hello');
    expect(changes[0].from_pos).toBe(0);
    expect(changes[0].to_pos).toBe(5);
  });

  it('typing in the middle of an existing insertion merges', () => {
    let doc = 'XY';
    let changes = [];
    const userId = 'user-1';

    // Insert 'ab' at position 1: 'XabY'
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 1, to: 1, insert: 'a' }));
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 2, to: 2, insert: 'b' }));
    expect(doc).toBe('XabY');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('ab');

    // Now insert 'Z' between 'a' and 'b' (position 2, inside the tracked range 1-3)
    ({ doc, changes } = applyEdit(doc, changes, userId, { from: 2, to: 2, insert: 'Z' }));
    expect(doc).toBe('XaZbY');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('aZb');
    expect(changes[0].from_pos).toBe(1);
    expect(changes[0].to_pos).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 8: Different users don't merge
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: different users produce separate changes', () => {
  it('Alice and Bob typing at the same position create 2 changes', () => {
    let doc = 'text';
    let changes = [];

    ({ doc, changes } = applyEdit(doc, changes, 'alice', { from: 0, to: 0, insert: 'A' }));
    ({ doc, changes } = applyEdit(doc, changes, 'bob', { from: 1, to: 1, insert: 'B' }));

    expect(doc).toBe('ABtext');
    expect(changes).toHaveLength(2);
    expect(changes[0].author_id).toBe('alice');
    expect(changes[1].author_id).toBe('bob');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 9: Delete key on tracked insertion characters
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: delete key on tracked insertion', () => {
  it('delete individual characters from a tracked insertion', () => {
    let doc = 'xxHelloxx';
    let changes = [
      {
        id: 'ins-1',
        from_pos: 2,
        to_pos: 7,
        inserted_text: 'Hello',
        deleted_text: '',
        author_id: 'user-1',
        status: 'pending',
      },
    ];

    // Delete 'H' at position 2
    ({ doc, changes } = deleteInsertionChar(doc, changes, 2));
    expect(doc).toBe('xxelloxx');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('ello');
    expect(changes[0].to_pos).toBe(6);

    // Delete 'l' at position 3 (now "ello", 'l' is at offset 1 → pos 3)
    ({ doc, changes } = deleteInsertionChar(doc, changes, 3));
    expect(doc).toBe('xxeloxx');
    expect(changes[0].inserted_text).toBe('elo');

    // Delete all remaining: 'e', 'l', 'o'
    ({ doc, changes } = deleteInsertionChar(doc, changes, 2));
    expect(changes[0].inserted_text).toBe('lo');
    ({ doc, changes } = deleteInsertionChar(doc, changes, 2));
    expect(changes[0].inserted_text).toBe('o');
    ({ doc, changes } = deleteInsertionChar(doc, changes, 2));
    expect(doc).toBe('xxxx');
    expect(changes).toHaveLength(0); // fully deleted
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 10: Replace a word (select + type)
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: replace a word', () => {
  it('"Hello world" → select "world", type "Earth" → accept → "Hello Earth"', () => {
    let doc = 'Hello world';
    let changes = [];

    // User selects "world" (pos 6-11) and types "Earth"
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 6,
      to: 11,
      insert: 'Earth',
      remove: 'world',
    }));
    expect(doc).toBe('Hello Earth');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('Earth');
    expect(changes[0].deleted_text).toBe('world');

    // Accept the replacement
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('Hello Earth');
    expect(changes[0].status).toBe('accepted');
  });

  it('"Hello world" → select "world", type "Earth" → reject → "Hello world"', () => {
    let doc = 'Hello world';
    let changes = [];

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 6,
      to: 11,
      insert: 'Earth',
      remove: 'world',
    }));
    expect(doc).toBe('Hello Earth');

    // Reject a replacement: remove inserted text, restore deleted text
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('Hello world');
    expect(changes[0].status).toBe('rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 11: Full review walkthrough
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: full review walkthrough', () => {
  it('walk through 3 changes: accept first, reject second, accept third', () => {
    // Original: "The quick brown fox"
    let doc = 'The quick brown fox';
    let changes = [];

    // Change 1: insert "very " before "quick" (pos 4)
    ({ doc, changes } = applyEdit(doc, changes, 'author', { from: 4, to: 4, insert: 'very ' }));
    expect(doc).toBe('The very quick brown fox');

    // Change 2: delete "brown " (pos 15-21 in modified doc)
    ({ doc, changes } = applyEdit(doc, changes, 'author', {
      from: 15,
      to: 21,
      remove: 'brown ',
    }));
    // Doc unchanged for deletion tracking
    expect(doc).toBe('The very quick brown fox');

    // Change 3: insert " jumps" at end (pos 24)
    ({ doc, changes } = applyEdit(doc, changes, 'author', {
      from: 24,
      to: 24,
      insert: ' jumps',
    }));
    expect(doc).toBe('The very quick brown fox jumps');

    // Sort pending by position (like the review walkthrough does)
    let pendingChanges = pending(changes).sort((a, b) => a.from_pos - b.from_pos);
    expect(pendingChanges).toHaveLength(3);

    // Review change 1 (insertion "very "): ACCEPT
    ({ doc, changes } = acceptChange(doc, changes, pendingChanges[0].id));
    expect(doc).toBe('The very quick brown fox jumps'); // unchanged, was already in doc

    // Review change 2 (deletion "brown "): ACCEPT
    pendingChanges = pending(changes).sort((a, b) => a.from_pos - b.from_pos);
    expect(pendingChanges).toHaveLength(2);
    ({ doc, changes } = acceptChange(doc, changes, pendingChanges[0].id));
    expect(doc).toBe('The very quick fox jumps');

    // Review change 3 (insertion " jumps"): ACCEPT
    pendingChanges = pending(changes).sort((a, b) => a.from_pos - b.from_pos);
    expect(pendingChanges).toHaveLength(1);
    ({ doc, changes } = acceptChange(doc, changes, pendingChanges[0].id));
    expect(doc).toBe('The very quick fox jumps');
    expect(pending(changes)).toHaveLength(0);
  });

  it('reject all changes restores original document', () => {
    let doc = 'ABCDEF';
    let changes = [];

    // Insert "xx" at pos 2
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', { from: 2, to: 2, insert: 'xx' }));
    expect(doc).toBe('ABxxCDEF');

    // Insert "yy" at pos 6
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', { from: 6, to: 6, insert: 'yy' }));
    expect(doc).toBe('ABxxCDyyEF');

    // Reject all — process from end to avoid position confusion
    let pendingChanges = pending(changes).sort((a, b) => b.from_pos - a.from_pos);
    for (const c of pendingChanges) {
      ({ doc, changes } = rejectChange(doc, changes, c.id));
    }

    expect(doc).toBe('ABCDEF');
    expect(pending(changes)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 12: Typing then backspacing part of the word
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: type "Hello", backspace to "He", then continue typing "lp"', () => {
  it('produces final tracked insertion "Help"', () => {
    let doc = '.';
    let changes = [];
    const u = 'user-1';

    // Type H-e-l-l-o
    for (const ch of 'Hello') {
      const pos = changes.length ? changes[0].to_pos : 0;
      ({ doc, changes } = applyEdit(doc, changes, u, { from: pos, to: pos, insert: ch }));
    }
    expect(doc).toBe('Hello.');
    expect(changes[0].inserted_text).toBe('Hello');

    // Backspace o, l, l → "He"
    ({ doc, changes } = applyEdit(doc, changes, u, { from: 4, to: 5, remove: 'o' }));
    ({ doc, changes } = applyEdit(doc, changes, u, { from: 3, to: 4, remove: 'l' }));
    ({ doc, changes } = applyEdit(doc, changes, u, { from: 2, to: 3, remove: 'l' }));
    expect(doc).toBe('He.');
    expect(changes[0].inserted_text).toBe('He');

    // Type l, p → "Help"
    ({ doc, changes } = applyEdit(doc, changes, u, { from: 2, to: 2, insert: 'l' }));
    ({ doc, changes } = applyEdit(doc, changes, u, { from: 3, to: 3, insert: 'p' }));
    expect(doc).toBe('Help.');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe('Help');
    expect(changes[0].from_pos).toBe(0);
    expect(changes[0].to_pos).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 13: LaTeX-specific editing
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: LaTeX editing', () => {
  it('insert an equation environment and accept', () => {
    let doc = 'Some text.\n\nMore text.';
    let changes = [];

    const equation = '\n\\begin{equation}\n  E = mc^{2}\n\\end{equation}\n';
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 11,
      to: 11,
      insert: equation,
    }));

    expect(doc).toContain('\\begin{equation}');
    expect(changes).toHaveLength(1);
    expect(changes[0].inserted_text).toBe(equation);

    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('Some text.\n\n\\begin{equation}\n  E = mc^{2}\n\\end{equation}\n\nMore text.');
  });

  it('delete a \\usepackage line and reject keeps it', () => {
    let doc = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}';
    let changes = [];

    // Delete "\\usepackage{amsmath}\n" (pos 24-45)
    const deletedText = '\\usepackage{amsmath}\n';
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 24,
      to: 24 + deletedText.length,
      remove: deletedText,
    }));

    // Reject — keep the package
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toContain('\\usepackage{amsmath}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 14: Length-dependent replacement — len(A) > len(B)
//   Replace a long word with a short one. Position shifts should be negative.
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: replace long word A with short word B (len(A) > len(B))', () => {
  // doc: "xx LONGWORD yy TAIL"
  //       0123456789...
  // A = "LONGWORD" (8 chars, pos 3-11), B = "SH" (2 chars)
  // After replace: "xx SH yy TAIL"
  // A later change at "TAIL" must shift back by 6 (len(A) - len(B) = 6)

  it('accept replacement: later change position shifts back', () => {
    let doc = 'xx LONGWORD yy TAIL';
    let changes = [];

    // Replace LONGWORD → SH
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 3,
      to: 11,
      insert: 'SH',
      remove: 'LONGWORD',
    }));
    expect(doc).toBe('xx SH yy TAIL');
    expect(changes[0].from_pos).toBe(3);
    expect(changes[0].to_pos).toBe(5); // 3 + len("SH")

    // A second insertion at "TAIL" (pos 9 in new doc)
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 9,
      to: 9,
      insert: 'NEW',
    }));
    expect(doc).toBe('xx SH yy NEWTAIL');
    expect(changes).toHaveLength(2);

    // Accept the replacement (first change) — doc stays the same (replacement already applied)
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('xx SH yy NEWTAIL');

    // Accept the insertion
    ({ doc, changes } = acceptChange(doc, changes, pending(changes)[0].id));
    expect(doc).toBe('xx SH yy NEWTAIL');
    expect(pending(changes)).toHaveLength(0);
  });

  it('reject replacement: restores long word, shifts later change forward', () => {
    let doc = 'xx LONGWORD yy TAIL';
    let changes = [];

    // Replace LONGWORD → SH
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 3,
      to: 11,
      insert: 'SH',
      remove: 'LONGWORD',
    }));
    expect(doc).toBe('xx SH yy TAIL');

    // Second insertion at pos 9 ("TAIL")
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 9,
      to: 9,
      insert: 'NEW',
    }));
    expect(doc).toBe('xx SH yy NEWTAIL');

    // Reject the replacement — "SH" removed, "LONGWORD" restored
    // delta = len("LONGWORD") - len("SH") = +6
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('xx LONGWORD yy NEWTAIL');

    // The second change should have shifted forward by 6
    const p = pending(changes);
    expect(p).toHaveLength(1);
    expect(p[0].inserted_text).toBe('NEW');
    expect(p[0].from_pos).toBe(15); // was 9, +6
    expect(p[0].to_pos).toBe(18); // was 12, +6
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 15: Length-dependent replacement — len(A) < len(B)
//   Replace a short word with a long one. Position shifts should be positive.
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: replace short word A with long word B (len(A) < len(B))', () => {
  // doc: "xx SH yy TAIL"
  // A = "SH" (2 chars, pos 3-5), B = "LONGWORD" (8 chars)
  // After replace: "xx LONGWORD yy TAIL"

  it('accept replacement: later change not shifted (replacement already in doc)', () => {
    let doc = 'xx SH yy TAIL';
    let changes = [];

    // Replace SH → LONGWORD
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 3,
      to: 5,
      insert: 'LONGWORD',
      remove: 'SH',
    }));
    expect(doc).toBe('xx LONGWORD yy TAIL');
    expect(changes[0].from_pos).toBe(3);
    expect(changes[0].to_pos).toBe(11); // 3 + len("LONGWORD")

    // Insert at TAIL (pos 15)
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 15,
      to: 15,
      insert: 'ZZZ',
    }));
    expect(doc).toBe('xx LONGWORD yy ZZZTAIL');

    // Accept both
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    ({ doc, changes } = acceptChange(doc, changes, pending(changes)[0].id));
    expect(doc).toBe('xx LONGWORD yy ZZZTAIL');
    expect(pending(changes)).toHaveLength(0);
  });

  it('reject replacement: restores short word, shifts later change backward', () => {
    let doc = 'xx SH yy TAIL';
    let changes = [];

    // Replace SH → LONGWORD
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 3,
      to: 5,
      insert: 'LONGWORD',
      remove: 'SH',
    }));
    expect(doc).toBe('xx LONGWORD yy TAIL');

    // Insert "ZZZ" at pos 15
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 15,
      to: 15,
      insert: 'ZZZ',
    }));
    expect(doc).toBe('xx LONGWORD yy ZZZTAIL');

    // Reject replacement — "LONGWORD" removed, "SH" restored
    // delta = len("SH") - len("LONGWORD") = -6
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('xx SH yy ZZZTAIL');

    const p = pending(changes);
    expect(p).toHaveLength(1);
    expect(p[0].inserted_text).toBe('ZZZ');
    expect(p[0].from_pos).toBe(9); // was 15, -6
    expect(p[0].to_pos).toBe(12); // was 18, -6
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 16: Length-dependent replacement — len(A) === len(B)
//   Equal length: no position shift at all.
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: replace equal-length word (len(A) === len(B))', () => {
  it('accept: no position shift on later change', () => {
    let doc = 'xx FOO yy TAIL';
    let changes = [];

    // Replace FOO → BAR (both 3 chars)
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 3,
      to: 6,
      insert: 'BAR',
      remove: 'FOO',
    }));
    expect(doc).toBe('xx BAR yy TAIL');

    // Insert at pos 10
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 10,
      to: 10,
      insert: 'NEW',
    }));
    expect(doc).toBe('xx BAR yy NEWTAIL');

    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('xx BAR yy NEWTAIL');

    // Second change: positions unchanged
    const p = pending(changes);
    expect(p[0].from_pos).toBe(10);
    expect(p[0].to_pos).toBe(13);
  });

  it('reject: no position shift on later change', () => {
    let doc = 'xx FOO yy TAIL';
    let changes = [];

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 3,
      to: 6,
      insert: 'BAR',
      remove: 'FOO',
    }));
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 10,
      to: 10,
      insert: 'NEW',
    }));

    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('xx FOO yy NEWTAIL');

    const p = pending(changes);
    expect(p[0].from_pos).toBe(10); // no shift — delta is 0
    expect(p[0].to_pos).toBe(13);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 17: Deletion of existing word A, with insertion B nearby
//   Does accepting deletion of A correctly shift B?
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: delete A, insert B — length variations', () => {
  // Each sub-test: "PREFIX [A] MIDDLE [B inserted] SUFFIX"
  //   - Delete A (tracked deletion, doc unchanged until accept)
  //   - Insert B after A
  //   - Accept deletion of A → B shifts back by len(A)

  it('A="LONGWORD"(8), B="Hi"(2): accept deletion shifts short B', () => {
    let doc = 'start LONGWORD middle end';
    let changes = [];
    // A is at pos 6-14

    // Track deletion of A
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 6,
      to: 14,
      remove: 'LONGWORD',
    }));
    expect(doc).toBe('start LONGWORD middle end'); // unchanged

    // Insert B at pos 22 ("end")
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 22,
      to: 22,
      insert: 'Hi',
    }));
    expect(doc).toBe('start LONGWORD middle Hiend');

    // Accept deletion of A → removes 8 chars, B shifts back by 8
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('start  middle Hiend');

    const p = pending(changes);
    expect(p).toHaveLength(1);
    expect(p[0].inserted_text).toBe('Hi');
    expect(p[0].from_pos).toBe(14); // was 22, -8
    expect(p[0].to_pos).toBe(16); // was 24, -8
  });

  it('A="Hi"(2), B="LONGINSERT"(10): accept deletion shifts long B', () => {
    let doc = 'start Hi middle end';
    let changes = [];
    // A is at pos 6-8

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 6,
      to: 8,
      remove: 'Hi',
    }));

    // Insert B at pos 16 ("end")
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 16,
      to: 16,
      insert: 'LONGINSERT',
    }));
    expect(doc).toBe('start Hi middle LONGINSERTend');

    // Accept deletion of A → removes 2 chars, B shifts back by 2
    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('start  middle LONGINSERTend');

    const p = pending(changes);
    expect(p[0].from_pos).toBe(14); // was 16, -2
    expect(p[0].to_pos).toBe(24); // was 26, -2
    expect(p[0].to_pos - p[0].from_pos).toBe(10); // B's length preserved
  });

  it('A="abc"(3), B="xyz"(3) equal length: accept shifts B back by 3', () => {
    let doc = '>>abc--xyz<<';
    let changes = [];
    // A at pos 2-5, B region starts at 7

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 2,
      to: 5,
      remove: 'abc',
    }));

    // Insert "NEW" at pos 7
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 7,
      to: 7,
      insert: 'NEW',
    }));
    expect(doc).toBe('>>abc--NEWxyz<<');

    ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
    expect(doc).toBe('>>--NEWxyz<<');

    const p = pending(changes);
    expect(p[0].from_pos).toBe(4); // was 7, -3
    expect(p[0].to_pos).toBe(7); // was 10, -3
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 18: Insertion B before deletion A — reject B shifts A?
//   Insert B before A, then reject B. Does A shift back correctly?
// ═══════════════════════════════════════════════════════════════════════════
describe('Scenario: insert B before deletion A — reject B', () => {
  it('B="LONGINSERT"(10) before A: reject B shifts A back by 10', () => {
    let doc = 'prefix TARGET suffix';
    let changes = [];
    // TARGET at pos 7-13

    // Insert B at pos 0
    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 0,
      to: 0,
      insert: 'LONGINSERT',
    }));
    expect(doc).toBe('LONGINSERTprefix TARGET suffix');

    // Delete A ("TARGET") — now at pos 17-23 (shifted by 10)
    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 17,
      to: 23,
      remove: 'TARGET',
    }));
    expect(doc).toBe('LONGINSERTprefix TARGET suffix');

    // Reject insertion B — removes 10 chars, A shifts back by 10
    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('prefix TARGET suffix');

    const p = pending(changes);
    expect(p).toHaveLength(1);
    expect(p[0].deleted_text).toBe('TARGET');
    expect(p[0].from_pos).toBe(7); // was 17, -10
    expect(p[0].to_pos).toBe(13); // was 23, -10
  });

  it('B="ab"(2) before A: reject B shifts A back by 2', () => {
    let doc = 'prefix TARGET suffix';
    let changes = [];

    ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
      from: 0,
      to: 0,
      insert: 'ab',
    }));
    expect(doc).toBe('abprefix TARGET suffix');

    ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
      from: 9,
      to: 15,
      remove: 'TARGET',
    }));

    ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
    expect(doc).toBe('prefix TARGET suffix');

    const p = pending(changes);
    expect(p[0].from_pos).toBe(7); // was 9, -2
    expect(p[0].to_pos).toBe(13); // was 15, -2
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 19: Parametric — systematically test many length combos
// ═══════════════════════════════════════════════════════════════════════════
describe('Parametric: replacement accept/reject with varying lengths', () => {
  const cases = [
    { A: 'x', B: 'LONGWORD' }, // 1 vs 8
    { A: 'ab', B: 'LONGWORD' }, // 2 vs 8
    { A: 'LONGWORD', B: 'x' }, // 8 vs 1
    { A: 'LONGWORD', B: 'ab' }, // 8 vs 2
    { A: 'abc', B: 'xyz' }, // 3 vs 3 (equal)
    { A: 'a', B: 'b' }, // 1 vs 1 (equal, minimal)
    { A: '', B: 'INSERT' }, // 0 vs 6 (pure insertion as "replacement")
    { A: 'ABCDEFGHIJ', B: 'Z' }, // 10 vs 1
    { A: 'Z', B: 'ABCDEFGHIJ' }, // 1 vs 10
  ];

  for (const { A, B } of cases) {
    const lenA = A.length;
    const lenB = B.length;

    if (lenA === 0) {
      // Pure insertion — accept keeps text, reject removes it
      it(`pure insertion B="${B}" (${lenB}) — accept keeps, reject removes`, () => {
        let doc = 'PREFIX_SUFFIX';
        let changes = [];
        const insertPos = 7; // between PREFIX_ and SUFFIX

        ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
          from: insertPos,
          to: insertPos,
          insert: B,
        }));
        expect(doc).toBe('PREFIX_' + B + 'SUFFIX');

        // Test accept path
        let result = acceptChange(doc, changes, changes[0].id);
        expect(result.doc).toBe('PREFIX_' + B + 'SUFFIX');

        // Test reject path (start fresh)
        doc = 'PREFIX_SUFFIX';
        changes = [];
        ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
          from: insertPos,
          to: insertPos,
          insert: B,
        }));
        result = rejectChange(doc, changes, changes[0].id);
        expect(result.doc).toBe('PREFIX_SUFFIX');
      });
      continue;
    }

    it(`replace A="${A}"(${lenA}) → B="${B}"(${lenB}) — accept keeps B, position shift correct`, () => {
      // Layout: "HEAD_[A]_MID_TAIL"
      const head = 'HEAD_';
      const mid = '_MID_';
      const tail = 'TAIL';
      const origDoc = head + A + mid + tail;
      let doc = origDoc;
      let changes = [];

      const aStart = head.length;
      const aEnd = aStart + lenA;

      // Replace A with B
      ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
        from: aStart,
        to: aEnd,
        insert: B,
        remove: A,
      }));
      const expectedAfterReplace = head + B + mid + tail;
      expect(doc).toBe(expectedAfterReplace);

      // Insert "ZZ" at the tail position (should be at head + B + mid)
      const tailPos = head.length + lenB + mid.length;
      ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
        from: tailPos,
        to: tailPos,
        insert: 'ZZ',
      }));
      expect(doc).toBe(head + B + mid + 'ZZ' + tail);

      // Accept the replacement — doc unchanged
      ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
      expect(doc).toBe(head + B + mid + 'ZZ' + tail);

      // The "ZZ" insertion's position should be unchanged after accept
      const p = pending(changes);
      expect(p).toHaveLength(1);
      expect(p[0].from_pos).toBe(tailPos);
      expect(p[0].to_pos).toBe(tailPos + 2);
    });

    it(`replace A="${A}"(${lenA}) → B="${B}"(${lenB}) — reject restores A, shifts later change by ${lenA - lenB}`, () => {
      const head = 'HEAD_';
      const mid = '_MID_';
      const tail = 'TAIL';
      let doc = head + A + mid + tail;
      let changes = [];

      const aStart = head.length;
      const aEnd = aStart + lenA;

      // Replace A with B
      ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
        from: aStart,
        to: aEnd,
        insert: B,
        remove: A,
      }));

      // Insert "ZZ" after the replacement region
      const tailPos = head.length + lenB + mid.length;
      ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
        from: tailPos,
        to: tailPos,
        insert: 'ZZ',
      }));

      // Reject the replacement — restores A
      ({ doc, changes } = rejectChange(doc, changes, changes[0].id));
      const expectedAfterReject = head + A + mid + 'ZZ' + tail;
      expect(doc).toBe(expectedAfterReject);

      // "ZZ" should have shifted by (lenA - lenB)
      const delta = lenA - lenB;
      const p = pending(changes);
      expect(p).toHaveLength(1);
      expect(p[0].from_pos).toBe(tailPos + delta);
      expect(p[0].to_pos).toBe(tailPos + delta + 2);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 20: Parametric — deletion with insertion at various distances
// ═══════════════════════════════════════════════════════════════════════════
describe('Parametric: delete A, later insert B — accept deletion shifts B', () => {
  const cases = [
    { A: 'x', B: 'LONGINSERT', gap: 5 },
    { A: 'LONGDELETE', B: 'y', gap: 5 },
    { A: 'abc', B: 'def', gap: 0 }, // B immediately after A
    { A: 'abc', B: 'def', gap: 20 }, // B far after A
    { A: 'HUGE_DELETE_STR', B: 'tiny', gap: 3 },
    { A: 'sm', B: 'REALLY_BIG_INSERT', gap: 1 },
  ];

  for (const { A, B, gap } of cases) {
    it(`delete A="${A}"(${A.length}), insert B="${B}"(${B.length}), gap=${gap} — accept shifts B back by ${A.length}`, () => {
      // Build doc: "PP[A]<gap of dots>[B insertion point]SS"
      const prefix = 'PP';
      const gapStr = '.'.repeat(gap);
      const suffix = 'SS';
      const origDoc = prefix + A + gapStr + suffix;
      let doc = origDoc;
      let changes = [];

      const aStart = prefix.length;
      const aEnd = aStart + A.length;

      // Track deletion of A
      ({ doc, changes } = applyEdit(doc, changes, 'user-1', {
        from: aStart,
        to: aEnd,
        remove: A,
      }));
      expect(doc).toBe(origDoc); // unchanged for tracked deletion

      // Insert B right before suffix
      const bPos = prefix.length + A.length + gap;
      ({ doc, changes } = applyEdit(doc, changes, 'user-2', {
        from: bPos,
        to: bPos,
        insert: B,
      }));
      expect(doc).toBe(prefix + A + gapStr + B + suffix);

      // Accept deletion of A → B shifts back by len(A)
      ({ doc, changes } = acceptChange(doc, changes, changes[0].id));
      expect(doc).toBe(prefix + gapStr + B + suffix);

      const p = pending(changes);
      expect(p).toHaveLength(1);
      expect(p[0].inserted_text).toBe(B);
      expect(p[0].from_pos).toBe(bPos - A.length);
      expect(p[0].to_pos).toBe(bPos - A.length + B.length);
      // Verify length of B is preserved
      expect(p[0].to_pos - p[0].from_pos).toBe(B.length);
    });
  }
});
