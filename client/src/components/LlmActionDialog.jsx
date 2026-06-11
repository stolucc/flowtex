// @ts-check
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
/** @param {any} raw */
/** @param {any} raw */
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

/** Strip the conversational fluff that local LLMs add despite a
 *  "respond ONLY with the rewritten text" system prompt. Catches the
 *  common preamble shapes ("Here is...", "Sure! ...", "Of course! ...")
 *  and the trailing "let me know..." sign-offs, plus markdown code
 *  fences. Run AFTER streaming completes — mid-stream stripping is
 *  too fragile because partial chunks can't be confidently classified.
 *
 *  Intentionally conservative: anything we don't recognise is passed
 *  through untouched. Better to leave a preamble than to chew a
 *  legitimate first sentence the user wanted to keep.
 */
/** @param {string} raw */
export function stripLlmPreamble(raw) {
  if (!raw) return raw;
  let text = raw.trim();

  // Markdown code fence wrappers — drop fully wrapping ones. Inner
  // code-fenced blocks (e.g. a code-quoted LaTeX example WITHIN
  // prose) are intentionally not stripped.
  const fenceMatch = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Single quote-wrapping that some models add: leading and trailing
  // matching double-quote OR backtick. Only strip if the open/close
  // are at the very ends — otherwise we'd eat legitimate quotes
  // inside the text.
  for (const q of ['"', '`', "'", '“']) {
    const close = q === '“' ? '”' : q;
    if (text.startsWith(q) && text.endsWith(close) && text.length > 2) {
      text = text.slice(1, -1).trim();
    }
  }

  // Conversational preambles. Each pattern matches the start of the
  // text, optionally a blank line, then the real content begins. The
  // anchored regex ensures we only strip when the preamble is at the
  // very start.
  const preambles = [
    // "Here is the rewritten/paraphrased/translated/etc text:"
    /^(here\s+(?:is|are)|here(?:'|’)s)[^\n.!?]{0,120}[:\-—]\s*\n+/i,
    // "Sure! Here's..." / "Of course! ..." / "Certainly! ..."
    /^(sure|of course|certainly|absolutely|got it|okay|ok)[!,.]?\s*[^\n]{0,200}[:\-—]\s*\n+/i,
    // "I rewrote/paraphrased/translated... as follows:"
    /^I\s+(?:have\s+)?(?:rewrote|rewritten|paraphrased|translated|reformat|summarised|summarized|expanded|shortened|edited)[^\n]{0,200}[:\-—]\s*\n+/i,
    // "Below is..."
    /^below\s+is[^\n.!?]{0,120}[:\-—]\s*\n+/i,
  ];
  for (const re of preambles) {
    const m = text.match(re);
    if (m) {
      text = text.slice(m[0].length).trim();
      break; // one preamble at most; don't recursively strip prose
    }
  }

  // Trailing sign-offs.
  const signoffs = [
    /\n+(?:let me know|i hope this helps|feel free to|please let me know|hope (?:this|that) helps)[^\n]*\.?\s*$/i,
    /\n+(?:if you(?:'|’)d like|would you like)[^\n]{0,200}[?.!]\s*$/i,
  ];
  for (const re of signoffs) {
    const m = text.match(re);
    if (m) {
      text = text.slice(0, m.index).trimEnd();
      break;
    }
  }

  return text;
}

/** Translate an /llm/status `error` string (returned by the helper when
 *  it can't reach Ollama) into something actionable. The raw Go errors
 *  ("dial tcp 127.0.0.1:11434: connect: connection refused", "no such
 *  host", "i/o timeout") are accurate but unhelpful to a normal user.
 *  Match the common shapes and rewrite each into a concrete next step.
 *
 *  Conservative: anything we don't recognise is passed through with a
 *  generic preface so the original Go error still helps power users.
 */
/** @param {string} raw */
export function translateOllamaError(raw) {
  const msg = String(raw || '');
  if (!msg) {
    return 'No local LLM detected. Make sure Ollama is running on your machine.';
  }
  if (/connection refused|no connection could be made|actively refused/i.test(msg)) {
    return (
      'Ollama is not running on this machine.\n\n' +
      'macOS: open the Ollama app from /Applications.\n' +
      'Linux / terminal: run `ollama serve` (and `ollama pull llama3.2:3b` if you haven\'t pulled a model yet).\n\n' +
      'The helper expected Ollama at http://127.0.0.1:11434.'
    );
  }
  if (/no such host|nodename nor servname/i.test(msg)) {
    return (
      'The configured LLM URL doesn\'t resolve. Check `llm_base_url` in ~/.flowtex-helper/config.json.\n' +
      '(Default and recommended: http://127.0.0.1:11434)'
    );
  }
  if (/timeout|deadline exceeded/i.test(msg)) {
    return (
      'Ollama didn\'t respond in time. It may be busy loading a model — wait a few seconds and re-open this dialog.'
    );
  }
  if (/ollama returned 4\d\d|ollama returned 5\d\d/i.test(msg)) {
    return 'Ollama returned an HTTP error:\n\n' + msg;
  }
  // Unknown shape — show the raw error but prefaced so it doesn't
  // look like FlowTex is what's broken.
  return 'Couldn\'t reach the local LLM (Ollama). Raw error:\n\n' + msg;
}

/** Translate an /llm/complete error into something actionable. The
 *  most common confusing case is "unknown task" — the running helper
 *  binary is older than the client and doesn't have this task wired
 *  up yet. The /llm/status supportedTasks check usually hides those
 *  menu items, but if the user gets here anyway (cached client state,
 *  helper restarted between menu open and click, etc.), surface the
 *  rebuild step instead of the bare server message.
 */
/** @param {any} raw */
/** @param {any} raw */
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
 * @param {any} props
 */
export default function LlmActionDialog({ task, initialText, onClose, onAccept }) {
  const taskSpec = /** @type {Record<string, any>} */ (LLM_TASKS)[task] || LLM_TASKS['write-to-length'];
  const { alert: showAlert } = useAlert();
  const initialWordCount = (initialText.match(/\S+/g) || []).length || 1;
  const [targetWords, setTargetWords] = useState(initialWordCount);
  const [instruction, setInstruction] = useState('');
  const [models, setModels] = useState(/** @type {any[]} */ ([]));
  const [model, setModel] = useState('');
  const [statusError, setStatusError] = useState(''); // empty = no error
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [output, setOutput] = useState('');
  const [streamError, setStreamError] = useState('');
  const abortRef = useRef(/** @type {any} */ (null));

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
    fetchLlmStatus().then((/** @type {any} */ r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok) {
        setStatusError(translateStatusError(r.error));
        return;
      }
      const s = r.status || {};
      if (!s.available) {
        setStatusError(translateOllamaError(s.error));
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
    /** @type {any} */
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
      (delta) => setOutput((/** @type {any} */ prev) => prev + delta),
      ctl.signal,
    );
    setGenerating(false);
    if (r.aborted) return;
    if (!r.ok) {
      setStreamError(translateGenerateError(r.error));
      return;
    }
    // Local LLMs frequently add "Here is the rewritten text:" preambles
    // despite the system prompt forbidding it. Strip them now, AFTER
    // the stream is complete, so the preview pane and the Accept
    // button operate on the cleaned text (what you see is what gets
    // inserted). Stripper is intentionally conservative — it leaves
    // anything it doesn't recognise alone.
    setOutput((/** @type {any} */ cur) => stripLlmPreamble(cur));
  }, [initialText, targetWords, instruction, model, task, taskSpec.needsTargetWords, taskSpec.needsInstruction, showAlert]);

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleAccept = () => {
    if (!output.trim()) return;
    onAccept(output.trim());
    onClose();
  };

  const overlayClick = (/** @type {any} */ e) => {
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
                  onChange={(/** @type {any} */ e) => setTargetWords(e.target.value)}
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
                  onChange={(/** @type {any} */ e) => setInstruction(e.target.value)}
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
                  onChange={(/** @type {any} */ e) => setModel(e.target.value)}
                  disabled={generating}
                >
                  {models.map((/** @type {any} */ m) => <option key={m} value={m}>{m}</option>)}
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
