// HelperStatusIndicator: persistent toolbar dot + popover for the local
// helper. Replaces the previous "go hunt through three menus" UX with a
// single always-visible affordance.
//
// State machine maps the existing useHelperStatus shape (already read
// via HelperStatusContext) to one of four indicator modes:
//
//   loading    — gray pulse,   "Checking helper…"
//   paired     — green dot,    "Helper paired", popover shows version
//                              + Reinstall + Open guide
//   unpaired   — yellow dot,   "Helper running but not paired", popover
//                              shows Pair button + Open guide
//   missing    — red dot,      "Helper not detected", popover shows
//                              Install button + Open guide
//
// The popover anchors right-aligned below the indicator (similar to
// the UserMenu pattern). Click-outside + Escape close it.
//
// Gated on serverFeatures.localCompile -- a deploy without the flag
// hides the indicator entirely.

import React, { useState, useEffect, useRef } from 'react';
import { useHelperStatusContext } from '../contexts/HelperStatusContext.jsx';
import useClickOutside from '../hooks/useClickOutside.js';
import {
  detectPlatform,
  helperDownloadURL,
  helperDmgURL,
  helperReleasesURL,
} from '../utils/platformDetect.js';

const COLOR_OK = '#16a34a';
const COLOR_WARN = '#f59e0b';
const COLOR_FAIL = '#ef4444';
const COLOR_PENDING = 'var(--text-muted)';

export default function HelperStatusIndicator({ onOpenSettings, onOpenGuide }) {
  const { status, redetect } = useHelperStatusContext();
  const [open, setOpen] = useState(false);
  const [latestRelease, setLatestRelease] = useState(null);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Fetch latest release info on mount. Cached server-side for 15min,
  // so this is cheap even when many tabs are open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/helper/latest-version');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setLatestRelease(data);
      } catch {
        // Best-effort; silent failure keeps the indicator quiet.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const platform = detectPlatform();

  // Map status -> indicator mode.
  let mode = 'loading';
  let label = 'Checking helper…';
  let dotColor = COLOR_PENDING;
  if (status.loading && !status.available && !status.error) {
    mode = 'loading';
  } else if (status.available) {
    mode = 'paired';
    label = 'Helper paired';
    dotColor = COLOR_OK;
  } else if (status.error === 'unpaired') {
    mode = 'unpaired';
    label = 'Helper running but not paired';
    dotColor = COLOR_WARN;
  } else if (status.error === 'unreachable') {
    mode = 'missing';
    label = 'Helper not detected';
    dotColor = COLOR_FAIL;
  }

  return (
    <div className="helper-status-indicator" ref={ref}>
      <button
        type="button"
        className="helper-status-indicator-trigger"
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
      >
        <span
          className={`helper-status-indicator-dot ${mode === 'loading' ? 'pulse' : ''}`}
          style={{ background: dotColor }}
        />
        <span className="helper-status-indicator-label">Helper</span>
      </button>
      {open && (
        <div className="helper-status-popover" role="dialog" aria-label="Helper status">
          <div className="helper-status-popover-header">
            <span className="helper-status-popover-dot" style={{ background: dotColor }} />
            <span className="helper-status-popover-title">{label}</span>
          </div>

          {mode === 'paired' && (
            <>
              <div className="helper-status-popover-meta">
                <div>TeX Live: <strong>{status.year || 'unknown year'}</strong></div>
                {status.enginesAvailable?.length > 0 && (
                  <div>Engines: {status.enginesAvailable.join(', ')}</div>
                )}
                {latestRelease?.version && (
                  <div className="helper-status-popover-hint">
                    Latest available: helper v{latestRelease.version}.
                    Reinstall if you suspect yours is older.
                  </div>
                )}
              </div>
              <PopoverActions
                primary={null}
                secondary={[
                  <a
                    key="reinstall"
                    className="helper-status-popover-link"
                    href={platform === 'macos' ? helperDmgURL('arm64') : helperDownloadURL()}
                    rel="noopener"
                  >
                    Reinstall / update
                  </a>,
                  <button
                    key="guide"
                    type="button"
                    className="helper-status-popover-link helper-status-popover-link-button"
                    onClick={() => { setOpen(false); onOpenGuide?.(); }}
                  >
                    Helper setup guide
                  </button>,
                ]}
              />
            </>
          )}

          {mode === 'unpaired' && (
            <>
              <div className="helper-status-popover-meta">
                <p>
                  The helper is running on this machine but isn&apos;t paired
                  with this browser. Pair from Account Settings → Compile.
                </p>
              </div>
              <PopoverActions
                primary={
                  <button
                    type="button"
                    className="helper-status-popover-primary"
                    onClick={() => { setOpen(false); onOpenSettings?.(); }}
                  >
                    Open pairing
                  </button>
                }
                secondary={[
                  <button
                    key="redetect"
                    type="button"
                    className="helper-status-popover-link helper-status-popover-link-button"
                    onClick={() => { redetect(); }}
                  >
                    Retry detection
                  </button>,
                  <button
                    key="guide"
                    type="button"
                    className="helper-status-popover-link helper-status-popover-link-button"
                    onClick={() => { setOpen(false); onOpenGuide?.(); }}
                  >
                    Setup guide
                  </button>,
                ]}
              />
            </>
          )}

          {mode === 'missing' && (
            <>
              <div className="helper-status-popover-meta">
                <p>
                  Install the local helper to compile on your laptop instead
                  of the server. {latestRelease?.version && (
                    <>Latest: helper v{latestRelease.version}.</>
                  )}
                </p>
              </div>
              <PopoverActions
                primary={
                  <a
                    className="helper-status-popover-primary"
                    href={platform === 'macos' ? helperDmgURL('arm64') : helperDownloadURL()}
                    rel="noopener"
                  >
                    Download for {labelForPlatform(platform)}
                  </a>
                }
                secondary={[
                  <a
                    key="all"
                    className="helper-status-popover-link"
                    href={helperReleasesURL()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    All downloads
                  </a>,
                  <button
                    key="redetect"
                    type="button"
                    className="helper-status-popover-link helper-status-popover-link-button"
                    onClick={() => { redetect(); }}
                  >
                    Retry detection
                  </button>,
                  <button
                    key="guide"
                    type="button"
                    className="helper-status-popover-link helper-status-popover-link-button"
                    onClick={() => { setOpen(false); onOpenGuide?.(); }}
                  >
                    Setup guide
                  </button>,
                ]}
              />
            </>
          )}

          {mode === 'loading' && (
            <div className="helper-status-popover-meta">
              <p>Detecting helper on localhost:9876…</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PopoverActions({ primary, secondary }) {
  return (
    <div className="helper-status-popover-actions">
      {primary}
      {secondary && secondary.length > 0 && (
        <div className="helper-status-popover-secondary">{secondary}</div>
      )}
    </div>
  );
}

function labelForPlatform(p) {
  if (p === 'macos') return 'macOS';
  if (p === 'windows') return 'Windows';
  if (p === 'linux') return 'Linux';
  return 'your platform';
}
