// Thin wrapper around fetch() targeting the local flowtex-helper binary.
//
// The helper listens on http://localhost:9876 by default. Modern browsers
// treat http://localhost as a "potentially trustworthy" origin (W3C Secure
// Contexts §3.1), so a fetch from a HTTPS-served FlowTex tab to plain HTTP
// localhost is NOT mixed-content-blocked. This eliminates the self-signed-
// cert acceptance dance that earlier phases required.
//
// Security is still real: token auth + origin allowlist + Host pin all
// apply. The only thing dropped vs the old TLS mode is integrity-on-the-
// wire over loopback — which on localhost is moot, traffic never leaves
// the machine.
//
// Users who want TLS regardless can launch the helper with --tls; the
// bridge transparently uses https in that case via the HELPER_BASE_HTTPS
// fallback below. We probe http first because it is the new default.
//
// Auth: bearer token paired via the tray-code handshake. Stored in
// localStorage under `flowtex.helper.token`. Cleared on unpair.

const HELPER_BASE_HTTP = 'http://localhost:9876';
const HELPER_BASE_HTTPS = 'https://localhost:9876';
// Cache which scheme answered most recently so we don't double-probe
// every request. Lives in localStorage so a refresh remembers.
const SCHEME_CACHE_KEY = 'flowtex.helper.scheme';
const TOKEN_STORAGE_KEY = 'flowtex.helper.token';

function getCachedBase() {
  try {
    const cached = window.localStorage.getItem(SCHEME_CACHE_KEY);
    if (cached === 'https') return HELPER_BASE_HTTPS;
    return HELPER_BASE_HTTP;
  } catch { return HELPER_BASE_HTTP; }
}

function rememberBase(url) {
  try {
    const scheme = url.startsWith('https://') ? 'https' : 'http';
    window.localStorage.setItem(SCHEME_CACHE_KEY, scheme);
  } catch { /* private mode — ignore */ }
}

// Try the preferred scheme first, fall back to the other on network error.
// Used by pingHealth / fetchHelperVersion / pairWithHelper. compileLocal
// uses the cached base directly because by then we know which one works.
//
// `targetAddressSpace: 'local'` opts into Chrome's Private Network
// Access: flowtex.click (public, HTTPS) → 127.0.0.1 (loopback) is
// otherwise blocked by the browser. Per the PNA spec there are three
// address spaces: `public`, `private` (RFC1918), and `local`
// (loopback / 127.0.0.1 / [::1]). The helper binds to loopback, so
// the right value is `local`; using `private` causes Chrome to
// reject the request with "target IP address space of `local` yet
// the resource is in [...]".
async function fetchTryBoth(path, opts) {
  const first = getCachedBase();
  const second = first === HELPER_BASE_HTTPS ? HELPER_BASE_HTTP : HELPER_BASE_HTTPS;
  const merged = { targetAddressSpace: 'local', ...(opts || {}) };
  try {
    const res = await fetch(first + path, merged);
    rememberBase(first);
    return res;
  } catch {
    // First base unreachable — let the second-base fetch throw on its
    // own if it also fails. No inner try/catch: just propagate.
    const res = await fetch(second + path, merged);
    rememberBase(second);
    return res;
  }
}

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
      const res = await fetchTryBoth('/health', { signal: ctl.signal });
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
      const res = await fetchTryBoth('/version', {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object') return null;
      // distributions_available is the full list of installed TeX
      // Live years the helper detected (typically just one, but
      // install-texlive-year.sh users can have several side-by-side).
      // The picker UI unions these with the server's list so the user
      // can pin a project to any year reachable on either side.
      const dists = Array.isArray(data.distributions_available) ? data.distributions_available : [];
      return {
        engine: typeof data.engine === 'string' ? data.engine : '',
        year: typeof data.year === 'string' ? data.year : '',
        scheme: typeof data.scheme === 'string' ? data.scheme : '',
        enginesAvailable: Array.isArray(data.engines_available) ? data.engines_available : [],
        biber: typeof data.biber === 'string' ? data.biber : '',
        distributionsAvailable: dists
          .filter((d) => d && typeof d.year === 'string')
          .map((d) => ({ year: d.year, path: typeof d.path === 'string' ? d.path : '' })),
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
export async function compileLocal({ jobId, mainFile, compiler, showTrackedChanges, texDistribution, files }) {
  const token = getHelperToken();
  if (!token) {
    return { ok: false, fatal: true, error: 'No helper token. Pair the helper in Account Settings.' };
  }
  let res;
  try {
    res = await fetchTryBoth('/compile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobId, mainFile, compiler, showTrackedChanges, texDistribution: texDistribution || '', files }),
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
    let bin;
    try {
      bin = atob(data.pdf);
    } catch (err) {
      return { ok: false, fatal: false, error: `Helper returned malformed base64: ${err?.message || err}`, log: data.log || '' };
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Sanity check: a real PDF starts with "%PDF-" (0x25 0x50 0x44 0x46 0x2D).
    // latexmk with -f keeps going past errors and can sometimes produce a
    // truncated/garbage file; bouncing it back as "no PDF" here gives the
    // user a clearer error than the PdfViewer's generic "Failed to load PDF".
    if (bytes.length < 5 ||
        bytes[0] !== 0x25 || bytes[1] !== 0x50 ||
        bytes[2] !== 0x44 || bytes[3] !== 0x46 ||
        bytes[4] !== 0x2D) {
      const head = Array.from(bytes.slice(0, Math.min(16, bytes.length)))
        .map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return {
        ok: false,
        fatal: false,
        error: `Helper returned a non-PDF blob (${bytes.length} bytes, first bytes: ${head}). Check the compile log.`,
        log: data.log || '',
      };
    }
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
    const res = await fetchTryBoth(`/pair?code=${encodeURIComponent(code)}`, {
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
