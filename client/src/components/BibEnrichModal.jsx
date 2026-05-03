import React, { useState, useRef, useMemo, useEffect } from 'react';
import { post } from '../api.js';
import { findMatchingBrace } from '../utils/latexParser.js';

const ALL_FIELDS = [
  { key: 'doi', label: 'DOI' },
  { key: 'pages', label: 'Pages' },
  { key: 'volume', label: 'Volume' },
  { key: 'number', label: 'Number / Issue' },
  { key: 'publisher', label: 'Publisher' },
  { key: 'year', label: 'Year' },
  { key: 'month', label: 'Month' },
  { key: 'journal', label: 'Journal' },
  { key: 'booktitle', label: 'Book / Conf. title' },
  { key: 'url', label: 'URL' },
  { key: 'issn', label: 'ISSN' },
  { key: 'isbn', label: 'ISBN' },
  { key: 'author', label: 'Author' },
  { key: 'title', label: 'Title' },
];

/**
 * Parses BibTeX source into an array of entry objects with key, type, fields, and byte offsets.
 * @param {string} content - Raw .bib file content
 * @returns {Array<{key: string, type: string, fields: Object, entryStart: number, entryEnd: number}>}
 */
function parseBibEntries(content) {
  const entries = [];
  const re = /@(\w+)\s*\{([^,\s]+)\s*,/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const type = match[1].toLowerCase();
    if (type === 'string' || type === 'preamble' || type === 'comment') continue;
    const key = match[2].trim();
    const start = match.index + match[0].length;

    const closeIdx = findMatchingBrace(content, start - 1, false);
    const i = closeIdx === -1 ? content.length : closeIdx + 1;
    const body = content.slice(start, i - 1);

    const fields = {};
    const fieldRe = /(\w+)\s*=\s*/g;
    let fm;
    while ((fm = fieldRe.exec(body)) !== null) {
      const fieldName = fm[1].toLowerCase();
      let vi = fm.index + fm[0].length;
      let value = '';
      if (body[vi] === '{') {
        let d = 1;
        vi++;
        while (vi < body.length && d > 0) {
          if (body[vi] === '{') d++;
          else if (body[vi] === '}') d--;
          if (d > 0) value += body[vi];
          vi++;
        }
      } else if (body[vi] === '"') {
        vi++;
        while (vi < body.length && body[vi] !== '"') {
          value += body[vi];
          vi++;
        }
      } else {
        while (vi < body.length && body[vi] !== ',' && body[vi] !== '}') {
          value += body[vi];
          vi++;
        }
        value = value.trim();
      }
      fields[fieldName] = value;
    }

    entries.push({ key, type, fields, entryStart: match.index, entryEnd: i });
  }
  return entries;
}

/**
 * Splices accepted field additions into .bib source, working back-to-front to preserve offsets.
 * @param {string} content - Original .bib file content
 * @param {Array} entries - Parsed BibTeX entries from parseBibEntries
 * @param {Array<{entryKey: string, field: string, value: string}>} acceptedChanges
 * @returns {string} Updated .bib content
 */
function applyAcceptedChanges(content, entries, acceptedChanges) {
  // acceptedChanges: [{ entryKey, field, value }]
  // Group by entry key
  const byEntry = {};
  for (const ch of acceptedChanges) {
    if (!byEntry[ch.entryKey]) byEntry[ch.entryKey] = [];
    byEntry[ch.entryKey].push(ch);
  }

  let output = content;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const changes = byEntry[entry.key];
    if (!changes || changes.length === 0) continue;

    const closingBrace = entry.entryEnd - 1;
    let insertPos = closingBrace;
    while (insertPos > 0 && /\s/.test(output[insertPos - 1])) insertPos--;

    const newFields = [];
    for (const ch of changes) {
      if (ch.field === 'journal' && ['inproceedings', 'incollection'].includes(entry.type)) continue;
      if (ch.field === 'booktitle' && ['article'].includes(entry.type)) continue;
      newFields.push(`  ${ch.field.padEnd(12)} = {${ch.value}}`);
    }

    if (newFields.length > 0) {
      let pre = output.slice(0, insertPos);
      if (!pre.trimEnd().endsWith(',')) pre = pre.trimEnd() + ',';
      const post = output.slice(insertPos);
      output = pre + '\n' + newFields.join(',\n') + ',' + post;
    }
  }

  return output;
}

