// @ts-check
import React, { useState, useEffect, useRef } from 'react';
import SYMBOL_CATEGORIES from '../data/symbols.js';

/**
 * Grid-based picker for browsing and inserting LaTeX special symbols by category.
 * @param {any} props
 */
function SymbolPicker({ onInsert, onClose, declaredPackages }) {
  const [selected, setSelected] = useState(/** @type {any} */ (null));
  const [filter, setFilter] = useState('');
  const filterRef = useRef(/** @type {any} */ (null));

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  const filtered = filter.trim()
    ? SYMBOL_CATEGORIES.map((/** @type {any} */ cat) => ({
        ...cat,
        symbols: cat.symbols.filter(([cmd]) => cmd.toLowerCase().includes(filter.toLowerCase())),
      })).filter((/** @type {any} */ cat) => cat.symbols.length > 0)
    : SYMBOL_CATEGORIES;

  // Find package for selected symbol
  const selectedPkg = selected
    ? SYMBOL_CATEGORIES.flatMap((/** @type {any} */ c) => c.symbols).find((/** @type {any} */ s) => s[0] === selected)?.[2] || null
    : null;

  const handleInsert = (/** @type {any} */ cmd) => {
    onInsert(cmd);
    onClose();
  };

  return (
    <div className="symbol-picker-overlay" onClick={onClose}>
      <div className="symbol-picker" onClick={(/** @type {any} */ e) => e.stopPropagation()}>
        <div className="symbol-picker-header">
          <span className="symbol-picker-title">Insert Special Symbol</span>
          <button className="symbol-picker-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <input
          ref={filterRef}
          className="symbol-picker-filter"
          placeholder="Search symbols..."
          value={filter}
          onChange={(/** @type {any} */ e) => setFilter(e.target.value)}
        />
        <div className="symbol-picker-body">
          {filtered.map((/** @type {any} */ cat) => (
            <div key={cat.name} className="symbol-picker-category">
              <div className="symbol-picker-cat-name">{cat.name}</div>
              <div className="symbol-picker-grid">
                {cat.symbols.map(([cmd, glyph, pkg]) => (
                  <button
                    key={cmd}
                    className={`symbol-picker-cell${selected === cmd ? ' selected' : ''}${pkg ? ' has-pkg' : ''}`}
                    title={pkg ? `${cmd} (${pkg})` : cmd}
                    onClick={() => setSelected(cmd)}
                    onDoubleClick={() => handleInsert(cmd)}
                  >
                    {glyph}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="symbol-picker-empty">No symbols match &quot;{filter}&quot;</div>}
        </div>
        <div className="symbol-picker-footer">
          <div>
            <span className="symbol-picker-selected-cmd">{selected || ''}</span>
            {selectedPkg && <span className="symbol-picker-pkg">{declaredPackages && (declaredPackages.has(selectedPkg) ? <span className="pkg-ok" title="Included in preamble">☑</span> : <span className="pkg-warn" title="Not in preamble">⚠</span>)}Requires: \usepackage{'{' + selectedPkg + '}'}</span>}
          </div>
          <button
            className="symbol-picker-insert-btn"
            disabled={!selected}
            onClick={() => selected && handleInsert(selected)}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}

export default SymbolPicker;
