// @ts-check
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import useClickOutside from '../hooks/useClickOutside.js';
import { getCursorStyle } from '../utils/visualMode.js';
import { findMatchingBrace } from '../utils/latexParser.js';

/** LaTeX color name → CSS color map for toolbar indicators */
/** @type {Record<string, string>} */
const VM_COLOR_MAP = {
  black: '#000000', red: '#e53935', blue: '#1e88e5', green: '#43a047',
  orange: '#fb8c00', purple: '#8e24aa', cyan: '#00acc1', magenta: '#d81b60',
  brown: '#6d4c41', teal: '#00897b', violet: '#7b1fa2', olive: '#827717',
  gray: '#757575', NavyBlue: '#1565c0', ForestGreen: '#2e7d32', BrickRed: '#c62828',
  yellow: '#fdd835', lime: '#c0ca33', pink: '#f48fb1', lightgray: '#e0e0e0',
};

/**
 * Visual-mode formatting toolbar. Renders only when `visualMode` is true.
 *
 * The parent (Editor) is responsible for calling `ref.current.refresh()` whenever
 * the cursor moves so the toolbar can re-read the surrounding LaTeX context.
 *
 * Props:
 *   viewRef          — ref to the CodeMirror EditorView
 *   visualMode       — boolean toggling visibility / behavior
 *   onInsertList     — callback used for the bullet/numbered list buttons. Kept in
 *                      Editor.jsx because it shares logic with the visual-mode
 *                      keymap (Enter/Tab/Shift-Tab) which also operates on lists.
 */
