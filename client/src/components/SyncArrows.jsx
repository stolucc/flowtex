import React from 'react';

/** Forward and inverse SyncTeX navigation buttons between editor and PDF. */
export default function SyncArrows({ onSyncForward, onSyncInverse, hasPdf, hasPdfPosition }) {
  return (
    <div className="sync-arrows">
      <button className="sync-btn" onClick={onSyncForward} disabled={!hasPdf} title="Sync editor → PDF">
        &rarr;
      </button>
      <button
        className="sync-btn"
        onClick={onSyncInverse}
        disabled={!hasPdf || !hasPdfPosition}
        title="Sync PDF → editor (click on PDF first)"
      >
        &larr;
      </button>
    </div>
  );
}
