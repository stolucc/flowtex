// @ts-check
import React, { useState, useRef } from 'react';

/**
 * Modal for selecting two .tex files to generate a latexdiff comparison.
 * @param {any} props
 */
export default function CompareFilesModal({ files, onClose, onStartDiff }) {
  const [oldFileId, setOldFileId] = useState('');
  const [newFileId, setNewFileId] = useState('');
  const overlayRef = useRef(/** @type {any} */ (null));

  const texFiles = (files || []).filter((/** @type {any} */ f) => f.path.endsWith('.tex'));

  const handleCompare = () => {
    if (!oldFileId || !newFileId || oldFileId === newFileId) return;
    onStartDiff(oldFileId, newFileId);
    onClose();
  };

  const selectStyle = {
    display: 'block',
    width: '100%',
    marginTop: 4,
    padding: '8px 10px',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: 13,
  };

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(/** @type {any} */ e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="modal-card" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h2>Compare Files</h2>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Generates a diff between two .tex files using latexdiff, then compiles the result. Output streams to the
            console panel.
          </p>

          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Old version (original)
            <select value={oldFileId} onChange={(/** @type {any} */ e) => setOldFileId(e.target.value)} style={selectStyle}>
              <option value="">Select file...</option>
              {texFiles.map((/** @type {any} */ f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            New version (modified)
            <select value={newFileId} onChange={(/** @type {any} */ e) => setNewFileId(e.target.value)} style={selectStyle}>
              <option value="">Select file...</option>
              {texFiles.map((/** @type {any} */ f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <button
              onClick={handleCompare}
              disabled={!oldFileId || !newFileId || oldFileId === newFileId}
              style={{
                padding: '9px 16px',
                background: 'var(--accent)',
                color: '#000',
                border: 'none',
                borderRadius: 'var(--radius-pill)',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 13,
                opacity: !oldFileId || !newFileId || oldFileId === newFileId ? 0.5 : 1,
              }}
            >
              Compare
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '9px 16px',
                background: 'var(--bg-hover)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-pill)',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
