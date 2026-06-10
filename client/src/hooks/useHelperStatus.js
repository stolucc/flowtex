// @ts-check
// Polls the local helper for liveness + version. Adaptive cadence:
//   - FAST (3 s) on first mount / right after a status change, so a freshly
//     started or freshly paired helper is discovered quickly.
//   - SLOW (60 s) once the helper is green; this is just a liveness check.
//   - After FAILURES_BEFORE_GIVE_UP consecutive fast-tier failures we
//     STOP polling AND persist "offline" to localStorage for
//     OFFLINE_CACHE_TTL_MS. Subsequent page loads consult the cache
//     and skip the auto-probe entirely so the console stays clean.
//
// Two explicit recovery paths remain — both clear the cache:
//   1. AccountSettingsModal does its own probe and broadcasts
//      `flowtex:helper-status-changed`. The listener calls probe()
//      again, which on success markOnline()s and updates the status.
//   2. The redetect() callback returned from this hook (wired to
//      a "Test connection" button) clears the cache and re-mounts
//      the effect.
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
import {
  pingHealth,
  fetchHelperVersion,
  isHelperCachedOffline,
  markHelperOffline,
  clearHelperOfflineCache,
} from '../utils/helperBridge.js';

/** @typedef {import('../../../shared/types.ts').HelperStatus} HelperStatus */

const FAST_INTERVAL_MS = 3_000;
const SLOW_INTERVAL_MS = 60_000;
// How many consecutive fast-tier failures we tolerate before giving
// up. 5 × 3 s = ~15 s of rapid discovery before we go quiet.
const FAILURES_BEFORE_GIVE_UP = 5;

/**
 * @param {{ enabled: boolean }} opts
 * @returns {{ status: HelperStatus, redetect: () => void }}
 */
export default function useHelperStatus({ enabled }) {
  // useState infers T from the runtime literal shape unless we cast.
  // Without the explicit HelperStatus cast, the inferred T becomes the
  // narrow `{available: false, loading}` shape and every later
  // setStatus call that passes a `{available: true, ...}` payload
  // gets a 'true is not assignable to false' error.
  const [status, setStatus] = useState(
    /** @type {HelperStatus} */ ({ available: false, loading: enabled }),
  );
  const [pokeKey, setPokeKey] = useState(0);
  // Failures count + the live status are kept in refs so the
  // self-rescheduling tick loop can read the freshest value without
  // having them in the effect's dependency array. (Putting them in deps
  // would re-run the effect on every probe outcome, which restarts the
  // timer immediately and turns the throttle into a render-loop —
  // exactly the regression that landed in fcef109 and produced ~40
  // ERR_CONNECTION_REFUSED per second in the console.)
  const failuresRef = useRef(0);
  const availableRef = useRef(false);

  const probe = useCallback(async () => {
    setStatus((prev) => ({ ...prev, loading: true }));
    const alive = await pingHealth();
    if (!alive) {
      failuresRef.current += 1;
      availableRef.current = false;
      if (failuresRef.current >= FAILURES_BEFORE_GIVE_UP) markHelperOffline();
      setStatus({ available: false, loading: false, error: 'unreachable' });
      return;
    }
    const version = await fetchHelperVersion();
    if (!version) {
      // Helper is up but auth failed (or returned junk). Treat as not
      // available but distinguish the error so the settings UI can prompt
      // "pair the helper" rather than "install the helper".
      failuresRef.current += 1;
      availableRef.current = false;
      if (failuresRef.current >= FAILURES_BEFORE_GIVE_UP) markHelperOffline();
      setStatus({ available: false, loading: false, error: 'unpaired' });
      return;
    }
    failuresRef.current = 0;
    availableRef.current = true;
    clearHelperOfflineCache();
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
      availableRef.current = false;
      return undefined;
    }
    let cancelled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    // Self-rescheduling tick: after each probe, pick the next interval
    // based on the up-to-date refs. The effect mounts once per
    // enabled/pokeKey change, never per probe outcome, so the cadence
    // genuinely throttles.
    async function tick() {
      if (cancelled) return;
      await probe();
      if (cancelled) return;
      let next;
      if (availableRef.current) next = SLOW_INTERVAL_MS;
      else if (failuresRef.current < FAILURES_BEFORE_GIVE_UP) next = FAST_INTERVAL_MS;
      else return; // give up; user must redetect or trigger the broadcast
      timer = setTimeout(tick, next);
    }

    // Skip the auto-probe entirely when we have a recent "offline"
    // marker. The status sits at unreachable until the user explicitly
    // redetects (which clears the marker before re-mounting) or
    // AccountSettings broadcasts a successful probe (the onChange
    // listener below picks it up and re-enters the tick loop).
    if (isHelperCachedOffline()) {
      setStatus({ available: false, loading: false, error: 'unreachable' });
    } else {
      tick();
    }

    // External success ping (AccountSettingsModal broadcasts on every
    // successful probe) drops us back into FAST discovery and
    // re-probes immediately.
    const onChange = () => {
      failuresRef.current = 0;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      tick();
    };
    window.addEventListener('flowtex:helper-status-changed', onChange);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('flowtex:helper-status-changed', onChange);
    };
  }, [enabled, pokeKey, probe]);

  return {
    status,
    redetect: () => {
      failuresRef.current = 0;
      clearHelperOfflineCache();
      setPokeKey((k) => k + 1);
    },
  };
}
