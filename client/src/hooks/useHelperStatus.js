// Polls the local helper for liveness + version, every 5 minutes plus an
// immediate ping on mount and on `pokeKey` increment (settings UI fires
// poke when the user clicks "Re-detect").
//
// Status shape mirrors what resolveCompileLocation() needs:
//   { available: bool, year?: string, scheme?: string, error?: string }
//
// Until a helper binary exists (Phase 1), this hook will always settle
// at { available: false, error: 'unreachable' } — that's the correct
// state, and the rest of the app degrades gracefully (settings UI shows
// "Local helper not detected", useCompilation falls back to server).
//
// Only fires the probes when the user has opted into local compile (per
// design — no point pinging localhost on every page load for users who
// will never use the feature). The caller passes `enabled` based on
// either the user's setting or the per-project override.

import { useState, useEffect, useCallback } from 'react';
import { pingHealth, fetchHelperVersion } from '../utils/helperBridge.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

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
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Reset to a clean disabled state so the UI doesnt show a stale
      // "available" badge after the user switches their preference off.
      setStatus({ available: false, loading: false });
      return undefined;
    }
    probe();
    const id = setInterval(probe, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, pokeKey, probe]);

  return { status, redetect: () => setPokeKey((k) => k + 1) };
}
