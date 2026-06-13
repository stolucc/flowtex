import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB so isProjectEncrypted is controllable.
vi.mock('../db.js', () => ({
  default: { get: vi.fn() },
}));

import db from '../db.js';
import {
  ProjectLockedError,
  isProjectEncrypted,
  getEncryptionContext,
  encryptContentForStorage,
  decryptRowsForRead,
  decryptContentForRead,
} from '../services/projectContentCrypto.js';
import {
  unlockProject,
  clearAllProjectKeys,
} from '../services/projectKeyCache.js';
import {
  generateDEK,
  encryptFileContent,
} from '../utils/projectCrypto.js';

beforeEach(() => {
  clearAllProjectKeys();
  vi.clearAllMocks();
});

/** @param {boolean} enc */
function mockEncrypted(enc) {
  db.get.mockResolvedValue({ encrypted: enc });
}

describe('isProjectEncrypted', () => {
  it('true when the column is set', async () => {
    mockEncrypted(true);
    expect(await isProjectEncrypted('p1')).toBe(true);
  });
  it('false when unset / missing row', async () => {
    db.get.mockResolvedValue(undefined);
    expect(await isProjectEncrypted('p1')).toBe(false);
  });
});

describe('getEncryptionContext', () => {
  it('plaintext project → { encrypted:false, dek:null }', async () => {
    mockEncrypted(false);
    expect(await getEncryptionContext('p1')).toEqual({ encrypted: false, dek: null });
  });

  it('encrypted + unlocked → returns the cached dek', async () => {
    mockEncrypted(true);
    const dek = generateDEK();
    unlockProject('p1', dek);
    const ctx = await getEncryptionContext('p1');
    expect(ctx.encrypted).toBe(true);
    expect(ctx.dek?.equals(dek)).toBe(true);
  });

  it('encrypted + locked → throws ProjectLockedError (status 423)', async () => {
    mockEncrypted(true);
    await expect(getEncryptionContext('p1')).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(getEncryptionContext('p1')).rejects.toMatchObject({ status: 423 });
  });
});

describe('encryptContentForStorage', () => {
  it('passes plaintext through for a plaintext project', async () => {
    mockEncrypted(false);
    expect(await encryptContentForStorage('p1', 'hello')).toBe('hello');
  });

  it('encrypts for an unlocked encrypted project (output != plaintext, round-trips)', async () => {
    mockEncrypted(true);
    const dek = generateDEK();
    unlockProject('p1', dek);
    const stored = await encryptContentForStorage('p1', '\\section{x}');
    expect(stored).not.toBe('\\section{x}');
    expect(stored).not.toContain('section');
    // round-trip with the same DEK
    const { decryptFileContent } = await import('../utils/projectCrypto.js');
    expect(decryptFileContent(stored, dek)).toBe('\\section{x}');
  });

  it('throws when encrypted but locked', async () => {
    mockEncrypted(true);
    await expect(encryptContentForStorage('p1', 'x')).rejects.toBeInstanceOf(ProjectLockedError);
  });
});

describe('decryptRowsForRead', () => {
  it('no-op for plaintext project', async () => {
    mockEncrypted(false);
    const rows = [{ content: 'plain', is_binary: false }];
    await decryptRowsForRead('p1', rows);
    expect(rows[0].content).toBe('plain');
  });

  it('decrypts text rows for an unlocked encrypted project', async () => {
    mockEncrypted(true);
    const dek = generateDEK();
    unlockProject('p1', dek);
    const rows = [
      { content: encryptFileContent('hello', dek), is_binary: false },
      { content: encryptFileContent('world', dek), is_binary: false },
    ];
    await decryptRowsForRead('p1', rows);
    expect(rows.map((r) => r.content)).toEqual(['hello', 'world']);
  });

  it('skips binary rows and empty content', async () => {
    mockEncrypted(true);
    const dek = generateDEK();
    unlockProject('p1', dek);
    const rows = [
      { content: null, is_binary: true },
      { content: '', is_binary: false },
      { content: encryptFileContent('real', dek), is_binary: false },
    ];
    await decryptRowsForRead('p1', rows);
    expect(rows[0].content).toBeNull();
    expect(rows[1].content).toBe('');
    expect(rows[2].content).toBe('real');
  });

  it('throws when encrypted but locked', async () => {
    mockEncrypted(true);
    await expect(decryptRowsForRead('p1', [{ content: 'x', is_binary: false }]))
      .rejects.toBeInstanceOf(ProjectLockedError);
  });
});

describe('decryptContentForRead', () => {
  it('returns empty/null content unchanged without touching the DB', async () => {
    expect(await decryptContentForRead('p1', '')).toBe('');
    expect(await decryptContentForRead('p1', null)).toBeNull();
    expect(db.get).not.toHaveBeenCalled();
  });

  it('passes through for plaintext project', async () => {
    mockEncrypted(false);
    expect(await decryptContentForRead('p1', 'hi')).toBe('hi');
  });

  it('decrypts for unlocked encrypted project', async () => {
    mockEncrypted(true);
    const dek = generateDEK();
    unlockProject('p1', dek);
    const blob = encryptFileContent('secret', dek);
    expect(await decryptContentForRead('p1', blob)).toBe('secret');
  });
});
