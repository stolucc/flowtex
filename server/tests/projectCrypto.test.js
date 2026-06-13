import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KDF_PARAMS,
  generateDEK,
  generateSalt,
  generateRecoveryCode,
  normalizeRecoveryCode,
  deriveKEK,
  wrapDEK,
  unwrapDEK,
  encryptFileContent,
  decryptFileContent,
  buffersEqual,
} from '../utils/projectCrypto.js';

// Use a deliberately cheap KDF in tests so the suite stays fast — the
// argon2 derive is the only slow part. Correctness doesn't depend on
// the cost factors.
const FAST_KDF = { type: 'argon2id', memoryCost: 8 * 1024, timeCost: 1, parallelism: 1 };

describe('generateDEK', () => {
  it('returns 32 random bytes', () => {
    const dek = generateDEK();
    expect(Buffer.isBuffer(dek)).toBe(true);
    expect(dek.length).toBe(32);
  });

  it('is random (two DEKs differ)', () => {
    expect(buffersEqual(generateDEK(), generateDEK())).toBe(false);
  });
});

describe('generateSalt', () => {
  it('returns a non-empty buffer', () => {
    expect(generateSalt().length).toBe(16);
  });
  it('differs each call', () => {
    expect(buffersEqual(generateSalt(), generateSalt())).toBe(false);
  });
});