/** Multi-step modal that enriches .bib entries by looking up missing fields via CrossRef. */
export default function BibEnrichModal({ file, onClose, onApply }) {
  const [step, setStep] = useState('select'); // 'select' | 'lookup' | 'review'
  const [selectedFields, setSelectedFields] = useState(['doi', 'pages', 'volume', 'number', 'publisher']);
  const [selectedEntries, setSelectedEntries] = useState(null); // Set of entry keys
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [logLines, setLogLines] = useState([]);
  // For review: track accepted/rejected per entry+field
  // changeStatus: { 'entryKey::field': 'pending' | 'accepted' | 'rejected' }
  const [changeStatus, setChangeStatus] = useState({});
  const [previewKey, setPreviewKey] = useState(null);
  const overlayRef = useRef(null);
  const logRef = useRef(null);

  const entries = useMemo(() => {
    const parsed = parseBibEntries(file?.content || '');
    return parsed.sort((a, b) => a.key.localeCompare(b.key));
  }, [file?.content]);

  // Initialize selectedEntries when entries change
  useEffect(() => {
    if (selectedEntries === null) {
      setSelectedEntries(new Set(entries.map((e) => e.key)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const toggleField = (key) => {
    setSelectedFields((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));
  };

  const toggleEntry = (key) => {
    setSelectedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const addLog = (line) => {
    setLogLines((prev) => [...prev, line]);
    setTimeout(() => {
      logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    }, 0);
  };

  const handleLookup = async () => {
    if (selectedFields.length === 0 || !selectedEntries || selectedEntries.size === 0) return;
    setStep('lookup');
    setLoading(true);
    setResults(null);
    setLogLines([]);

    const entriesToLookup = entries.filter((e) => selectedEntries.has(e.key));
    const allResults = [];
    addLog(`Starting lookup for ${entriesToLookup.length} entries...`);

    for (let i = 0; i < entriesToLookup.length; i++) {
      const e = entriesToLookup[i];
      const title = e.fields.title || '';
      const shortTitle = title.length > 50 ? title.slice(0, 50) + '...' : title;
      addLog(`[${i + 1}/${entriesToLookup.length}] ${e.key}${shortTitle ? ' — ' + shortTitle : ''}`);

      if (!title) {
        addLog(`  ⏭ skipped (no title)`);
        allResults.push({ key: e.key, found: false, added: {} });
        continue;
      }

      try {
        const res = await post('/api/bib/enrich', {
          entries: [
            {
              key: e.key,
              title: `{${e.fields.title}}`,
              author: e.fields.author ? `{${e.fields.author}}` : '',
              existingFields: Object.fromEntries(
                Object.entries(e.fields)
                  .map(([k, v]) => [k, v || null])
                  .filter(([, v]) => v),
              ),
            },
          ],
          fields: selectedFields,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Lookup failed');

        const result = data.results[0];
        allResults.push(result);
        const addedKeys = Object.keys(result.added);
        if (result.found && addedKeys.length > 0) {
          addLog(`  ✓ found: +${addedKeys.join(', +')}`);
        } else if (result.found) {
          addLog(`  ✓ found (already complete)`);
        } else {
          addLog(`  ✗ not found on CrossRef`);
        }
      } catch (err) {
        addLog(`  ✗ error: ${err.message}`);
        allResults.push({ key: e.key, found: false, added: {} });
      }
    }

    const foundCount = allResults.filter((r) => r.found && Object.keys(r.added).length > 0).length;
    const totalAdded = allResults.reduce((sum, r) => sum + Object.keys(r.added).length, 0);
    addLog(`\nDone. Found data for ${foundCount} entries (${totalAdded} fields to add).`);

    // Initialize change status — all pending
    const status = {};
    for (const r of allResults) {
      for (const field of Object.keys(r.added)) {
        status[`${r.key}::${field}`] = 'pending';
      }
    }
    setChangeStatus(status);
    setResults(allResults);
    setLoading(false);

    if (totalAdded > 0) {
      setTimeout(() => setStep('review'), 600);
    }
  };

  const handleApply = () => {
    if (!results) return;
    // Collect accepted changes
    const accepted = [];
    for (const r of results) {
      for (const [field, value] of Object.entries(r.added)) {
        const key = `${r.key}::${field}`;
        if (changeStatus[key] === 'accepted' || changeStatus[key] === 'pending') {
          // pending = not explicitly rejected, treat as accepted on "Accept All"
        }
        if (changeStatus[key] === 'accepted') {
          accepted.push({ entryKey: r.key, field, value });
        }
      }
    }
    if (accepted.length === 0) return;
    const newContent = applyAcceptedChanges(file.content, entries, accepted);
    onApply(newContent);
    onClose();
  };

  const handleAcceptAll = () => {
    setChangeStatus((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k] === 'pending') next[k] = 'accepted';
      }
      return next;
    });
  };

  const handleRejectAll = () => {
    setChangeStatus((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k] === 'pending') next[k] = 'rejected';
      }
      return next;
    });
  };

  const setFieldStatus = (entryKey, field, status) => {
    setChangeStatus((prev) => ({ ...prev, [`${entryKey}::${field}`]: status }));
  };

  // Compute counts for review
  const pendingCount = Object.values(changeStatus).filter((s) => s === 'pending').length;
  const acceptedCount = Object.values(changeStatus).filter((s) => s === 'accepted').length;
  const rejectedCount = Object.values(changeStatus).filter((s) => s === 'rejected').length;

  const resultsWithChanges = results?.filter((r) => Object.keys(r.added).length > 0) || [];

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="modal-card bib-enrich-modal">
        <div className="modal-header">
          <h2>Complete Bibliography</h2>
        </div>

        <div className="bib-enrich-body">
          {/* STEP 1: Select fields + entries */}
          {step === 'select' && (
            <>
              <p className="bib-enrich-hint">
                Select the fields to look up from CrossRef, and choose which references to complete.
              </p>

              <div className="bib-enrich-section-label">Fields to complete</div>
              <div className="bib-enrich-fields">
                {ALL_FIELDS.map((f) => (
                  <label key={f.key} className="bib-enrich-field-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedFields.includes(f.key)}
                      onChange={() => toggleField(f.key)}
                    />
                    {f.label}
                  </label>
                ))}
              </div>

              <div className="bib-enrich-section-label">
                References ({selectedEntries?.size || 0} of {entries.length} selected)
                <span className="bib-enrich-select-links">
                  <button onClick={() => setSelectedEntries(new Set(entries.map((e) => e.key)))}>Select all</button>
                  <button onClick={() => setSelectedEntries(new Set())}>Select none</button>
                </span>
              </div>
              <div className="bib-enrich-split">
                <div className="bib-enrich-entry-table">
                  {entries.map((e) => {
                    const title = e.fields.title || '';
                    const shortTitle = title.length > 60 ? title.slice(0, 60) + '...' : title;
                    const existingFields = Object.keys(e.fields).filter((k) => k !== 'title' && k !== 'author');
                    return (
                      <div
                        key={e.key}
                        className={`bib-enrich-entry-row ${selectedEntries?.has(e.key) ? 'selected' : ''} ${previewKey === e.key ? 'previewing' : ''}`}
                        onClick={() => setPreviewKey((prev) => (prev === e.key ? null : e.key))}
                      >
                        <input
                          type="checkbox"
                          checked={selectedEntries?.has(e.key) || false}
                          onChange={(ev) => {
                            ev.stopPropagation();
                            toggleEntry(e.key);
                          }}
                        />
                        <span className="bib-enrich-entry-key">{e.key}</span>
                        <span className="bib-enrich-entry-title">{shortTitle || <em>no title</em>}</span>
                        {existingFields.length > 0 && (
                          <span className="bib-enrich-entry-existing" title={existingFields.join(', ')}>
                            {existingFields.length} field{existingFields.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {previewKey &&
                  (() => {
                    const entry = entries.find((e) => e.key === previewKey);
                    if (!entry) return null;
                    const raw = file.content.slice(entry.entryStart, entry.entryEnd);
                    return (
                      <div className="bib-enrich-preview">
                        <div className="bib-enrich-preview-header">
                          <span>{previewKey}</span>
                          <button onClick={() => setPreviewKey(null)}>&times;</button>
                        </div>
                        <pre className="bib-enrich-preview-code">{raw}</pre>
                      </div>
                    );
                  })()}
              </div>

              <div className="bib-enrich-actions">
                <button
                  className="bib-enrich-btn primary"
                  onClick={handleLookup}
                  disabled={selectedFields.length === 0 || !selectedEntries || selectedEntries.size === 0}
                >
                  Look up {selectedEntries?.size || 0} {(selectedEntries?.size || 0) === 1 ? 'entry' : 'entries'}
                </button>
                <button className="bib-enrich-btn" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {/* STEP 2: Lookup in progress */}
          {step === 'lookup' && (
            <>
              <div className="bib-enrich-log" ref={logRef}>
                {logLines.map((line, i) => (
                  <div
                    key={i}
                    className={`bib-enrich-log-line${line.startsWith('  ✓') ? ' log-ok' : line.startsWith('  ✗') ? ' log-err' : line.startsWith('  ⏭') ? ' log-skip' : ''}`}
                  >
                    {line}
                  </div>
                ))}
                {loading && <div className="bib-enrich-log-line log-cursor">_</div>}
              </div>
              {!loading && results && (
                <div className="bib-enrich-actions">
                  {resultsWithChanges.length > 0 ? (
                    <button className="bib-enrich-btn primary" onClick={() => setStep('review')}>
                      Review {Object.keys(changeStatus).length} proposed changes
                    </button>
                  ) : (
                    <p className="bib-enrich-hint">No new fields found.</p>
                  )}
                  <button
                    className="bib-enrich-btn"
                    onClick={() => {
                      setStep('select');
                      setResults(null);
                      setLogLines([]);
                    }}
                  >
                    Back
                  </button>
                </div>
              )}
            </>
          )}

          {/* STEP 3: Review diff */}
          {step === 'review' && results && (
            <>
              <div className="bib-enrich-review-bar">
                <span className="bib-enrich-review-counts">
                  {pendingCount > 0 && <span className="review-pending">{pendingCount} pending</span>}
                  {acceptedCount > 0 && <span className="review-accepted">{acceptedCount} accepted</span>}
                  {rejectedCount > 0 && <span className="review-rejected">{rejectedCount} rejected</span>}
                </span>
                <span className="bib-enrich-review-bulk">
                  <button className="bib-enrich-btn-sm accept" onClick={handleAcceptAll} disabled={pendingCount === 0}>
                    Accept all
                  </button>
                  <button className="bib-enrich-btn-sm reject" onClick={handleRejectAll} disabled={pendingCount === 0}>
                    Reject all
                  </button>
                </span>
              </div>

              <div className="bib-enrich-diff-list">
                {resultsWithChanges.map((r) => {
                  const entry = entries.find((e) => e.key === r.key);
                  return (
                    <div key={r.key} className="bib-enrich-diff-entry">
                      <div className="bib-enrich-diff-entry-header">
                        <span className="bib-enrich-diff-key">
                          @{entry?.type || 'misc'}
                          {'{' + r.key + '}'}
                        </span>
                      </div>
                      {Object.entries(r.added).map(([field, value]) => {
                        const statusKey = `${r.key}::${field}`;
                        const st = changeStatus[statusKey] || 'pending';
                        return (
                          <div key={field} className={`bib-enrich-diff-line ${st}`}>
                            <span className="bib-enrich-diff-plus">+</span>
                            <span className="bib-enrich-diff-field">{field}</span>
                            <span className="bib-enrich-diff-eq">=</span>
                            <span className="bib-enrich-diff-value">{'{' + value + '}'}</span>
                            <span className="bib-enrich-diff-actions">
                              {st === 'pending' && (
                                <>
                                  <button
                                    className="bib-enrich-btn-sm accept"
                                    onClick={() => setFieldStatus(r.key, field, 'accepted')}
                                    title="Accept"
                                  >
                                    ✓
                                  </button>
                                  <button
                                    className="bib-enrich-btn-sm reject"
                                    onClick={() => setFieldStatus(r.key, field, 'rejected')}
                                    title="Reject"
                                  >
                                    ✗
                                  </button>
                                </>
                              )}
                              {st === 'accepted' && (
                                <button
                                  className="bib-enrich-btn-sm undo"
                                  onClick={() => setFieldStatus(r.key, field, 'pending')}
                                  title="Undo"
                                >
                                  ↩
                                </button>
                              )}
                              {st === 'rejected' && (
                                <button
                                  className="bib-enrich-btn-sm undo"
                                  onClick={() => setFieldStatus(r.key, field, 'pending')}
                                  title="Undo"
                                >
                                  ↩
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              <div className="bib-enrich-actions">
                <button className="bib-enrich-btn primary" onClick={handleApply} disabled={acceptedCount === 0}>
                  Apply {acceptedCount} change{acceptedCount !== 1 ? 's' : ''}
                </button>
                <button className="bib-enrich-btn" onClick={() => setStep('lookup')}>
                  Back to log
                </button>
                <button className="bib-enrich-btn" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
