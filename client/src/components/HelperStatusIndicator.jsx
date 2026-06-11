// @ts-check
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

/** @typedef {import('../../../shared/types.ts').HelperStatus} HelperStatus */
/** @typedef {import('../../../shared/types.ts').LatestHelperVersionResponse} LatestHelperVersionResponse */
/** @typedef {import('../../../shared/types.ts').Platform} Platform */

const COLOR_OK = '#16a34a';
const COLOR_WARN = '#f59e0b';
const COLOR_FAIL = '#ef4444';
const COLOR_PENDING = 'var(--text-muted)';

/**
 * @param {{ onOpenSettings?: () => void, onOpenGuide?: () => void }} props
 */
export default function HelperStatusIndicator({ onOpenSettings, onOpenGuide }) {
  const { status, redetect } = useHelperStatusContext();
  const [open, setOpen] = useState(false);
  /** @type {[LatestHelperVersionResponse | null, (v: LatestHelperVersionResponse | null) => void]} */
  const [latestRelease, setLatestRelease] = useState(
    /** @type {LatestHelperVersionResponse | null} */ (null),
  );
  const ref = useRef(/** @type {any} */ (null));
  useClickOutside(ref, () => setOpen(false), open);

  useEffect(() => {
    if (!open) return undefined;
    /** @param {KeyboardEvent} e */
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

  // detectPlatform returns { os: 'darwin'|'linux'|'windows'|'unknown', arch }.
  // platformDetect's URL helpers all take this object (not a string).
  const platform = detectPlatform();
  // Prefer a .dmg URL on macOS (menu-bar app installer); raw binary
  // everywhere else. Falls to null on platforms we don't ship binaries
  // for (Windows pre-v0.2.7, "unknown"); the UI then exposes the
  // all-releases page instead.
  const downloadHref = (platform.os === 'darwin')
    ? helperDmgURL(platform)
    : helperDownloadURL(platform);

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
        onClick={() => setOpen((/** @type {any} */ v) => !v)}
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

          {/* Discriminator-based JSX: each branch reads status.available
              or status.error directly so the type narrowing fires. The
              `mode` variable still drives the dot color + label at the
              top, but inside the JSX we re-check the discriminator so
              TypeScript can prove which fields exist. */}
          {status.available && (
            <>
              <div className="helper-status-popover-meta">
                <div>TeX Live: <strong>{status.year || 'unknown year'}</strong></div>
                {status.enginesAvailable && status.enginesAvailable.length > 0 && (
                  <div>Engines: {status.enginesAvailable.join(', ')}</div>
                )}
                <HelperVersionLine
                  installed={status.helperVersion}
                  latest={latestRelease?.version}
                />
              </div>
              <PopoverActions
                primary={null}
                secondary={[
                  <a
                    key="reinstall"
                    className="helper-status-popover-link"
                    href={downloadHref || helperReleasesURL()}
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

          {!status.available && status.error === 'unpaired' && (
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

          {!status.available && status.error === 'unreachable' && (
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
                    href={downloadHref || helperReleasesURL()}
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

/**
 * @param {{
 *   primary: React.ReactNode,
 *   secondary?: React.ReactNode[]
 * }} props
 */
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

/** @typedef {'unknown' | 'up-to-date' | 'older' | 'newer'} VersionVerdict */

// Compare installed helper version against the latest published
// release. Returns 'unknown' for helpers that predate the
// helper_version field (helper v0.3.0 and older -- the field shipped
// in v0.3.1), 'up-to-date' when both sides agree, 'older' when the
// installed version semver-precedes the latest, 'newer' when the
// installed version is somehow ahead (dev builds, manually-built).
//
// Pure-string semver compare is intentional -- we control both ends
// (helper-vX.Y.Z tags), so we don't need to handle pre-release suffixes
// or build metadata. If the format diverges in the future, fall back
// to "unknown" rather than guessing.
/**
 * @param {string | null | undefined} installed
 * @param {string | null | undefined} latest
 * @returns {VersionVerdict}
 */
/** @param {string} installed @param {string} latest */
function compareHelperVersion(installed, latest) {
  if (!installed || !latest) return 'unknown';
  /** @param {string} s */
  const parse = (/** @type {any} */ s) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b) return 'unknown';
  for (let i = 0; i < 3; i++) {
    // a and b are 3-tuples by construction (parse returns null
    // otherwise) so the bracket index is always defined.
    const ai = /** @type {number} */ (a[i]);
    const bi = /** @type {number} */ (b[i]);
    if (ai < bi) return 'older';
    if (ai > bi) return 'newer';
  }
  return 'up-to-date';
}

/**
 * @param {{
 *   installed: string | null | undefined,
 *   latest: string | null | undefined
 * }} props
 */
function HelperVersionLine({ installed, latest }) {
  const verdict = compareHelperVersion(installed || '', latest || '');
  if (verdict === 'older') {
    return (
      <div className="helper-status-popover-hint helper-status-popover-update">
        Update available: helper v{latest} (you have v{installed}).
      </div>
    );
  }
  if (verdict === 'up-to-date') {
    return (
      <div className="helper-status-popover-hint">
        Helper v{installed} (latest).
      </div>
    );
  }
  if (verdict === 'newer') {
    return (
      <div className="helper-status-popover-hint">
        Helper v{installed} (dev build, ahead of latest released v{latest}).
      </div>
    );
  }
  // 'unknown' -- helper too old to report its version, OR latest
  // metadata not yet loaded. Fall back to the v0.3.0 wording.
  if (latest) {
    return (
      <div className="helper-status-popover-hint">
        Latest available: helper v{latest}. Reinstall if you suspect yours is older.
      </div>
    );
  }
  return null;
}

/**
 * @param {Platform | undefined | null} p
 * @returns {string}
 */
/** @param {any} p */
/** @param {any} p */
function labelForPlatform(p) {
  if (!p) return 'your platform';
  if (p.os === 'darwin') return 'macOS';
  if (p.os === 'windows') return 'Windows';
  if (p.os === 'linux') return 'Linux';
  return 'your platform';
}