describe('generateRecoveryCode / normalizeRecoveryCode', () => {
  it('produces a grouped uppercase code from the Crockford alphabet', () => {
    const code = generateRecoveryCode();
    // 32 base32 chars grouped in 4s → 8 groups separated by 7 hyphens.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  });

  it('excludes ambiguous letters I, L, O, U', () => {
    // Generate several; none should contain the excluded letters.
    for (let i = 0; i < 20; i++) {
      expect(generateRecoveryCode()).not.toMatch(/[ILOU]/);
    }
  });

  it('normalize strips hyphens/whitespace and uppercases', () => {
    expect(normalizeRecoveryCode('abcd-efgh ijkl')).toBe('ABCDEFGHIJKL');
    expect(normalizeRecoveryCode('ABCD-EFGH')).toBe('ABCDEFGH');
  });

  it('normalize makes grouped and ungrouped forms equivalent', () => {
    const code = generateRecoveryCode();
    const ungrouped = code.replace(/-/g, '');
    expect(normalizeRecoveryCode(code)).toBe(normalizeRecoveryCode(ungrouped));
  });
});

describe('deriveKEK', () => {
  it('derives a 32-byte key', async () => {
    const kek = await deriveKEK('passphrase', generateSalt(), FAST_KDF);
    expect(kek.length).toBe(32);
  });

  it('is deterministic for the same secret + salt + params', async () => {
    const salt = generateSalt();
    const a = await deriveKEK('hunter2', salt, FAST_KDF);
    const b = await deriveKEK('hunter2', salt, FAST_KDF);
    expect(buffersEqual(a, b)).toBe(true);
  });

  it('differs for a different secret', async () => {
    const salt = generateSalt();
    const a = await deriveKEK('hunter2', salt, FAST_KDF);
    const b = await deriveKEK('hunter3', salt, FAST_KDF);
    expect(buffersEqual(a, b)).toBe(false);
  });

  it('differs for a different salt (same secret)', async () => {
    const a = await deriveKEK('hunter2', generateSalt(), FAST_KDF);
    const b = await deriveKEK('hunter2', generateSalt(), FAST_KDF);
    expect(buffersEqual(a, b)).toBe(false);
  });

  it('rejects empty secret', async () => {
    await expect(deriveKEK('', generateSalt(), FAST_KDF)).rejects.toThrow();
  });

  it('rejects non-buffer salt', async () => {
    await expect(deriveKEK('x', /** @type {any} */ ('notbuf'), FAST_KDF)).rejects.toThrow();
  });

  it('exposes sane DEFAULT_KDF_PARAMS', () => {
    expect(DEFAULT_KDF_PARAMS.type).toBe('argon2id');
    expect(DEFAULT_KDF_PARAMS.memoryCost).toBeGreaterThanOrEqual(64 * 1024);
  });
});

describe('wrapDEK / unwrapDEK', () => {
  it('round-trips a DEK through a KEK', async () => {
    const dek = generateDEK();
    const kek = await deriveKEK('pass', generateSalt(), FAST_KDF);
    const wrapped = wrapDEK(dek, kek);
    expect(typeof wrapped).toBe('string');
    expect(buffersEqual(unwrapDEK(wrapped, kek), dek)).toBe(true);
  });

  it('unwrap with a WRONG kek throws (GCM tag mismatch)', async () => {
    const dek = generateDEK();
    const salt = generateSalt();
    const right = await deriveKEK('right', salt, FAST_KDF);
    const wrong = await deriveKEK('wrong', salt, FAST_KDF);
    const wrapped = wrapDEK(dek, right);
    expect(() => unwrapDEK(wrapped, wrong)).toThrow();
  });

  it('two wraps of the SAME dek (passphrase + recovery) both unwrap to it', async () => {
    const dek = generateDEK();
    const salt = generateSalt();
    const passKek = await deriveKEK('my passphrase', salt, FAST_KDF);
    const recovery = generateRecoveryCode();
    const recoveryKek = await deriveKEK(normalizeRecoveryCode(recovery), salt, FAST_KDF);

    const wrappedByPass = wrapDEK(dek, passKek);
    const wrappedByRecovery = wrapDEK(dek, recoveryKek);

    expect(buffersEqual(unwrapDEK(wrappedByPass, passKek), dek)).toBe(true);
    expect(buffersEqual(unwrapDEK(wrappedByRecovery, recoveryKek), dek)).toBe(true);
  });

  it('rejects a non-32-byte dek or kek', () => {
    expect(() => wrapDEK(Buffer.alloc(16), Buffer.alloc(32))).toThrow();
    expect(() => wrapDEK(Buffer.alloc(32), Buffer.alloc(16))).toThrow();
  });

  it('unwrap rejects garbage input', () => {
    expect(() => unwrapDEK('', Buffer.alloc(32))).toThrow();
    expect(() => unwrapDEK('!!!notbase64tagtooshort', Buffer.alloc(32))).toThrow();
  });

  it('two wraps of the same dek produce different ciphertexts (random IV)', async () => {
    const dek = generateDEK();
    const kek = await deriveKEK('p', generateSalt(), FAST_KDF);
    expect(wrapDEK(dek, kek)).not.toBe(wrapDEK(dek, kek));
  });
});

describe('encryptFileContent / decryptFileContent', () => {
  it('round-trips UTF-8 content', () => {
    const dek = generateDEK();
    const text = 'Hello \\textbf{world} — café, 日本語, 😀';
    const blob = encryptFileContent(text, dek);
    expect(decryptFileContent(blob, dek)).toBe(text);
  });

  it('round-trips empty content', () => {
    const dek = generateDEK();
    expect(decryptFileContent(encryptFileContent('', dek), dek)).toBe('');
  });

  it('produces base64 (storable in a TEXT column)', () => {
    const dek = generateDEK();
    const blob = encryptFileContent('x', dek);
    expect(blob).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('ciphertext differs from plaintext and across calls (random IV)', () => {
    const dek = generateDEK();
    const a = encryptFileContent('same input', dek);
    const b = encryptFileContent('same input', dek);
    expect(a).not.toContain('same input');
    expect(a).not.toBe(b);
  });

  it('decrypt with a WRONG dek throws', () => {
    const blob = encryptFileContent('secret', generateDEK());
    expect(() => decryptFileContent(blob, generateDEK())).toThrow();
  });

  it('decrypt throws on tampered ciphertext (GCM integrity)', () => {
    const dek = generateDEK();
    const blob = encryptFileContent('secret', dek);
    // Flip a byte in the middle of the base64 → corrupt ciphertext.
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] ^= 0xff; // corrupt the auth tag
    expect(() => decryptFileContent(buf.toString('base64'), dek)).toThrow();
  });

  it('rejects non-string inputs', () => {
    const dek = generateDEK();
    expect(() => encryptFileContent(/** @type {any} */ (123), dek)).toThrow();
    expect(() => decryptFileContent(/** @type {any} */ (123), dek)).toThrow();
  });
});

describe('end-to-end: enable-encryption flow simulation', () => {
  it('passphrase + recovery both unlock the DEK that decrypts a file', async () => {
    // Simulate what Phase 2/3 will do at "enable encryption":
    const dek = generateDEK();
    const salt = generateSalt();
    const passphrase = 'correct horse battery staple';
    const recovery = generateRecoveryCode();

    const passKek = await deriveKEK(passphrase, salt, FAST_KDF);
    const recKek = await deriveKEK(normalizeRecoveryCode(recovery), salt, FAST_KDF);
    const wrappedByPass = wrapDEK(dek, passKek);
    const wrappedByRecovery = wrapDEK(dek, recKek);

    const encrypted = encryptFileContent('\\documentclass{article}', dek);

    // Later: unlock via passphrase.
    const dekFromPass = unwrapDEK(wrappedByPass, await deriveKEK(passphrase, salt, FAST_KDF));
    expect(decryptFileContent(encrypted, dekFromPass)).toBe('\\documentclass{article}');

    // Or unlock via recovery code (user lost passphrase).
    const dekFromRec = unwrapDEK(wrappedByRecovery, await deriveKEK(normalizeRecoveryCode(recovery), salt, FAST_KDF));
    expect(decryptFileContent(encrypted, dekFromRec)).toBe('\\documentclass{article}');
  });
});

// Each validation guard is two clauses joined by `||`. Test each clause
// in isolation so a mutant that drops one (or flips the comparison)
// can't hide behind the other still firing. These pin the
// security-relevant guards: a too-short key or ciphertext must always
// be rejected.
describe('input-validation guards (per-clause)', () => {
  const KEK = () => Buffer.alloc(32, 1);

  it('deriveKEK: rejects non-string secret AND empty-string secret distinctly', async () => {
    await expect(deriveKEK(/** @type {any} */ (123), generateSalt(), FAST_KDF)).rejects.toThrow();
    await expect(deriveKEK('', generateSalt(), FAST_KDF)).rejects.toThrow();
  });

  it('deriveKEK: rejects non-buffer salt AND empty-buffer salt distinctly', async () => {
    await expect(deriveKEK('x', /** @type {any} */ ('notbuf'), FAST_KDF)).rejects.toThrow();
    await expect(deriveKEK('x', Buffer.alloc(0), FAST_KDF)).rejects.toThrow();
  });

  it('wrapDEK: rejects non-buffer dek AND wrong-length dek distinctly', () => {
    expect(() => wrapDEK(/** @type {any} */ ('notbuf'), KEK())).toThrow();
    expect(() => wrapDEK(Buffer.alloc(31), KEK())).toThrow();
    expect(() => wrapDEK(Buffer.alloc(33), KEK())).toThrow();
  });

  it('wrapDEK: rejects non-buffer kek AND wrong-length kek distinctly', () => {
    expect(() => wrapDEK(generateDEK(), /** @type {any} */ ('notbuf'))).toThrow();
    expect(() => wrapDEK(generateDEK(), Buffer.alloc(31))).toThrow();
  });

  it('unwrapDEK: rejects non-string wrapped AND empty-string wrapped distinctly', () => {
    expect(() => unwrapDEK(/** @type {any} */ (123), KEK())).toThrow();
    expect(() => unwrapDEK('', KEK())).toThrow();
  });

  it('gcmDecrypt path: a ciphertext shorter than IV+tag is rejected (too short)', () => {
    // 27 bytes < 12 (IV) + 16 (tag) = 28 minimum. Must throw, not
    // read out of bounds.
    const tooShort = Buffer.alloc(27).toString('base64');
    expect(() => unwrapDEK(tooShort, KEK())).toThrow();
    expect(() => decryptFileContent(tooShort, KEK())).toThrow();
  });

  it('gcmDecrypt path: exactly IV+tag with empty ciphertext still validates the tag', () => {
    // 28 bytes (12 IV + 16 tag, zero ciphertext) is length-valid but
    // the tag won't verify under a random key → throws.
    const minLen = Buffer.alloc(28).toString('base64');
    expect(() => unwrapDEK(minLen, KEK())).toThrow();
  });

  it('buffersEqual: false on non-buffer args AND on length mismatch distinctly', () => {
    expect(buffersEqual(/** @type {any} */ ('a'), Buffer.alloc(1))).toBe(false);
    expect(buffersEqual(Buffer.alloc(1), /** @type {any} */ ('b'))).toBe(false);
    expect(buffersEqual(Buffer.alloc(1), Buffer.alloc(2))).toBe(false);
    expect(buffersEqual(Buffer.from([5]), Buffer.from([5]))).toBe(true);
  });
});
