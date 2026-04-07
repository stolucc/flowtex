import React, { useState, useEffect, useCallback, useRef } from 'react';
import { get, post } from '../api.js';
import { getColor } from './Avatar.jsx';
import lineDiff from '../utils/lineDiff.js';
import { formatRelativeTime as formatDate } from '../utils/dateFormat.js';
import { CloseIcon, UndoIcon } from './Icons.jsx';

/** Format a date string to a short locale time (e.g. "3:42 PM"). */
function formatTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Group an array of snapshot versions by their calendar date. */
function groupByDate(versions) {
  const groups = {};
  for (const v of versions) {
    const d = new Date(v.created_at);
    const key = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (!groups[key]) groups[key] = [];
    groups[key].push(v);
  }
  return Object.entries(groups);
}

/** Inline badge showing +added / -removed line counts for a diff. */
function DiffStats({ diff }) {
  const added = diff.filter((l) => l.type === 'add').length;
  const removed = diff.filter((l) => l.type === 'remove').length;
  return (
    <span className="history-diff-stats">
      {added > 0 && <span className="diff-stat-add">+{added}</span>}
      {removed > 0 && <span className="diff-stat-remove">-{removed}</span>}
      {added === 0 && removed === 0 && <span className="diff-stat-none">no changes</span>}
    </span>
  );
}

const CONTEXT_LINES = 3;

/** Build GitHub-style hunks from a flat diff */
function buildHunks(diff) {
  let oldLine = 0,
    newLine = 0;
  const numbered = diff.map((line, i) => {
    let oldNum = null,
      newNum = null;
    if (line.type === 'same') {
      oldLine++;
      newLine++;
      oldNum = oldLine;
      newNum = newLine;
    } else if (line.type === 'remove') {
      oldLine++;
      oldNum = oldLine;
    } else if (line.type === 'add') {
      newLine++;
      newNum = newLine;
    }
    return { ...line, oldNum, newNum, idx: i };
  });

  const changeIndices = [];
  for (let i = 0; i < numbered.length; i++) {
    if (numbered[i].type !== 'same') changeIndices.push(i);
  }

  if (changeIndices.length === 0) {
    return [
      {
        header: null,
        lines: numbered.slice(0, Math.min(10, numbered.length)),
        collapsed: numbered.length > 10 ? numbered.length - 10 : 0,
      },
    ];
  }

  const ranges = [];
  let start = changeIndices[0];
  let end = changeIndices[0];
  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - end <= CONTEXT_LINES * 2 + 1) {
      end = changeIndices[i];
    } else {
      ranges.push([start, end]);
      start = changeIndices[i];
      end = changeIndices[i];
    }
  }
  ranges.push([start, end]);

  const hunks = [];
  for (const [rangeStart, rangeEnd] of ranges) {
    const ctxStart = Math.max(0, rangeStart - CONTEXT_LINES);
    const ctxEnd = Math.min(numbered.length - 1, rangeEnd + CONTEXT_LINES);
    const lines = numbered.slice(ctxStart, ctxEnd + 1);

    const firstOld = lines.find((l) => l.oldNum !== null)?.oldNum || 1;
    const firstNew = lines.find((l) => l.newNum !== null)?.newNum || 1;
    const oldCount = lines.filter((l) => l.type === 'same' || l.type === 'remove').length;
    const newCount = lines.filter((l) => l.type === 'same' || l.type === 'add').length;
    const header = `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`;

    const collapsedBefore = ctxStart > 0 ? ctxStart - (hunks.length > 0 ? hunks[hunks.length - 1]._ctxEnd + 1 : 0) : 0;

    hunks.push({ header, lines, collapsedBefore, _ctxEnd: ctxEnd });
  }

  const lastEnd = ranges[ranges.length - 1][1] + CONTEXT_LINES;
  if (lastEnd < numbered.length - 1) {
    hunks.push({ collapsed: numbered.length - 1 - lastEnd });
  }

  return hunks;
}

/** Character-level diff between two strings. Returns array of [highlighted, text] pairs. */
function charDiff(oldStr, newStr) {
  // Find common prefix
  let pre = 0;
  while (pre < oldStr.length && pre < newStr.length && oldStr[pre] === newStr[pre]) pre++;
  // Find common suffix
  let suf = 0;
  while (
    suf < oldStr.length - pre &&
    suf < newStr.length - pre &&
    oldStr[oldStr.length - 1 - suf] === newStr[newStr.length - 1 - suf]
  )
    suf++;

  const oldMid = oldStr.slice(pre, oldStr.length - suf);
  const newMid = newStr.slice(pre, newStr.length - suf);
  const prefix = oldStr.slice(0, pre);
  const suffix = oldStr.slice(oldStr.length - suf);

  return { prefix, suffix, oldMid, newMid };
}

