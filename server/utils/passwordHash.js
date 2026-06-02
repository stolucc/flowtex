// Unified password-hash interface. New hashes use Argon2id (ASVS v4.0.3
// §2.4.1 — preferred algorithm at L2/L3); existing bcrypt hashes are
// still verified transparently so users authenticate normally and get
// migrated to Argon2id on their next password set/reset.
//
// Parameters (m=64MiB, t=3, p=1) are the conservative side of the OWASP
// 2024 recommendation. ~250 ms per hash on a typical VPS — high enough
// to push GPU-cracking cost into the right zone for our threat model
// (DB-dump leak), low enough that a single login isn't perceptibly
// slow. Tunable via env if a stronger setting is needed later.

import argon2 from 'argon2';
import bcrypt from 'bcryptjs';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,  // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

/**
 * Hash a plaintext password for storage. Always emits Argon2id.
 * @param {string} plaintext
 * @returns {Promise<string>} Self-describing hash string (encoding
 *   includes algorithm + params, so verifyPassword can read it back).
 */
export async function hashPassword(plaintext) {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored hash. Dispatches by hash
 * prefix so legacy bcrypt rows continue to authenticate during the
 * lazy-migration period.
 *
 * Argon2id hashes start with `$argon2id$`; bcrypt with `$2a$` / `$2b$`
 * / `$2y$`. Anything else returns false (defensive — would otherwise
 * throw out of the verify library).
 *
 * @param {string} plaintext
 * @param {string} storedHash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plaintext, storedHash) {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
  try {
    if (storedHash.startsWith('$argon2')) {
      return await argon2.verify(storedHash, plaintext);
    }
    if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
      return await bcrypt.compare(plaintext, storedHash);
    }
    return false;
  } catch {
    // Library threw on malformed hash — treat as wrong password.
    return false;
  }
}

/**
 * Is the stored hash already in our preferred format (Argon2id)?
 * Used by login/change-password call sites that want to opportunistically
 * re-hash legacy bcrypt rows after successful verify.
 */
export function needsRehash(storedHash) {
  if (typeof storedHash !== 'string') return true;
  return !storedHash.startsWith('$argon2');
}
