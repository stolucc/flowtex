// @ts-check
import React, { useState } from 'react';
import generateLatexTable, { getMergeAt, isCoveredByMerge } from '../utils/latexTableGenerator.js';

/** Available LaTeX table environment options for the environment selector dropdown. */
const TABLE_ENV_OPTIONS = [
  { value: 'tabular', label: 'tabular' },
  { value: 'tabularx', label: 'tabularx (full width)' },
  { value: 'longtable', label: 'longtable (multi-page)' },
  { value: 'array', label: 'array (math mode)' },
];

/**
 * Interactive table builder with grid size selection, cell editing, merge, alignment, and LaTeX generation.
 * @param {any} props
 */
function TableGridPicker({ onInsert, onClose, onDelete, initial, multiColumn, declaredPackages }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const MAX_ROWS = 12;
  const MAX_COLS = 12;
  const [hover, setHover] = useState({ r: 0, c: 0 });
  const [rows, setRows] = useState(initial?.rows || 0);
  const [cols, setCols] = useState(initial?.cols || 0);
  const [sizeConfirmed, setSizeConfirmed] = useState(!!initial?.cells);
  const [placement, setPlacement] = useState(initial?.placement || 'htbp');
  // Per-column alignment: array of { align: 'l'|'c'|'r'|'p', width?: string }
  const [colSettings, setColSettings] = useState(() => {
    if (initial?.alignments && initial.alignments.length > 0) {
      // Merge alignments with colWidths: 'p' columns get their width from colWidths
      const widths = initial.colWidths || [];
      return initial.alignments.map((/** @type {any} */ a, /** @type {any} */ i) => {
        if (a === 'p' && widths[i]) return { align: 'p', width: widths[i] };
        return { align: a };
      });
    }
    const n = initial?.cols || 0;
    return Array.from({ length: n }, () => ({ align: initial?.alignment || 'c' }));
  });
  const [borders, setBorders] = useState(initial?.borders || 'none');
  const [headerRow, setHeaderRow] = useState(initial?.headerRow ?? true);
  const [caption, setCaption] = useState(initial?.caption || false);
  const [captionText, setCaptionText] = useState(initial?.captionText || '');
  const [label, setLabel] = useState(initial?.label || '');
  const [captionPos, setCaptionPos] = useState(initial?.captionPos || 'top');
  const [captionVAlign, setCaptionVAlign] = useState(initial?.captionVAlign || 'center');
  const [env, setEnv] = useState(initial?.env || 'tabular');
  const [centering, setCentering] = useState(initial?.centering ?? true);
  const [boldHeader, setBoldHeader] = useState(initial?.boldHeader || false);
  const [zebra, setZebra] = useState(initial?.zebra || false);
  // Booktabs row separator: 'none' | 'midrule' | 'addlinespace'
  const [booktabsSep, setBooktabsSep] = useState(initial?.booktabsSep || 'none');
  const [merges, setMerges] = useState(initial?.merges || []);
  // Partial horizontal rules: array of { row, fromCol, toCol } (0-based)
  const [clines, setClines] = useState(initial?.clines || []);
  // Vertical lines: array of cols+1 booleans (left edge, between each col, right edge)
  const [vlines, setVlines] = useState(() => {
    if (initial?.vlines) return initial.vlines;
    if (initial?.borders === 'all') return Array(initial.cols + 1).fill(true);
    return Array((initial?.cols || 0) + 1).fill(false);
  });
  const [selection, setSelection] = useState(/** @type {any} */ (null)); // { startRow, startCol, endRow, endCol }
  const [selecting, setSelecting] = useState(false);

  const isEditing = !!initial?.cells;
  const hasSize = rows > 0 && cols > 0;

  // Compute minimum rows/cols based on last row/col with actual content
  let minRows = 0,
    minCols = 0;
  if (isEditing && initial.cells) {
    for (let r = initial.cells.length - 1; r >= 0; r--) {
      if (initial.cells[r]?.some((/** @type {any} */ c) => c != null && c.trim().length > 0)) {
        minRows = r + 1;
        break;
      }
    }
    for (let r = 0; r < initial.cells.length; r++) {
      const row = initial.cells[r];
      if (!row) continue;
      // Skip header row — its content is auto-generated and shouldn't prevent column removal
      if (headerRow && r === 0) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        if (row[c] != null && row[c].trim().length > 0 && c + 1 > minCols) {
          minCols = c + 1;
          break;
        }
      }
    }
    // Cap to grid size so the builder is never stuck
    minRows = Math.min(minRows, MAX_ROWS);
    minCols = Math.min(minCols, MAX_COLS);
  }

  const handleGridClick = (/** @type {any} */ r, /** @type {any} */ c) => {
    const newCols = Math.max(c, minCols);
    setRows(Math.max(r, minRows));
    setCols(newCols);
    setSizeConfirmed(true);
    // Resize vlines array to match new column count
    setVlines((prev) => {
      const needed = newCols + 1;
      if (prev.length === needed) return prev;
      if (prev.length < needed) return [...prev, ...Array(needed - prev.length).fill(false)];
      return prev.slice(0, needed);
    });
    // Resize colSettings to match new column count
    setColSettings((prev) => {
      const defaultAlign = prev.length > 0 ? prev[prev.length - 1].align : 'c';
      if (prev.length < newCols) return [...prev, ...Array(newCols - prev.length).fill({ align: defaultAlign })];
      return prev.slice(0, newCols);
    });
  };

  /** Normalize a drag selection so r1/c1 is always the top-left corner. */