/** Pair up adjacent remove/add blocks and compute inline highlights */
function annotateHunkLines(lines) {
  const annotated = [];
  let i = 0;
  while (i < lines.length) {
    // Collect a contiguous block of changes (removes and adds in either order)
    if (lines[i].type === 'remove' || lines[i].type === 'add') {
      const removes = [];
      const adds = [];
      while (i < lines.length && (lines[i].type === 'remove' || lines[i].type === 'add')) {
        if (lines[i].type === 'remove') removes.push(lines[i]);
        else adds.push(lines[i]);
        i++;
      }

      // Pair them up for inline highlighting
      const pairCount = Math.min(removes.length, adds.length);
      for (let p = 0; p < removes.length; p++) {
        if (p < pairCount) {
          const { prefix, suffix, oldMid } = charDiff(removes[p].text, adds[p].text);
          annotated.push({ ...removes[p], segments: renderSegments(prefix, oldMid, suffix) });
        } else {
          annotated.push({ ...removes[p], segments: null });
        }
      }
      for (let p = 0; p < adds.length; p++) {
        if (p < pairCount) {
          const { prefix, suffix, newMid } = charDiff(removes[p].text, adds[p].text);
          annotated.push({ ...adds[p], segments: renderSegments(prefix, newMid, suffix) });
        } else {
          annotated.push({ ...adds[p], segments: null });
        }
      }
    } else {
      annotated.push({ ...lines[i], segments: null });
      i++;
    }
  }
  return annotated;
}

/** Render inline diff segments, highlighting the changed middle portion. */
function renderSegments(prefix, mid, suffix) {
  // Only highlight if there's a meaningful common prefix or suffix
  // (otherwise the whole line is different and highlighting everything looks the same)
  if (!prefix && !suffix) return null;
  if (!mid) return null;
  return (
    <>
      {prefix}
      <span className="gh-diff-highlight">{mid}</span>
      {suffix}
    </>
  );
}

