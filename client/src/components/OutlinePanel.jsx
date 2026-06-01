import React, { useMemo } from 'react';
import { parseOutline } from '../utils/latexOutline.js';

/**
 * Sidebar panel listing chapter/section/subsection headings of the
 * active .tex file, with click-to-jump into the editor. Sits in the
 * left sidebar below FileTree. Only meaningful for .tex files; non-tex
 * shows an empty-state hint.
 *
 * Re-parses on every render — the parser is a single linear regex
 * pass and the source comes from `activeFile.content` which only
 * updates on debounced saves, so the cost is negligible even on big
 * files.
 */
export default function OutlinePanel({ activeFile, onJump, onCollapse }) {
  const entries = useMemo(() => {
    if (!activeFile?.path?.endsWith('.tex')) return [];
    return parseOutline(activeFile.content || '');
  }, [activeFile?.path, activeFile?.content]);

  const isTex = !!activeFile?.path?.endsWith('.tex');

  return (
    <div className="outline-panel">
      <div className="outline-panel-header">
        <span className="outline-panel-title">Outline</span>
        {onCollapse && (
          <button
            type="button"
            className="outline-panel-collapse"
            title="Collapse outline"
            onClick={onCollapse}
          >
            &minus;
          </button>
        )}
      </div>
      <div className="outline-panel-body">
        {!isTex ? (
          <div className="outline-panel-empty">Open a .tex file to see its outline.</div>
        ) : entries.length === 0 ? (
          <div className="outline-panel-empty">
            No headings yet. Add a <code>\section{'{…}'}</code> or <code>\chapter{'{…}'}</code> and it&rsquo;ll appear here.
          </div>
        ) : (
          <ul className="outline-panel-list" role="tree">
            {entries.map((e, i) => (
              <li
                key={`${e.line}-${i}`}
                role="treeitem"
                className={`outline-entry outline-level-${e.level}`}
                style={{ paddingLeft: 8 + e.level * 10 }}
                title={`${e.label} — line ${e.line}`}
                onClick={() => onJump?.(e.line)}
              >
                <span className="outline-entry-title">{e.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
