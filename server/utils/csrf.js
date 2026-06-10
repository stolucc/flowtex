// @ts-check
import crypto from 'crypto';

/** Constant-time CSRF token comparison.
 *
 *  JavaScript's `!==` on strings short-circuits on the first differing
 *  byte; over many requests that's a per-byte timing leak. Practically
 *  very hard to exploit (attacker needs a valid session and network
 *  jitter dominates the ns-scale difference) but matching the Go
 *  helper's `subtle.ConstantTimeCompare` posture is cheap and aligns
 *  with OWASP ASVS V3.4.2 guidance.
 *
 *  Returns false (rejects) when either side is empty, non-string, or
 *  a different length -- crypto.timingSafeEqual throws on different-
 *  length inputs, so the length check is a precondition.
 */
/**
 * @param {unknown} provided
 * @param {string | null | undefined} expected
 * @returns {boolean}
 */
export function csrfTokensMatch(provided, expected) {
  if (!expected || typeof provided !== 'string' || provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}
