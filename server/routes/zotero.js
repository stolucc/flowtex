import { Router } from 'express';
import db from '../db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import logger from '../logger.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();
const ZOTERO_API = 'https://api.zotero.org';

// ── Connection management ────────────────────────────────────────────

/** GET /api/zotero/status -- Check if the user has a connected Zotero account. */
router.get('/status', async (req, res) => {
  const row = await db.get('SELECT zotero_user_id, display_name, updated_at FROM zotero_tokens WHERE user_id = $1', [
    req.session.userId,
  ]);
  res.json({ connected: !!row, zoteroUserId: row?.zotero_user_id, displayName: row?.display_name });
});

/** POST /api/zotero/connect -- Connect a Zotero account by verifying and storing an API key. */
router.post('/connect', async (req, res) => {
  const { apiKey } = req.body;
  // Zotero API keys are alphanumeric. Reject anything else outright so the
  // key can't inject path segments into the verification URL below.
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10 || !/^[A-Za-z0-9]+$/.test(apiKey)) {
    return res.status(400).json({ error: 'Invalid API key' });
  }

  try {
    // Verify the key by fetching user info from Zotero
    const resp = await fetch(`${ZOTERO_API}/keys/${apiKey}`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      return res.status(400).json({ error: 'Invalid Zotero API key. Check it at zotero.org/settings/keys' });
    }
    const keyInfo = await resp.json();
    const zoteroUserId = String(keyInfo.userID);
    logger.debug({ zoteroUserId }, 'Zotero account connected');
    const displayName = keyInfo.displayName || keyInfo.username || 'Zotero User';

    const encryptedKey = encrypt(apiKey);
    await db.run(
      `INSERT INTO zotero_tokens (user_id, api_key, zotero_user_id, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET api_key = $2, zotero_user_id = $3, display_name = $4, updated_at = NOW()`,
      [req.session.userId, encryptedKey, zoteroUserId, displayName],
    );

    res.json({ ok: true, zoteroUserId, displayName });
  } catch (err) {
    sendError(res, err);
  }
});

/** DELETE /api/zotero/disconnect -- Disconnect and remove the user's Zotero API key. */
router.delete('/disconnect', async (req, res) => {
  await db.run('DELETE FROM zotero_tokens WHERE user_id = $1', [req.session.userId]);
  res.json({ ok: true });
});

// ── Helper to get decrypted key ──────────────────────────────────────

/** Retrieve and decrypt the Zotero API key and user ID for a given user. */
async function getZoteroAuth(userId) {
  const row = await db.get('SELECT api_key, zotero_user_id FROM zotero_tokens WHERE user_id = $1', [userId]);
  if (!row) return null;
  return { apiKey: decrypt(row.api_key), zoteroUserId: row.zotero_user_id };
}

/** Make an authenticated request to the Zotero API and return the parsed response with total count. */
async function zoteroFetch(path, apiKey, query = {}) {
  const url = new URL(path, ZOTERO_API);
  // SSRF guard: if `path` is ever passed as an absolute URL (now or in
  // a future refactor), `new URL(path, base)` lets it override the
  // base entirely. Pin the origin to the Zotero API so a caller that
  // accidentally accepts user input here can't redirect us at an
  // internal service or attacker host.
  if (url.origin !== new URL(ZOTERO_API).origin) {
    throw new Error(`zoteroFetch: refusing to fetch non-Zotero origin: ${url.origin}`);
  }
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), {
    headers: { 'Zotero-API-Key': apiKey, 'Zotero-API-Version': '3' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Zotero API error: ${resp.status}`);
  const totalResults = resp.headers.get('Total-Results');
  const data = await resp.json();
  return { data, totalResults: totalResults ? parseInt(totalResults) : null };
}

// ── Library browsing ────────────────────────────────────────────────

/** GET /api/zotero/collections -- List the user's Zotero library collections. */
router.get('/collections', async (req, res) => {
  const auth = await getZoteroAuth(req.session.userId);
  if (!auth) return res.status(401).json({ error: 'Zotero not connected' });

  try {
    const { data } = await zoteroFetch(`/users/${auth.zoteroUserId}/collections`, auth.apiKey, {
      limit: 100,
      sort: 'title',
    });
    const collections = data.map((c) => ({
      key: c.key,
      name: c.data.name,
      parentKey: c.data.parentCollection || null,
      numItems: c.meta?.numItems || 0,
    }));
    res.json(collections);
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /api/zotero/items -- List items from the user's Zotero library or a specific collection. */
router.get('/items', async (req, res) => {
  const auth = await getZoteroAuth(req.session.userId);
  if (!auth) return res.status(401).json({ error: 'Zotero not connected' });

  const { collection, q, start, limit } = req.query;
  const params = {
    limit: Math.min(parseInt(limit) || 50, 100),
    start: parseInt(start) || 0,
    sort: 'dateModified',
    direction: 'desc',
    itemType: '-attachment || note',
  };
  if (q) params.q = q;

  // Validate collection key format to prevent path traversal
  if (collection && !/^[A-Za-z0-9]+$/.test(collection)) {
    return res.status(400).json({ error: 'Invalid collection key' });
  }

  try {
    const path = collection
      ? `/users/${auth.zoteroUserId}/collections/${collection}/items/top`
      : `/users/${auth.zoteroUserId}/items/top`;

    const { data, totalResults } = await zoteroFetch(path, auth.apiKey, params);

    const items = data.map((item) => ({
      key: item.key,
      type: item.data.itemType,
      title: item.data.title || '(untitled)',
      creators: (item.data.creators || []).map((c) => c.name || [c.lastName, c.firstName].filter(Boolean).join(', ')),
      date: item.data.date || '',
      year: item.meta?.parsedDate?.split('-')[0] || '',
      publicationTitle: item.data.publicationTitle || item.data.bookTitle || '',
      DOI: item.data.DOI || '',
      tags: (item.data.tags || []).map((t) => t.tag),
    }));

    res.json({ items, total: totalResults, start: params.start, limit: params.limit });
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /api/zotero/export -- Export selected Zotero items as BibTeX. */
router.get('/export', async (req, res) => {
  const auth = await getZoteroAuth(req.session.userId);
  if (!auth) return res.status(401).json({ error: 'Zotero not connected' });

  const { keys } = req.query; // comma-separated item keys
  if (!keys) return res.status(400).json({ error: 'No item keys specified' });

  const keyList = keys.split(',').slice(0, 100); // max 100 at once

  try {
    const url = new URL(`/users/${auth.zoteroUserId}/items`, ZOTERO_API);
    url.searchParams.set('itemKey', keyList.join(','));
    url.searchParams.set('format', 'bibtex');
    url.searchParams.set('limit', String(keyList.length));

    const resp = await fetch(url.toString(), {
      headers: { 'Zotero-API-Key': auth.apiKey, 'Zotero-API-Version': '3' },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) throw new Error(`Zotero API error: ${resp.status}`);
    const bibtex = await resp.text();
    res.json({ bibtex });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
