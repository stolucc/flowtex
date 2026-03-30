/**
 * One-time migration: re-encrypt all tokens from old salt/key to new salt/key.
 * Run with: node --env-file=.env server/migrate-salt.js
 *
 * This script:
 * 1. Decrypts all github_tokens and zotero_keys using the OLD key derivation
 * 2. Re-encrypts them using the NEW key derivation
 * 3. Updates the rows in-place
 *
 * Safe to run multiple times — already-migrated tokens will fail old-decrypt and be skipped.
 */

import crypto from 'crypto';
import pg from 'pg';

const ALGORITHM = 'aes-256-gcm';

function deriveKeyWith(salt, fallbackKey) {
  const keyMaterial = process.env.ENCRYPTION_KEY || fallbackKey;
  return crypto.scryptSync(keyMaterial, salt, 32);
}

const OLD_KEY = deriveKeyWith('underleaf-salt', 'underleaf-dev-encryption-key-change-in-production');
const NEW_KEY = deriveKeyWith('flowtex-salt', 'flowtex-dev-encryption-key-change-in-production');

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

  // Migrate github_tokens
  const ghRows = await pool.query('SELECT user_id, token FROM github_tokens');
  let ghMigrated = 0;
  let ghSkipped = 0;
  for (const row of ghRows.rows) {
    try {
      const plaintext = decryptWith(OLD_KEY, row.token);
      const reEncrypted = encryptWith(NEW_KEY, plaintext);
      await pool.query('UPDATE github_tokens SET token = $1 WHERE user_id = $2', [reEncrypted, row.user_id]);
      ghMigrated++;
    } catch {
      // Already migrated or unencrypted — skip
      ghSkipped++;
    }
  }
  console.log(`github_tokens: ${ghMigrated} migrated, ${ghSkipped} skipped`);

  // Migrate zotero_keys
  const zotRows = await pool.query('SELECT user_id, api_key FROM zotero_keys').catch(() => ({ rows: [] }));
  let zotMigrated = 0;
  let zotSkipped = 0;
  for (const row of zotRows.rows) {
    try {
      const plaintext = decryptWith(OLD_KEY, row.api_key);
      const reEncrypted = encryptWith(NEW_KEY, plaintext);
      await pool.query('UPDATE zotero_keys SET api_key = $1 WHERE user_id = $2', [reEncrypted, row.user_id]);
      zotMigrated++;
    } catch {
      zotSkipped++;
    }
  }
  console.log(`zotero_keys: ${zotMigrated} migrated, ${zotSkipped} skipped`);

  await pool.end();
  console.log('Done. You can now update crypto.js to use the new salt.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
