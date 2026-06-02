import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import db from '../db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { isLocalCompileEnabled } from '../utils/featureFlags.js';
import logger from '../logger.js';

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MINUTES = 15;

// Track used TOTP codes to prevent replay
const usedTotpCodes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of usedTotpCodes) {
    if (now > expiry) usedTotpCodes.delete(key);
  }
  db.run('DELETE FROM used_totp_codes WHERE expires_at < NOW()').catch((e) => console.warn('TOTP cleanup failed:', e.message));
}, 60000).unref();

/** Decrypt an encrypted TOTP secret, falling back to the raw value if decryption fails. */
export function decryptTotpSecret(encrypted) {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return encrypted;
  }
}

/**
 * Validate password strength requirements.
 * @param {string} password
 * @returns {string|null} Error message, or null if valid.
 */
export function validatePassword(password) {
  // ASVS v4.0.3 §2.1.1: minimum 12 characters at L2. Only enforced for
  // NEW passwords (registration, password change, password reset);
  // existing 8-11 char passwords still authenticate via bcrypt.compare
  // and won't be invalidated. Users are pushed to 12 only when they
  // next set a password.
  if (typeof password !== 'string' || password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  return null;
}

/**
 * Check the password against the HIBP "Pwned Passwords" range API using
 * k-anonymity (first 5 hex chars of SHA-1 sent over the wire; the API
 * returns all matching suffixes). Throws a 400 if the password appears in
 * any known breach. Fail-open on network/HTTP errors so a transient API
 * outage doesn't lock users out of password changes; set
 * `DISABLE_HIBP_CHECK=1` to skip entirely (e.g. offline deploys).
 */
export async function checkPasswordNotBreached(password) {
  if (process.env.DISABLE_HIBP_CHECK === '1') return;
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return; // fail-open on non-2xx
    const body = await resp.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, countStr] = line.trim().split(':');
      if (hashSuffix === suffix && parseInt(countStr, 10) > 0) {
        throw Object.assign(
          new Error('This password has appeared in known data breaches. Please choose a different one.'),
          { status: 400 },
        );
      }
    }
  } catch (err) {
    if (err.status === 400) throw err; // re-throw our own breach error
    // Otherwise fail-open: network/timeout/parse issues shouldn't block password changes.
  }
}

/** Check if an account is locked due to too many failed login attempts.
 *
 *  Two locks, both per the LOCKOUT_WINDOW_MINUTES window:
 *
 *   1. Per-(email, IP) at MAX_FAILED_ATTEMPTS — blocks targeted
 *      brute-force from a single source against one account. This
 *      replaces the previous email-only lock, which let any attacker
 *      who knew a victim's email lock the victim out from logging in
 *      anywhere by spamming wrong passwords from one IP. With the
 *      per-(email, IP) variant the legitimate user from a different
 *      network is unaffected.
 *
 *   2. Per-IP at MAX_FAILED_ATTEMPTS * 3 — blocks one IP from
 *      scanning many accounts (credential-stuffing across the user
 *      base).
 *
 *  Requests without an IP (test fixtures, mis-configured proxies)
 *  fall back to the email-only lock so we don't ship an "IP missing →
 *  no lockout" hole.
 */
export async function isAccountLocked(email, ip) {
  if (!ip) {
    const result = await db.get(
      `SELECT COUNT(*) AS cnt FROM login_attempts WHERE email = $1 AND success = FALSE AND created_at > NOW() - make_interval(mins => $2)`,
      [email, LOCKOUT_WINDOW_MINUTES],
    );
    return parseInt(result?.cnt || 0) >= MAX_FAILED_ATTEMPTS;
  }
  const result = await db.get(
    `SELECT COUNT(*) AS cnt FROM login_attempts WHERE email = $1 AND ip = $2 AND success = FALSE AND created_at > NOW() - make_interval(mins => $3)`,
    [email, ip, LOCKOUT_WINDOW_MINUTES],
  );
  if (parseInt(result?.cnt || 0) >= MAX_FAILED_ATTEMPTS) return true;
  const ipResult = await db.get(
    `SELECT COUNT(*) AS cnt FROM login_attempts WHERE ip = $1 AND success = FALSE AND created_at > NOW() - make_interval(mins => $2)`,
    [ip, LOCKOUT_WINDOW_MINUTES],
  );
  if (parseInt(ipResult?.cnt || 0) >= MAX_FAILED_ATTEMPTS * 3) return true;
  return false;
}

