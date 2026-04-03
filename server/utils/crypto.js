import crypto from 'crypto';
import db from '../db.js';

const ALGORITHM = 'aes-256-gcm';

const DEV_FALLBACK_KEY = '0'.repeat(64); // insecure — dev only

let _salt = null;

/**
 * Must be called once at startup (after initSchema).
 * Loads the per-installation salt from the settings table,
 * generating one on first run.
 */
export async function initCrypto() {
  const row = await db.get('SELECT value FROM settings WHERE key = $1', ['encryption_salt']);
  if (row) {
    _salt = row.value;
  } else {
    _salt = crypto.randomBytes(32).toString('hex');
    await db.run(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      ['encryption_salt', _salt],
    );
    // Re-read in case of race condition (another process inserted first)
    const check = await db.get('SELECT value FROM settings WHERE key = $1', ['encryption_salt']);
    if (check) _salt = check.value;
  }
  // Invalidate cached key so it's re-derived with the loaded salt
  _key = null;
}

function getSalt() {
  if (!_salt) {
    throw new Error('initCrypto() must be called before using encrypt/decrypt');
  }
  return _salt;
}

function deriveKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        "ENCRYPTION_KEY must be set in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    // Dev fallback — tokens encrypted with this are NOT secure
    console.warn('[SECURITY] ENCRYPTION_KEY not set — using insecure dev fallback. Do NOT use in production.');
    return crypto.scryptSync(DEV_FALLBACK_KEY, getSalt(), 32);
  }
  return crypto.scryptSync(envKey, getSalt(), 32);
}

let _key = null;
function key() {
  if (!_key) _key = deriveKey();
  return _key;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

/** @internal — test use only */
export function _setSaltForTesting(salt) {
  _salt = salt;
  _key = null;
}

export function decrypt(data) {
  if (typeof data !== 'string') throw new Error('Invalid encrypted data');
  const parts = data.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted data');
  const [ivHex, tagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
