// @ts-check
// Google sign-in (OpenID Connect, authorization-code flow + PKCE).
//
// Two halves:
//   1. The OIDC exchange (buildAuthRequest / exchangeCallback) -- thin
//      wrapper over openid-client, which validates the ID token's
//      signature (Google JWKS), iss, aud, exp, nonce, and the PKCE
//      verifier. We additionally require email_verified === true.
//   2. Account resolution (resolveGoogleLogin / linkGoogleToUser /
//      unlinkGoogle) -- decides which FlowTex user a verified Google
//      identity maps to. Pure DB logic; covered by integration tests.
//
// Design decisions (agreed 2026-10-24):
//   - Existing password account with the same email: link only after
//     the user re-enters that account's FlowTex password (+ TOTP when
//     enabled). Never auto-link on email alone.
//   - FlowTex TOTP still applies after Google sign-in.
//   - Password and Google both stay valid after linking. Unlink is
//     allowed only when a password exists, so nobody is locked out.
//   - An UNVERIFIED password account with the same email is a squat
//     (nobody proved they own the mailbox; it can't sign in). Google
//     proves ownership, so the Google user claims it: password wiped,
//     email marked verified, google_sub set.

import * as oidc from 'openid-client';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { verifyPassword } from '../utils/passwordHash.js';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');
const SCOPE = 'openid email profile';

/** True when the operator has configured a Google OAuth client. */
export function isGoogleAuthEnabled() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** @type {Promise<oidc.Configuration> | null} */
let configPromise = null;

/** Discover Google's OIDC metadata once per process (JWKS is fetched
 *  and cached by openid-client). A failed discovery is not cached, so a
 *  transient outage at boot doesn't disable Google sign-in until
 *  restart. */
function getConfig() {
  if (!configPromise) {
    configPromise = oidc
      .discovery(
        GOOGLE_ISSUER,
        /** @type {string} */ (process.env.GOOGLE_CLIENT_ID),
        /** @type {string} */ (process.env.GOOGLE_CLIENT_SECRET),
      )
      .catch((err) => {
        configPromise = null;
        throw err;
      });
  }
  return configPromise;
}

/**
 * Build the Google authorization URL plus the per-request secrets the
 * callback must check. Caller stores the secrets server-side (session).
 * @param {string} redirectUri
 */
export async function buildAuthRequest(redirectUri) {
  const config = await getConfig();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    // Always show the account chooser: a user with several Google
    // accounts must be able to pick, and a shared computer must not
    // silently sign in as whoever used Google last.
    prompt: 'select_account',
  });
  return { url: url.href, state, nonce, codeVerifier };
}

/**
 * @typedef {{ sub: string, email: string, name: string }} GoogleIdentity
 */

/**
 * Exchange the callback's authorization code and return the verified
 * identity. Throws (status 400) on any validation failure.
 * @param {URL} callbackUrl  full callback URL incl. code + state query
 * @param {{ state: string, nonce: string, codeVerifier: string }} expected
 * @returns {Promise<GoogleIdentity>}
 */
export async function exchangeCallback(callbackUrl, expected) {
  const config = await getConfig();
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: expected.codeVerifier,
    expectedState: expected.state,
    expectedNonce: expected.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  return identityFromClaims(claims);
}

/**
 * Validate the claims we rely on beyond what openid-client checks.
 * @param {Record<string, unknown> | undefined} claims
 * @returns {GoogleIdentity}
 */
export function identityFromClaims(claims) {
  const bad = (/** @type {string} */ msg) => Object.assign(new Error(msg), { status: 400 });
  if (!claims) throw bad('Google did not return an ID token');
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255) throw bad('Invalid Google subject');
  // Google sends a real boolean; anything else (missing, "true") is
  // treated as unverified.
  if (claims.email_verified !== true) throw bad('Google account email is not verified');
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase().trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw bad('Google account has no usable email');
  }
  // Strip CR/LF (the name is reused in email subjects) and cap length
  // to the same 200 chars the register route enforces.
  const rawName = typeof claims.name === 'string' ? claims.name : '';
  const name = rawName.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || email;
  return { sub, email, name };
}

/**
 * @typedef {{ id: string, email: string, name: string, totp_enabled: boolean, totp_secret: string | null, is_admin: boolean }} ResolvedUser
 * @typedef {(
 *   | { kind: 'login', user: ResolvedUser, isNew: boolean, claimed: boolean }
 *   | { kind: 'needs_link', userId: string, email: string, existingName: string }
 *   | { kind: 'refused', reason: 'deleted' | 'sso_required' | 'other_google_linked' }
 * )} GoogleLoginResult
 */

const USER_COLS = 'id, email, name, totp_enabled, totp_secret, is_admin, auth_method, deleted_at, email_verified, google_sub';

