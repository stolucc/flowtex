import React, { useState } from 'react';
import generateLatexTable, { getMergeAt, isCoveredByMerge } from '../utils/latexTableGenerator.js';

export const TABLE_ENV_OPTIONS = [
  { value: 'tabular', label: 'tabular' },
  { value: 'tabularx', label: 'tabularx (full width)' },
  { value: 'longtable', label: 'longtable (multi-page)' },
  { value: 'array', label: 'array (math mode)' },
];

function TableGridPicker({ onInsert, onClose, initial }) {
  const MAX_ROWS = 12;
  const MAX_COLS = 12;
  const [hover, setHover] = useState({ r: 0, c: 0 });
  const [rows, setRows] = useState(initial?.rows || 0);
  const [cols, setCols] = useState(initial?.cols || 0);
  const [sizeConfirmed, setSizeConfirmed] = useState(!!initial?.cells);
  const [alignment, setAlignment] = useState(initial?.alignment || 'c');
  const [borders, setBorders] = useState(initial?.borders || 'none');
  const [headerRow, setHeaderRow] = useState(initial?.headerRow ?? true);
  const [caption, setCaption] = useState(initial?.caption || false);
  const [captionText, setCaptionText] = useState(initial?.captionText || '');
  const [label, setLabel] = useState(initial?.label || '');
  const [env, setEnv] = useState(initial?.env || 'tabular');
  const [centering, setCentering] = useState(initial?.centering ?? true);
  const [boldHeader, setBoldHeader] = useState(initial?.boldHeader || false);
  const [zebra, setZebra] = useState(initial?.zebra || false);
  const [merges, setMerges] = useState(initial?.merges || []);
  // Vertical lines: array of cols+1 booleans (left edge, between each col, right edge)
  const [vlines, setVlines] = useState(() => {
    if (initial?.vlines) return initial.vlines;
    if (initial?.borders === 'all') return Array(initial.cols + 1).fill(true);
    return Array((initial?.cols || 0) + 1).fill(false);
  });
  const [selection, setSelection] = useState(null); // { startRow, startCol, endRow, endCol }
  const [selecting, setSelecting] = useState(false);

  const isEditing = !!initial?.cells;
  const hasSize = rows > 0 && cols > 0;

  // Compute minimum rows/cols based on last row/col with actual content
  let minRows = 0, minCols = 0;
  if (isEditing && initial.cells) {
    for (let r = initial.cells.length - 1; r >= 0; r--) {
      if (initial.cells[r]?.some(c => c != null && c.trim().length > 0)) { minRows = r + 1; break; }
    }
    for (const row of initial.cells) {
      if (!row) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        if (row[c] != null && row[c].trim().length > 0 && c + 1 > minCols) { minCols = c + 1; break; }
      }
    }
  }

  const handleGridClick = (r, c) => {
    const newCols = Math.max(c, minCols);
    setRows(Math.max(r, minRows));
    setCols(newCols);
    setSizeConfirmed(true);
    // Resize vlines array to match new column count
    setVlines(prev => {
      const needed = newCols + 1;
      if (prev.length === needed) return prev;
      if (prev.length < needed) return [...prev, ...Array(needed - prev.length).fill(false)];
      return prev.slice(0, needed);
    });
  };

  function normalizeSelection(sel) {
    return {
      r1: Math.min(sel.startRow, sel.endRow), c1: Math.min(sel.startCol, sel.endCol),
      r2: Math.max(sel.startRow, sel.endRow), c2: Math.max(sel.startCol, sel.endCol),
    };
  }
  function isInSelection(sel, r, c) {
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return r >= r1 && r <= r2 && c >= c1 && c <= c2;
  }
  function selectionSpan(sel) {
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return { rows: r2 - r1 + 1, cols: c2 - c1 + 1, cells: (r2 - r1 + 1) * (c2 - c1 + 1) };
  }
  function selectionOverlapsMerge(merges, sel) {
    if (!sel || !merges.length) return false;
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return merges.some(m => {
      const mr2 = m.row + m.rowSpan - 1, mc2 = m.col + m.colSpan - 1;
      const overlaps = m.row <= r2 && mr2 >= r1 && m.col <= c2 && mc2 >= c1;
      // Fully contained is OK (we'd unmerge first), partial is not
      const fullyContained = m.row >= r1 && mr2 <= r2 && m.col >= c1 && mc2 <= c2;
      return overlaps && !fullyContained;
    });
  }

  const handleInsert = () => {
    if (!hasSize) return;
    // When editing, preserve existing cell content where possible
    const cells = initial?.cells || [];
    const table = generateLatexTable({ rows, cols, alignment, borders, headerRow, caption, captionText, label, env, centering, boldHeader, zebra, cells, rawColSpec: initial?.rawColSpec, longtablePreamble: initial?.longtablePreamble, alignments: initial?.alignments, merges, vlines });
    onInsert(table);
    onClose();
  };

  return (
    <div className="table-builder">
      <div className="table-builder-left">
        <div className="table-grid-label">{hover.r > 0 ? `${hover.r} \u00d7 ${hover.c}` : hasSize ? `${rows} \u00d7 ${cols}` : 'Select size'}</div>
        <div className="table-grid" onMouseEnter={() => setSizeConfirmed(false)} onMouseLeave={() => { setHover({ r: 0, c: 0 }); setSizeConfirmed(hasSize); }}>
          {Array.from({ length: MAX_ROWS }, (_, r) => (
            <div key={r} className="table-grid-row">
              {Array.from({ length: MAX_COLS }, (_, c) => (
                <div
                  key={c}
                  className={`table-grid-cell ${r < (hover.r || rows) && c < (hover.c || cols) ? 'active' : ''}${isEditing && (r < minRows && c < minCols) ? ' locked' : ''}`}
                  onMouseEnter={() => setHover({ r: Math.max(r + 1, minRows), c: Math.max(c + 1, minCols) })}
                  onClick={() => handleGridClick(r + 1, c + 1)}
                />
              ))}
            </div>
          ))}
        </div>
        {isEditing && <div className="table-builder-editing">Editing table</div>}
      </div>
      <div className="table-builder-opts">
        <div className="table-opt-row">
          <label className="table-opt-label">Environment</label>
          <select className="table-opt-select" value={env} onChange={e => setEnv(e.target.value)}>
            {TABLE_ENV_OPTIONS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
        </div>
        <div className="table-opt-row">
          <label className="table-opt-label">Alignment</label>
          <div className="table-opt-btns">
            {[['l', 'Left'], ['c', 'Center'], ['r', 'Right']].map(([v, l]) => (
              <button key={v} className={`table-opt-btn ${alignment === v ? 'active' : ''}`} onClick={() => setAlignment(v)} title={l}>{l[0]}</button>
            ))}
          </div>
        </div>
        <div className="table-opt-row">
          <label className="table-opt-label">Booktabs</label>
          <div className="table-vlines-icons">
            <button className={`table-vline-icon${borders === 'booktabs' ? ' active' : ''}`}
              title="Booktabs (toprule/midrule/bottomrule)" onClick={() => {
                setBorders('booktabs');
                setVlines(Array(cols + 1).fill(false));
              }}>
              <svg width="20" height="16" viewBox="0 0 20 16">
                <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                <line x1="2" y1="1" x2="18" y2="1" stroke="var(--accent, #4fc3f7)" strokeWidth="2.5" />
                <line x1="2" y1="5.5" x2="18" y2="5.5" stroke="var(--accent, #4fc3f7)" strokeWidth="1" />
                <line x1="2" y1="15" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2.5" />
              </svg>
            </button>
            <span className="table-vlines-sep" />
          </div>
        </div>
        <div className="table-opt-row">
          <label className="table-opt-label">Horizontal lines</label>
          <div className={`table-vlines-icons${borders === 'booktabs' ? ' disabled' : ''}`}>
            {[
              { mode: 'none', title: 'None', lines: [] },
              { mode: 'outside', title: 'Top & Bottom', lines: [[1, 15]] },
              { mode: 'header', title: 'Top, Header & Bottom', lines: [[1, 15], [5.5, null]] },
              { mode: 'all', title: 'All', lines: [[1, 15], [5.5, null], [10, null]] },
            ].map(({ mode, title, lines: hlines }) => (
              <button key={mode} className={`table-vline-icon${borders === mode ? ' active' : ''}`}
                title={title} disabled={borders === 'booktabs'} onClick={() => setBorders(mode)}>
                <svg width="20" height="16" viewBox="0 0 20 16">
                  <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                  {hlines.map((hl, i) => {
                    if (hl[1] !== null) {
                      return <React.Fragment key={i}>
                        <line x1="2" y1={hl[0]} x2="18" y2={hl[0]} stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                        <line x1="2" y1={hl[1]} x2="18" y2={hl[1]} stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                      </React.Fragment>;
                    }
                    return <line key={i} x1="2" y1={hl[0]} x2="18" y2={hl[0]} stroke="var(--accent, #4fc3f7)" strokeWidth="1.5" />;
                  })}
                </svg>
              </button>
            ))}
          </div>
        </div>
        {hasSize && (
          <div className="table-opt-row">
            <label className="table-opt-label">Vertical lines</label>
            <div className={`table-vlines-icons${borders === 'booktabs' ? ' disabled' : ''}`}>
              {['none', 'outside', 'all'].map(mode => {
                const current = vlines.every(v => v) ? 'all' :
                  vlines[0] && vlines[cols] && vlines.slice(1, cols).every(v => !v) ? 'outside' : 'none';
                return (
                  <button key={mode} className={`table-vline-icon${current === mode ? ' active' : ''}`}
                    title={mode.charAt(0).toUpperCase() + mode.slice(1)}
                    disabled={borders === 'booktabs'}
                    onClick={() => {
                      if (mode === 'all') setVlines(Array(cols + 1).fill(true));
                      else if (mode === 'outside') setVlines([true, ...Array(Math.max(0, cols - 1)).fill(false), true]);
                      else setVlines(Array(cols + 1).fill(false));
                    }}>
                    <svg width="20" height="16" viewBox="0 0 20 16">
                      <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                      {mode === 'outside' && (<>
                        <line x1="2" y1="1" x2="2" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                        <line x1="18" y1="1" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                      </>)}
                      {mode === 'all' && (<>
                        <line x1="2" y1="1" x2="2" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                        <line x1="7.5" y1="1" x2="7.5" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="1.5" />
                        <line x1="12.5" y1="1" x2="12.5" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="1.5" />
                        <line x1="18" y1="1" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                      </>)}
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="table-opt-row table-opt-checks">
          <label className="table-opt-check"><input type="checkbox" checked={headerRow} onChange={() => setHeaderRow(v => !v)} /> Header row</label>
          <label className="table-opt-check"><input type="checkbox" checked={boldHeader} onChange={() => setBoldHeader(v => !v)} /> Bold header</label>
          <label className="table-opt-check"><input type="checkbox" checked={caption} onChange={() => setCaption(v => !v)} /> Caption</label>
          <label className="table-opt-check"><input type="checkbox" checked={centering} onChange={() => setCentering(v => !v)} /> Centered</label>
          <label className="table-opt-check"><input type="checkbox" checked={zebra} onChange={() => setZebra(v => !v)} /> Zebra stripes</label>
        </div>
        {caption && (
          <>
            <div className="table-opt-row">
              <label className="table-opt-label">Caption</label>
              <input className="table-opt-input" type="text" placeholder="Caption here" value={captionText} onChange={e => setCaptionText(e.target.value)} />
            </div>
            <div className="table-opt-row">
              <label className="table-opt-label">Label</label>
              <input className="table-opt-input" type="text" placeholder="tab:mytable" value={label} onChange={e => setLabel(e.target.value)} />
            </div>
          </>
        )}
      </div>
      <div className="table-builder-actions">
        <button className="table-builder-insert" onClick={handleInsert} disabled={!hasSize}>{isEditing ? 'Update' : 'Insert'}</button>
        <button className="table-builder-cancel" onClick={onClose}>Cancel</button>
      </div>
      {hasSize && (
        <div className="table-cell-layout">
          <div className="table-cell-layout-header">
            <span className="table-cell-layout-title">Cell layout</span>
            {selection && selectionSpan(selection).cells > 1 && !selectionOverlapsMerge(merges, selection) && (
              <button className="table-merge-btn" onClick={() => {
                const { r1, c1, r2, c2 } = normalizeSelection(selection);
                setMerges(prev => [...prev, { row: r1, col: c1, rowSpan: r2 - r1 + 1, colSpan: c2 - c1 + 1, align: alignment }]);
                setSelection(null);
              }}>Merge</button>
            )}
          </div>
          <div className="table-cell-preview" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
            onMouseUp={() => setSelecting(false)}
            onMouseLeave={() => setSelecting(false)}
          >
            {Array.from({ length: rows }, (_, r) =>
              Array.from({ length: cols }, (_, c) => {
                const merge = getMergeAt(merges, r, c);
                const covered = isCoveredByMerge(merges, r, c);
                if (covered) return null;
                const cellContent = initial?.cells?.[r]?.[c];
                const display = cellContent != null ? cellContent.slice(0, 30) : '';
                const isSel = selection && isInSelection(selection, r, c);
                const style = {};
                if (merge) {
                  if (merge.colSpan > 1) style.gridColumn = `span ${merge.colSpan}`;
                  if (merge.rowSpan > 1) style.gridRow = `span ${merge.rowSpan}`;
                }
                return (
                  <div key={`${r}-${c}`}
                    className={`table-cell-preview-cell${isSel ? ' selected' : ''}${merge ? ' merged' : ''}${headerRow && r === 0 ? ' header' : ''}`}
                    style={style}
                    title={cellContent || `(${r+1}, ${c+1})`}
                    onMouseDown={(e) => { e.preventDefault(); setSelection({ startRow: r, startCol: c, endRow: r, endCol: c }); setSelecting(true); }}
                    onMouseEnter={() => { if (selecting) setSelection(prev => prev ? { ...prev, endRow: r, endCol: c } : prev); }}
                    onClick={() => {
                      // Click on merged cell: offer unmerge
                      if (merge) {
                        setMerges(prev => prev.filter(m => m !== merge));
                        setSelection(null);
                      }
                    }}
                  >
                    {merge && <span className="table-cell-merge-badge">{merge.colSpan > 1 || merge.rowSpan > 1 ? `${merge.rowSpan}×${merge.colSpan}` : ''}</span>}
                    {display}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TableGridPicker;
