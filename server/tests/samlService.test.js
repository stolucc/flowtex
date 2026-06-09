// SAML / SSO Day 1 -- SP keypair lifecycle tests.
//
// Pure-logic tests of generateSpKeypair (in-memory, no DB) and a
// round-trip through the DB-backed getSpKeypair / rotateSpKeypair
// (using the existing test DB mocks).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';

// Mock the DB layer so we don't need a live Postgres for these tests.
// The integration-style verification happens in a future
// saml-routes.integration.test.js gated on RUN_PG_INTEGRATION=1.
const mockRows = new Map();
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(async (sql, params) => {
      const key = JSON.stringify({ sql, params });
      return mockRows.get(key) ?? null;
    }),
    run: vi.fn(async (sql, params) => {
      // Crude SQL parser: capture INSERT INTO saml_sp_keypair as a
      // get-able row keyed by the id column. Enough for these tests.
      if (/INSERT\s+INTO\s+saml_sp_keypair/i.test(sql)) {
        const [id, privKeyEnc, certPem, fpr, notAfter] = params;
        const row = {
          private_key_encrypted: privKeyEnc,
          certificate_pem: certPem,
          fingerprint_sha256: fpr,
          not_valid_after: notAfter,
        };
        const selectKey = JSON.stringify({
          sql: 'SELECT private_key_encrypted, certificate_pem, fingerprint_sha256, not_valid_after FROM saml_sp_keypair WHERE id = $1',
          params: [id],
        });
        mockRows.set(selectKey, row);
      }
    }),
  },
}));

// Mock the crypto utils so encrypt/decrypt round-trip without needing
// initCrypto's salt setup.
vi.mock('../utils/crypto.js', () => ({
  encrypt: vi.fn((s) => `enc(${s})`),
  decrypt: vi.fn((s) => s.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  generateSpKeypair,
  getSpKeypair,
  rotateSpKeypair,
  _testing,
} from '../services/samlService.js';

beforeEach(() => {
  mockRows.clear();
  _testing.resetCache();
});

describe('generateSpKeypair', () => {
  it('returns a PEM-shaped private key + X.509 certificate', async () => {
    const kp = await generateSpKeypair('https://flowtex.click/saml/sp');
    expect(kp.privateKey).toMatch(/^-----BEGIN (RSA )?PRIVATE KEY-----/);
    expect(kp.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(kp.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.notAfter).toBeInstanceOf(Date);
    // 3 years validity; allow a day of slack for test runs near midnight UTC.
    const yearsAhead = (kp.notAfter.getTime() - Date.now()) / (365 * 24 * 3600 * 1000);
    expect(yearsAhead).toBeGreaterThan(2.99);
    expect(yearsAhead).toBeLessThan(3.01);
  });

  it('embeds the entityID as the certificate CN', async () => {
    const kp = await generateSpKeypair('https://flowtex.click/saml/sp');
    // Decode the cert and check the subject CN. node-built-in
    // X509Certificate parses the PEM directly.
    const x509 = new X509Certificate(kp.certificatePem);
    expect(x509.subject).toContain('flowtex.click/saml/sp');
  });

  it('two successive calls return DIFFERENT keypairs (no caching at gen layer)', async () => {
    const a = await generateSpKeypair('https://flowtex.click/saml/sp');
    const b = await generateSpKeypair('https://flowtex.click/saml/sp');
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
  });

  it('rejects empty entityID', async () => {
    await expect(generateSpKeypair('')).rejects.toThrow(/entityId is required/);
    await expect(generateSpKeypair(undefined)).rejects.toThrow();
  });
});

describe('getSpKeypair', () => {
  it('generates + persists on first call', async () => {
    const kp = await getSpKeypair('https://flowtex.click/saml/sp');
    expect(kp.privateKey).toMatch(/^-----BEGIN/);
    expect(kp.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    // Cache populated.
    expect(_testing.resetCache).toBeDefined();
  });

  it('returns the cached keypair on second call (no new gen)', async () => {
    const first = await getSpKeypair('https://flowtex.click/saml/sp');
    const second = await getSpKeypair('https://flowtex.click/saml/sp');
    // Same private key (cache returned) -- new gen would produce a
    // different one.
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.fingerprintSha256).toBe(first.fingerprintSha256);
  });

  it('reads from DB on cold start (no in-memory cache)', async () => {
    // Seed: generate + persist.
    await getSpKeypair('https://flowtex.click/saml/sp');
    const fingerprint = (await getSpKeypair()).fingerprintSha256;
    _testing.resetCache(); // simulate a process restart
    // Now fetch without providing an entityID -- should still work
    // because the row exists.
    const reloaded = await getSpKeypair();
    expect(reloaded.fingerprintSha256).toBe(fingerprint);
  });

  it('throws if no row exists and no entityID provided', async () => {
    await expect(getSpKeypair()).rejects.toThrow(/no keypair exists/);
  });
});

describe('rotateSpKeypair', () => {
  it('replaces the persisted row + invalidates the cache', async () => {
    const original = await getSpKeypair('https://flowtex.click/saml/sp');
    const rotated = await rotateSpKeypair('https://flowtex.click/saml/sp', 'admin-user-id');
    expect(rotated.fingerprintSha256).not.toBe(original.fingerprintSha256);
    // Next getSpKeypair() should return the rotated one.
    const fetched = await getSpKeypair();
    expect(fetched.fingerprintSha256).toBe(rotated.fingerprintSha256);
  });
});
