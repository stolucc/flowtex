// Integration: per-project encryption end-to-end against real PG.
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { seedUser, seedProject, seedFile } from './setup.js';
import * as enc from '../../services/encryptionService.js';
import { getProjectFiles, updateFileContent } from '../../services/projectService.js';
import { isProjectUnlocked, clearAllProjectKeys, lockProject } from '../../services/projectKeyCache.js';
import { ProjectLockedError } from '../../services/projectContentCrypto.js';

let owner, project;

beforeEach(async () => {
  clearAllProjectKeys();
  owner = await seedUser();
  project = await seedProject(owner.id);
});

describe('enableEncryption', () => {
  it('encrypts existing file content at rest and returns a recovery code', async () => {
    const file = await seedFile(project.id, 'main.tex', '\\documentclass{article}');
    const { recoveryCode } = await enc.enableEncryption(project.id, 'correct horse battery');

    // Fixed-length ({4}, {7}), hyphen-anchored — no backtracking (false positive).
    // eslint-disable-next-line security/detect-unsafe-regex
    expect(recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);

    // Raw DB row is now ciphertext, not the plaintext.
    const raw = await db.get('SELECT content FROM files WHERE id = $1', [file.id]);
    expect(raw.content).not.toContain('documentclass');
    expect(raw.content).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64

    // projects.encrypted flag set.
    const p = await db.get('SELECT encrypted, encryption_meta FROM projects WHERE id = $1', [project.id]);
    expect(p.encrypted).toBe(true);
    expect(p.encryption_meta.wrappedDekPassphrase).toBeTruthy();
    expect(p.encryption_meta.wrappedDekRecovery).toBeTruthy();
  });

  it('auto-unlocks for the enabling session (getProjectFiles returns plaintext)', async () => {
    await seedFile(project.id, 'main.tex', 'hello world');
    await enc.enableEncryption(project.id, 'passphrase123');
    expect(isProjectUnlocked(project.id)).toBe(true);
    const files = await getProjectFiles(project.id);
    expect(files.find((f) => f.path === 'main.tex').content).toBe('hello world');
  });

  it('refuses to double-encrypt', async () => {
    await enc.enableEncryption(project.id, 'passphrase123');
    await expect(enc.enableEncryption(project.id, 'passphrase123')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a too-short passphrase', async () => {
    await expect(enc.enableEncryption(project.id, 'short')).rejects.toMatchObject({ status: 400 });
  });
});

describe('lock / unlock', () => {
  it('locked project: getProjectFiles throws 423', async () => {
    await seedFile(project.id, 'main.tex', 'secret');
    await enc.enableEncryption(project.id, 'passphrase123');
    // Drop the auto-unlock from enable.
    lockProject(project.id);
    expect(isProjectUnlocked(project.id)).toBe(false);
    await expect(getProjectFiles(project.id)).rejects.toBeInstanceOf(ProjectLockedError);
  });

  it('unlock with correct passphrase restores reads', async () => {
    await seedFile(project.id, 'main.tex', 'secret body');
    await enc.enableEncryption(project.id, 'passphrase123');
    lockProject(project.id);

    const r = await enc.unlockWithSecret(project.id, 'passphrase123');
    expect(r.ok).toBe(true);
    const files = await getProjectFiles(project.id);
    expect(files.find((f) => f.path === 'main.tex').content).toBe('secret body');
  });

  it('unlock with the recovery code works (viaRecovery=true)', async () => {
    await seedFile(project.id, 'main.tex', 'recover me');
    const { recoveryCode } = await enc.enableEncryption(project.id, 'passphrase123');
    lockProject(project.id);

    const r = await enc.unlockWithSecret(project.id, recoveryCode);
    expect(r.ok).toBe(true);
    expect(r.viaRecovery).toBe(true);
    const files = await getProjectFiles(project.id);
    expect(files.find((f) => f.path === 'main.tex').content).toBe('recover me');
  });

  it('unlock with a wrong secret fails', async () => {
    await enc.enableEncryption(project.id, 'passphrase123');
    lockProject(project.id);
    const r = await enc.unlockWithSecret(project.id, 'wrong passphrase');
    expect(r.ok).toBe(false);
    expect(isProjectUnlocked(project.id)).toBe(false);
  });
});

describe('saveFile under encryption', () => {
  it('a save while unlocked stores ciphertext and reads back as plaintext', async () => {
    const file = await seedFile(project.id, 'main.tex', 'original');
    await enc.enableEncryption(project.id, 'passphrase123');

    await updateFileContent(file.id, 'edited content', owner.id, undefined, undefined);

    const raw = await db.get('SELECT content FROM files WHERE id = $1', [file.id]);
    expect(raw.content).not.toContain('edited content');

    const files = await getProjectFiles(project.id);
    expect(files.find((f) => f.path === 'main.tex').content).toBe('edited content');
  });

  it('a save while locked throws 423 (no plaintext written)', async () => {
    const file = await seedFile(project.id, 'main.tex', 'original');
    await enc.enableEncryption(project.id, 'passphrase123');
    lockProject(project.id);
    await expect(
      updateFileContent(file.id, 'should not persist', owner.id, undefined, undefined),
    ).rejects.toBeInstanceOf(ProjectLockedError);
  });
});

describe('rotatePassphrase', () => {
  it('rotates to a new passphrase + new recovery code; old passphrase stops working', async () => {
    await seedFile(project.id, 'main.tex', 'rotate test');
    await enc.enableEncryption(project.id, 'oldpassphrase1');

    const { recoveryCode: newRecovery } = await enc.rotatePassphrase(project.id, 'oldpassphrase1', 'newpassphrase1');
    expect(newRecovery).toBeTruthy();

    clearAllProjectKeys();
    // Old passphrase no longer unlocks.
    expect((await enc.unlockWithSecret(project.id, 'oldpassphrase1')).ok).toBe(false);
    // New passphrase does.
    expect((await enc.unlockWithSecret(project.id, 'newpassphrase1')).ok).toBe(true);

    clearAllProjectKeys();
    // New recovery code does too.
    expect((await enc.unlockWithSecret(project.id, newRecovery)).ok).toBe(true);
  });

  it('rejects rotation with a wrong current secret', async () => {
    await enc.enableEncryption(project.id, 'oldpassphrase1');
    await expect(enc.rotatePassphrase(project.id, 'wrongpass', 'newpassphrase1')).rejects.toMatchObject({ status: 401 });
  });
});
