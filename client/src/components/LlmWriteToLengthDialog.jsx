import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLlmStatus, streamLlmComplete } from '../utils/helperBridge.js';
import { useAlert } from '../contexts/AlertContext.jsx';

/** "Write to length" modal — rewrites the selected text to a target
 *  word count via the local LLM. Modal lifecycle:
 *
 *   1. Mount: fetch /llm/status, pick a default model. If no LLM is
 *      available, show a helpful explanation instead of the form.
 *   2. Form: word-count input (defaults to selection's word count),
 *      model picker (if more than one available).
 *   3. Generate: stream LLM output into a read-only preview.
 *   4. Done: [Accept] (replace selection in editor) / [Discard] (no-op).
 *
 *  No keystrokes from the user's selection leave the machine — the
 *  helper is loopback-only and the helper validates that on every
 *  request.
 */
export default function LlmWriteToLengthDialog({ initialText, onClose, onAccept }) {
  const { alert: showAlert } = useAlert();
  const initialWordCount = (initialText.match(/\S+/g) || []).length || 1;
  const [targetWords, setTargetWords] = useState(initialWordCount);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [statusError, setStatusError] = useState(''); // empty = no error
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [output, setOutput] = useState('');
  const [streamError, setStreamError] = useState('');
  const abortRef = useRef(null);

  // Fetch helper LLM status on mount. If the helper isn't paired, or
  // Ollama isn't running, the user sees a one-line explanation.
  useEffect(() => {
    let cancelled = false;
    fetchLlmStatus().then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok) {
        setStatusError(r.error || 'Helper unavailable');
        return;
      }
      const s = r.status || {};
      if (!s.available) {
        setStatusError(s.error || 'No local LLM detected. Make sure Ollama is running on your machine.');
        return;
      }
      const list = Array.isArray(s.models) ? s.models : [];
      setModels(list);
      // Pick the helper's default model if it's installed; otherwise
      // fall back to the first installed model.
      const def = s.defaultModel && list.includes(s.defaultModel) ? s.defaultModel : list[0] || '';
      setModel(def);
    });
    return () => { cancelled = true; };
  }, []);

  // Cancel any in-flight stream when the modal closes — even if the
  // model is mid-generation, the helper should stop chewing CPU.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!model) {
      showAlert('Pick a model first.', { title: 'No model selected' });
      return;
    }
    const n = parseInt(targetWords, 10);
    if (!Number.isFinite(n) || n < 1 || n > 2000) {
      showAlert('Word count must be between 1 and 2000.', { title: 'Invalid length' });
      return;
    }
    setGenerating(true);
    setOutput('');
    setStreamError('');
    const ctl = new AbortController();
    abortRef.current = ctl;
    const r = await streamLlmComplete(
      { task: 'write-to-length', input: initialText, targetWords: n, model },
      (delta) => setOutput((prev) => prev + delta),
      ctl.signal,
    );
    setGenerating(false);
    if (r.aborted) return;
    if (!r.ok) setStreamError(r.error || 'Generation failed');
  }, [initialText, targetWords, model, showAlert]);

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleAccept = () => {
    if (!output.trim()) return;
    onAccept(output.trim());
    onClose();
  };

  const overlayClick = (e) => {
    if (e.target === e.currentTarget && !generating) onClose();
  };

  return (
    <div className="modal-overlay" onClick={overlayClick}>
      <div className="modal llm-dialog" role="dialog" aria-modal="true" aria-labelledby="llm-dialog-title">
        <div className="modal-header">
          <h2 id="llm-dialog-title">Write to length</h2>
        </div>
        {loading ? (
          <div className="llm-dialog-body"><p>Checking local LLM…</p></div>
        ) : statusError ? (
          <div className="llm-dialog-body">
            <p className="llm-dialog-error">{statusError}</p>
            <p className="llm-dialog-hint">
              This feature uses a local LLM via the flowtex-helper. Install Ollama
              (<a href="https://ollama.com/" target="_blank" rel="noreferrer">ollama.com</a>)
              and pull a model, then re-open this dialog.
            </p>
            <div className="llm-dialog-actions">
              <button type="button" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <div className="llm-dialog-body">
            <div className="llm-dialog-row">
              <label htmlFor="llm-words">Target length</label>
              <input
                id="llm-words"
                type="number"
                min={1}
                max={2000}
                value={targetWords}
                onChange={(e) => setTargetWords(e.target.value)}
                disabled={generating}
              />
              <span className="llm-dialog-row-suffix">words</span>
            </div>
            {models.length > 1 && (
              <div className="llm-dialog-row">
                <label htmlFor="llm-model">Model</label>
                <select
                  id="llm-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={generating}
                >
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
            <div className="llm-dialog-source">
              <div className="llm-dialog-source-label">Selected ({initialWordCount} words):</div>
              <div className="llm-dialog-source-text">{initialText}</div>
            </div>
            {(output || generating || streamError) && (
              <div className="llm-dialog-output">
                <div className="llm-dialog-output-label">
                  Suggested {generating && <span className="llm-dialog-spinner">…</span>}
                </div>
                <div className="llm-dialog-output-text">{output || (generating ? '…' : '')}</div>
                {streamError && <div className="llm-dialog-error">{streamError}</div>}
              </div>
            )}
            <div className="llm-dialog-actions">
              {generating ? (
                <button type="button" onClick={handleStop}>Stop</button>
              ) : (
                <button type="button" onClick={onClose}>Cancel</button>
              )}
              {output && !generating ? (
                <>
                  <button type="button" onClick={handleGenerate}>Regenerate</button>
                  <button type="button" className="llm-dialog-accept" onClick={handleAccept}>Accept</button>
                </>
              ) : (
                <button
                  type="button"
                  className="llm-dialog-accept"
                  onClick={handleGenerate}
                  disabled={generating || !model}
                >
                  {generating ? 'Generating…' : 'Generate'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
