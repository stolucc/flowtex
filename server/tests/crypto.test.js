import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import nodeCrypto from 'crypto';
import { encrypt, decrypt, _setSaltForTesting, initCrypto } from '../utils/crypto.js';

const TEST_SALT = 'test-salt-for-unit-tests';

// Mock db for the initCrypto path. Most tests don't use it but a couple do.
vi.mock('../db.js', () => ({
  default: { get: vi.fn(), run: vi.fn() },
}));
import db from '../db.js';

beforeAll(() => {
  _setSaltForTesting(TEST_SALT);
});

describe('encrypt / decrypt', () => {
  beforeEach(() => {
    // Re-arm salt; some tests below null it out.
    _setSaltForTesting(TEST_SALT);
  });

  it('round-trips an ASCII string', () => {
    const original = 'ghp_SuperSecretToken12345';
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it('produces different ciphertexts for the same input (random IV)', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a).not.toBe(b);
  });

  it('handles empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('round-trips a unicode string (would corrupt under wrong encoding)', () => {
    // This catches any mutation that swaps the 'utf8' input encoding to ''
    // or to anything else, because non-ASCII bytes would re-encode wrong.
    const unicode = 'héllo wörld 日本語 🌍';
    expect(decrypt(encrypt(unicode))).toBe(unicode);
  });

  it('produces ciphertext in iv:tag:body hex format with the documented lengths', () => {
    const ct = encrypt('x');
    const parts = ct.split(':');
    expect(parts).toHaveLength(3);
    // 16-byte IV → 32 hex chars
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
    // 16-byte GCM auth tag → 32 hex chars
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    // Body is hex of any length
    expect(parts[2]).toMatch(/^[0-9a-f]*$/);
  });

  it('throws on tampered ciphertext (auth tag verification)', () => {
    const encrypted = encrypt('test');
    const tampered = encrypted.slice(0, -2) + 'ff';
    expect(() => decrypt(tampered)).toThrow();
  });

  it('decrypt throws when input is not a string (typeof guard)', () => {
    expect(() => decrypt(123)).toThrow(/Invalid encrypted data/);
    expect(() => decrypt(null)).toThrow(/Invalid encrypted data/);
    expect(() => decrypt(undefined)).toThrow(/Invalid encrypted data/);
    expect(() => decrypt(Buffer.from('x'))).toThrow(/Invalid encrypted data/);
  });

  it('decrypt throws when ciphertext is malformed (split parts != 3)', () => {
    expect(() => decrypt('only-one-part')).toThrow(/Malformed encrypted data/);
    expect(() => decrypt('two:parts')).toThrow(/Malformed encrypted data/);
    expect(() => decrypt('too:many:parts:here')).toThrow(/Malformed encrypted data/);
  });

  it('round-trip is reversible for arbitrary binary-safe strings', () => {
    // A bunch of byte values that would re-encode wrong under latin1/ascii.
    const cases = ['\x00\x01\x02', '\xff\xfe\xfd', '\u{1F600}'];
    for (const c of cases) expect(decrypt(encrypt(c))).toBe(c);
  });

  it('uses AES-256-GCM and the documented dev-fallback key when ENCRYPTION_KEY is unset', () => {
    // Pin the actual key derivation. If DEV_FALLBACK_KEY were mutated to ''
    // (or anything else), this manual decryption would fail.
    const oldKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    _setSaltForTesting(TEST_SALT);
    const ciphertext = encrypt('decryptable-with-known-key');
    const expectedKey = nodeCrypto.scryptSync('0'.repeat(64), TEST_SALT, 32);
    const [ivHex, tagHex, body] = ciphertext.split(':');
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', expectedKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const out = decipher.update(body, 'hex', 'utf8') + decipher.final('utf8');
    expect(out).toBe('decryptable-with-known-key');
    if (oldKey !== undefined) process.env.ENCRYPTION_KEY = oldKey;
  });
});

describe('getSalt error path', () => {
  it('throws a clear error when the salt has not been initialised', () => {
    _setSaltForTesting(null);
    expect(() => encrypt('x')).toThrow(/initCrypto\(\) must be called/);
    _setSaltForTesting(TEST_SALT);
  });
});

