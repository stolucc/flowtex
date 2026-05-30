import React, { useEffect, useState } from 'react';
import { fetchLlmStatus, pingHealth, fetchHelperVersion } from '../utils/helperBridge.js';

/** End-user setup + troubleshooting guide for flowtex-helper.
 *
 *  Shown from Help → Helper setup guide. Tries hard to tell the user
 *  exactly which step they're stuck on by probing the helper's
 *  /health, /version, and /llm/status on mount and surfacing a small
 *  status panel at the top of the dialog.
 *
 *  The body is plain instructional text — install, pair, configure
 *  local compile, configure local LLM, troubleshooting. No live
 *  controls (pairing has its own UI in Account Settings → Compile).
 */
export default function HelperGuideModal({ onClose }) {
  const [probe, setProbe] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = { helperReachable: false, paired: false, llm: null, version: '' };
      // /health is unauth + Origin-gated (post L1 fix). Reachable = the
      // helper is up at all.
      result.helperReachable = await pingHealth();
      if (!result.helperReachable) {
        if (!cancelled) setProbe({ loading: false, ...result });
        return;
      }
      // /version requires bearer, so a successful response = paired.
      const v = await fetchHelperVersion();
      result.paired = !!v?.version;
      result.version = v?.version || '';
      if (result.paired) {
        const s = await fetchLlmStatus();
        result.llm = s.ok ? s.status : { error: s.error || 'unknown' };
      }
      if (!cancelled) setProbe({ loading: false, ...result });
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal helper-guide-modal" role="dialog" aria-modal="true" aria-labelledby="helper-guide-title">
        <div className="modal-header">
          <h2 id="helper-guide-title">FlowTex helper — setup guide</h2>
        </div>
        <div className="helper-guide-body">
          <StatusPanel probe={probe} />

          <section className="helper-guide-section">
            <h3>What is the helper?</h3>
            <p>
              <code>flowtex-helper</code> is a small companion app that runs on
              <strong> your own machine</strong>. It enables two opt-in
              FlowTex features whose data should never leave your computer:
            </p>
            <ul>
              <li><strong>Local LaTeX compile</strong> — projects compile via your local TeX Live install, not on the FlowTex server.</li>
              <li><strong>Local LLM writing assistant</strong> — right-click selected text to rewrite / paraphrase / itemize via a local Ollama model.</li>
            </ul>
            <p>
              Source files and PDFs travel only between your browser and your
              helper. The FlowTex server is not in the loop for those features.
            </p>
          </section>

          <section className="helper-guide-section">
            <h3>1 · Install the helper</h3>
            <p><strong>macOS:</strong></p>
            <ol>
              <li>Download <code>FlowTexHelper.dmg</code> from
                <a href="https://github.com/stolucc/flowtex/releases" target="_blank" rel="noreferrer">github.com/stolucc/flowtex/releases</a>
                (look for the most recent <code>helper-v*</code> tag).</li>
              <li>Open the .dmg and drag <strong>FlowTexHelper.app</strong> to <code>/Applications</code>.</li>
              <li>Right-click the app and choose <strong>Open</strong> the first time (the binary is ad-hoc signed, not notarised — Gatekeeper warns once).</li>
              <li>An <strong>fTx</strong> icon appears in your menu bar; the helper is now running.</li>
            </ol>
            <p><strong>Windows:</strong></p>
            <ol>
              <li>Download <code>flowtex-helper-windows-amd64.exe</code> from the same
                <a href="https://github.com/stolucc/flowtex/releases" target="_blank" rel="noreferrer">GitHub Releases</a> page.</li>
              <li>Move it somewhere stable (e.g. <code>C:\Program Files\FlowTex\flowtex-helper.exe</code> or a folder in your user profile).</li>
              <li>Double-click to run. SmartScreen will warn the first time
                because the binary is not code-signed; click <strong>More info</strong> → <strong>Run anyway</strong>.</li>
              <li>The <strong>fTx</strong> icon appears in your system tray (bottom-right notification area).</li>
              <li>(Optional) for auto-start at login, drop a shortcut to the .exe into
                <code>%AppData%\Microsoft\Windows\Start Menu\Programs\Startup</code>.</li>
            </ol>
            <p><strong>Linux:</strong></p>
            <pre className="helper-guide-code">curl -fsSL https://github.com/stolucc/flowtex/releases/latest/download/install.sh | bash</pre>
            <p>
              The installer downloads the helper binary, verifies the SHA256
              against the release&apos;s signed <code>SHA256SUMS</code>, and installs
              to <code>/usr/local/bin/flowtex-helper</code>. Start it with
              <code> flowtex-helper</code> in a terminal (it stays in the
              foreground — use systemd for an always-on setup).
            </p>
          </section>

          <section className="helper-guide-section">
            <h3>2 · Pair with FlowTex</h3>
            <p>Pairing tells your browser which helper to talk to and exchanges a bearer token.</p>
            <ol>
              <li>In FlowTex, open <strong>Account Settings → Compile</strong>.</li>
              <li>
                <strong>macOS / Windows</strong>: click the <strong>fTx</strong> tray icon → <strong>Generate pairing code</strong>. A native dialog shows the 6-digit code and auto-copies it to the clipboard.<br />
                <strong>Linux</strong>: run <code>flowtex-helper pair</code> in a terminal — it prints a 6-digit code.
              </li>
              <li>Paste the code into the <strong>Pair helper</strong> input in FlowTex.</li>
              <li>The status row flips green: <strong>Paired. TeX Live YYYY</strong>.</li>
            </ol>
            <p className="helper-guide-note">
              The code is valid for 60 seconds and can be entered five times before the window closes (brute-force guard). If you miss the window, generate a new one.
            </p>
          </section>

          <section className="helper-guide-section">
            <h3>3 · Use local compile</h3>
            <p>Once paired, set <strong>Account Settings → Compile</strong> → <strong>Compile location</strong> to <strong>My local TeX Live</strong>. You can override this per-project in <strong>Project Settings → Compiler</strong>.</p>
            <p>If you have multiple TeX Live years installed (<code>/usr/local/texlive/2024</code>, <code>/usr/local/texlive/2025</code>, ...), the year picker shows what your helper can see.</p>
          </section>

          <section className="helper-guide-section">
            <h3>4 · Use local LLM (writing assistant)</h3>
            <p>The helper proxies to <a href="https://ollama.com/" target="_blank" rel="noreferrer">Ollama</a> — a local-LLM runtime that ships as a single binary. Install it, pull at least one model, and the right-click menu options light up.</p>
            <ol>
              <li>Install Ollama from <a href="https://ollama.com/" target="_blank" rel="noreferrer">ollama.com</a>.</li>
              <li>Pull a model. Good defaults:
                <pre className="helper-guide-code">ollama pull llama3.2:3b     # ~2 GB, fast on most hardware
ollama pull qwen2.5:7b      # ~5 GB, better at writing</pre>
              </li>
              <li>Verify it&apos;s running:
                <pre className="helper-guide-code">curl -s http://127.0.0.1:11434/api/tags</pre>
                You should see a JSON list of models.
              </li>
              <li>In FlowTex, <strong>select some text in the editor → right-click → pick an action</strong>:
                <ul>
                  <li><strong>Write to length…</strong> — rewrite to a target word count.</li>
                  <li><strong>Paraphrase</strong> — reword with similar length.</li>
                  <li><strong>Itemize</strong> — convert prose into a LaTeX <code>itemize</code> environment.</li>
                  <li><strong>Write it out</strong> — bullets back to a prose paragraph.</li>
                </ul>
              </li>
              <li>The dialog streams tokens live. Click <strong>Accept</strong> to replace your selection; <strong>Discard / Cancel</strong> leaves it alone.</li>
            </ol>
          </section>

          <section className="helper-guide-section">
            <h3>5 · Troubleshooting</h3>
            <dl className="helper-guide-faq">
              <dt>The status panel says &quot;helper not reachable&quot;.</dt>
              <dd>Make sure the helper is running. macOS: check the menu bar for fTx. Windows: check the system tray (bottom-right). Linux: <code>ps aux | grep flowtex-helper</code>. If it&apos;s not, start it.</dd>

              <dt>I just upgraded FlowTex and LLM features show &quot;Failed to fetch&quot;.</dt>
              <dd>Your helper binary is older than the new endpoints. Rebuild + restart:
                <pre className="helper-guide-code">cd flowtex/helper
go build -o flowtex-helper
# Restart: Quit from menu bar and re-open, or Ctrl-C and re-run.</pre>
              </dd>

              <dt>Pairing failed / paired but compile says &quot;Helper unavailable&quot;.</dt>
              <dd>Re-pair: in the helper menu bar, <strong>Generate pairing code</strong>, then paste it again in Account Settings → Compile. Tokens rotate on every pair, so the old browser is implicitly de-authenticated.</dd>

              <dt>LLM dialog says &quot;Ollama is running but no models are installed&quot;.</dt>
              <dd>Pull at least one model: <code>ollama pull llama3.2:3b</code>, then re-open the dialog.</dd>

              <dt>Ollama runs on a non-default port.</dt>
              <dd>Edit <code>~/.flowtex-helper/config.json</code> (Windows: <code>%USERPROFILE%\.flowtex-helper\config.json</code>) and set <code>&quot;llm_base_url&quot;: &quot;http://127.0.0.1:PORT&quot;</code>. The helper rejects non-loopback URLs at load time, so the value MUST be 127.0.0.1, ::1, or localhost.</dd>

              <dt>Self-hosting FlowTex on a different domain.</dt>
              <dd>The helper rejects requests from unknown origins. Add your domain: <code>flowtex-helper allow-origin https://your-flowtex.example.edu</code> and restart the helper.</dd>
            </dl>
          </section>

          <section className="helper-guide-section">
            <h3>What stays on your machine</h3>
            <ul>
              <li><strong>Local compile</strong>: project source + PDF travel browser → helper → browser only. Never touch the FlowTex server.</li>
              <li><strong>Local LLM</strong>: selected text → helper → Ollama → helper → browser. Helper validates that the Ollama URL is loopback before each request.</li>
            </ul>
            <p>For full security details see <code>helper/README.md</code> and <code>LOCAL_COMPILE_DEPLOY.md</code> in the FlowTex repo.</p>
          </section>

          <div className="helper-guide-actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Live status row at the top — runs three probes in series and tells
 *  the user which one failed first. Saves them digging into the body
 *  to figure out where they're stuck. */
function StatusPanel({ probe }) {
  if (probe.loading) {
    return <div className="helper-guide-status">Checking helper status…</div>;
  }
  const items = [];
  items.push({
    label: 'Helper running',
    ok: probe.helperReachable,
    detail: probe.helperReachable ? (probe.version ? `version ${probe.version}` : 'reachable') : 'not reachable',
  });
  items.push({
    label: 'Paired',
    ok: probe.paired,
    detail: probe.paired ? 'bearer token accepted' : (probe.helperReachable ? 'no token, run pairing' : 'n/a'),
  });
  const llm = probe.llm;
  items.push({
    label: 'Ollama',
    ok: !!llm && llm.available,
    detail: !probe.paired
      ? 'n/a'
      : llm?.available
        ? (llm.models?.length ? `${llm.models.length} model${llm.models.length === 1 ? '' : 's'} available` : 'running, 0 models')
        : (llm?.error || 'not detected'),
  });
  return (
    <div className="helper-guide-status">
      {items.map((it) => (
        <div key={it.label} className={`helper-guide-status-row ${it.ok ? 'ok' : 'fail'}`}>
          <span className="helper-guide-status-dot" aria-hidden>{it.ok ? '●' : '○'}</span>
          <span className="helper-guide-status-label">{it.label}</span>
          <span className="helper-guide-status-detail">{it.detail}</span>
        </div>
      ))}
    </div>
  );
}