/** @param {any} sel */
  function normalizeSelection(sel) {
    return {
      r1: Math.min(sel.startRow, sel.endRow),
      c1: Math.min(sel.startCol, sel.endCol),
      r2: Math.max(sel.startRow, sel.endRow),
      c2: Math.max(sel.startCol, sel.endCol),
    };
  }
  /** Check whether cell (r, c) falls within the given selection rectangle. */
  function isInSelection(sel, r, c) {
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return r >= r1 && r <= r2 && c >= c1 && c <= c2;
  }
  /** Return the row count, column count, and total cell count of a selection. */
/** @param {any} sel */
  function selectionSpan(sel) {
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return { rows: r2 - r1 + 1, cols: c2 - c1 + 1, cells: (r2 - r1 + 1) * (c2 - c1 + 1) };
  }
  /** Return true if the selection partially overlaps any existing merge (full containment is allowed). */
/** @param {any} merges */
/** @param {any} sel */
  function selectionOverlapsMerge(merges, sel) {
    if (!sel || !merges.length) return false;
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return merges.some((/** @type {any} */ m) => {
      const mr2 = m.row + m.rowSpan - 1,
        mc2 = m.col + m.colSpan - 1;
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
    const table = generateLatexTable({
      rows,
      cols,
      colSettings,
      borders,
      headerRow,
      caption,
      captionPos,
      captionVAlign,
      captionText,
      label,
      env,
      placement,
      centering,
      boldHeader,
      zebra,
      cells,
      longtablePreamble: initial?.longtablePreamble,
      merges,
      vlines,
      booktabsSep,
      clines,
    });
    onInsert(table);
    onClose();
  };

  return (
    <div className="table-builder">
      <div className="table-builder-left">
        <div className="table-grid-label">
          {hover.r > 0 ? `${hover.r} \u00d7 ${hover.c}` : hasSize ? `${rows} \u00d7 ${cols}` : 'Select size'}
        </div>
        <div
          className="table-grid"
          onMouseLeave={() => setHover({ r: 0, c: 0 })}
        >
          {Array.from({ length: MAX_ROWS }, (_, r) => (
            <div key={r} className="table-grid-row">
              {Array.from({ length: MAX_COLS }, (_, c) => {
                const hr = hover.r || rows;
                const hc = hover.c || cols;
                const active = sizeConfirmed
                  ? (r < rows && c < cols) || (hover.r > 0 && r < hover.r && c < hover.c)
                  : r < hr && c < hc;
                return (
                  <div
                    key={c}
                    className={`table-grid-cell ${active ? 'active' : ''}${isEditing && r < minRows && c < minCols ? ' locked' : ''}`}
                    onMouseEnter={() => setHover({ r: Math.max(r + 1, minRows), c: Math.max(c + 1, minCols) })}
                    onClick={() => handleGridClick(r + 1, c + 1)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="table-builder-opts">
        <div className="table-opts-columns">
          <div className="table-opts-left">
            <div className="table-opt-row">
              <label className="table-opt-label">Environment</label>
              <select className="table-opt-select" value={env} onChange={(/** @type {any} */ e) => {
                setEnv(e.target.value);
                if (e.target.value === 'longtable' && (captionPos === 'left' || captionPos === 'right')) {
                  setCaptionPos('top');
                  setCaptionVAlign('center');
                }
              }}>
                {TABLE_ENV_OPTIONS.map((/** @type {any} */ e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>
            {env !== 'longtable' && (
              <div className="table-opt-row">
                <label className="table-opt-label">Placement</label>
                <select className="table-opt-select" value={placement} onChange={(/** @type {any} */ e) => setPlacement(e.target.value)}>
                  <option value="htbp">Auto [htbp]</option>
                  <option value="H">Here [H]</option>
                  <option value="t">Top [t]</option>
                  <option value="b">Bottom [b]</option>
                </select>
              </div>
            )}
            <div className="table-opt-row">
              <label className="table-opt-label">Booktabs</label>
              <div className="table-vlines-icons">
                <button
                  className={`table-vline-icon${borders === 'booktabs' ? ' active' : ''}`}
                  title="Booktabs (toprule/midrule/bottomrule)"
                  onClick={() => {
                    if (borders === 'booktabs') {
                      setBorders('none');
                    } else {
                      setBorders('booktabs');
                      setVlines(Array(cols + 1).fill(false));
                    }
                  }}
                >
                  <svg width="20" height="16" viewBox="0 0 20 16">
                    <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                    <line x1="2" y1="1" x2="18" y2="1" stroke="var(--accent, #4fc3f7)" strokeWidth="2.5" />
                    <line x1="2" y1="5.5" x2="18" y2="5.5" stroke="var(--accent, #4fc3f7)" strokeWidth="1" />
                    <line x1="2" y1="15" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2.5" />
                  </svg>
                </button>
                <span className="table-vlines-sep" />
                <button
                  className={`table-vline-icon${booktabsSep === 'addlinespace' && borders === 'booktabs' ? ' active' : ''}`}
                  title="\addlinespace between rows"
                  disabled={borders !== 'booktabs'}
                  onClick={() => setBooktabsSep(booktabsSep === 'addlinespace' ? 'none' : 'addlinespace')}
                >
                  <svg width="20" height="16" viewBox="0 0 20 16">
                    <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                    <line x1="2" y1="3" x2="18" y2="3" stroke="var(--accent, #4fc3f7)" strokeWidth="1.2" />
                    <line x1="2" y1="13" x2="18" y2="13" stroke="var(--accent, #4fc3f7)" strokeWidth="1.2" />
                    <path d="M6 7 L10 9 L14 7" fill="none" stroke="var(--accent, #4fc3f7)" strokeWidth="1" opacity="0.6" />
                  </svg>
                </button>
                <button
                  className={`table-vline-icon${booktabsSep === 'midrule' && borders === 'booktabs' ? ' active' : ''}`}
                  title="\midrule between rows"
                  disabled={borders !== 'booktabs'}
                  onClick={() => setBooktabsSep(booktabsSep === 'midrule' ? 'none' : 'midrule')}
                >
                  <svg width="20" height="16" viewBox="0 0 20 16">
                    <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                    <line x1="2" y1="3" x2="18" y2="3" stroke="var(--accent, #4fc3f7)" strokeWidth="1.2" />
                    <line x1="2" y1="8" x2="18" y2="8" stroke="var(--accent, #4fc3f7)" strokeWidth="1" />
                    <line x1="2" y1="13" x2="18" y2="13" stroke="var(--accent, #4fc3f7)" strokeWidth="1.2" />
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
                  {
                    mode: 'header',
                    title: 'Top, Header & Bottom',
                    lines: [
                      [1, 15],
                      [5.5, null],
                    ],
                  },
                  {
                    mode: 'all',
                    title: 'All',
                    lines: [
                      [1, 15],
                      [5.5, null],
                      [10, null],
                    ],
                  },
                ].map(({ mode, title, lines: hlines }) => (
                  <button
                    key={mode}
                    className={`table-vline-icon${borders === mode && borders !== 'booktabs' ? ' active' : ''}`}
                    title={title}
                    disabled={borders === 'booktabs'}
                    onClick={() => setBorders(mode)}
                  >
                    <svg width="20" height="16" viewBox="0 0 20 16">
                      <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                      {hlines.map((/** @type {any} */ hl, /** @type {any} */ i) => {
                        if (hl[1] !== null) {
                          return (
                            <React.Fragment key={i}>
                              <line
                                x1="2"
                                y1={hl[0]}
                                x2="18"
                                y2={hl[0]}
                                stroke="var(--accent, #4fc3f7)"
                                strokeWidth="2"
                              />
                              <line
                                x1="2"
                                y1={hl[1]}
                                x2="18"
                                y2={hl[1]}
                                stroke="var(--accent, #4fc3f7)"
                                strokeWidth="2"
                              />
                            </React.Fragment>
                          );
                        }
                        return (
                          <line
                            key={i}
                            x1="2"
                            y1={hl[0]}
                            x2="18"
                            y2={hl[0]}
                            stroke="var(--accent, #4fc3f7)"
                            strokeWidth="1.5"
                          />
                        );
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
                  {['none', 'outside', 'all'].map((/** @type {any} */ mode) => {
                    const current = vlines.every((/** @type {any} */ v) => v)
                      ? 'all'
                      : vlines[0] && vlines[cols] && vlines.slice(1, cols).every((/** @type {any} */ v) => !v)
                        ? 'outside'
                        : 'none';
                    return (
                      <button
                        key={mode}
                        className={`table-vline-icon${current === mode && borders !== 'booktabs' ? ' active' : ''}`}
                        title={mode.charAt(0).toUpperCase() + mode.slice(1)}
                        disabled={borders === 'booktabs'}
                        onClick={() => {
                          if (mode === 'all') setVlines(Array(cols + 1).fill(true));
                          else if (mode === 'outside')
                            setVlines([true, ...Array(Math.max(0, cols - 1)).fill(false), true]);
                          else setVlines(Array(cols + 1).fill(false));
                        }}
                      >
                        <svg width="20" height="16" viewBox="0 0 20 16">
                          <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                          {mode === 'outside' && (
                            <>
                              <line x1="2" y1="1" x2="2" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                              <line x1="18" y1="1" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                            </>
                          )}
                          {mode === 'all' && (
                            <>
                              <line x1="2" y1="1" x2="2" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                              <line
                                x1="7.5"
                                y1="1"
                                x2="7.5"
                                y2="15"
                                stroke="var(--accent, #4fc3f7)"
                                strokeWidth="1.5"
                              />
                              <line
                                x1="12.5"
                                y1="1"
                                x2="12.5"
                                y2="15"
                                stroke="var(--accent, #4fc3f7)"
                                strokeWidth="1.5"
                              />
                              <line x1="18" y1="1" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                            </>
                          )}
                        </svg>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="table-opts-right">
            <label className="table-opt-toggle">
              <span className="table-opt-toggle-label">Header row</span>
              <button
                className={`table-toggle${headerRow ? ' on' : ''}`}
                onClick={() => setHeaderRow((v) => !v)}
                role="switch"
                aria-checked={headerRow}
              >
                <span className="table-toggle-knob" />
              </button>
            </label>
            <label className="table-opt-toggle">
              <span className="table-opt-toggle-label">Bold header</span>
              <button
                className={`table-toggle${boldHeader ? ' on' : ''}`}
                onClick={() => setBoldHeader((v) => !v)}
                role="switch"
                aria-checked={boldHeader}
              >
                <span className="table-toggle-knob" />
              </button>
            </label>
            <label className={`table-opt-toggle${captionPos === 'left' || captionPos === 'right' ? ' disabled' : ''}`}>
              <span className="table-opt-toggle-label">Centered</span>
              <button
                className={`table-toggle${centering && captionPos !== 'left' && captionPos !== 'right' ? ' on' : ''}`}
                onClick={() => { if (captionPos !== 'left' && captionPos !== 'right') setCentering((v) => !v); }}
                role="switch"
                aria-checked={centering && captionPos !== 'left' && captionPos !== 'right'}
                disabled={captionPos === 'left' || captionPos === 'right'}
              >
                <span className="table-toggle-knob" />
              </button>
            </label>
            <label className="table-opt-toggle">
              <span className="table-opt-toggle-label">Zebra stripes</span>
              <button
                className={`table-toggle${zebra ? ' on' : ''}`}
                onClick={() => setZebra((v) => !v)}
                role="switch"
                aria-checked={zebra}
              >
                <span className="table-toggle-knob" />
              </button>
            </label>
          </div>
        </div>
        <div className="table-opt-caption-group">
          <label className="table-opt-toggle">
            <span className="table-opt-toggle-label">Caption</span>
            <button
              className={`table-toggle${caption ? ' on' : ''}`}
              onClick={() => setCaption((v) => !v)}
              role="switch"
              aria-checked={caption}
            >
              <span className="table-toggle-knob" />
            </button>
          </label>
          {caption && (
            <>
              <div className="table-opt-row">
                <label className="table-opt-label">Position</label>
                <div className="caption-pos-grid">
                  {[
                    ['top', 'center', 'Top', <svg key="t" width="18" height="14" viewBox="0 0 18 14"><rect x="2" y="4" width="14" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="4" y1="1.5" x2="14" y2="1.5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                    ['bottom', 'center', 'Bottom', <svg key="b" width="18" height="14" viewBox="0 0 18 14"><rect x="2" y="1" width="14" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="4" y1="12.5" x2="14" y2="12.5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                    ['left', 'top', 'Top left', <svg key="lt" width="18" height="14" viewBox="0 0 18 14"><rect x="6" y="1" width="11" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="2" y1="2" x2="2" y2="5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                    ['left', 'center', 'Center left', <svg key="lc" width="18" height="14" viewBox="0 0 18 14"><rect x="6" y="1" width="11" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="2" y1="4.5" x2="2" y2="9.5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                    ['left', 'bottom', 'Bottom left', <svg key="lb" width="18" height="14" viewBox="0 0 18 14"><rect x="6" y="1" width="11" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="2" y1="9" x2="2" y2="12" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                    ['right', 'top', 'Top right', <svg key="rt" width="18" height="14" viewBox="0 0 18 14"><rect x="1" y="1" width="11" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="16" y1="2" x2="16" y2="5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                    ['right', 'center', 'Center right', <svg key="rc" width="18" height="14" viewBox="0 0 18 14"><rect x="1" y="1" width="11" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="16" y1="4.5" x2="16" y2="9.5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                    ['right', 'bottom', 'Bottom right', <svg key="rb" width="18" height="14" viewBox="0 0 18 14"><rect x="1" y="1" width="11" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="16" y1="9" x2="16" y2="12" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/></svg>],
                  ].map(([pos, valign, title, icon]) => (
                    <button
                      key={title}
                      className={`table-opt-btn ${captionPos === pos && captionVAlign === valign ? 'active' : ''}`}
                      onClick={() => {
                        setCaptionPos(pos);
                        setCaptionVAlign(valign);
                      }}
                      title={title}
                      disabled={(env === 'longtable' || multiColumn) && (pos === 'left' || pos === 'right')}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
              <div className="table-opt-row">
                <label className="table-opt-label">Caption</label>
                <input
                  className="table-opt-input"
                  type="text"
                  placeholder="Caption here"
                  value={captionText}
                  onChange={(/** @type {any} */ e) => setCaptionText(e.target.value)}
                />
              </div>
              <div className="table-opt-row">
                <label className="table-opt-label">Label</label>
                <input
                  className="table-opt-input"
                  type="text"
                  placeholder="tab:mytable"
                  value={label}
                  onChange={(/** @type {any} */ e) => setLabel(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
        {(borders === 'booktabs' || captionPos === 'left' || captionPos === 'right' || placement === 'H' || zebra) && (
          <div className="table-pkg-notice">
            {borders === 'booktabs' && <span>{declaredPackages && (declaredPackages.has('booktabs') ? <span className="pkg-ok" title="Included in preamble">☑</span> : <span className="pkg-warn" title="Not in preamble">⚠</span>)}Requires <code>\usepackage{'{'}booktabs{'}'}</code></span>}
            {(captionPos === 'left' || captionPos === 'right') && <span>{declaredPackages && (declaredPackages.has('floatrow') ? <span className="pkg-ok" title="Included in preamble">☑</span> : <span className="pkg-warn" title="Not in preamble">⚠</span>)}Requires <code>\usepackage{'{'}floatrow{'}'}</code></span>}
            {placement === 'H' && <span>{declaredPackages && (declaredPackages.has('float') ? <span className="pkg-ok" title="Included in preamble">☑</span> : <span className="pkg-warn" title="Not in preamble">⚠</span>)}Requires <code>\usepackage{'{'}float{'}'}</code></span>}
            {zebra && <span>{declaredPackages && (declaredPackages.has('xcolor') ? <span className="pkg-ok" title="Included in preamble">☑</span> : <span className="pkg-warn" title="Not in preamble">⚠</span>)}Requires <code>\usepackage[table]{'{'}xcolor{'}'}</code></span>}
          </div>
        )}
        <div className="table-builder-actions">
          {onDelete && !confirmDelete && (
            <button className="table-builder-delete" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
          {confirmDelete && (
            <span className="table-delete-confirm">
              <span className="table-delete-confirm-label">Delete table?</span>
              <button className="table-delete-confirm-yes" onClick={onDelete}>Yes</button>
              <button className="table-delete-confirm-no" onClick={() => setConfirmDelete(false)}>No</button>
            </span>
          )}
          <button className="table-builder-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="table-builder-insert" onClick={handleInsert} disabled={!hasSize}>
            {isEditing ? 'Update' : 'Insert'}
          </button>
        </div>
      </div>
      {hasSize && (
        <div className="table-cell-layout">
          <div className="table-cell-layout-header">
            <span className="table-cell-layout-title">Cell layout</span>
            {selection && selectionSpan(selection).cells > 1 && !selectionOverlapsMerge(merges, selection) && (
              <button
                className="table-merge-btn"
                onClick={() => {
                  const { r1, c1, r2, c2 } = normalizeSelection(selection);
                  setMerges((prev) => [
                    ...prev,
                    { row: r1, col: c1, rowSpan: r2 - r1 + 1, colSpan: c2 - c1 + 1, align: colSettings[c1]?.align || 'c' },
                  ]);
                  setSelection(null);
                }}
              >
                Merge
              </button>
            )}
            {selection && (() => {
              const { r1, c1, r2, c2 } = normalizeSelection(selection);
              if (r1 !== r2) return null;
              if (c1 === 0 && c2 === cols - 1) return null;
              const existing = clines.find((/** @type {any} */ cl) => cl.row === r1 && cl.fromCol === c1 && cl.toCol === c2);
              const isBt = borders === 'booktabs';
              if (existing) {
                return (
                  <>
                    {isBt && (
                      <select
                        className="table-opt-select table-cline-trim-select"
                        value={existing.trim || ''}
                        onChange={(/** @type {any} */ e) => {
                          const trim = e.target.value;
                          setClines((prev) => prev.map((/** @type {any} */ cl) =>
                            cl === existing ? { ...cl, trim } : cl
                          ));
                        }}
                      >
                        <option value="">no trim</option>
                        <option value="lr">trim (lr)</option>
                        <option value="l">trim (l)</option>
                        <option value="r">trim (r)</option>
                      </select>
                    )}
                    <button
                      className="table-merge-btn"
                      onClick={() => {
                        setClines((prev) => prev.filter((/** @type {any} */ cl) => cl !== existing));
                        setSelection(null);
                      }}
                    >
                      Remove rule
                    </button>
                  </>
                );
              }
              return (
                <>
                  {isBt && (
                    <select
                      className="table-opt-select table-cline-trim-select"
                      id="cline-new-trim"
                      defaultValue="lr"
                    >
                      <option value="">no trim</option>
                      <option value="lr">trim (lr)</option>
                      <option value="l">trim (l)</option>
                      <option value="r">trim (r)</option>
                    </select>
                  )}
                  <button
                    className="table-merge-btn"
                    onClick={() => {
                      const trimVal = isBt ? (document.getElementById('cline-new-trim')?.value || 'lr') : '';
                      setClines((prev) => [...prev, { row: r1, fromCol: c1, toCol: c2, trim: trimVal }]);
                      setSelection(null);
                    }}
                  >
                    {isBt ? '\\cmidrule' : '\\cline'}
                  </button>
                </>
              );
            })()}
          </div>
          <div className="table-col-headers" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {Array.from({ length: cols }, (_, c) => {
              const cs = colSettings[c] || { align: 'c' };
              return (
                <div key={c} className="table-col-header">
                  <div className="table-col-align-btns">
                    {['l', 'c', 'r', 'p'].map((/** @type {any} */ a) => (
                      <button
                        key={a}
                        className={`table-col-align-btn${cs.align === a ? ' active' : ''}`}
                        onClick={() => {
                          setColSettings((prev) => {
                            const next = [...prev];
                            while (next.length <= c) next.push({ align: 'c' });
                            if (a === 'p' && !next[c].width) {
                              const sideC = captionPos === 'left' || captionPos === 'right';
                              const base = sideC ? 0.55 : 0.97;
                              const total = Math.max(0.3, base - cols * 0.035);
                              next[c] = { align: 'p', width: `${(total / cols).toFixed(2)}\\textwidth` };
                            } else {
                              next[c] = { ...next[c], align: a };
                            }
                            return next;
                          });
                        }}
                        title={a === 'p' ? 'Fixed width' : a === 'l' ? 'Left' : a === 'c' ? 'Center' : 'Right'}
                      >
                        {a.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  {cs.align === 'p' && (
                    <input
                      className="table-col-width-input"
                      type="text"
                      value={cs.width || ''}
                      onChange={(/** @type {any} */ e) => {
                        setColSettings((prev) => {
                          const next = [...prev];
                          next[c] = { ...next[c], width: e.target.value };
                          return next;
                        });
                      }}
                      placeholder="e.g. 3cm"
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div
            className="table-cell-preview"
            style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
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
                // Check if a cline covers this cell's bottom edge
                const effectiveColEnd = merge ? c + (merge.colSpan || 1) - 1 : c;
                const hasClineBelow = clines.some((/** @type {any} */ cl) => cl.row === r && cl.fromCol <= c && cl.toCol >= effectiveColEnd);
                if (hasClineBelow) {
                  style.borderBottom = '2px solid var(--accent)';
                }
                return (
                  <div
                    key={`${r}-${c}`}
                    className={`table-cell-preview-cell${isSel ? ' selected' : ''}${merge ? ' merged' : ''}${headerRow && r === 0 ? ' header' : ''}`}
                    style={style}
                    title={cellContent || `(${r + 1}, ${c + 1})`}
                    onMouseDown={(/** @type {any} */ e) => {
                      e.preventDefault();
                      setSelection({ startRow: r, startCol: c, endRow: r, endCol: c });
                      setSelecting(true);
                    }}
                    onMouseEnter={() => {
                      if (selecting) setSelection((prev) => (prev ? { ...prev, endRow: r, endCol: c } : prev));
                    }}
                    onClick={() => {
                      // Click on merged cell: offer unmerge
                      if (merge) {
                        setMerges((prev) => prev.filter((/** @type {any} */ m) => m !== merge));
                        setSelection(null);
                      }
                    }}
                  >
                    {merge && (
                      <span className="table-cell-merge-badge">
                        {merge.colSpan > 1 || merge.rowSpan > 1 ? `${merge.rowSpan}×${merge.colSpan}` : ''}
                      </span>
                    )}
                    {display}
                  </div>
                );
              }),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TableGridPicker;
