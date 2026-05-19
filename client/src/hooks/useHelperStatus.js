// Polls the local helper for liveness + version. Adaptive cadence:
// 3 s while not green (fast feedback after the user starts the helper or
// pairs in a different surface), 60 s once green (just a liveness check).
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

import { useState, useEffect, useCallback } from 'react';
import { pingHealth, fetchHelperVersion } from '../utils/helperBridge.js';

// Adaptive interval mirrors MfaSetupModals own probe loop.
const FAST_INTERVAL_MS = 3_000;
const SLOW_INTERVAL_MS = 60_000;

export default function useHelperStatus({ enabled }) {
  const [status, setStatus] = useState({ available: false, loading: enabled });
  const [pokeKey, setPokeKey] = useState(0);

  const probe = useCallback(async () => {
    setStatus((prev) => ({ ...prev, loading: true }));
    const alive = await pingHealth();
    if (!alive) {
      setStatus({ available: false, loading: false, error: 'unreachable' });
      return;
    }
    const version = await fetchHelperVersion();
    if (!version) {
      // Helper is up but auth failed (or returned junk). Treat as not
      // available but distinguish the error so the settings UI can prompt
      // "pair the helper" rather than "install the helper".
      setStatus({ available: false, loading: false, error: 'unpaired' });
      return;
    }
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
      return undefined;
    }
    probe();
    // Pick interval based on current status. The dep on
    // status.available makes the effect re-run when the badge flips, so
    // we naturally downshift to the slow cadence once healthy.
    const interval = status.available ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS;
    const id = setInterval(probe, interval);
    // Listen for explicit status-change pings from helperBridge AND
    // MfaSetupModal (which broadcasts on every successful probe).
    // Without this the consumer waits up to a full poll cycle to
    // notice a freshly-paired helper.
    const onChange = () => probe();
    window.addEventListener('flowtex:helper-status-changed', onChange);
    return () => {
      clearInterval(id);
      window.removeEventListener('flowtex:helper-status-changed', onChange);
    };
  }, [enabled, pokeKey, probe, status.available]);

  return { status, redetect: () => setPokeKey((k) => k + 1) };
}
