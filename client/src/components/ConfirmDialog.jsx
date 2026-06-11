// @ts-check
import React, { useEffect, useRef } from 'react';

/**
 * Generic confirmation dialog overlay with customisable confirm button label and style.
 * @param {any} props
 */
export default function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Delete',
  confirmClass = 'confirm-dialog-delete',
}) {
  const overlayRef = useRef(/** @type {any} */ (null));

  useEffect(() => {
    const handleKey = (/** @type {any} */ e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const handleOverlayClick = (/** @type {any} */ e) => {
    if (e.target === overlayRef.current) onCancel();
  };

  return (
    <div className="modal-overlay confirm-dialog-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card confirm-dialog">
        <p className="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button className="confirm-dialog-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className={confirmClass} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
