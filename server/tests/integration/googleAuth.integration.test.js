// Google sign-in account resolution against the real database.
//
// The OIDC exchange itself is unit-tested with a mocked openid-client
// (tests/googleAuthService.test.js); here we start from an already
// verified identity and check which account it maps to, and that the
// link / unlink / squat-claim writes land correctly.

import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { seedUser } from './setup.js';
import { hashPassword } from '../../utils/passwordHash.js';
import {
  resolveGoogleLogin,
  linkGoogleToUser,
  unlinkGoogle,
} from '../../services/googleAuthService.js';

const sub = () => `g-${uuid()}`;
const mail = () => `g-${uuid().slice(0, 8)}@example.test`;

describe('resolveGoogleLogin', () => {
  it('creates a verified, password-less account for a new identity', async () => {
    const identity = { sub: sub(), email: mail(), name: 'New Person' };
    const r = await resolveGoogleLogin(identity);
    expect(r.kind).toBe('login');
    expect(r.isNew).toBe(true);
    const row = await db.get('SELECT * FROM users WHERE id = $1', [r.user.id]);
    expect(row).toMatchObject({
      email: identity.email,
      name: 'New Person',
      google_sub: identity.sub,
      email_verified: true,
      password_hash: null,
      auth_method: 'password',
    });
  });

  it('logs in by google_sub even if the Google email has changed', async () => {
    const s = sub();
    const u = await seedUser({ email: mail() });
    await db.run('UPDATE users SET google_sub = $1 WHERE id = $2', [s, u.id]);
    const r = await resolveGoogleLogin({ sub: s, email: mail(), name: 'x' });
    expect(r).toMatchObject({ kind: 'login', isNew: false, claimed: false });
    expect(r.user.id).toBe(u.id);
  });

  it('asks for the password when a verified password account has the email', async () => {
    const u = await seedUser({ email: mail(), name: 'Existing' });
    const r = await resolveGoogleLogin({ sub: sub(), email: u.email, name: 'Other Name' });
    expect(r).toEqual({ kind: 'needs_link', userId: u.id, email: u.email, existingName: 'Existing' });
    // Nothing written yet.
    const row = await db.get('SELECT google_sub, name FROM users WHERE id = $1', [u.id]);
    expect(row).toEqual({ google_sub: null, name: 'Existing' });
  });

  it('matches the email case-insensitively via the normalised identity', async () => {
    const u = await seedUser({ email: mail() });
    const r = await resolveGoogleLogin({ sub: sub(), email: u.email.toLowerCase(), name: 'x' });
    expect(r.kind).toBe('needs_link');
  });

  it('claims an unverified squat: wipes password + tokens, verifies, links', async () => {
    const email = mail();
    const id = uuid();
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1, $2, 'Squatter', 'hash', FALSE)`,
      [id, email],
    );
    await db.run(
      `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
      [uuid(), id, 'h-' + uuid()],
    );
    await db.run(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
      [uuid(), id, 'r-' + uuid()],
    );
    const s = sub();
    const r = await resolveGoogleLogin({ sub: s, email, name: 'Real Owner' });
    expect(r).toMatchObject({ kind: 'login', claimed: true, isNew: false });
    const row = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    expect(row).toMatchObject({ google_sub: s, email_verified: true, password_hash: null, name: 'Real Owner' });
    const tok = await db.get('SELECT used FROM email_verification_tokens WHERE user_id = $1', [id]);
    expect(tok.used).toBe(true);
    const resets = await db.get('SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1', [id]);
    expect(resets.n).toBe(0);
  });

  it('refuses soft-deleted accounts (by sub and by email)', async () => {
    const s = sub();
    const a = await seedUser({ email: mail() });
    await db.run('UPDATE users SET google_sub = $1, deleted_at = NOW() WHERE id = $2', [s, a.id]);
    expect(await resolveGoogleLogin({ sub: s, email: mail(), name: 'x' })).toEqual({ kind: 'refused', reason: 'deleted' });

    const b = await seedUser({ email: mail() });
    await db.run('UPDATE users SET deleted_at = NOW() WHERE id = $1', [b.id]);
    expect(await resolveGoogleLogin({ sub: sub(), email: b.email, name: 'x' })).toEqual({ kind: 'refused', reason: 'deleted' });
  });

  it('refuses SAML accounts so org SSO cannot be bypassed', async () => {
    const u = await seedUser({ email: mail() });
    await db.run("UPDATE users SET auth_method = 'saml', password_hash = NULL WHERE id = $1", [u.id]);
    expect(await resolveGoogleLogin({ sub: sub(), email: u.email, name: 'x' })).toEqual({ kind: 'refused', reason: 'sso_required' });

    const s = sub();
    await db.run('UPDATE users SET google_sub = $1 WHERE id = $2', [s, u.id]);
    expect(await resolveGoogleLogin({ sub: s, email: u.email, name: 'x' })).toEqual({ kind: 'refused', reason: 'sso_required' });
  });

  it('refuses when the email account already has a different Google linked', async () => {
    const u = await seedUser({ email: mail() });
    await db.run('UPDATE users SET google_sub = $1 WHERE id = $2', [sub(), u.id]);
    expect(await resolveGoogleLogin({ sub: sub(), email: u.email, name: 'x' })).toEqual({ kind: 'refused', reason: 'other_google_linked' });
  });
});