describe('deriveKey paths', () => {
  let oldKey, oldNodeEnv, warnSpy;
  beforeEach(() => {
    oldKey = process.env.ENCRYPTION_KEY;
    oldNodeEnv = process.env.NODE_ENV;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = oldKey;
    process.env.NODE_ENV = oldNodeEnv;
    warnSpy.mockRestore();
  });

  it('uses the env ENCRYPTION_KEY (not the dev fallback) when one is set', () => {
    // Two distinct env keys must produce different ciphertexts (and different
    // wouldnt-decrypt-as-each-other behaviour).
    process.env.ENCRYPTION_KEY = 'A'.repeat(64);
    _setSaltForTesting(TEST_SALT); // resets cached _key
    const ctA = encrypt('x');
    process.env.ENCRYPTION_KEY = 'B'.repeat(64);
    _setSaltForTesting(TEST_SALT);
    expect(() => decrypt(ctA)).toThrow(); // wrong key
    // Decrypt with the same key works
    process.env.ENCRYPTION_KEY = 'A'.repeat(64);
    _setSaltForTesting(TEST_SALT);
    expect(decrypt(ctA)).toBe('x');
  });

  it('warns when falling back to the dev key (covers the [SECURITY] log message)', () => {
    delete process.env.ENCRYPTION_KEY;
    _setSaltForTesting(TEST_SALT);
    encrypt('x');
    // Find the warn call that mentions our message.
    const calls = warnSpy.mock.calls.flat().join(' ');
    expect(calls).toMatch(/\[SECURITY\] ENCRYPTION_KEY not set/);
  });

  it('throws in production when ENCRYPTION_KEY is missing', () => {
    // _setSaltForTesting must run while NODE_ENV is still 'test' (its own
    // guard); switch to 'production' after to trigger deriveKey's path.
    _setSaltForTesting(TEST_SALT);
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production';
    expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY must be set in production/);
  });
});

describe('_setSaltForTesting guard', () => {
  let oldNodeEnv;
  beforeEach(() => { oldNodeEnv = process.env.NODE_ENV; });
  afterEach(() => { process.env.NODE_ENV = oldNodeEnv; _setSaltForTesting(TEST_SALT); });

  it('throws when called with NODE_ENV !== test', () => {
    process.env.NODE_ENV = 'production';
    expect(() => _setSaltForTesting('any')).toThrow(/_setSaltForTesting is only available in NODE_ENV=test/);
  });

  it('also throws when NODE_ENV is undefined', () => {
    delete process.env.NODE_ENV;
    expect(() => _setSaltForTesting('any')).toThrow();
  });
});

describe('initCrypto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the existing salt when one is stored', async () => {
    db.get.mockResolvedValueOnce({ value: 'stored-salt' });
    await initCrypto();
    expect(db.run).not.toHaveBeenCalled();
  });

  it('selects from settings WHERE key = encryption_salt', async () => {
    db.get.mockResolvedValueOnce({ value: 'stored-salt' });
    await initCrypto();
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT value FROM settings WHERE key = $1');
    expect(params).toEqual(['encryption_salt']);
  });

  it('generates and inserts a random salt on first run', async () => {
    db.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ value: 'inserted-salt' });
    await initCrypto();
    expect(db.run).toHaveBeenCalledWith(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      expect.arrayContaining(['encryption_salt']),
    );
    // Restore test salt for subsequent tests.
    _setSaltForTesting(TEST_SALT);
  });

  it('the inserted salt is a 64-char hex string (32 random bytes)', async () => {
    db.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ value: 'inserted-salt' });
    await initCrypto();
    const insertedSalt = db.run.mock.calls[0][1][1];
    expect(insertedSalt).toMatch(/^[0-9a-f]{64}$/);
    _setSaltForTesting(TEST_SALT);
  });

  it('re-reads the settings row after insert (race-condition recovery)', async () => {
    db.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ value: 'race-winner-salt' });
    await initCrypto();
    // Two SELECTs should have happened: pre-insert (returns null) and post-insert.
    expect(db.get).toHaveBeenCalledTimes(2);
    expect(db.get.mock.calls[1][0]).toBe('SELECT value FROM settings WHERE key = $1');
    expect(db.get.mock.calls[1][1]).toEqual(['encryption_salt']);
    _setSaltForTesting(TEST_SALT);
  });
});