/** Renders a GitHub-style unified diff with line numbers and inline highlights. */
function DiffView({ diff }) {
  const hunks = buildHunks(diff);

  return (
    <div className="gh-diff">
      {hunks.map((hunk, hi) => {
        if (hunk.collapsed && !hunk.header) {
          return (
            <div key={`trail-${hi}`} className="gh-diff-expand">
              <span className="gh-diff-expand-icon">⋯</span>
              {hunk.collapsed} unchanged lines
            </div>
          );
        }
        const annotatedLines = annotateHunkLines(hunk.lines || []);
        return (
          <div key={hi} className="gh-diff-hunk">
            {hunk.collapsedBefore > 0 && (
              <div className="gh-diff-expand">
                <span className="gh-diff-expand-icon">⋯</span>
                {hunk.collapsedBefore} unchanged lines
              </div>
            )}
            {hunk.header && <div className="gh-diff-hunk-header">{hunk.header}</div>}
            <table className="gh-diff-table">
              <tbody>
                {annotatedLines.map((row, ri) => (
                  <tr key={ri} className={`gh-diff-row gh-diff-row-${row.type}`}>
                    <td className="gh-diff-num gh-diff-num-old">{row.oldNum ?? ''}</td>
                    <td className="gh-diff-num gh-diff-num-new">{row.newNum ?? ''}</td>
                    <td className="gh-diff-marker">{row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ''}</td>
                    <td className="gh-diff-code">{row.segments || row.text || '\u00A0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

/** Side panel for browsing project snapshots, viewing diffs, and restoring previous versions. */
export default function HistoryPanel({
  projectId,
  currentUserName,
  refreshKey,
  snapshotInterval,
  onSnapshotIntervalChange,
  onClose,
  onRestore,
  onSelectVersion,
  historyFileId,
  historyFilePath,
}) {
  const [snapshots, setSnapshots] = useState([]);
  const [selected, setSelected] = useState(null);
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [viewingFile, setViewingFile] = useState(null);

  const pendingAutoSelect = useRef(true);

  // Load snapshot list
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    pendingAutoSelect.current = true;
    get(`/api/history/${projectId}`)
      .then((r) => r.json())
      .then((data) => {
        setSnapshots(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectId, refreshKey]);

  // Auto-select the latest snapshot when first loaded
  useEffect(() => {
    if (pendingAutoSelect.current && snapshots.length > 0 && !selected) {
      pendingAutoSelect.current = false;
      selectSnapshot(snapshots[0]);
    }
  }, [snapshots]);

  // When a file is clicked in the history files panel, load its diff
  useEffect(() => {
    if (!historyFileId || !selected) return;
    if (viewingFile?.id === historyFileId) return;

    setViewingFile({ id: historyFileId, path: historyFilePath });
    setDiff(null);

    (async () => {
      try {
        const res = await get(`/api/history/snapshot/${selected.id}/file/${historyFileId}`);
        const data = await res.json();
        setDiff(lineDiff(data.previousContent, data.currentContent));
      } catch (e) {
        console.error('Failed to load file diff', e);
      }
    })();
  }, [historyFileId, selected]);

  /** Select a snapshot and notify the parent to load its details. */
  const selectSnapshot = useCallback(
    async (snap) => {
      setSelected(snap);
      setDiff(null);
      setViewingFile(null);
      onSelectVersion?.(snap);
    },
    [onSelectVersion],
  );

  // Once a snapshot is selected and its metadata loaded (via onSelectVersion -> App),
  // auto-load the first edited file's diff
  useEffect(() => {
    if (!selected || !historyFileId) return;
    // historyFileId gets set by App.jsx after onSelectVersion fetches snapshot details
    setViewingFile({ id: historyFileId, path: historyFilePath });
    setDiff(null);

    (async () => {
      try {
        const res = await get(`/api/history/snapshot/${selected.id}/file/${historyFileId}`);
        const data = await res.json();
        setDiff(lineDiff(data.previousContent, data.currentContent));
      } catch (e) {
        console.error('Failed to load file diff', e);
      }
    })();
  }, [selected?.id, historyFileId]);

  /** Restore all project files to the selected snapshot's state. */
  const handleRestore = async () => {
    if (!selected || restoring) return;
    setConfirmRestore(false);
    setRestoring(true);
    try {
      const res = await post(`/api/history/restore/${selected.id}`);
      const data = await res.json();
      if (data.ok) {
        onRestore(data.files);
      }
    } catch (e) {
      console.error('Restore failed', e);
    }
    setRestoring(false);
  };

  const grouped = groupByDate(snapshots);

  return (
    <div className="history-panel">
      <div className="history-diff-pane">
        <div className="history-diff-header">
          {selected ? (
            <>
              <span className="history-diff-filename">{viewingFile?.path || 'Select a file to view diff'}</span>
              {diff && <DiffStats diff={diff} />}
              <span className="history-diff-meta">
                {selected.author_name === currentUserName ? 'You' : selected.author_name} —{' '}
                {formatDate(selected.created_at)}
                {selected.label && <> — {selected.label}</>}
              </span>
              <button className="history-restore-btn" onClick={() => setConfirmRestore(true)} disabled={restoring}>
                {restoring ? 'Restoring...' : 'Restore to this snapshot'}
              </button>
            </>
          ) : (
            <span className="history-diff-placeholder">Select a snapshot to view changes</span>
          )}
        </div>
        <div className="history-diff-body">
          {diff ? (
            <DiffView diff={diff} />
          ) : selected ? (
            <div className="history-diff-loading">
              {viewingFile ? 'Loading diff...' : 'Select a file from the files panel to view its diff'}
            </div>
          ) : null}
        </div>
      </div>
      <div className="history-list-pane">
        <div className="history-list-header">
          <span>History</span>
          <div className="history-header-controls">
            <select
              className="history-interval-select"
              value={snapshotInterval || 30}
              onChange={(e) => onSnapshotIntervalChange?.(parseInt(e.target.value))}
              title="Snapshot interval"
            >
              <option value={10}>10s</option>
              <option value={30}>30s</option>
              <option value={60}>1 min</option>
              <option value={120}>2 min</option>
              <option value={300}>5 min</option>
              <option value={600}>10 min</option>
            </select>
            <button className="history-close-btn" onClick={onClose} title="Close history">
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="history-list-body">
          {loading && <div className="history-list-loading">Loading...</div>}
          {!loading && snapshots.length === 0 && (
            <div className="history-list-empty">No history yet. Snapshots are taken automatically while editing.</div>
          )}
          {grouped.map(([date, items]) => (
            <div key={date}>
              <div className="history-date-header">{date}</div>
              {items.map((v) => (
                <div
                  key={v.id}
                  className={`history-entry ${selected?.id === v.id ? 'active' : ''}`}
                  onClick={() => selectSnapshot(v)}
                >
                  <div className="history-entry-top">
                    <span className="history-entry-file">{v.label || 'Snapshot'}</span>
                    <span className="history-entry-time">{formatTime(v.created_at)}</span>
                  </div>
                  <div className="history-entry-meta">
                    <span className="history-entry-author">
                      <span className="history-author-swatch" style={{ backgroundColor: getColor(v.author_name) }} />
                      {v.author_name === currentUserName ? 'You' : v.author_name}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {confirmRestore && selected && (
        <div className="modal-overlay" onClick={() => setConfirmRestore(false)}>
          <div className="modal-card history-restore-modal" onClick={(e) => e.stopPropagation()}>
            <div className="history-restore-modal-icon">
              <UndoIcon size={32} stroke="var(--accent)" />
            </div>
            <h2>Restore to this snapshot?</h2>
            <p className="history-restore-modal-desc">
              This will revert <strong>all files</strong> to their state at{' '}
              <strong>{formatDate(selected.created_at)}</strong>. Files created after this snapshot will be removed, and
              any deleted files will be brought back.
            </p>
            <p className="history-restore-modal-note">
              A snapshot of the current state will be saved first, so you can undo this.
            </p>
            <div className="history-restore-modal-actions">
              <button className="history-restore-modal-cancel" onClick={() => setConfirmRestore(false)}>
                Cancel
              </button>
              <button className="history-restore-modal-confirm" onClick={handleRestore}>
                Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