describe('linkGoogleToUser', () => {
  it('links, and is idempotent for the same sub', async () => {
    const u = await seedUser({ email: mail() });
    const s = sub();
    const linked = await linkGoogleToUser(u.id, s);
    expect(linked.google_sub).toBe(s);
    await expect(linkGoogleToUser(u.id, s)).resolves.toMatchObject({ google_sub: s });
  });

  it('refuses a sub that belongs to another account', async () => {
    const s = sub();
    const a = await seedUser({ email: mail() });
    const b = await seedUser({ email: mail() });
    await linkGoogleToUser(a.id, s);
    await expect(linkGoogleToUser(b.id, s)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses replacing an existing different link', async () => {
    const u = await seedUser({ email: mail() });
    await linkGoogleToUser(u.id, sub());
    await expect(linkGoogleToUser(u.id, sub())).rejects.toMatchObject({ status: 409 });
  });

  it('refuses SAML and deleted accounts', async () => {
    const saml = await seedUser({ email: mail() });
    await db.run("UPDATE users SET auth_method = 'saml' WHERE id = $1", [saml.id]);
    await expect(linkGoogleToUser(saml.id, sub())).rejects.toMatchObject({ status: 409 });
    const gone = await seedUser({ email: mail() });
    await db.run('UPDATE users SET deleted_at = NOW() WHERE id = $1', [gone.id]);
    await expect(linkGoogleToUser(gone.id, sub())).rejects.toMatchObject({ status: 404 });
  });
});

describe('unlinkGoogle', () => {
  it('unlinks with the right password', async () => {
    const u = await seedUser({ email: mail(), password_hash: await hashPassword('correct horse battery') });
    await linkGoogleToUser(u.id, sub());
    await expect(unlinkGoogle(u.id, 'wrong')).rejects.toMatchObject({ status: 401 });
    await unlinkGoogle(u.id, 'correct horse battery');
    const row = await db.get('SELECT google_sub FROM users WHERE id = $1', [u.id]);
    expect(row.google_sub).toBeNull();
  });

  it('refuses when the account has no password (would lock the user out)', async () => {
    const r = await resolveGoogleLogin({ sub: sub(), email: mail(), name: 'Google Only' });
    await expect(unlinkGoogle(r.user.id, 'anything')).rejects.toMatchObject({ status: 400 });
    const row = await db.get('SELECT google_sub FROM users WHERE id = $1', [r.user.id]);
    expect(row.google_sub).not.toBeNull();
  });

  it('refuses when nothing is linked', async () => {
    const u = await seedUser({ email: mail() });
    await expect(unlinkGoogle(u.id, 'x')).rejects.toMatchObject({ status: 400 });
  });
});
