import React, { useEffect, useRef } from 'react';

export default function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = 'Delete', confirmClass = 'confirm-dialog-delete' }) {
  const overlayRef = useRef(null);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onCancel();
  };

  return (
    <div className="modal-overlay confirm-dialog-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card confirm-dialog">
        <p className="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button className="confirm-dialog-cancel" onClick={onCancel}>Cancel</button>
          <button className={confirmClass} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
