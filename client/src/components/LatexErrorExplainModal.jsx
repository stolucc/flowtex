// @ts-check
import React, { useEffect, useRef, useState } from 'react';
import { streamLlmComplete, fetchLlmStatus } from '../utils/helperBridge.js';

/**
 * Streams an LLM-generated explanation of a LaTeX compile error.
 *
 * Trigger: user clicks the "Explain with AI" button on an error row
 * that no rule matched. The orchestrator (App.jsx) builds the
 * instruction + input via buildExplainPrompt and passes them here.
 *
 * @param {object} props
 * @param {() => void} props.onClose
 * @param {string} props.instruction
 * @param {string} props.input
 * @param {string} props.errorText           - shown verbatim at the top
 * @param {string | null | undefined} [props.filePath]
 * @param {number | null | undefined} [props.line]
 */
export default function LatexErrorExplainModal({ onClose, instruction, input, errorText, filePath, line }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState(/** @type {'checking' | 'unavailable' | 'streaming' | 'done' | 'error'} */ ('checking'));
  const [errorMsg, setErrorMsg] = useState('');
  const abortRef = useRef(/** @type {AbortController | null} */ (null));

  useEffect(() => {
    let cancelled = false;
    abortRef.current = new AbortController();

    (async () => {
      // Probe helper LLM availability first so we can render a
      // clear "pair the helper" CTA rather than a cryptic "no
      // streaming reader" error. fetchLlmStatus returns
      // { ok: true, status } or { ok: false, error }.
      const probe = await fetchLlmStatus();
      if (cancelled) return;
      if (!probe?.ok) {
        setStatus('unavailable');
        setErrorMsg(probe?.error || 'The helper LLM is not currently available.');
        return;
      }
      const llm = probe.status;
      if (!llm?.available) {
        setStatus('unavailable');
        setErrorMsg(llm?.error || 'The helper LLM is not currently available.');
        return;
      }
      setStatus('streaming');
      const model = llm.defaultModel || (llm.models && llm.models[0]) || '';
      if (!model) {
        setStatus('unavailable');
        setErrorMsg('No LLM model is configured in the helper.');
        return;
      }

      let acc = '';
      const signal = abortRef.current?.signal;
      const result = await streamLlmComplete(
        { task: 'custom', input, model, instruction },
        (delta) => {
          if (cancelled) return;
          acc += delta;
          setText(acc);
        },
        signal,
      );
      if (cancelled) return;
      if (result.ok) {
        setStatus('done');
      } else if (result.aborted) {
        // user closed the modal mid-stream; no UI update needed
      } else {
        setStatus('error');
        setErrorMsg(result.error || 'The helper LLM returned an error.');
      }
    })();

    return () => {
      cancelled = true;
      if (abortRef.current) abortRef.current.abort();
    };
  }, [instruction, input]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-window latex-explain-modal"
        onClick={(/** @type {any} */ e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Explain with AI</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="latex-explain-context">
            <div className="latex-explain-error">
              <strong>Error:</strong>{' '}
              <code>{errorText}</code>
            </div>
            {filePath && (
              <div className="latex-explain-location">
                <strong>Location:</strong> {filePath}
                {typeof line === 'number' ? `:${line}` : ''}
              </div>
            )}
          </div>

          {status === 'checking' && (
            <div className="latex-explain-status">Checking helper status…</div>
          )}
          {status === 'unavailable' && (
            <div className="latex-explain-status latex-explain-status-error">
              <p>{errorMsg}</p>
              <p>
                Pair the helper and configure a local LLM (Ollama) to use this feature.
                See Help → Helper setup guide.
              </p>
            </div>
          )}
          {(status === 'streaming' || status === 'done') && (
            <div className="latex-explain-output">
              {/* Stream as a pre-formatted block; the model is asked to
                  output two short paragraphs (Cause / Fix) so plain
                  text rendering is plenty. */}
              <pre className="latex-explain-text">{text || (status === 'streaming' ? '…' : '')}</pre>
              {status === 'streaming' && (
                <div className="latex-explain-streaming-tag">Streaming…</div>
              )}
            </div>
          )}
          {status === 'error' && (
            <div className="latex-explain-status latex-explain-status-error">
              {errorMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
