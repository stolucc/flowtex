import { describe, it, expect, beforeEach } from 'vitest';
import {
  unlockProject,
  lockProject,
  forceLockProject,
  getProjectDEK,
  isProjectUnlocked,
  refCount,
  clearAllProjectKeys,
} from '../services/projectKeyCache.js';

const DEK = () => Buffer.alloc(32, 7);
const DEK2 = () => Buffer.alloc(32, 9);

beforeEach(() => clearAllProjectKeys());

describe('unlockProject / getProjectDEK', () => {
  it('stores a DEK and reports unlocked', () => {
    expect(unlockProject('p1', DEK())).toBe(true);
    expect(isProjectUnlocked('p1')).toBe(true);
    expect(getProjectDEK('p1')?.equals(DEK())).toBe(true);
  });

  it('returns null DEK when locked', () => {
    expect(getProjectDEK('nope')).toBeNull();
    expect(isProjectUnlocked('nope')).toBe(false);
  });

  it('rejects a non-32-byte dek', () => {
    expect(unlockProject('p1', Buffer.alloc(16))).toBe(false);
    expect(isProjectUnlocked('p1')).toBe(false);
  });

  it('copies the caller buffer (later caller mutation does not corrupt cache)', () => {
    const buf = DEK();
    unlockProject('p1', buf);
    buf.fill(0); // caller zeroes its own copy
    expect(getProjectDEK('p1')?.equals(DEK())).toBe(true);
  });
});

describe('refcounting', () => {
  it('bumps refcount on repeat unlock of the same project+dek', () => {
    unlockProject('p1', DEK());
    unlockProject('p1', DEK());
    expect(refCount('p1')).toBe(2);
  });

  it('rejects a second unlock with a DIFFERENT dek (keeps original)', () => {
    unlockProject('p1', DEK());
    expect(unlockProject('p1', DEK2())).toBe(false);
    expect(refCount('p1')).toBe(1);
    expect(getProjectDEK('p1')?.equals(DEK())).toBe(true);
  });

  it('lock decrements; only the last lock drops the key', () => {
    unlockProject('p1', DEK());
    unlockProject('p1', DEK());
    expect(lockProject('p1')).toBe(false); // still 1 ref
    expect(isProjectUnlocked('p1')).toBe(true);
    expect(lockProject('p1')).toBe(true);  // last ref
    expect(isProjectUnlocked('p1')).toBe(false);
  });

  it('lock on an unknown project is a no-op returning true (already locked)', () => {
    expect(lockProject('ghost')).toBe(true);
  });
});

describe('forceLockProject', () => {
  it('drops the key regardless of refcount', () => {
    unlockProject('p1', DEK());
    unlockProject('p1', DEK());
    expect(refCount('p1')).toBe(2);
    forceLockProject('p1');
    expect(isProjectUnlocked('p1')).toBe(false);
    expect(refCount('p1')).toBe(0);
  });

  it('is safe on an unknown project', () => {
    expect(() => forceLockProject('ghost')).not.toThrow();
  });
});

describe('zero-on-drop', () => {
  it('zeroes the cached buffer when the last ref locks', () => {
    const buf = DEK();
    unlockProject('p1', buf);
    // The cache holds a COPY; grab a live reference to it.
    const live = getProjectDEK('p1');
    expect(live).not.toBeNull();
    lockProject('p1');
    // After drop, the buffer we held should be zeroed.
    expect(live?.every((b) => b === 0)).toBe(true);
  });
});

describe('clearAllProjectKeys', () => {
  it('drops every key', () => {
    unlockProject('a', DEK());
    unlockProject('b', DEK2());
    clearAllProjectKeys();
    expect(isProjectUnlocked('a')).toBe(false);
    expect(isProjectUnlocked('b')).toBe(false);
  });
});