/** Record a login attempt; on success, clear previous failures for that email. */
export async function recordLoginAttempt(email, ip, success) {
  await db.run('INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)', [email, ip || null, success]);
  if (success) await db.run('DELETE FROM login_attempts WHERE email = $1 AND success = FALSE', [email]);
}

async function isTotpUsed(userId, code) {
  const key = `${userId}:${code}`;
  if (usedTotpCodes.has(key)) return true;
  const row = await db
    .get('SELECT 1 FROM used_totp_codes WHERE user_id = $1 AND code = $2 AND expires_at > NOW()', [userId, code])
    .catch((e) => { console.warn('TOTP usage check failed:', e.message); return null; });
  return !!row;
}

async function markTotpUsed(userId, code) {
  const key = `${userId}:${code}`;
  usedTotpCodes.set(key, Date.now() + 90000);
  await db
    .run(
      "INSERT INTO used_totp_codes (user_id, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 seconds') ON CONFLICT DO NOTHING",
      [userId, code],
    )
    .catch((e) => console.warn('Failed to persist TOTP usage:', e.message));
}

// --- Core auth operations ---

/**
 * Register a new user account (unverified).
 * @returns {{id, email, name, totpEnabled, isAdmin, emailVerified}} The new user.
 */
export async function registerUser(email, name, password) {
  const pwError = validatePassword(password);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });
  await checkPasswordNotBreached(password);

  const normalizedEmail = email.toLowerCase().trim();
  // A soft-deleted row still occupies the email; treat it the same as an
  // active account for enumeration purposes (return the same "verification
  // sent" shape). The dummy bcrypt below equalises timing.
  const existing = await db.get('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing) {
    // Don't leak whether the email is registered. The route returns the same
    // "verification sent" shape regardless, so an attacker can't distinguish
    // existing accounts via response status. We still do a dummy bcrypt to
    // equalize timing between the create-new and skip paths.
    await bcrypt.hash(password, 12);
    return {
      id: null,
      email: normalizedEmail,
      name: null,
      totpEnabled: false,
      isAdmin: false,
      emailVerified: false,
      alreadyExisted: true,
    };
  }

  const id = uuid();
  const password_hash = await bcrypt.hash(password, 12);
  // Strip CR/LF so the name can't be used to inject email headers when reused in subjects.
  const safeName = name.replace(/[\r\n]+/g, ' ').trim();
  await db.run('INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1, $2, $3, $4, FALSE)', [
    id,
    normalizedEmail,
    safeName,
    password_hash,
  ]);
  return {
    id,
    email: normalizedEmail,
    name: safeName,
    totpEnabled: false,
    isAdmin: false,
    emailVerified: false,
    alreadyExisted: false,
  };
}

/**
 * Create an email verification token (rate-limited to 3/hour).
 * @returns {string|null} The raw token, or null if rate-limited.
 */
