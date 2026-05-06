// Defense-in-depth: a transactionFilter that runs AFTER the input
// filter and strips any orphan TC_START sentinel that didn't form a
// valid marker. This catches corruption from any source — OT
// broadcasts that bypass the input filter via tcMarkerSkipAnnotation,
// legacy data from older builds, accept/reject edits that race with
// concurrent typing, etc.
//
// Strip strategy: scan for TC_START. If parseAt returns a valid
// marker, skip over it. Otherwise strip the sentinel AND the apparent
// header bytes up to the 4th colon — that's what the parser would
// have read. If no 4th colon shows up within ~80 chars, just strip
// the sentinel alone (the visible "del:..." text the user can clean
// up by hand, but at least the magic Unicode is gone).
import { EditorState } from '@codemirror/state';
import { TC_START, parseAt } from '@shared/tcMarkers.js';

const MAX_HEADER_SCAN = 80;

function findOrphanRanges(doc) {
  const ranges = [];
  if (!doc.includes(TC_START)) return ranges;
  let i = 0;
  while (i < doc.length) {
    const idx = doc.indexOf(TC_START, i);
    if (idx === -1) break;
    const m = parseAt(doc, idx);
    if (m) {
      i = m.to;
      continue;
    }
    let j = idx + 1;
    let colons = 0;
    while (j < doc.length && colons < 4 && j - idx < MAX_HEADER_SCAN) {
      if (doc[j] === ':') colons++;
      j++;
    }
    if (colons < 4) j = idx + 1;
    ranges.push({ from: idx, to: j });
    i = j;
  }
  return ranges;
}

export const tcMarkerSanitizer = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const orphans = findOrphanRanges(tr.newDoc.toString());
  if (orphans.length === 0) return tr;
  // Apply strips in reverse so the earlier orphans' positions stay valid.
  const sortedOrphans = orphans.sort((a, b) => b.from - a.from);
  const changes = sortedOrphans.map((o) => ({ from: o.from, to: o.to, insert: '' }));
  return [tr, { changes, sequential: false }];
});

export { findOrphanRanges };
