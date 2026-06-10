// @ts-check
// Best-effort detection of the user's OS and CPU arch from the
// browser. Used to pick which flowtex-helper binary to offer for
// download. Conservative: when we can't tell, we offer all variants
// rather than guessing.
//
// Type contracts: Platform / OperatingSystem / Architecture from
// shared/types.ts. Opted into ts-check (see tsconfig.json include).

/** @typedef {import('../../../shared/types.ts').Platform} Platform */

/**
 * Returns the detected OS + arch, falling back to { os: 'unknown' }
 * when navigator is missing or we can't classify the UA. Sync by
 * design -- the indicator renders during initial paint and can't
 * wait for the userAgentData async API.
 *
 * @returns {Platform}
 */
export function detectPlatform() {
  if (typeof navigator === 'undefined') return { os: 'unknown' };
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';

  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    // The only reliable arch signal (userAgentData.getHighEntropyValues
    // for "architecture") is async, but we need a synchronous answer
    // for the initial render. navigator.platform on Apple Silicon Macs
    // still reports "MacIntel" for backward compatibility, so a sync
    // UA scrape can't distinguish. Default to arm64 — the share of
    // remaining Intel Macs is small and the dropdown still lists the
    // other variant for the rare Intel user to pick.
    return { os: 'darwin', arch: 'arm64' };
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
 *
 * @param {Platform} plat
 * @returns {string | null}
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
 *
 * @param {Platform} plat
 * @param {string} [repo]
 * @returns {string | null}
 */
export function helperDownloadURL(plat, repo = 'stolucc/flowtex') {
  const asset = helperAssetName(plat);
  if (!asset) return null;
  return `https://github.com/${repo}/releases/latest/download/${asset}`;
}

/**
 * URL to the latest macOS .dmg installer. The .dmg wraps the same Mach-O
 * the raw download offers, plus an Info.plist that turns it into a
 * menu-bar app — the recommended path for non-CLI users.
 *
 * @param {Platform} plat
 * @param {string} [repo]
 * @returns {string | null}
 */
export function helperDmgURL(plat, repo = 'stolucc/flowtex') {
  if (plat.os !== 'darwin') return null;
  const arch = plat.arch || 'arm64';
  return `https://github.com/${repo}/releases/latest/download/FlowTex-Helper-${arch}.dmg`;
}

/**
 * Repo URL — used for "all releases" fallback links.
 *
 * @param {string} [repo]
 * @returns {string}
 */
export function helperReleasesURL(repo = 'stolucc/flowtex') {
  return `https://github.com/${repo}/releases`;
}
