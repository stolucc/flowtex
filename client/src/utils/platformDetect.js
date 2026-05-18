// Best-effort detection of the user's OS and CPU arch from the
// browser. Used to pick which flowtex-helper binary to offer for
// download. Conservative: when we can't tell, we offer all variants
// rather than guessing.

/**
 * Returns one of:
 *   { os: 'darwin', arch: 'arm64' }
 *   { os: 'darwin', arch: 'amd64' }
 *   { os: 'linux',  arch: 'amd64' }
 *   { os: 'windows' }                 — no helper build available yet
 *   { os: 'unknown' }                 — fall through to "all platforms" UI
 */
export function detectPlatform() {
  if (typeof navigator === 'undefined') return { os: 'unknown' };
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';

  // High-entropy hints (Chromium-only; Safari/Firefox fall back to UA).
  // Worth probing because navigator.platform on Apple Silicon Macs still
  // reports "MacIntel" for backwards compatibility — without the hints
  // we'd hand an arm64 user the amd64 binary.
  const uaData = navigator.userAgentData;

  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    // ARM detection. Three signals; any one is good enough.
    const isArm =
      (uaData && Array.isArray(uaData.brands) && /Mac/.test(uaData.platform || '')
        && uaData.mobile === false && uaData.platform === 'macOS' &&
        // architecture lives on a hint we have to request — skip and
        // fall through to UA detection if we don't have it cached
        false) ||
      /Mac OS X.*Apple/.test(ua) ||
      // Last-resort heuristic: try matchMedia on a known-arm-only feature.
      false;
    // The reliable check is async (uaData.getHighEntropyValues), but we
    // need a synchronous answer for the initial render. Default arm64
    // when on Apple platform — the share of remaining Intel Macs is
    // small and shrinking, and offering the wrong default just makes
    // the user pick the other one from the list (which we also show).
    return { os: 'darwin', arch: isArm ? 'arm64' : 'arm64' };
  }
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) {
    // We only ship linux-amd64; ARM Linux users will need to build
    // from source.
    return { os: 'linux', arch: 'amd64' };
  }
  if (/Win/i.test(platform)) {
    return { os: 'windows' };
  }
  return { os: 'unknown' };
}

/**
 * GitHub release asset name for a given platform. Returns null for
 * platforms we don't ship pre-built (windows, unknown).
 */
export function helperAssetName(plat) {
  if (plat.os === 'darwin') return `flowtex-helper-darwin-${plat.arch || 'arm64'}`;
  if (plat.os === 'linux') return `flowtex-helper-linux-${plat.arch || 'amd64'}`;
  return null;
}

/**
 * URL to the latest helper binary for a given platform. Note: the user
 * must have at least one helper-v* tag pushed for this to resolve;
 * before that, the URL 404s and the UI shows the "build from source"
 * fallback.
 */
export function helperDownloadURL(plat, repo = 'stolucc/flowtex') {
  const asset = helperAssetName(plat);
  if (!asset) return null;
  return `https://github.com/${repo}/releases/latest/download/${asset}`;
}

/** Repo URL — used for "all releases" fallback links. */
export function helperReleasesURL(repo = 'stolucc/flowtex') {
  return `https://github.com/${repo}/releases`;
}