export async function createEmailVerificationToken(userId) {
  // Rate limit: max 3 tokens per hour
  const recent = await db.get(
    `SELECT COUNT(*) AS cnt FROM email_verification_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId],
  );
  if (parseInt(recent?.cnt || 0) >= 3) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  // Window is deliberately short — the verifyEmail() endpoint is now
  // idempotent (so an email-scanner GET followed by the human's click
  // both succeed), which made the token reusable within its window.
  // Tightening the window from 24h → 1h limits exposure if the user's
  // inbox is ever compromised, archived, or forwarded — without
  // breaking the scanner-then-human race (which resolves within
  // seconds) or a normal user clicking from a second device. Users
  // who let it lapse hit Resend (rate-limited at 3/hour).
  await db.run(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
    [uuid(), userId, tokenHash],
  );
  return token;
}

/**
 * Verify a user's email address using a verification token.
 *
 * Idempotent on purpose: many corporate/consumer mail providers
 * (Outlook Safe Links, Gmail's malware scanner, Apple Mail preview)
 * GET the URL in a verification email BEFORE the human clicks, to
 * sandbox-check it for malware. A strict single-use endpoint would
 * mark the token used on the scanner's hit and tell the human
 * "already used / expired" 30s later when they actually click. So:
 *
 *   1. Look up the token (regardless of `used` flag) while it's
 *      still inside its 24h expiry window.
 *   2. If the associated user is ALREADY verified, return success —
 *      the work is done, whoever GET'd this URL (scanner or human)
 *      gets a clean "verified" response.
 *   3. If not verified yet, flip email_verified=TRUE, mark this
 *      token AND the user's sibling tokens used in one transaction.
 *
 * Security trade-off: the token remains reusable for up to 24h. The
 * threat would be "attacker with access to the user's mailbox
 * re-verifying" — they'd already be in the inbox, which is a much
 * bigger compromise. And re-verifying an already-verified account
 * is a no-op, so there's no extra power gained.
 *
 * @returns {string} The verified user's ID.
 */
export async function verifyEmail(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await db.get(
    `SELECT t.user_id, u.email_verified, u.deleted_at
     FROM email_verification_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.expires_at > NOW()`,
    [tokenHash],
  );
  if (!row) throw Object.assign(new Error('Invalid or expired verification link'), { status: 400 });
  if (row.deleted_at) {
    // The account is in the recovery bin; clicking a stale verification
    // link must not silently re-activate it.
    throw Object.assign(new Error('This account has been deleted.'), { status: 410 });
  }

  // Idempotent path: already verified (either by a previous click or
  // by an email-scanner prefetch). Nothing to do — return success.
  if (row.email_verified) return row.user_id;

  await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [row.user_id]);
  // Invalidate all tokens for this user (this one + any siblings)
  // so a future re-verify can't run against a stale token after the
  // user changes their email.
  await db.run('UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1', [row.user_id]);
  return row.user_id;
}

/**
 * Authenticate a user by email and password.
 * @returns {{user} | {error, status, unverified?, userId?}} The user or an error descriptor.
 */
// Pre-computed bcrypt hash of a fixed string at the same cost factor as real
// password hashes. Used to equalize timing on the user-not-found path so an
// attacker can't tell registered emails from unregistered ones via response
// timing. The string itself doesn't matter — only the cost factor does.
const DUMMY_BCRYPT_HASH =
  '$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export async function authenticateUser(email, password) {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.get(
    'SELECT id, email, name, password_hash, totp_enabled, totp_secret, is_admin, email_verified, deleted_at FROM users WHERE email = $1',
    [normalizedEmail],
  );
  if (!user) {
    // Dummy bcrypt to make this path take the same time as the real
    // wrong-password path below. Without this, "user not found" returns in
    // ~5ms while "user found, wrong password" takes ~150ms — a clear
    // enumeration oracle.
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    return { error: 'Invalid credentials', status: 401 };
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return { error: 'Invalid credentials', status: 401 };

  // Soft-deleted accounts: present as plain invalid credentials so we
  // don't leak the bin's existence to scanners. The real user can ask an
  // admin to restore (the deletion email tells them how).
  if (user.deleted_at) return { error: 'Invalid credentials', status: 401 };

  if (!user.email_verified) {
    return {
      error: 'Please verify your email address before signing in. Check your inbox for a verification link.',
      status: 403,
      unverified: true,
      userId: user.id,
    };
  }

  return { user };
}

/** Verify a TOTP code, rejecting replays. */
export async function verifyTotp(userId, code, totpSecret) {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(decryptTotpSecret(totpSecret)),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return { error: 'Invalid verification code', status: 401 };
  if (await isTotpUsed(userId, code)) return { error: 'Verification code already used', status: 401 };
  await markTotpUsed(userId, code);
  return { ok: true };
}

// MFA-bypass cookie lifetime. Was 30 days; shortened to 7 because the
// cookie is rotated on every use and stolen-cookie MFA bypass shouldn't
// last a month.
const TRUST_DAYS = 7;
const TRUST_MS = TRUST_DAYS * 24 * 60 * 60 * 1000;

/** Create a trusted-device token for MFA bypass. */
export async function createTrustedDevice(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const deviceName = userAgent?.substring(0, 200) || 'Unknown device';
  await db.run(
    `INSERT INTO trusted_devices (id, user_id, token_hash, device_name, expires_at) VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $5))`,
    [uuid(), userId, tokenHash, deviceName, TRUST_DAYS],
  );
  return { token, maxAge: TRUST_MS };
}

/**
 * Check whether a trusted-device cookie is still valid for this user, and
 * rotate the underlying token on success. Rotation limits the blast radius
 * of cookie theft: an attacker who replays a stolen cookie races the real
 * user, and only one of them keeps the bypass.
 *
 * @returns {null|{token, maxAge}} null if invalid/expired; otherwise the
 *   new cookie value the caller should set in the response.
 */
export async function checkTrustedDevice(userId, trustCookie) {
  if (!trustCookie) return null;
  const oldHash = crypto.createHash('sha256').update(trustCookie).digest('hex');
  const device = await db.get(
    'SELECT id FROM trusted_devices WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()',
    [oldHash, userId],
  );
  if (!device) return null;
  const newToken = crypto.randomBytes(32).toString('hex');
  const newHash = crypto.createHash('sha256').update(newToken).digest('hex');
  await db.run(
    `UPDATE trusted_devices SET token_hash = $1, expires_at = NOW() + make_interval(days => $2) WHERE id = $3`,
    [newHash, TRUST_DAYS, device.id],
  );
  return { token: newToken, maxAge: TRUST_MS };
}

/** Fetch the current user's profile (id, email, name, totpEnabled, isAdmin, compileLocation, serverFeatures). */
export async function getCurrentUser(userId) {
  const user = await db.get(
    'SELECT id, email, name, totp_enabled, is_admin, compile_location FROM users WHERE id = $1',
    [userId],
  );
  if (!user) return null;
  // serverFeatures is the operator-controlled flag surface, returned on
  // /me so the client can decide whether to render flag-gated UI without
  // a separate round-trip. Feature flags are not secret — they describe
  // what the deployment opts into, same shape as GitHubs or Linears
  // /capabilities endpoints.
  const serverFeatures = {
    localCompile: isLocalCompileEnabled(),
  };
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    totpEnabled: !!user.totp_enabled,
    isAdmin: !!user.is_admin,
    // compile_location is always reported. When FEATURE_LOCAL_COMPILE is
    // off the API just refuses to mutate it, so legacy users always see
    // the column default 'server' here. New clients hide the UI when
    // serverFeatures.localCompile is false.
    compileLocation: user.compile_location || 'server',
    serverFeatures,
  };
}

/** Update a user's mutable profile fields (name, optionally compile_location). */
export async function updateProfile(userId, { name, compile_location }) {
  if (name !== undefined) {
    // Strip CR/LF so the name can't inject email headers when reused in subjects.
    const safeName = name.replace(/[\r\n]+/g, ' ').trim();
    if (!safeName) throw Object.assign(new Error('Name cannot be empty'), { status: 400 });
    if (safeName.length > 200) throw Object.assign(new Error('Name too long'), { status: 400 });
    await db.run('UPDATE users SET name = $1 WHERE id = $2', [safeName, userId]);
  }
  if (compile_location !== undefined) {
    // Caller route already gated this behind FEATURE_LOCAL_COMPILE. Defensively
    // coerce anything other than the two known values to 'server' so the column
    // never holds a typo or an unsupported enum.
    const val = compile_location === 'local' ? 'local' : 'server';
    await db.run('UPDATE users SET compile_location = $1 WHERE id = $2', [val, userId]);
  }
  return getCurrentUser(userId);
}

// --- TOTP management ---

/** Generate a TOTP secret and QR code for MFA setup (does not enable yet). */
export async function setupTotp(userId) {
  const user = await db.get('SELECT id, email, totp_enabled FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (user.totp_enabled) throw Object.assign(new Error('MFA is already enabled'), { status: 400 });

  const secret = new OTPAuth.Secret();
  const totp = new OTPAuth.TOTP({
    issuer: 'FlowTex',
    label: user.email,
    secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const qrDataUrl = await QRCode.toDataURL(totp.toString());
  await db.run('UPDATE users SET totp_secret = $1 WHERE id = $2', [encrypt(secret.base32), user.id]);
  return { secret: secret.base32, qrCode: qrDataUrl };
}

/** Verify a TOTP code against the pending secret and enable MFA for the user. */
export async function verifyAndEnableTotp(userId, code) {
  const user = await db.get('SELECT id, totp_secret, totp_enabled FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!user.totp_secret) throw Object.assign(new Error('Run setup first'), { status: 400 });
  if (user.totp_enabled) throw Object.assign(new Error('MFA is already enabled'), { status: 400 });

  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(decryptTotpSecret(user.totp_secret)),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) throw Object.assign(new Error('Invalid code. Please try again.'), { status: 400 });

  await db.run('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [user.id]);
}

/** Disable MFA after verifying the user's password. */
export async function disableTotp(userId, password) {
  const user = await db.get('SELECT id, password_hash, totp_enabled FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!user.totp_enabled) throw Object.assign(new Error('MFA is not enabled'), { status: 400 });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw Object.assign(new Error('Invalid password'), { status: 401 });

  await db.run('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', [user.id]);
  await db.run('DELETE FROM trusted_devices WHERE user_id = $1', [user.id]);
}

// --- Password management ---

/**
 * Create a password-reset token (rate-limited to 3/hour).
 * @returns {{token, userId, email}|null} Null if user not found or rate-limited.
 */
export async function createPasswordResetToken(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.get(
    'SELECT id, email, deleted_at FROM users WHERE email = $1',
    [normalizedEmail],
  );
  if (!user) return null; // Don't reveal user existence
  if (user.deleted_at) return null; // Soft-deleted accounts can't reset their own password

  const recentTokens = await db.get(
    `SELECT COUNT(*) AS cnt FROM password_reset_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [user.id],
  );
  if (parseInt(recentTokens?.cnt || 0) >= 3) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.run(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
    [uuid(), user.id, tokenHash],
  );
  return { token, userId: user.id, email: user.email };
}

