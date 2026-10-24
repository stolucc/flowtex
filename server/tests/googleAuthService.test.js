import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({ default: {} }));
vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({ fake: 'config' })),
  randomPKCECodeVerifier: vi.fn(() => 'verifier-123'),
  calculatePKCECodeChallenge: vi.fn(async () => 'challenge-abc'),
  randomState: vi.fn(() => 'state-xyz'),
  randomNonce: vi.fn(() => 'nonce-789'),
  buildAuthorizationUrl: vi.fn((config, params) => new URL(`https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(params)}`)),
  authorizationCodeGrant: vi.fn(),
}));

import * as oidc from 'openid-client';
import {
  isGoogleAuthEnabled,
  buildAuthRequest,
  exchangeCallback,
  identityFromClaims,
  _testing,
} from '../services/googleAuthService.js';

const saved = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  _testing.resetConfig();
  process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
});
afterEach(() => {
  process.env = { ...saved };
});

describe('isGoogleAuthEnabled', () => {
  it('needs both client id and secret', () => {
    expect(isGoogleAuthEnabled()).toBe(true);
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(isGoogleAuthEnabled()).toBe(false);
    process.env.GOOGLE_CLIENT_SECRET = 's';
    delete process.env.GOOGLE_CLIENT_ID;
    expect(isGoogleAuthEnabled()).toBe(false);
  });
});

describe('buildAuthRequest', () => {
  it('uses PKCE S256, state, nonce, the openid email profile scope, and the account chooser', async () => {
    const r = await buildAuthRequest('https://app.test/api/auth/google/callback');
    expect(r).toMatchObject({ state: 'state-xyz', nonce: 'nonce-789', codeVerifier: 'verifier-123' });
    const url = new URL(r.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: 'https://app.test/api/auth/google/callback',
      scope: 'openid email profile',
      code_challenge: 'challenge-abc',
      code_challenge_method: 'S256',
      state: 'state-xyz',
      nonce: 'nonce-789',
      prompt: 'select_account',
    });
    expect(oidc.discovery).toHaveBeenCalledWith(new URL('https://accounts.google.com'), 'cid.apps.googleusercontent.com', 'secret');
  });

  it('caches discovery, but retries after a failed discovery', async () => {
    oidc.discovery.mockRejectedValueOnce(new Error('network'));
    await expect(buildAuthRequest('https://x/cb')).rejects.toThrow('network');
    await buildAuthRequest('https://x/cb');
    await buildAuthRequest('https://x/cb');
    expect(oidc.discovery).toHaveBeenCalledTimes(2);
  });
});

describe('exchangeCallback', () => {
  it('passes PKCE verifier, state, and nonce checks to openid-client and requires an ID token', async () => {
    oidc.authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ sub: '1234', email: 'A@Example.com', email_verified: true, name: 'Ann' }),
    });
    const cb = new URL('https://app.test/api/auth/google/callback?code=c&state=state-xyz');
    const id = await exchangeCallback(cb, { state: 'state-xyz', nonce: 'nonce-789', codeVerifier: 'verifier-123' });
    expect(id).toEqual({ sub: '1234', email: 'a@example.com', name: 'Ann' });
    expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith({ fake: 'config' }, cb, {
      pkceCodeVerifier: 'verifier-123',
      expectedState: 'state-xyz',
      expectedNonce: 'nonce-789',
      idTokenExpected: true,
    });
  });

  it('propagates openid-client validation failures', async () => {
    oidc.authorizationCodeGrant.mockRejectedValueOnce(new Error('unexpected ID Token "nonce" claim value'));
    await expect(
      exchangeCallback(new URL('https://x/cb?code=c'), { state: 's', nonce: 'n', codeVerifier: 'v' }),
    ).rejects.toThrow(/nonce/);
  });
});

describe('identityFromClaims', () => {
  const ok = { sub: 's1', email: 'u@example.com', email_verified: true, name: 'U' };

  it('rejects a missing token, missing/oversized sub', () => {
    expect(() => identityFromClaims(undefined)).toThrow(/ID token/);
    expect(() => identityFromClaims({ ...ok, sub: '' })).toThrow(/subject/);
    expect(() => identityFromClaims({ ...ok, sub: 5 })).toThrow(/subject/);
    expect(() => identityFromClaims({ ...ok, sub: 'x'.repeat(256) })).toThrow(/subject/);
  });

  it('requires email_verified to be literally true', () => {
    for (const v of [false, 'true', undefined, 1]) {
      expect(() => identityFromClaims({ ...ok, email_verified: v })).toThrow(/not verified/);
    }
  });

  it('rejects missing or malformed email', () => {
    expect(() => identityFromClaims({ ...ok, email: undefined })).toThrow(/email/);
    expect(() => identityFromClaims({ ...ok, email: 'nope' })).toThrow(/email/);
  });

  it('errors carry status 400', () => {
    try {
      identityFromClaims({ ...ok, email_verified: false });
    } catch (e) {
      expect(e.status).toBe(400);
    }
  });

  it('normalises email, strips CR/LF from name, caps name, falls back to email', () => {
    expect(identityFromClaims({ ...ok, email: ' U@Example.COM ', name: 'A\r\nBcc: x' }))
      .toEqual({ sub: 's1', email: 'u@example.com', name: 'A Bcc: x' });
    expect(identityFromClaims({ ...ok, name: 'n'.repeat(500) }).name).toHaveLength(200);
    expect(identityFromClaims({ ...ok, name: undefined }).name).toBe('u@example.com');
    expect(identityFromClaims({ ...ok, name: '  \n ' }).name).toBe('u@example.com');
  });
});
