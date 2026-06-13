// @ts-check
//
// Resolve `\command` -> `package` for arbitrary LaTeX commands, NOT
// just the curated COMMAND_PACKAGES list in latexErrorHelp.js.
//
// Lookup order is
//   1. Static JSON map: see latexErrorHelp.js. The React hook checks
//      this first and only falls through to this file when the JSON
//      doesn't have an entry.
//   2. localStorage cache: persists previously-resolved answers.
//   3. Helper LLM fallback: if the helper is paired and an LLM is
//      configured, ask the LLM "Which CTAN package provides \X?".
//      Cached as low-confidence so the UI can surface a "may be wrong"
//      hint later.
//
// The previous architecture also had a server-side TeX-Live index
// (.sty file grep). It was removed in favor of the static JSON +
// LLM fallback. See [[project-flowtex-latex-errors]] notes.
//
// Storage shape (localStorage key `flowtex-cmdpkg`):
//   { [cmd]: { package: string | null, source: string, ts: number } }
// The whole thing is a single key (one JSON object) so we don't have
// to enumerate localStorage to know what's cached. Sized to a couple
// thousand commands max -- a TL install has ~10k commands; the
// localStorage limit is 5 MB, well above our worst case.

import { streamLlmComplete, fetchLlmStatus } from './helperBridge.js';

/**
 * @typedef {{ package: string | null, source: 'static' | 'localStorage' | 'llm' | 'unknown', confidence?: 'high' | 'low' }} LookupResult
 */

const STORAGE_KEY = 'flowtex-cmdpkg';
const STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory mirror of the localStorage cache. Refreshed on import +
// after each writeback so reads don't have to JSON.parse on every
// lookup. Also serves as the cache when localStorage is unavailable
// (private-browsing / quota exceeded).
/** @type {Map<string, { package: string | null, source: string, ts: number }>} */
const memCache = new Map();

let loaded = false;

/**
 * Lazily load the localStorage cache into memory. Idempotent.
 */
function loadCache() {
  if (loaded) return;
  loaded = true;
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const now = Date.now();
    for (const [cmd, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = /** @type {any} */ (entry);
      if (typeof e.ts !== 'number' || now - e.ts > STORAGE_TTL_MS) continue;
      memCache.set(cmd, { package: e.package ?? null, source: e.source ?? 'unknown', ts: e.ts });
    }
  } catch {
    // Corrupt cache or quota error -- start fresh.
  }
}

let writebackTimer = /** @type {any} */ (null);

/**
 * Schedule a debounced writeback to localStorage. Several rapid
 * lookups in the same tick should produce one write.
 */
function scheduleWriteback() {
  if (typeof localStorage === 'undefined') return;
  if (writebackTimer) return;
  writebackTimer = setTimeout(() => {
    writebackTimer = null;
    try {
      /** @type {Record<string, { package: string | null, source: string, ts: number }>} */
      const out = {};
      for (const [cmd, e] of memCache.entries()) out[cmd] = e;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      // Quota or serialization error; skip silently.
    }
  }, 250);
}

/**
 * Write a lookup result into the cache (memory + scheduled localStorage).
 * Cached null answers are kept so the orchestrator doesn't keep retrying
 * the same unknown command.
 *
 * @param {string} cmd
 * @param {LookupResult} result
 */
export function cacheLookup(cmd, result) {
  memCache.set(cmd, {
    package: result.package,
    source: result.source,
    ts: Date.now(),
  });
  scheduleWriteback();
}

/**
 * Read a cached result without firing any network request.
 *
 * @param {string} cmd
 * @returns {LookupResult | null}
 */
export function readCache(cmd) {
  loadCache();
  const entry = memCache.get(cmd);
  if (!entry) return null;
  const src = /** @type {LookupResult['source']} */ (entry.source);
  return {
    package: entry.package,
    source: src,
    confidence: src === 'llm' ? 'low' : 'high',
  };
}

// queryServerIndex was removed when the TL .sty-grep server endpoint
// was deleted -- the index produced too many false positives. The
// orchestrator now falls straight from cache to LLM.

/**
 * Parse the helper LLM's freeform answer into a single package name.
 * The prompt asks the model to answer with just the package name (or
 * 'unknown'); we still defend against extra text -- trim to the first
 * token, strip backslashes, drop "unknown" / "none" / "n/a".
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function parseLlmAnswer(raw) {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .replace(/^[`*\\]+|[`*\\]+$/g, '')
    .split(/[\s,.;\n]+/)[0]
    .toLowerCase();
  if (!trimmed) return null;
  if (['unknown', 'none', 'n/a', 'na', 'null', 'no', 'undefined', '(none)'].includes(trimmed)) return null;
  // Package names: must start with an ASCII letter; rest is letters,
  // digits, hyphen. Real CTAN names start with a letter -- excluding
  // leading digits filters out junk LLM output like "0" / "42" without
  // losing any legitimate package.
  if (!/^[a-z][a-z0-9-]*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Ask the helper LLM which package provides a command. Returns null
 * if no helper, no LLM, or the LLM's answer doesn't parse.
 *
 * @param {string} cmd
 * @returns {Promise<string | null>}
 */
export async function queryHelperLlm(cmd) {
  try {
    const probe = await fetchLlmStatus();
    if (!probe?.ok || !probe.status?.available) return null;
    const model = probe.status.defaultModel || (probe.status.models && probe.status.models[0]);
    if (!model) return null;

    const instruction = [
      'You are a CTAN expert. Answer with EXACTLY one CTAN package name (lowercase, ASCII).',
      'No prose, no markdown, no quotes.',
      'If the command is not provided by any CTAN package, answer with the literal word: unknown',
      'If the command is built into the LaTeX kernel (no package needed), also answer: unknown',
    ].join('\n');
    const input = `Which CTAN package provides the LaTeX command \\${cmd}?`;

    let acc = '';
    const result = await streamLlmComplete(
      { task: 'custom', input, model, instruction },
      (delta) => {
        acc += delta;
      },
    );
    if (!result.ok) return null;
    return parseLlmAnswer(acc);
  } catch {
    return null;
  }
}

/**
 * Top-level resolver: returns the package for a command using cache
 * -> server -> LLM, in that order. Caches every hit (including nulls).
 *
 * @param {string} cmd
 * @param {{ allowLlm?: boolean }} [opts]
 * @returns {Promise<LookupResult>}
 */
export async function lookupCommandPackage(cmd, opts = {}) {
  const allowLlm = opts.allowLlm !== false;

  // 1. Cache.
  const cached = readCache(cmd);
  if (cached) return cached;

  // 2. Helper LLM. (The server-side TL index step was removed.)
  if (allowLlm) {
    const fromLlm = await queryHelperLlm(cmd);
    if (fromLlm) {
      const r = /** @type {LookupResult} */ ({ package: fromLlm, source: 'llm', confidence: 'low' });
      cacheLookup(cmd, r);
      return r;
    }
  }

  // 4. Nothing worked -- cache the miss so we don't ask again every
  // time the user re-opens the panel.
  const miss = /** @type {LookupResult} */ ({ package: null, source: 'unknown' });
  cacheLookup(cmd, miss);
  return miss;
}

/**
 * Reset everything. Useful for tests; the route's reindex flow does
 * NOT reach here -- the client's cache is on a separate TTL.
 */
export function _resetForTesting() {
  memCache.clear();
  loaded = false;
  if (writebackTimer) {
    clearTimeout(writebackTimer);
    writebackTimer = null;
  }
}
