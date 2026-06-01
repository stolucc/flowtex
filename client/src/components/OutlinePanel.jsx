import React, { useMemo, useRef } from 'react';
import { parseDocumentOutline } from '../utils/latexOutline.js';

/**
 * Sidebar panel listing every chapter/section/subsection heading of
 * the document — walks \input{…} / \include{…} from the project's
 * main file so the outline covers ALL .tex files, not just the one
 * the editor is currently showing. Click an entry to jump.
 *
 * Drag the top edge to resize. The user file panel and outline panel
 * share the sidebar height; smaller outline = more file tree.
 */
export default function OutlinePanel({
  files,
  mainFilePath,
  activeFile,
  onJump,
  height,
  onResize,
}) {
  const entries = useMemo(() => {
    return parseDocumentOutline(files || [], mainFilePath);
  }, [files, mainFilePath]);

  const hasAnyTex = (files || []).some((f) => !f.is_binary && f.path?.endsWith('.tex'));

  // Drag the top edge: tracked client-Y delta becomes negative height
  // delta (drag up = grow). Min 80px so the header is still useful;
  // max 70vh so the file tree above always has room.
  const dragStartRef = useRef(null);
  const handleResizeStart = (e) => {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, h: height };
    const onMove = (ev) => {
      if (!dragStartRef.current) return;
      const delta = dragStartRef.current.y - ev.clientY;
      const next = Math.max(80, Math.min(window.innerHeight * 0.7, dragStartRef.current.h + delta));
      onResize?.(next);
    };
    const onUp = () => {
      dragStartRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="outline-panel" style={{ height }}>
      <div
        className="outline-resize-handle"
        onMouseDown={handleResizeStart}
        title="Drag to resize outline panel"
      />
      <div className="outline-panel-header">
        <span className="outline-panel-title">Outline</span>
      </div>
      <div className="outline-panel-body">
        {!hasAnyTex ? (
          <div className="outline-panel-empty">Add a .tex file to see its outline.</div>
        ) : entries.length === 0 ? (
          <div className="outline-panel-empty">
            No headings found in the document. Add a <code>\section{'{…}'}</code> or{' '}
            <code>\chapter{'{…}'}</code> in your main file or any <code>\input</code>-ed file.
          </div>
        ) : (
          <ul className="outline-panel-list" role="tree">
            {entries.map((e, i) => {
              const inActive = activeFile && e.path === activeFile.path;
              return (
                <li
                  key={`${e.path}-${e.line}-${i}`}
                  role="treeitem"
                  className={`outline-entry outline-level-${e.level}${inActive ? ' outline-entry-active-file' : ''}`}
                  style={{ paddingLeft: 8 + e.level * 10 }}
                  title={`${e.path}:${e.line} — \\${e.label}`}
                  onClick={() => onJump?.(e.path, e.line)}
                >
                  <span className="outline-entry-title">{e.title}</span>
                  {!inActive && (
                    <span className="outline-entry-path">
                      {e.path.split('/').pop()}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
