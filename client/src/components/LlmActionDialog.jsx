import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLlmStatus, streamLlmComplete } from '../utils/helperBridge.js';
import { useAlert } from '../contexts/AlertContext.jsx';
import { LLM_TASKS } from '../utils/llmTasks.js';

/** Map a raw error string into something the user can act on.
 *
 *  The browser's bare "Failed to fetch" usually means the helper is
 *  unreachable — but the common cause right now is an outdated helper
 *  binary that lacks /llm/* routes: the browser fires a CORS preflight
 *  for the Authorization header, the old helper 404s the OPTIONS
 *  without CORS headers, and the browser surfaces the rejection as
 *  TypeError: Failed to fetch. Tell the user to rebuild + restart.
 */
function translateStatusError(raw) {
  const msg = String(raw || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return (
      "Couldn't reach the helper for LLM features. " +
      'If you upgraded recently, the helper binary on your machine ' +
      'needs to be rebuilt and restarted so it picks up the new ' +
      "/llm/* endpoints. From the helper source dir:\n" +
      '    go build -o flowtex-helper\n' +
      'then restart the helper (Quit from the menu-bar icon and re-open, ' +
      'or Ctrl-C the headless process and re-run it).'
    );
  }
  if (/Helper not paired/i.test(msg)) {
    return 'Helper not paired. Open Account Settings → Compile, run `flowtex-helper pair`, and paste the 6-digit code.';
  }
  return msg || 'Helper unavailable';
}

/** Translate an /llm/complete error into something actionable. The
 *  most common confusing case is "unknown task" — the running helper
 *  binary is older than the client and doesn't have this task wired
 *  up yet. The /llm/status supportedTasks check usually hides those
 *  menu items, but if the user gets here anyway (cached client state,
 *  helper restarted between menu open and click, etc.), surface the
 *  rebuild step instead of the bare server message.
 */
function translateGenerateError(raw) {
  const msg = String(raw || '');
  if (/unknown task/i.test(msg)) {
    return (
      'This action isn\'t supported by the running helper binary. ' +
      'You probably have an older flowtex-helper installed. Rebuild ' +
      'and restart:\n' +
      '    cd flowtex/helper\n' +
      '    go build -o flowtex-helper\n' +
      'then quit the menu-bar helper and re-open it (or Ctrl-C and ' +
      're-run the headless process).'
    );
  }
  return msg || 'Generation failed';
}

/** Local-LLM action modal. One component services all four tasks —
 *  the only per-task difference is the title + whether we show a
 *  target-words input. Lifecycle:
 *
 *   1. Mount: fetch /llm/status, pick a default model. If no LLM is
 *      available, show a helpful explanation instead of the form.
 *   2. Form: optional word-count input (write-to-length only),
 *      model picker (when more than one available).
 *   3. Generate: stream LLM output into a read-only preview.
 *   4. Done: [Accept] (replace selection in editor) / [Discard] (no-op).
 *
 *  No keystrokes from the user's selection leave the machine — the
 *  helper is loopback-only and the helper validates that on every
 *  request.
 */
export default function LlmActionDialog({ task, initialText, onClose, onAccept }) {
  const taskSpec = LLM_TASKS[task] || LLM_TASKS['write-to-length'];
  const { alert: showAlert } = useAlert();
  const initialWordCount = (initialText.match(/\S+/g) || []).length || 1;
  const [targetWords, setTargetWords] = useState(initialWordCount);
  const [instruction, setInstruction] = useState('');
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
  // Three distinct sad paths get tailored messages so the user always
  // has a concrete next step:
  //   1. "Failed to fetch"  → helper unreachable; likely an old binary
  //                           that doesn't have /llm/* endpoints yet
  //                           and is failing the CORS preflight.
  //   2. available=false    → helper reached but can't talk to Ollama.
  //   3. available=true,
  //      models=[]          → Ollama reached but no models pulled.
  useEffect(() => {
    let cancelled = false;
    fetchLlmStatus().then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok) {
        setStatusError(translateStatusError(r.error));
        return;
      }
      const s = r.status || {};
      if (!s.available) {
        setStatusError(s.error || 'No local LLM detected. Make sure Ollama is running on your machine.');
        return;
      }
      const list = Array.isArray(s.models) ? s.models : [];
      if (list.length === 0) {
        setStatusError(
          'Ollama is running but no models are installed. Pull one in a terminal:\n' +
            '    ollama pull llama3.2:3b\n' +
            'then re-open this dialog.',
        );
        return;
      }
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
    const payload = { task, input: initialText, model };
    if (taskSpec.needsTargetWords) {
      const n = parseInt(targetWords, 10);
      if (!Number.isFinite(n) || n < 1 || n > 2000) {
        showAlert('Word count must be between 1 and 2000.', { title: 'Invalid length' });
        return;
      }
      payload.targetWords = n;
    }
    if (taskSpec.needsInstruction) {
      const trimmed = (instruction || '').trim();
      if (!trimmed) {
        showAlert(
          'Tell the LLM what to do with the selected text (e.g. "translate to French", "make this sound more formal").',
          { title: 'Instruction needed' },
        );
        return;
      }
      if (trimmed.length > 1000) {
        showAlert('Instruction is too long (max 1000 characters).', { title: 'Instruction too long' });
        return;
      }
      payload.instruction = trimmed;
    }
    setGenerating(true);
    setOutput('');
    setStreamError('');
    const ctl = new AbortController();
    abortRef.current = ctl;
    const r = await streamLlmComplete(
      payload,
      (delta) => setOutput((prev) => prev + delta),
      ctl.signal,
    );
    setGenerating(false);
    if (r.aborted) return;
    if (!r.ok) setStreamError(translateGenerateError(r.error));
  }, [initialText, targetWords, instruction, model, task, taskSpec.needsTargetWords, taskSpec.needsInstruction, showAlert]);

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
          <h2 id="llm-dialog-title">{taskSpec.title}</h2>
        </div>
        {loading ? (
          <div className="llm-dialog-body"><p>Checking local LLM…</p></div>
        ) : statusError ? (
          <div className="llm-dialog-body">
            <pre className="llm-dialog-error llm-dialog-error-block">{statusError}</pre>
            <p className="llm-dialog-hint">
              Don&apos;t have Ollama yet? Get it at{' '}
              <a href="https://ollama.com/" target="_blank" rel="noreferrer">ollama.com</a>.
            </p>
            <div className="llm-dialog-actions">
              <button type="button" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <div className="llm-dialog-body">
            {taskSpec.needsTargetWords && (
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
            )}
            {taskSpec.needsInstruction && (
              <div className="llm-dialog-instruction">
                <label htmlFor="llm-instruction" className="llm-dialog-source-label">
                  Instruction
                </label>
                <textarea
                  id="llm-instruction"
                  rows={3}
                  maxLength={1000}
                  placeholder='e.g. "translate to French", "make this sound more formal", "rewrite as a single sentence"'
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  disabled={generating}
                />
                <p className="llm-dialog-hint">
                  The assistant is constrained to textual transformations of
                  your selection only — instructions like &ldquo;delete files&rdquo; or
                  &ldquo;run a command&rdquo; will be refused. Output replaces your
                  selection only after you click <strong>Accept</strong>.
                </p>
              </div>
            )}
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
                {streamError && (
                  <pre className="llm-dialog-error llm-dialog-error-block">{streamError}</pre>
                )}
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