const VisualModeToolbar = forwardRef(/**
 * @param {any} props
 * @param {any} ref
 */
function VisualModeToolbar(
  { viewRef, visualMode, onInsertList, onInsertQuote, citeKeys },
  ref,
) {
  // ── Visual mode formatting state ──
  const [vmBold, setVmBold] = useState(false);
  const [vmItalic, setVmItalic] = useState(false);
  const [vmUnderline, setVmUnderline] = useState(false);
  const [vmHeadingLevel, setVmHeadingLevel] = useState('normal');
  const [vmBlockStyle, setVmBlockStyle] = useState('Normal');
  const [vmTextColor, setVmTextColor] = useState(/** @type {any} */ (null));
  const [vmHighlightColor, setVmHighlightColor] = useState(/** @type {any} */ (null));
  const [vmTextColorOpen, setVmTextColorOpen] = useState(false);
  const [vmHighlightOpen, setVmHighlightOpen] = useState(false);
  const vmTextColorRef = useRef(/** @type {any} */ (null));
  const vmHighlightRef = useRef(/** @type {any} */ (null));
  useClickOutside(vmTextColorRef, () => setVmTextColorOpen(false), vmTextColorOpen);
  useClickOutside(vmHighlightRef, () => setVmHighlightOpen(false), vmHighlightOpen);

  // Citation picker
  const [vmCiteOpen, setVmCiteOpen] = useState(false);
  const [vmCiteQuery, setVmCiteQuery] = useState('');
  const [vmCiteIdx, setVmCiteIdx] = useState(0);
  const vmCiteRef = useRef(/** @type {any} */ (null));
  const vmCiteInputRef = useRef(/** @type {any} */ (null));
  useClickOutside(vmCiteRef, () => setVmCiteOpen(false), vmCiteOpen);
  useEffect(() => {
    if (vmCiteOpen) {
      setVmCiteQuery('');
      setVmCiteIdx(0);
      // Focus the search input on next tick
      setTimeout(() => vmCiteInputRef.current?.focus(), 0);
    }
  }, [vmCiteOpen]);

  // Update visual mode toolbar state when cursor moves
  const vmUpdateState = useCallback(() => {
    const view = viewRef.current;
    if (!view || !visualMode) return;
    const { from } = view.state.selection.main;

    // Use the proper cursor style detector
    const style = getCursorStyle(view.state.doc, from);

    // Map block style to heading select value
    /** @type {Record<string, string>} */
    const blockToLevel = {
      Part: 'part', Chapter: 'chapter', Section: 'section',
      Subsection: 'subsection', Subsubsection: 'subsubsection',
      Paragraph: 'paragraph',
    };
    setVmHeadingLevel(blockToLevel[style.block] || 'normal');
    setVmBlockStyle(style.block);

    // Map inline formatting
    setVmBold(style.inline.includes('bold'));
    setVmItalic(style.inline.includes('italic'));
    setVmUnderline(style.inline.includes('underline'));
    setVmTextColor(style.textColor || null);
    setVmHighlightColor(style.highlight || null);
  }, [viewRef, visualMode]);

  // Refresh state when toggling into visual mode
  useEffect(() => {
    if (visualMode) vmUpdateState();
  }, [visualMode, vmUpdateState]);

  useImperativeHandle(ref, () => ({
    refresh: vmUpdateState,
  }), [vmUpdateState]);

  // Toggle wrap: if selection has text, wrap/unwrap; if empty, insert at cursor
  const vmToggleWrap = useCallback((/** @type {any} */ before, /** @type {any} */ after) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.doc.sliceString(from, to);

    if (from === to) {
      // No selection — insert empty command and place cursor inside
      view.dispatch({
        changes: { from, to, insert: before + after },
        selection: { anchor: from + before.length },
      });
    } else {
      // Check if already wrapped — unwrap
      const beforeText = view.state.doc.sliceString(from - before.length, from);
      const afterText = view.state.doc.sliceString(to, to + after.length);
      if (beforeText === before && afterText === after) {
        view.dispatch({
          changes: [
            { from: from - before.length, to: from, insert: '' },
            { from: to, to: to + after.length, insert: '' },
          ],
        });
      } else {
        view.dispatch({
          changes: { from, to, insert: before + selected + after },
          selection: { anchor: from + before.length, head: from + before.length + selected.length },
        });
      }
    }
    view.focus();
  }, [viewRef]);

  // Build the LaTeX wrapper for a highlight color.
  // Uses \hl{} (soul package) which supports line breaks, unlike \colorbox.
  // Yellow: \hl{text}   Other: {\sethlcolor{color}\hl{text}}
  const hlWrapper = useCallback((/** @type {string} */ colorName) => {
    if (colorName === 'yellow') return { before: '\\hl{', after: '}' };
    return { before: `{\\sethlcolor{${colorName}}\\hl{`, after: '}}' };
  }, []);

  // Find the enclosing color/highlight command around `pos`.
  // Returns { cmdStart, contentStart, closePos, oldColor } or null.
  const vmFindEnclosingColor = useCallback((/** @type {string} */ doc, /** @type {number} */ pos, /** @type {string} */ mode) => {
    const searchStart = Math.max(0, pos - 500);
    const before = doc.slice(searchStart, pos);
    const patterns = mode === 'highlight'
      ? [/\\colorbox\{([^}]*)\}\{/g, /\\hl\{/g, /\{\\sethlcolor\{([^}]*)\}\\hl\{/g]
      : [/\\textcolor\{([^}]*)\}\{/g];

    for (const re of patterns) {
      let match, best = null;
      while ((match = re.exec(before)) !== null) best = match;
      if (!best) continue;

      const cmdStart = searchStart + best.index;
      const contentStart = cmdStart + best[0].length;
      // Walk braces to find matching close
      const closeIdx = findMatchingBrace(doc, contentStart - 1);
      if (closeIdx === -1) continue;
      const i = closeIdx;
      // For {\sethlcolor{color}\hl{text}}, the close includes the outer }
      let actualClose = i;
      const isSethlcolor = best[0].startsWith('{\\sethlcolor');
      if (isSethlcolor && i + 1 < doc.length && doc[i + 1] === '}') {
        actualClose = i + 1;
      }
      if (pos >= contentStart && pos <= i) {
        const oldColor = best[1] || (mode === 'highlight' ? 'yellow' : null);
        return { cmdStart, contentStart, closePos: i, actualClose, oldColor, isSethlcolor };
      }
    }
    return null;
  }, []);

  // Apply, change, or remove \textcolor / highlight.
  // colorName = null means "remove formatting".
  const vmApplyColor = useCallback((/** @type {string | null} */ colorName, /** @type {string} */ mode) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc.toString();

    const enc = vmFindEnclosingColor(doc, from, mode);

    if (enc) {
      const { cmdStart, contentStart, closePos, actualClose } = enc;
      const content = doc.slice(contentStart, closePos);
      const prefixLen = contentStart - cmdStart;
      const suffixEnd = (actualClose || closePos) + 1;

      if (!colorName || colorName === enc.oldColor) {
        // Remove: strip the command wrapper, keep content
        view.dispatch({
          changes: [
            { from: cmdStart, to: contentStart, insert: '' },
            { from: closePos, to: suffixEnd, insert: '' },
          ],
          selection: { anchor: Math.min(from - prefixLen, cmdStart + content.length) },
        });
      } else {
        // Change color: replace the entire wrapper
        if (mode === 'highlight') {
          const { before, after } = hlWrapper(colorName);
          view.dispatch({
            changes: [
              { from: cmdStart, to: contentStart, insert: before },
              { from: closePos, to: suffixEnd, insert: after },
            ],
            selection: { anchor: from - prefixLen + before.length },
          });
        } else {
          const newPrefix = `\\textcolor{${colorName}}{`;
          view.dispatch({
            changes: { from: cmdStart, to: contentStart, insert: newPrefix },
            selection: { anchor: from - prefixLen + newPrefix.length },
          });
        }
      }
      view.focus();
      setVmTextColorOpen(false);
      setVmHighlightOpen(false);
      return;
    }

    // Not inside an existing command — wrap (only if a color was picked)
    if (!colorName) { setVmTextColorOpen(false); setVmHighlightOpen(false); return; }

    let wrapper, after;
    if (mode === 'highlight') {
      const hl = hlWrapper(colorName);
      wrapper = hl.before;
      after = hl.after;
    } else {
      wrapper = `\\textcolor{${colorName}}{`;
      after = '}';
    }

    if (from === to) {
      view.dispatch({
        changes: { from, insert: wrapper + after },
        selection: { anchor: from + wrapper.length },
      });
    } else {
      const selected = doc.slice(from, to);
      view.dispatch({
        changes: { from, to, insert: wrapper + selected + after },
        selection: { anchor: from + wrapper.length, head: from + wrapper.length + selected.length },
      });
    }
    view.focus();
    setVmTextColorOpen(false);
    setVmHighlightOpen(false);
  }, [viewRef, vmFindEnclosingColor, hlWrapper]);

  // ── Citation insertion ──
  const filteredCites = (() => {
    const q = vmCiteQuery.trim().toLowerCase();
    const list = citeKeys || [];
    if (!q) return list.slice(0, 50);
    return list
      .filter((/** @type {any} */ c) => c.label.toLowerCase().includes(q) || (c.detail || '').toLowerCase().includes(q))
      .slice(0, 50);
  })();
  const insertCitation = useCallback((/** @type {any} */ key) => {
    const view = viewRef.current;
    if (!view || !key) return;
    const { from, to } = view.state.selection.main;
    const text = `\\cite{${key}}`;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
    setVmCiteOpen(false);
  }, [viewRef]);

  if (!visualMode) return null;

  return (
    <div className="vm-toolbar">
      <select
        className="vm-toolbar-select"
        value={vmHeadingLevel}
        onChange={(/** @type {any} */ e) => {
          const view = viewRef.current;
          if (!view) return;
          const level = e.target.value;
          const { from } = view.state.selection.main;
          const line = view.state.doc.lineAt(from);
          const lineText = line.text;
          // Strip existing heading command
          const stripped = lineText.replace(/^\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{(.*)\}\s*$/, '$2')
                                   .replace(/^\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{/, '');
          let newText;
          if (level === 'normal') {
            newText = stripped;
          } else {
            newText = `\\${level}{${stripped}}`;
          }
          view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } });
          view.focus();
        }}
      >
        <option value="normal">Normal text</option>
        <option value="part">Part</option>
        <option value="chapter">Chapter</option>
        <option value="section">Heading 1</option>
        <option value="subsection">Heading 2</option>
        <option value="subsubsection">Heading 3</option>
        <option value="paragraph">Paragraph heading</option>
      </select>

      <span className="vm-toolbar-sep" />

      <button
        className={`vm-toolbar-btn ${vmBold ? 'vm-toolbar-btn-active' : ''}`}
        title="Bold (⌘B)"
        onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
        onClick={() => vmToggleWrap('\\textbf{', '}')}
      ><strong>B</strong></button>
      <button
        className={`vm-toolbar-btn ${vmItalic ? 'vm-toolbar-btn-active' : ''}`}
        title="Italic (⌘I)"
        onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
        onClick={() => vmToggleWrap('\\emph{', '}')}
      ><em>I</em></button>
      <button
        className={`vm-toolbar-btn ${vmUnderline ? 'vm-toolbar-btn-active' : ''}`}
        title="Underline (⌘U)"
        onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
        onClick={() => vmToggleWrap('\\underline{', '}')}
      ><span style={{ textDecoration: 'underline' }}>U</span></button>

      <div className="vm-toolbar-color-wrap" ref={vmTextColorRef}>
        <button
          className={`vm-toolbar-btn ${vmTextColor ? 'vm-toolbar-btn-active' : ''}`}
          title="Text color"
          onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
          onClick={() => { setVmTextColorOpen(v => !v); setVmHighlightOpen(false); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 20h12" stroke="currentColor" strokeWidth="3" style={{ color: vmTextColor ? (VM_COLOR_MAP[vmTextColor] || vmTextColor) : 'var(--vm-text-color-indicator, #e53935)' }} />
            <path d="M9 4l-4 12h2.5l1-3h7l1 3H19L15 4H9z" fill="currentColor" />
          </svg>
        </button>
        {vmTextColorOpen && (
          <div className="vm-color-dropdown">
            <button
              className="vm-color-swatch vm-color-none"
              title="Remove color"
              onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
              onClick={() => vmApplyColor(null, 'text')}
            />
            {[
              { name: 'black', css: '#000000' }, { name: 'red', css: '#e53935' },
              { name: 'blue', css: '#1e88e5' }, { name: 'green', css: '#43a047' },
              { name: 'orange', css: '#fb8c00' }, { name: 'purple', css: '#8e24aa' },
              { name: 'cyan', css: '#00acc1' }, { name: 'magenta', css: '#d81b60' },
              { name: 'brown', css: '#6d4c41' }, { name: 'teal', css: '#00897b' },
              { name: 'violet', css: '#7b1fa2' }, { name: 'olive', css: '#827717' },
              { name: 'gray', css: '#757575' }, { name: 'NavyBlue', css: '#1565c0' },
              { name: 'ForestGreen', css: '#2e7d32' }, { name: 'BrickRed', css: '#c62828' },
            ].map(c => (
              <button
                key={c.name}
                className={`vm-color-swatch${vmTextColor === c.name ? ' vm-color-swatch-active' : ''}`}
                style={{ backgroundColor: c.css }}
                title={c.name}
                onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
                onClick={() => vmApplyColor(c.name, 'text')}
              />
            ))}
          </div>
        )}
      </div>

      <div className="vm-toolbar-color-wrap" ref={vmHighlightRef}>
        <button
          className={`vm-toolbar-btn ${vmHighlightColor ? 'vm-toolbar-btn-active' : ''}`}
          title="Highlight color"
          onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
          onClick={() => { setVmHighlightOpen(v => !v); setVmTextColorOpen(false); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="14" width="18" height="6" rx="1" fill={vmHighlightColor ? (VM_COLOR_MAP[vmHighlightColor] || vmHighlightColor) : '#ffff00'} stroke="#ccc" strokeWidth="1" />
            <path d="M15.5 4.5l2 2M8.5 11.5l5-5 2 2-5 5-2.5.5.5-2.5z" stroke="currentColor" fill="currentColor" opacity="0.8" />
          </svg>
        </button>
        {vmHighlightOpen && (
          <div className="vm-color-dropdown">
            <button
              className="vm-color-swatch vm-color-none"
              title="Remove highlight"
              onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
              onClick={() => vmApplyColor(null, 'highlight')}
            />
            {[
              { name: 'yellow', css: '#fdd835' }, { name: 'lime', css: '#c0ca33' },
              { name: 'cyan', css: '#80deea' }, { name: 'pink', css: '#f48fb1' },
              { name: 'orange', css: '#ffcc80' }, { name: 'green', css: '#a5d6a7' },
              { name: 'magenta', css: '#f8bbd0' }, { name: 'lightgray', css: '#e0e0e0' },
            ].map(c => (
              <button
                key={c.name}
                className={`vm-color-swatch${vmHighlightColor === c.name ? ' vm-color-swatch-active' : ''}`}
                style={{ backgroundColor: c.css }}
                title={c.name}
                onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
                onClick={() => vmApplyColor(c.name, 'highlight')}
              />
            ))}
          </div>
        )}
      </div>

      <span className="vm-toolbar-sep" />

      <button
        className={`vm-toolbar-btn ${vmBlockStyle === 'Itemize' ? 'vm-toolbar-btn-active' : ''}`}
        title="Bulleted list"
        onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
        onClick={() => onInsertList('itemize')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2">
          <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/><line x1="9" y1="6" x2="21" y2="6"/>
          <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/><line x1="9" y1="12" x2="21" y2="12"/>
          <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/><line x1="9" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <button
        className={`vm-toolbar-btn ${vmBlockStyle === 'Enumerate' ? 'vm-toolbar-btn-active' : ''}`}
        title="Numbered list"
        onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
        onClick={() => onInsertList('enumerate')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round">
          <text x="2" y="8" fontSize="8" fill="currentColor" stroke="none" fontFamily="serif">1.</text><line x1="9" y1="6" x2="21" y2="6"/>
          <text x="2" y="14" fontSize="8" fill="currentColor" stroke="none" fontFamily="serif">2.</text><line x1="9" y1="12" x2="21" y2="12"/>
          <text x="2" y="20" fontSize="8" fill="currentColor" stroke="none" fontFamily="serif">3.</text><line x1="9" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <button
        className={`vm-toolbar-btn ${vmBlockStyle === 'Quote' ? 'vm-toolbar-btn-active' : ''}`}
        title="Block quote"
        onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
        onClick={() => onInsertQuote?.()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 7h4v4H7c-1.5 0-2 1.5-2 3v3" />
          <path d="M15 7h4v4h-4c-1.5 0-2 1.5-2 3v3" />
        </svg>
      </button>

      <span className="vm-toolbar-sep" />

      <div ref={vmCiteRef} className="vm-toolbar-dropdown">
        <button
          className="vm-toolbar-btn"
          title="Insert citation (\\cite{…})"
          onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
          onClick={() => setVmCiteOpen((/** @type {any} */ v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4z" />
            <path d="M4 17a3 3 0 0 1 3-3h12" />
            <path d="M9 8h6" />
            <path d="M9 11h4" />
          </svg>
        </button>
        {vmCiteOpen && (
          <div className="vm-cite-popover">
            <input
              ref={vmCiteInputRef}
              className="vm-cite-search"
              type="text"
              placeholder="Search citations…"
              value={vmCiteQuery}
              onChange={(/** @type {any} */ e) => { setVmCiteQuery(e.target.value); setVmCiteIdx(0); }}
              onKeyDown={(/** @type {any} */ e) => {
                if (e.key === 'Escape') { setVmCiteOpen(false); e.preventDefault(); }
                else if (e.key === 'ArrowDown') { setVmCiteIdx((i) => Math.min(i + 1, filteredCites.length - 1)); e.preventDefault(); }
                else if (e.key === 'ArrowUp') { setVmCiteIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
                else if (e.key === 'Enter' && filteredCites[vmCiteIdx]) { insertCitation(filteredCites[vmCiteIdx].label); e.preventDefault(); }
              }}
            />
            <div className="vm-cite-list">
              {filteredCites.length === 0 ? (
                <div className="vm-cite-empty">
                  {(citeKeys || []).length === 0
                    ? 'No .bib entries found in this project.'
                    : 'No citations match.'}
                </div>
              ) : (
                filteredCites.map((/** @type {any} */ c, /** @type {any} */ i) => (
                  <button
                    key={c.label}
                    className={`vm-cite-item ${i === vmCiteIdx ? 'vm-cite-item-active' : ''}`}
                    onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
                    onClick={() => insertCitation(c.label)}
                    onMouseEnter={() => setVmCiteIdx(i)}
                  >
                    <span className="vm-cite-key">{c.label}</span>
                    {c.detail && <span className="vm-cite-detail">{c.detail}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default VisualModeToolbar;