/** Reset a user's password using a valid reset token; invalidates all sessions. */
export async function resetPassword(token, newPassword) {
  const pwError = validatePassword(newPassword);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });
  await checkPasswordNotBreached(newPassword);

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // The whole reset is wrapped in a transaction: if validation fails or any
  // statement errors, the row stays unused. The earlier flow marked the token
  // used eagerly with UPDATE…RETURNING and then rolled back via a second
  // UPDATE, which left a stranded "used" token if the process died between
  // the two statements.
  return db.transaction(async (tx) => {
    const resetToken = await tx.get(
      `UPDATE password_reset_tokens SET used = TRUE WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW() RETURNING id, user_id`,
      [tokenHash],
    );
    if (!resetToken) throw Object.assign(new Error('Invalid or expired reset link'), { status: 400 });

    const currentUser = await tx.get('SELECT password_hash FROM users WHERE id = $1', [resetToken.user_id]);
    if (currentUser && (await bcrypt.compare(newPassword, currentUser.password_hash))) {
      // Throwing rolls the transaction back, so the token remains unused.
      throw Object.assign(new Error('New password must be different from your current password'), { status: 400 });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await tx.run('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetToken.user_id]);
    await tx.run('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND id != $2', [
      resetToken.user_id,
      resetToken.id,
    ]);
    await tx.run(`DELETE FROM session WHERE sess->>'userId' = $1`, [resetToken.user_id]);
    await tx.run('DELETE FROM trusted_devices WHERE user_id = $1', [resetToken.user_id]);
    return resetToken.user_id;
  });
}

/** Change the user's email after verifying their password. */
export async function changeEmail(userId, password, newEmail) {
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
    throw Object.assign(new Error('Invalid email address'), { status: 400 });

  const user = await db.get('SELECT id, email, name, password_hash FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!(await bcrypt.compare(password, user.password_hash)))
    throw Object.assign(new Error('Incorrect password'), { status: 401 });
  if (normalizedEmail === user.email)
    throw Object.assign(new Error('New email is the same as your current email'), { status: 400 });

  const existing = await db.get('SELECT 1 FROM users WHERE email = $1', [normalizedEmail]);
  if (existing) throw Object.assign(new Error('An account with this email already exists'), { status: 409 });

  await db.run('UPDATE users SET email = $1, email_verified = FALSE WHERE id = $2', [normalizedEmail, user.id]);
  return { email: normalizedEmail, oldEmail: user.email, name: user.name, needsVerification: true };
}

/** Change the user's password after verifying the current one. */
export async function changePassword(userId, currentPassword, newPassword) {
  const user = await db.get('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!(await bcrypt.compare(currentPassword, user.password_hash)))
    throw Object.assign(new Error('Current password is incorrect'), { status: 401 });
  if (currentPassword === newPassword)
    throw Object.assign(new Error('New password must be different from your current password'), { status: 400 });

  const pwError = validatePassword(newPassword);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });
  await checkPasswordNotBreached(newPassword);

  const newHash = await bcrypt.hash(newPassword, 12);
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
}

/** Number of days a soft-deleted account lives in the recovery bin before
 *  the daily cron permanently purges it. The deletion email quotes this
 *  number, the admin UI displays it, and purgeExpiredSoftDeletes uses it
 *  as the cut-off — keep them all in sync via this constant. */
export const SOFT_DELETE_WINDOW_DAYS = 30;

/** Soft-delete the account: marks deleted_at = NOW(), revokes every
 *  session + reset/verification token + trusted device, and (best-effort)
 *  closes any live WS connections via app.locals.disconnectUserEverywhere
 *  if the caller passes the express app. The user row, authorship, and
 *  memberships all remain intact so a restore is a clean revert. The
 *  actual cascade-and-delete only happens at the 30-day mark via
 *  purgeExpiredSoftDeletes. */
async function softDeleteUserInTx(tx, user) {
  await tx.run('UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL', [user.id]);
  await tx.run(`DELETE FROM session WHERE sess->>'userId' = $1`, [user.id]);
  await tx.run('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);
  await tx.run('DELETE FROM email_verification_tokens WHERE user_id = $1', [user.id]);
  await tx.run('DELETE FROM trusted_devices WHERE user_id = $1', [user.id]);
}

/** Permanently delete a user account and all owned data after verifying their password. */
/** Tear down all rows referencing a user that don't ON-DELETE-CASCADE
 *  cleanly, then delete the user row. Run inside a transaction. Shared by
 *  the self-delete and admin-delete paths so they stay in lock-step. */
async function purgeUserInTx(tx, user) {
  await tx.run('UPDATE comments SET author_id = NULL WHERE author_id = $1', [user.id]);
  await tx.run('UPDATE comment_replies SET author_id = NULL WHERE author_id = $1', [user.id]);
  await tx.run('UPDATE file_versions SET author_id = NULL WHERE author_id = $1', [user.id]);
  await tx.run('UPDATE project_snapshots SET author_id = NULL WHERE author_id = $1', [user.id]);
  await tx.run('DELETE FROM project_invitations WHERE inviter_id = $1', [user.id]);
  await tx.run('DELETE FROM project_github_links WHERE linked_by = $1', [user.id]);
  await tx.run('UPDATE audit_log SET user_id = NULL WHERE user_id = $1', [user.id]);
  await tx.run('DELETE FROM login_attempts WHERE email = $1', [user.email]);

  // Drop projects where the user is the only member.
  await tx.run(
    `DELETE FROM projects WHERE id IN (
      SELECT p.id FROM projects p JOIN project_members pm ON p.id = pm.project_id
      WHERE pm.user_id = $1 AND pm.role = 'owner'
        AND NOT EXISTS (SELECT 1 FROM project_members pm2 WHERE pm2.project_id = p.id AND pm2.user_id != $1)
    )`,
    [user.id],
  );

  // For projects the user owned where co-members exist, promote the
  // longest-tenured remaining member to owner so the project doesn't end
  // up un-administrable when the FK cascade wipes the owner row below.
  await tx.run(
    `UPDATE project_members AS new_owner SET role = 'owner'
       FROM (
         SELECT DISTINCT ON (pm.project_id) pm.project_id, pm.user_id
           FROM project_members pm
           JOIN project_members owner_row
             ON owner_row.project_id = pm.project_id
            AND owner_row.user_id = $1
            AND owner_row.role = 'owner'
          WHERE pm.user_id <> $1
          ORDER BY pm.project_id, pm.created_at ASC, pm.user_id ASC
       ) AS promotions
       WHERE new_owner.project_id = promotions.project_id
         AND new_owner.user_id    = promotions.user_id`,
    [user.id],
  );

  await tx.run('DELETE FROM users WHERE id = $1', [user.id]);
}

export async function deleteAccount(userId, password) {
  const user = await db.get(
    'SELECT id, email, name, password_hash, is_admin, deleted_at FROM users WHERE id = $1',
    [userId],
  );
  if (!user || user.deleted_at) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!(await bcrypt.compare(password, user.password_hash)))
    throw Object.assign(new Error('Invalid password'), { status: 401 });

  await db.transaction(async (tx) => {
    // Refuse if this would leave the system with zero alive admins.
    // "Alive" excludes soft-deleted rows (they can't sign in). Same
    // invariant the admin-promote/demote route enforces — without this
    // guard a sole admin could lock the system out by self-deleting,
    // because the recovery-bin restore endpoint itself requires an admin
    // session.
    //
    // FOR UPDATE locks every admin row in the count, serialising
    // concurrent admin-self-deletes / admin-demotes / admin-deletes that
    // would otherwise both observe count=2 and both proceed, leaving
    // zero admins. The lock is released when this tx commits or rolls back.
    if (user.is_admin) {
      const countRow = await tx.get(
        'SELECT COUNT(*)::int AS n FROM (SELECT id FROM users WHERE is_admin = TRUE AND deleted_at IS NULL FOR UPDATE) sub',
      );
      if ((countRow?.n || 0) <= 1) {
        throw Object.assign(
          new Error('You are the only admin. Promote another user to admin before deleting your account.'),
          { status: 409 },
        );
      }
    }
    await softDeleteUserInTx(tx, user);
  });
  return { email: user.email, name: user.name };
}

/** Admin-driven delete of another user. Requires the *admin's* own password
 *  (not the target's — the admin doesn't know it). Same cascade as the
 *  self-delete path. Returns { email, name } of the deleted user so the
 *  caller can send a goodbye email. */
export async function adminDeleteUser(adminId, adminPassword, targetUserId) {
  if (!adminId || !targetUserId) throw Object.assign(new Error('Missing ids'), { status: 400 });
  if (adminId === targetUserId) {
    throw Object.assign(new Error('Use the self-delete flow to remove your own account'), { status: 400 });
  }
  const admin = await db.get('SELECT id, password_hash, is_admin FROM users WHERE id = $1', [adminId]);
  if (!admin || !admin.is_admin) {
    throw Object.assign(new Error('Not an admin'), { status: 403 });
  }
  if (!adminPassword || typeof adminPassword !== 'string') {
    throw Object.assign(new Error('Admin password required'), { status: 400 });
  }
  if (!(await bcrypt.compare(adminPassword, admin.password_hash))) {
    throw Object.assign(new Error('Invalid admin password'), { status: 401 });
  }
  const target = await db.get('SELECT id, email, name, is_admin, deleted_at FROM users WHERE id = $1', [targetUserId]);
  if (!target) throw Object.assign(new Error('Target user not found'), { status: 404 });
  if (target.deleted_at) {
    throw Object.assign(new Error('User is already scheduled for deletion'), { status: 409 });
  }

  await db.transaction(async (tx) => {
    // Symmetric guard with deleteAccount: if removing this admin would
    // leave zero alive admins, refuse. Without the lock, two admins
    // running adminDeleteUser on each other simultaneously could both
    // observe count=2 and both proceed. See deleteAccount for the
    // same FOR UPDATE pattern.
    if (target.is_admin) {
      const countRow = await tx.get(
        'SELECT COUNT(*)::int AS n FROM (SELECT id FROM users WHERE is_admin = TRUE AND deleted_at IS NULL FOR UPDATE) sub',
      );
      if ((countRow?.n || 0) <= 1) {
        throw Object.assign(
          new Error('Cannot delete the last admin. Promote another user to admin first.'),
          { status: 409 },
        );
      }
    }
    await softDeleteUserInTx(tx, target);
  });
  return { email: target.email, name: target.name };
}

/** Admin-driven restore of a soft-deleted user. Clears deleted_at so the
 *  user can sign in again. Requires the admin's own password as a second
 *  factor — mirrors adminDeleteUser, so a hijacked admin session can't
 *  one-click un-quarantine a user the operator had binned for cause.
 *  The restored user still has to log in (their session was killed at
 *  soft-delete). Returns the restored user's email + name so the caller
 *  can send a notification. */
export async function adminRestoreUser(adminId, adminPassword, targetUserId) {
  if (!adminId || !targetUserId) throw Object.assign(new Error('Missing ids'), { status: 400 });
  const admin = await db.get('SELECT id, password_hash, is_admin FROM users WHERE id = $1', [adminId]);
  if (!admin || !admin.is_admin) throw Object.assign(new Error('Not an admin'), { status: 403 });
  if (!adminPassword || typeof adminPassword !== 'string') {
    throw Object.assign(new Error('Admin password required'), { status: 400 });
  }
  if (!(await bcrypt.compare(adminPassword, admin.password_hash))) {
    throw Object.assign(new Error('Invalid admin password'), { status: 401 });
  }

  const target = await db.get(
    'SELECT id, email, name, deleted_at FROM users WHERE id = $1',
    [targetUserId],
  );
  if (!target) throw Object.assign(new Error('User not found'), { status: 404 });
  if (!target.deleted_at) {
    throw Object.assign(new Error('User is not deleted'), { status: 409 });
  }
  // Conditional UPDATE + rowCount check guards the race with the hourly
  // purge cron: if the row was hard-deleted between the SELECT above and
  // this UPDATE, rowCount is 0 and we surface a clear 410 instead of
  // returning {ok:true} for nothing.
  const res = await db.run(
    'UPDATE users SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL',
    [target.id],
  );
  if (!res?.rowCount) {
    throw Object.assign(
      new Error('Account was already permanently purged'),
      { status: 410 },
    );
  }
  return { email: target.email, name: target.name };
}

/** List users currently in the recovery bin (soft-deleted, awaiting purge).
 *  Returns the absolute purge date for each so the admin UI doesn't have to
 *  recompute the window. */
export async function listSoftDeletedUsers() {
  const rows = await db.all(
    `SELECT id, email, name, deleted_at,
            (deleted_at + ($1 || ' days')::interval) AS purge_at
       FROM users
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC`,
    [String(SOFT_DELETE_WINDOW_DAYS)],
  );
  return rows;
}

/** Permanently purge every soft-deleted account whose window has elapsed.
 *  Called from a daily cron in server/index.js. Returns the IDs that were
 *  purged so the caller can log them. */
export async function purgeExpiredSoftDeletes() {
  const expired = await db.all(
    `SELECT id, email, name FROM users
      WHERE deleted_at IS NOT NULL
        AND deleted_at < NOW() - ($1 || ' days')::interval`,
    [String(SOFT_DELETE_WINDOW_DAYS)],
  );
  const purgedIds = [];
  for (const user of expired) {
    try {
      await db.transaction(async (tx) => {
        await purgeUserInTx(tx, user);
      });
      purgedIds.push(user.id);
    } catch (err) {
      // One bad row shouldn't halt the whole sweep — log + skip.
      logger.error({ err, userId: user.id }, 'soft-delete purge failed for user');
    }
  }
  return purgedIds;
}
