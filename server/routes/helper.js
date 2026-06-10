// Routes for the FlowTex helper integration.
//
// /api/helper/latest-version
//   Returns the latest published helper version tag from GitHub
//   Releases. Cached in-process for 15 minutes so a stampede of
//   concurrent loads doesn't burn through the GitHub API's
//   unauthenticated 60-req/hour limit. Falls back to a sticky
//   "last known good" value on GitHub failure so the toolbar
//   indicator degrades gracefully (no error, no update prompt).

import { Router } from 'express';
import logger from '../logger.js';
import { isLocalCompileEnabled } from '../utils/featureFlags.js';

const router = Router();

const RELEASES_URL = 'https://api.github.com/repos/stolucc/flowtex/releases/latest';
// Cache TTL: 15 minutes. Helper releases drop on the order of weeks;
// this just bounds the operator burden of hitting GitHub's unauthenticated
// rate limit during a click-storm.
const CACHE_TTL_MS = 15 * 60 * 1000;
// On GitHub failure we hold the last good value forever (sticky cache).
// Cold start with no good value: we don't synthesise -- just return null
// so the client treats it as "no info" rather than showing a wrong update
// prompt.
let cache = { fetchedAt: 0, payload: null };

async function fetchLatestVersion() {
  // node's global fetch is available since Node 22 (FlowTex's runtime).
  const res = await fetch(RELEASES_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'flowtex-helper-version-probe',
    },
    // Snappy timeout: the toolbar indicator is best-effort UI. Don't
    // make the operator wait 30s for a GitHub stall.
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub release fetch failed: ${res.status}`);
  const data = await res.json();
  // The release tag is what we display ("helper-v0.3.0"). The HTML URL
  // is what the client links to for the "what's new" button.
  // Filter to helper-v* tags specifically; the repo also tags
  // non-helper releases (server / etc.) that the latest-release
  // endpoint sometimes surfaces depending on workflow ordering.
  if (typeof data.tag_name !== 'string' || !data.tag_name.startsWith('helper-v')) {
    // Walk recent releases until we find one tagged helper-v*.
    const listRes = await fetch(
      'https://api.github.com/repos/stolucc/flowtex/releases?per_page=20',
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'flowtex-helper-version-probe' },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!listRes.ok) throw new Error(`GitHub release list fetch failed: ${listRes.status}`);
    const list = await listRes.json();
    const hit = Array.isArray(list)
      ? list.find((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('helper-v') && !r.draft && !r.prerelease)
      : null;
    if (!hit) throw new Error('No helper-v* release found in the most recent 20 releases');
    return {
      tag: hit.tag_name,
      version: hit.tag_name.replace(/^helper-v/, ''),
      releaseUrl: hit.html_url,
      publishedAt: hit.published_at,
    };
  }
  return {
    tag: data.tag_name,
    version: data.tag_name.replace(/^helper-v/, ''),
    releaseUrl: data.html_url,
    publishedAt: data.published_at,
  };
}

router.get('/latest-version', async (req, res) => {
  // Only meaningful when the feature is on. Keeps the toolbar quiet
  // for non-local-compile deploys.
  if (!isLocalCompileEnabled()) {
    return res.status(404).json({ error: 'Local compile not enabled.' });
  }
  const now = Date.now();
  if (cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
    return res.json(cache.payload);
  }
  try {
    const payload = await fetchLatestVersion();
    cache = { fetchedAt: now, payload };
    res.json(payload);
  } catch (err) {
    logger.warn({ err }, 'helper/latest-version: GitHub fetch failed');
    // Sticky fallback: serve the last known good value (probably
    // populated by a successful earlier hit). If we have none, return
    // null so the client renders no update prompt.
    if (cache.payload) {
      res.json(cache.payload);
    } else {
      res.json({ tag: null, version: null, releaseUrl: null, publishedAt: null });
    }
  }
});

export default router;