/**
 * Map a verified Google identity to a FlowTex account.
 *
 *   1. google_sub match            -> login (unless deleted / SAML)
 *   2. email match, verified,
 *      password-mode, no sub       -> needs_link (password re-entry)
 *   3. email match, UNverified     -> claim the squat, login
 *   4. no match                    -> create, login
 *   anything else                  -> refused
 *
 * @param {GoogleIdentity} identity
 * @returns {Promise<GoogleLoginResult>}
 */
export async function resolveGoogleLogin({ sub, email, name }) {
  return db.transaction(async (tx) => {
    // Serialise concurrent callbacks for the same identity and the same
    // mailbox (double-clicked consent, two tabs).
    await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`google-sub:${sub}`]);
    await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`google-email:${email}`]);

    const bySub = await tx.get(`SELECT ${USER_COLS} FROM users WHERE google_sub = $1`, [sub]);
    if (bySub) {
      if (bySub.deleted_at) return { kind: 'refused', reason: 'deleted' };
      if (bySub.auth_method === 'saml') return { kind: 'refused', reason: 'sso_required' };
      return { kind: 'login', user: bySub, isNew: false, claimed: false };
    }

    const byEmail = await tx.get(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [email]);
    if (byEmail) {
      if (byEmail.deleted_at) return { kind: 'refused', reason: 'deleted' };
      if (byEmail.auth_method === 'saml') return { kind: 'refused', reason: 'sso_required' };
      if (byEmail.google_sub) return { kind: 'refused', reason: 'other_google_linked' };
      if (!byEmail.email_verified) {
        // Squat claim. The squatter never proved mailbox ownership and
        // could never sign in, so there is no session or data of theirs
        // to protect. Wipe the password they chose and any outstanding
        // verification tokens so neither can be used later.
        await tx.run(
          `UPDATE users SET google_sub = $1, email_verified = TRUE, password_hash = NULL,
                            name = $2, totp_enabled = FALSE, totp_secret = NULL
            WHERE id = $3`,
          [sub, name, byEmail.id],
        );
        await tx.run('UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1', [byEmail.id]);
        await tx.run('DELETE FROM password_reset_tokens WHERE user_id = $1', [byEmail.id]);
        const claimed = await tx.get(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [byEmail.id]);
        return { kind: 'login', user: claimed, isNew: false, claimed: true };
      }
      return { kind: 'needs_link', userId: byEmail.id, email, existingName: byEmail.name };
    }

    const id = uuid();
    await tx.run(
      `INSERT INTO users (id, email, name, password_hash, email_verified, google_sub)
       VALUES ($1, $2, $3, NULL, TRUE, $4)`,
      [id, email, name, sub],
    );
    const created = await tx.get(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
    return { kind: 'login', user: created, isNew: true, claimed: false };
  });
}

/**
 * Attach a Google identity to an existing account. Used both after the
 * password-confirm interstitial and from Settings. Caller must already
 * have authenticated the user (password, + TOTP where required).
 * @param {string} userId
 * @param {string} sub
 */
export async function linkGoogleToUser(userId, sub) {
  return db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`google-sub:${sub}`]);
    const user = await tx.get(`SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const conflict = (/** @type {string} */ msg) => Object.assign(new Error(msg), { status: 409 });
    if (!user || user.deleted_at) throw Object.assign(new Error('Account not found'), { status: 404 });
    if (user.auth_method === 'saml') throw conflict('This account signs in through your organisation and cannot use Google sign-in.');
    if (user.google_sub === sub) return user; // idempotent re-link
    if (user.google_sub) throw conflict('A different Google account is already linked. Unlink it first.');
    const taken = await tx.get('SELECT id FROM users WHERE google_sub = $1', [sub]);
    if (taken) throw conflict('That Google account is already linked to another FlowTex account.');
    await tx.run('UPDATE users SET google_sub = $1 WHERE id = $2', [sub, userId]);
    return tx.get(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId]);
  });
}

/**
 * Remove the Google link. Requires the account password -- both to
 * prove the caller is the owner and because without a password the
 * account would have no way to sign in.
 * @param {string} userId
 * @param {string} password
 */
export async function unlinkGoogle(userId, password) {
  const user = await db.get('SELECT id, password_hash, google_sub FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!user) throw Object.assign(new Error('Account not found'), { status: 404 });
  if (!user.google_sub) throw Object.assign(new Error('No Google account is linked.'), { status: 400 });
  if (!user.password_hash) {
    throw Object.assign(
      new Error('Set a password first (use "Forgot password" on the sign-in page), then unlink Google.'),
      { status: 400 },
    );
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    throw Object.assign(new Error('Incorrect password'), { status: 401 });
  }
  await db.run('UPDATE users SET google_sub = NULL WHERE id = $1', [userId]);
}

// Test-only hooks.
export const _testing = {
  resetConfig: () => { configPromise = null; },
};
