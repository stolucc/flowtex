// Thin wrapper around fetch() targeting the local flowtex-helper binary.
// The helper exposes its API on https://helper.localhost.flowtex.click:9876
// (DNS A record points to 127.0.0.1, helper terminates TLS with a real
// Lets-Encrypt cert — see LOCAL_COMPILE_DESIGN.md §7.4 for why the
// elaborate hostname dance instead of plain http://127.0.0.1).
//
// Auth: bearer token paired via the tray-code handshake (§7.3). Stored in
// localStorage under `flowtex.helper.token`. Cleared on unpair.
//
// Status: as of Phase 3, this module exposes the shape the rest of the
// app needs but pingHealth() will always return `{ available: false }`
// for users who haven't installed and paired a helper. Once the helper
// binary ships (Phase 1), the same endpoints become reachable and this
// file flips on automatically.

const HELPER_BASE = 'https://helper.localhost.flowtex.click:9876';
const TOKEN_STORAGE_KEY = 'flowtex.helper.token';

export function getHelperToken() {
  try { return window.localStorage.getItem(TOKEN_STORAGE_KEY) || ''; }
  catch { return ''; }
}

export function setHelperToken(token) {
  try { window.localStorage.setItem(TOKEN_STORAGE_KEY, token); }
  catch { /* private mode — degrade silently */ }
}

export function clearHelperToken() {
  try { window.localStorage.removeItem(TOKEN_STORAGE_KEY); }
  catch { /* ignore */ }
}

/**
 * Ping the helpers /health endpoint. Unauthenticated by design — this is
 * the "is the helper even running" probe. Returns true on 2xx, false on
 * any failure (network error, DNS, TLS, 4xx/5xx, timeout). Never throws.
 *
 * Timeout is short (1500ms) because this fires on app load + every few
 * minutes; we cant block the UI on a slow loopback resolution.
 */
export async function pingHealth() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    try {
      const res = await fetch(`${HELPER_BASE}/health`, { signal: ctl.signal });
      return res.ok;
    } finally { clearTimeout(timer); }
  } catch {
    return false;
  }
}

/**
 * Fetch the helpers reported TeX Live year + capabilities. Requires the
 * bearer token. Returns null if the helper is unreachable, unauthenticated,
 * or returns a malformed payload (defence against a stale token surviving
 * a helper reinstall that rotated the secret).
 */
export async function fetchHelperVersion() {
  const token = getHelperToken();
  if (!token) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    try {
      const res = await fetch(`${HELPER_BASE}/version`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object') return null;
      return {
        engine: typeof data.engine === 'string' ? data.engine : '',
        year: typeof data.year === 'string' ? data.year : '',
        scheme: typeof data.scheme === 'string' ? data.scheme : '',
        enginesAvailable: Array.isArray(data.engines_available) ? data.engines_available : [],
        biber: typeof data.biber === 'string' ? data.biber : '',
      };
    } finally { clearTimeout(timer); }
  } catch {
    return null;
  }
}

/**
 * Pair the helper using a 6-digit tray code shown in the helper's tray
 * menu (§7.3). On success, persists the returned bearer token to
 * localStorage and returns true. Returns false on any failure.
 *
 * NOTE: not yet usable — the helper binary doesn't exist as of Phase 3.
 * Wired now so the settings UI button has somewhere to call; will start
 * succeeding the day a helper ships.
 */
export async function pairWithHelper(code) {
  if (!/^\d{6}$/.test(String(code || ''))) return { ok: false, error: 'Code must be 6 digits' };
  try {
    const res = await fetch(`${HELPER_BASE}/pair?code=${encodeURIComponent(code)}`, {
      method: 'POST',
    });
    if (!res.ok) return { ok: false, error: `Helper returned ${res.status}` };
    const data = await res.json();
    if (!data?.token || typeof data.token !== 'string') {
      return { ok: false, error: 'Helper returned no token' };
    }
    setHelperToken(data.token);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not reach helper' };
  }
}
