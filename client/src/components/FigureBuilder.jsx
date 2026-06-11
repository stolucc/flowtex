// @ts-check
import React, { useState } from 'react';
import generateLatexFigure from '../utils/latexFigureGenerator.js';

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|pdf|eps|svg|tif|tiff|bmp)$/i;

/**
 * Visual builder for LaTeX figure environments with placement, caption, and sizing options.
 * @param {any} props
 */
export default function FigureBuilder({ onInsert, onClose, onDelete, initial, projectFiles, declaredPackages }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [imagePath, setImagePath] = useState(initial?.imagePath || '');
  const [width, setWidth] = useState(initial?.width || '0.8');
  const [widthUnit, setWidthUnit] = useState(initial?.widthUnit || 'textwidth');
  const [placement, setPlacement] = useState(initial?.placement || 'htbp');
  const [caption, setCaption] = useState(initial?.caption ?? true);
  const [captionText, setCaptionText] = useState(initial?.captionText || '');
  const [label, setLabel] = useState(initial?.label || '');
  const [centering, setCentering] = useState(initial?.centering ?? true);
  const [captionPos, setCaptionPos] = useState(initial?.captionPos || 'bottom');
  const [captionVAlign, setCaptionVAlign] = useState(initial?.captionVAlign || 'center');
  const [star, setStar] = useState(initial?.env === 'figure*');

  const isEditing = !!initial?.imagePath;

  const imageFiles = (projectFiles || []).filter(
    (f) => IMAGE_EXTENSIONS.test(f.path) && f.path !== 'thumbnail.png',
  );

  const handleInsert = () => {
    const latex = generateLatexFigure({
      env: star ? 'figure*' : 'figure',
      placement,
      imagePath,
      width,
      widthUnit,
      caption,
      captionText,
      label,
      centering,
      captionPos,
      captionVAlign,
    });
    onInsert(latex);
    onClose();
  };

  return (
    <div className="figure-builder">
      <div className="figure-builder-opts">
        <div className="table-opt-row">
          <label className="table-opt-label">Image</label>
          <select
            className="table-opt-select figure-file-select"
            value={imagePath}
            onChange={(/** @type {any} */ e) => setImagePath(e.target.value)}
          >
            <option value="">— select file —</option>
            {imageFiles.map((/** @type {any} */ f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
          <input
            className="table-opt-input figure-path-input"
            type="text"
            value={imagePath}
            onChange={(/** @type {any} */ e) => setImagePath(e.target.value)}
            placeholder="or type path…"
            style={{ marginLeft: 6, minWidth: 120 }}
          />
        </div>

        <div className="table-opt-row">
          <label className="table-opt-label">Width</label>
          <input
            className="table-opt-input"
            type="text"
            value={width}
            onChange={(/** @type {any} */ e) => setWidth(e.target.value)}
            style={{ width: 50 }}
          />
          <select
            className="table-opt-select"
            value={widthUnit}
            onChange={(/** @type {any} */ e) => setWidthUnit(e.target.value)}
            style={{ marginLeft: 4 }}
          >
            <option value="textwidth">\textwidth</option>
            <option value="linewidth">\linewidth</option>
            <option value="columnwidth">\columnwidth</option>
            <option value="cm">cm</option>
            <option value="mm">mm</option>
            <option value="in">in</option>
            <option value="pt">pt</option>
          </select>
        </div>

        <div className="table-opt-row">
          <label className="table-opt-label">Placement</label>
          <select
            className="table-opt-select"
            value={placement}
            onChange={(/** @type {any} */ e) => setPlacement(e.target.value)}
          >
            <option value="htbp">htbp (auto)</option>
            <option value="H">H (exact)</option>
            <option value="t">t (top)</option>
            <option value="b">b (bottom)</option>
            <option value="p">p (page)</option>
          </select>
          <label className="table-opt-toggle" style={{ marginLeft: 12 }}>
            <span className="table-opt-toggle-label">figure*</span>
            <button
              className={`table-toggle${star ? ' on' : ''}`}
              onClick={() => setStar((v) => !v)}
              role="switch"
              aria-checked={star}
            >
              <span className="table-toggle-knob" />
            </button>
          </label>
          <label className="table-opt-toggle" style={{ marginLeft: 12 }}>
            <span className="table-opt-toggle-label">Centering</span>
            <button
              className={`table-toggle${centering ? ' on' : ''}`}
              onClick={() => setCentering((v) => !v)}
              role="switch"
              aria-checked={centering}
            >
              <span className="table-toggle-knob" />
            </button>
          </label>
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
                      onClick={() => { setCaptionPos(pos); setCaptionVAlign(valign); }}
                      title={title}
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
                  value={captionText}
                  onChange={(/** @type {any} */ e) => setCaptionText(e.target.value)}
                  placeholder="Caption text"
                />
              </div>
              <div className="table-opt-row">
                <label className="table-opt-label">Label</label>
                <input
                  className="table-opt-input"
                  type="text"
                  value={label}
                  onChange={(/** @type {any} */ e) => setLabel(e.target.value)}
                  placeholder="fig:label"
                />
              </div>
            </>
          )}
        </div>

        {(captionPos === 'left' || captionPos === 'right' || placement === 'H') && (
          <div className="table-opt-packages">
            {(captionPos === 'left' || captionPos === 'right') && <span>{declaredPackages && (declaredPackages.has('floatrow') ? <span className="pkg-ok" title="Included in preamble">☑</span> : <span className="pkg-warn" title="Not in preamble">⚠</span>)}Requires <code>{'\u005cusepackage{floatrow}'}</code></span>}
            {placement === 'H' && <span>{declaredPackages && (declaredPackages.has('float') ? <span className="pkg-ok" title="Included in preamble">☑</span> : <span className="pkg-warn" title="Not in preamble">⚠</span>)}Requires <code>{'\u005cusepackage{float}'}</code></span>}
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
              <span className="table-delete-confirm-label">Delete figure?</span>
              <button className="table-delete-confirm-yes" onClick={onDelete}>Yes</button>
              <button className="table-delete-confirm-no" onClick={() => setConfirmDelete(false)}>No</button>
            </span>
          )}
          <button className="table-builder-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="table-builder-insert" onClick={handleInsert} disabled={!imagePath}>
            {isEditing ? 'Update' : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}
