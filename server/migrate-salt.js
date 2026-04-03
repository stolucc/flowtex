/**
 * One-time migration: re-encrypt all tokens from old hardcoded salt to new per-installation salt.
 * Run with: node --env-file=.env server/migrate-salt.js
 *
 * This script:
 * 1. Reads the per-installation salt from the settings table (must exist — start the server once first)
 * 2. Decrypts all github_tokens and zotero_keys using the OLD hardcoded salt
 * 3. Re-encrypts them using the NEW per-installation salt
 * 4. Updates the rows in-place
 *
 * Safe to run multiple times — already-migrated tokens will fail old-decrypt and be skipped.
 */

import crypto from 'crypto';
import pg from 'pg';

const ALGORITHM = 'aes-256-gcm';
const OLD_HARDCODED_SALT = 'flowtex-salt';
const DEV_FALLBACK_KEY = '0'.repeat(64);

function deriveKeyWith(salt) {
  const keyMaterial = process.env.ENCRYPTION_KEY || DEV_FALLBACK_KEY;
  return crypto.scryptSync(keyMaterial, salt, 32);
}

function decryptWith(key, data) {
  if (typeof data !== 'string') throw new Error('Invalid');
  const parts = data.split(':');
  if (parts.length !== 3) throw new Error('Malformed');
  const [ivHex, tagHex, encrypted] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function encryptWith(key, text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

async function migrate() {
  const pool = new pg.Pool({ database: process.env.PGDATABASE || 'flowtex' });

  // Load the per-installation salt
  const saltRow = await pool.query("SELECT value FROM settings WHERE key = 'encryption_salt'");
  if (!saltRow.rows[0]) {
    console.error('No encryption_salt found in settings table. Start the server once first to generate it.');
    process.exit(1);
  }
  const newSalt = saltRow.rows[0].value;

  const oldKey = deriveKeyWith(OLD_HARDCODED_SALT);
  const newKey = deriveKeyWith(newSalt);

  // Migrate github_tokens
  const ghRows = await pool.query('SELECT user_id, token FROM github_tokens');
  let ghMigrated = 0;
  let ghSkipped = 0;
  for (const row of ghRows.rows) {
    try {
      const plaintext = decryptWith(oldKey, row.token);
      const reEncrypted = encryptWith(newKey, plaintext);
      await pool.query('UPDATE github_tokens SET token = $1 WHERE user_id = $2', [reEncrypted, row.user_id]);
      ghMigrated++;
    } catch {
      // Already migrated or unencrypted — skip
      ghSkipped++;
    }
  }
  console.log(`github_tokens: ${ghMigrated} migrated, ${ghSkipped} skipped`);

  // Migrate zotero_tokens
  const zotRows = await pool.query('SELECT user_id, api_key FROM zotero_tokens').catch(() => ({ rows: [] }));
  let zotMigrated = 0;
  let zotSkipped = 0;
  for (const row of zotRows.rows) {
    try {
      const plaintext = decryptWith(oldKey, row.api_key);
      const reEncrypted = encryptWith(newKey, plaintext);
      await pool.query('UPDATE zotero_tokens SET api_key = $1 WHERE user_id = $2', [reEncrypted, row.user_id]);
      zotMigrated++;
    } catch {
      zotSkipped++;
    }
  }
  console.log(`zotero_tokens: ${zotMigrated} migrated, ${zotSkipped} skipped`);

  await pool.end();
  console.log('Done. All tokens re-encrypted with per-installation salt.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
