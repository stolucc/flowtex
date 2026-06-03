// Polls the local helper for liveness + version. Adaptive cadence:
//   - FAST (3 s) on first mount / right after a status change, so a freshly
//     started or freshly paired helper is discovered quickly.
//   - SLOW (60 s) once the helper is green; this is just a liveness check.
//   - LONG (5 min) after the helper has been unreachable for the first few
//     fast probes. Closes the "browser console full of /health ECONNREFUSED
//     errors when the helper is offline" complaint without sacrificing
//     discovery: the AccountSettingsModal broadcasts
//     `flowtex:helper-status-changed` on every successful probe it does,
//     and that event resets us back to the FAST tier; the redetect()
//     callback exposed from this hook does the same.
//
// Status shape mirrors what resolveCompileLocation() needs:
//   { available: bool, year?: string, scheme?: string, error?: string }
//
// Until a helper binary is installed + paired, this hook settles at
// { available: false, error: 'unreachable' } — that's the correct
// state, and the rest of the app degrades gracefully (settings UI shows
// "Local helper not detected", useCompilation falls back to server).
//
// Only fires the probes when the user has opted into local compile (per
// design — no point pinging localhost on every page load for users who
// will never use the feature). The caller passes `enabled` based on
// either the user's setting or the per-project override.

import { useState, useEffect, useCallback, useRef } from 'react';
import { pingHealth, fetchHelperVersion } from '../utils/helperBridge.js';

// Adaptive interval mirrors AccountSettingsModal's own probe loop.
const FAST_INTERVAL_MS = 3_000;
const SLOW_INTERVAL_MS = 60_000;
const LONG_INTERVAL_MS = 5 * 60_000;
// How many consecutive fast-tier failures we tolerate before downshifting
// to LONG_INTERVAL_MS. 5 × 3 s = ~15 s of rapid discovery, then back off.
const FAILURES_BEFORE_LONG = 5;

export default function useHelperStatus({ enabled }) {
  const [status, setStatus] = useState({ available: false, loading: enabled });
  const [pokeKey, setPokeKey] = useState(0);
  // Consecutive failures kept in state so the effect's interval picker
  // re-runs on every threshold cross. failuresRef gives the async probe
  // a stable counter to bump without restarting the interval mid-fetch.
  const failuresRef = useRef(0);
  const [failures, setFailures] = useState(0);

  const probe = useCallback(async () => {
    setStatus((prev) => ({ ...prev, loading: true }));
    const alive = await pingHealth();
    if (!alive) {
      failuresRef.current += 1;
      setFailures(failuresRef.current);
      setStatus({ available: false, loading: false, error: 'unreachable' });
      return;
    }
    const version = await fetchHelperVersion();
    if (!version) {
      // Helper is up but auth failed (or returned junk). Treat as not
      // available but distinguish the error so the settings UI can prompt
      // "pair the helper" rather than "install the helper".
      failuresRef.current += 1;
      setFailures(failuresRef.current);
      setStatus({ available: false, loading: false, error: 'unpaired' });
      return;
    }
    failuresRef.current = 0;
    setFailures(0);
    setStatus({
      available: true,
      loading: false,
      year: version.year,
      scheme: version.scheme,
      enginesAvailable: version.enginesAvailable,
      biber: version.biber,
      distributionsAvailable: version.distributionsAvailable || [],
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus({ available: false, loading: false });
      failuresRef.current = 0;
      return undefined;
    }
    probe();
    // Tier selection: green → SLOW; freshly unreachable → FAST for the
    // first few probes (discover-on-restart); stubbornly unreachable →
    // LONG so we don't fill the console.
    let interval;
    if (status.available) interval = SLOW_INTERVAL_MS;
    else if (failures < FAILURES_BEFORE_LONG) interval = FAST_INTERVAL_MS;
    else interval = LONG_INTERVAL_MS;
    const id = setInterval(probe, interval);
    // Any external success ping (e.g. user paired the helper in
    // AccountSettingsModal, which broadcasts on every successful probe)
    // resets the failure counter and re-probes immediately so we drop
    // back into FAST discovery instead of waiting up to LONG_INTERVAL_MS.
    const onChange = () => {
      failuresRef.current = 0;
      setFailures(0);
      probe();
    };
    window.addEventListener('flowtex:helper-status-changed', onChange);
    return () => {
      clearInterval(id);
      window.removeEventListener('flowtex:helper-status-changed', onChange);
    };
  }, [enabled, pokeKey, probe, status.available, failures]);

  return {
    status,
    redetect: () => {
      failuresRef.current = 0;
      setFailures(0);
      setPokeKey((k) => k + 1);
    },
  };
}
