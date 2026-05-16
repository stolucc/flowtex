import React, { useState } from 'react';
import { post } from '../api.js';

// The fixed list of feature areas a bug can be tagged with. Kept short so
// the modal stays scannable; users can always describe edge cases in the
// free-text body. Order roughly matches surface area / how often something
// goes wrong, not alphabetical.
const FEATURE_OPTIONS = [
  'Editor',
  'Compile / PDF viewer',
  'Track changes',
  'Comments',
  'Notifications',
  'Chat',
  'Real-time collaboration',
  'File management',
  'Visual mode (WYSIWYG)',
  'GitHub sync',
  'BibTeX / Zotero',
  'DOCX import',
  'Project copy / sharing',
  'Account settings / MFA',
  'Admin dashboard',
  'Something else',
];

/** Bug-report modal launched from Help → Report a bug. Sends a free-text
 *  description plus one or more feature-area tags to the admin inbox. */
export default function BugReportModal({ onClose }) {
  const [description, setDescription] = useState('');
  const [features, setFeatures] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const toggleFeature = (name) => {
    setFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const canSubmit = description.trim().length > 0 && !submitting;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await post('/api/bug-reports', {
        description: description.trim(),
        features: Array.from(features),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to send bug report');
        setSubmitting(false);
        return;
      }
      setSent(true);
      // Auto-close after a brief confirmation so the user can see "Sent".
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err.message || 'Failed to send bug report');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div className="modal bug-report-modal">
        <div className="modal-header">
          <h2>Report a bug</h2>
          <button className="modal-close" onClick={onClose} disabled={submitting}>&times;</button>
        </div>
        {sent ? (
          <div className="bug-report-sent">
            <p>Thanks — your bug report has been sent to the admin team.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bug-report-body">
            <label className="bug-report-field">
              <span>What went wrong?</span>
              <textarea
                autoFocus
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                maxLength={10000}
                placeholder="Describe what you were doing, what you expected, and what happened instead. Include steps to reproduce if you can."
              />
            </label>
            <fieldset className="bug-report-features">
              <legend>Which area(s) does this affect?</legend>
              <div className="bug-report-features-grid">
                {FEATURE_OPTIONS.map((name) => (
                  <label key={name} className="bug-report-feature-option">
                    <input
                      type="checkbox"
                      checked={features.has(name)}
                      onChange={() => toggleFeature(name)}
                    />
                    {name}
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <div className="bug-report-error">{error}</div>}
            <div className="bug-report-actions">
              <button type="button" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="submit" className="bug-report-submit" disabled={!canSubmit}>
                {submitting ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
