import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt, _setSaltForTesting } from '../utils/crypto.js';

describe('encrypt / decrypt', () => {
  beforeAll(() => {
    _setSaltForTesting('test-salt-for-unit-tests');
  });
  it('round-trips a string', () => {
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

  it('handles unicode', () => {
    const unicode = 'héllo wörld 日本語';
    expect(decrypt(encrypt(unicode))).toBe(unicode);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encrypt('test');
    const tampered = encrypted.slice(0, -2) + 'ff';
    expect(() => decrypt(tampered)).toThrow();
  });
});
