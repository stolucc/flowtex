// @ts-check
/**
 * Centralised access to FlowTex's localStorage settings.
 *
 * All FlowTex settings live under the `flowtex-` prefix in localStorage.
 * Use these helpers (with un-prefixed keys) instead of touching
 * `localStorage` directly so the prefix is applied consistently.
 */

const PREFIX = 'flowtex-';

/**
 * Read a string setting.
 * @param {string} key - Un-prefixed setting key (e.g. 'font-size').
 * @returns {string|null} The stored value, or null if missing.
 */
export function getSetting(key) {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

/**
 * Write a string setting. The value is coerced via String().
 * @param {string} key - Un-prefixed setting key.
 * @param {*} value - Value to store; non-strings are coerced.
 */
export function setSetting(key, value) {
  try {
    localStorage.setItem(PREFIX + key, String(value));
  } catch {
    // ignore quota / privacy-mode errors
  }
}

/**
 * Read and JSON-parse a setting. Returns `fallback` on missing key or parse error.
 * @param {string} key - Un-prefixed setting key.
 * @param {*} [fallback] - Value to return if missing or invalid (default: null).
 * @returns {*}
 */
export function getJsonSetting(key, fallback = null) {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * JSON-stringify and write a setting.
 * @param {string} key - Un-prefixed setting key.
 * @param {*} value - Any JSON-serialisable value.
 */
export function setJsonSetting(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
