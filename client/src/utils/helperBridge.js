// Thin wrapper around fetch() targeting the local flowtex-helper binary.
//
// Phase 1: helper terminates TLS with a self-signed cert and we hit it via
// https://localhost:9876. The user has to accept the cert exception once
// (browsers cache that per-origin), then this works for the lifetime of
// the cert (10 years).
//
// Phase 2 plan: ship a Lets-Encrypt cert for helper.localhost.flowtex.click
// (DNS A record → 127.0.0.1, see LOCAL_COMPILE_DESIGN.md §7.4) so the
// self-signed-cert step goes away.
//
// Auth: bearer token paired via the tray-code handshake (LOCAL_COMPILE_DESIGN.md §7.3).
// Stored in localStorage under `flowtex.helper.token`. Cleared on unpair.

const HELPER_BASE = 'https://localhost:9876';
const TOKEN_STORAGE_KEY = 'flowtex.helper.token';

export function getHelperToken() {
  try { return window.localStorage.getItem(TOKEN_STORAGE_KEY) || ''; }
  catch { return ''; }
}

export function setHelperToken(token) {
  try { window.localStorage.setItem(TOKEN_STORAGE_KEY, token); }
  catch { /* private mode — degrade silently */ }
  notifyHelperStatusChanged();
}

export function clearHelperToken() {
  try { window.localStorage.removeItem(TOKEN_STORAGE_KEY); }
  catch { /* ignore */ }
  notifyHelperStatusChanged();
}

/**
 * Fires a window event that long-lived consumers (notably the
 * useHelperStatus hook used in App.jsx) can listen for to re-probe the
 * helper immediately. Without this, App.jsx caches the "unreachable"
 * state for 5 minutes after first probe — so right after pairing the
 * PdfViewer would still show the "Local TeX Live not detected" banner
 * for several minutes even though the helper became available.
 */
function notifyHelperStatusChanged() {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event('flowtex:helper-status-changed'));
  } catch { /* very old browser without Event() — give up silently */ }
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
 * Compile a project via the local helper. Resolves to either:
 *
 *   { ok: true,  pdfBlob, log }   — helper compiled, PDF byte-array returned
 *   { ok: false, fatal: true,  error }  — bearer auth failed; token was
 *                                          cleared. Caller should fall back
 *                                          to server compile.
 *   { ok: false, fatal: true,  error }  — transport / DNS / TLS / unreachable.
 *                                          Caller should fall back to server.
 *   { ok: false, fatal: false, error, log? }
 *                                  — helper reachable, but the compile itself
 *                                    failed (no PDF). Server compile would
 *                                    fail the same way; surface the error,
 *                                    do NOT fall back.
 *
 * `fatal` distinguishes "the helper bridge is broken, retry on server"
 * from "the latex itself blew up, retrying on server is pointless".
 */
export async function compileLocal({ jobId, mainFile, compiler, showTrackedChanges, files }) {
  const token = getHelperToken();
  if (!token) {
    return { ok: false, fatal: true, error: 'No helper token. Pair the helper in Account Settings.' };
  }
  let res;
  try {
    res = await fetch(`${HELPER_BASE}/compile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobId, mainFile, compiler, showTrackedChanges, files }),
    });
  } catch (err) {
    return { ok: false, fatal: true, error: `Helper unreachable: ${err?.message || err}` };
  }
  if (res.status === 401) {
    // Stale token — helper rotated since last pair. Clear and bubble.
    clearHelperToken();
    return { ok: false, fatal: true, error: 'Helper authentication failed. Re-pair the helper.' };
  }
  if (!res.ok) {
    return { ok: false, fatal: true, error: `Helper returned HTTP ${res.status}` };
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, fatal: true, error: 'Helper returned malformed JSON' };
  }
  if (data.success && typeof data.pdf === 'string' && data.pdf.length > 0) {
    // Decode base64 PDF -> Uint8Array -> Blob. Slightly verbose because
    // atob doesn't handle binary cleanly without this dance.
    const bin = atob(data.pdf);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pdfBlob = new Blob([bytes], { type: 'application/pdf' });
    return { ok: true, pdfBlob, log: data.log || '' };
  }
  // Helper reachable, but the compile itself failed. The server compile
  // would fail the same way (same source, same TC marks); do not fall
  // back, just surface the error.
  return {
    ok: false,
    fatal: false,
    error: data.error || 'Compile failed (no PDF produced)',
    log: data.log || '',
  };
}

/**
 * Pair the helper using a 6-digit tray code shown in the helper's tray
 * menu (§7.3). On success, persists the returned bearer token to
 * localStorage and returns true. Returns false on any failure.
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
