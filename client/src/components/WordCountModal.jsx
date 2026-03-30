import React, { useRef } from 'react';

export default function WordCountModal({ data, loading, error, onClose }) {
  const overlayRef = useRef(null);

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="modal wordcount-modal">
        <div className="modal-header">
          <h2>Word Count</h2>
        </div>
        <div className="modal-body">
          {loading && <div className="wordcount-loading">Counting words...</div>}
          {error && <div className="settings-error">{error}</div>}
          {data && (
            <>
              <table className="wordcount-table">
                <tbody>
                  <tr>
                    <td className="wordcount-label">Words in text</td>
                    <td className="wordcount-value">{data.words.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td className="wordcount-label">Words in headers</td>
                    <td className="wordcount-value">{data.headers.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td className="wordcount-label">Captions &amp; outside text</td>
                    <td className="wordcount-value">{data.captions.toLocaleString()}</td>
                  </tr>
                  {data.mathInline > 0 && (
                    <tr>
                      <td className="wordcount-label">Math (inline)</td>
                      <td className="wordcount-value">{data.mathInline.toLocaleString()}</td>
                    </tr>
                  )}
                  {data.mathDisplay > 0 && (
                    <tr>
                      <td className="wordcount-label">Math (display)</td>
                      <td className="wordcount-value">{data.mathDisplay.toLocaleString()}</td>
                    </tr>
                  )}
                  {data.floats > 0 && (
                    <tr>
                      <td className="wordcount-label">Floats / tables / figures</td>
                      <td className="wordcount-value">{data.floats.toLocaleString()}</td>
                    </tr>
                  )}
                  <tr className="wordcount-total">
                    <td className="wordcount-label">Total</td>
                    <td className="wordcount-value">{data.total.toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>

              {data.sections.length > 0 && (
                <>
                  <h3 className="wordcount-sections-title">By section</h3>
                  <div className="wordcount-sections-scroll">
                    <table className="wordcount-table wordcount-sections">
                      <thead>
                        <tr>
                          <th className="wordcount-sec-name">Section</th>
                          <th className="wordcount-sec-num">Words</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.sections.map((s, i) => {
                          const indent = s.label.startsWith('Subsection:')
                            ? 1
                            : s.label.startsWith('Subsubsection:')
                              ? 2
                              : 0;
                          const name = s.label.replace(/^(Section|Subsection|Subsubsection|Chapter):\s*/, '');
                          return (
                            <tr key={i}>
                              <td className="wordcount-sec-name" style={{ paddingLeft: 8 + indent * 16 }}>
                                {name}
                              </td>
                              <td className="wordcount-sec-num">{s.words.toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
