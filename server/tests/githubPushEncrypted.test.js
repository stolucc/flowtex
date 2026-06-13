import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy deps so importing githubService is cheap and the
// encrypted-refusal short-circuit is the only path exercised.
vi.mock('../db.js', () => ({ default: { get: vi.fn() } }));
vi.mock('../utils/crypto.js', () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock('../utils/gitSync.js', () => ({ pushToGitHub: vi.fn(), pullFromGitHub: vi.fn() }));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import db from '../db.js';
import { pushToGitHub } from '../utils/gitSync.js';
import { pushProject } from '../services/githubService.js';

beforeEach(() => vi.clearAllMocks());

describe('pushProject — encrypted-project refusal', () => {
  it('rejects with 409 when the project is encrypted (before any token/repo work)', async () => {
    db.get.mockResolvedValueOnce({ encrypted: true });
    await expect(pushProject('p1', 'u1', 'msg')).rejects.toMatchObject({ status: 409 });
    // Must short-circuit: never reaches the actual git push.
    expect(pushToGitHub).not.toHaveBeenCalled();
  });

  it('does not block a plaintext project at the encryption gate (falls through to token check)', async () => {
    // encrypted=false → passes the gate, then fails at the NEXT step
    // (no GitHub token) with status 400, proving the gate let it past.
    db.get.mockResolvedValueOnce({ encrypted: false }); // encryption check
    db.get.mockResolvedValue(undefined);                // getUserToken → none
    await expect(pushProject('p1', 'u1', 'msg')).rejects.toMatchObject({ status: 400 });
  });
});
