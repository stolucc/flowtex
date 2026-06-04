import { describe, it, expect } from 'vitest';
import { isReadOnlyForUser, getProjectRole } from '../projectRole.js';

describe('getProjectRole', () => {
  const ALICE = 'user-alice';

  it.each([['owner'], ['editor'], ['commenter'], ['viewer']])(
    'returns the %s role string',
    (role) => {
      expect(getProjectRole([{ id: ALICE, role }], ALICE)).toBe(role);
    },
  );

  it('returns null when members has not loaded', () => {
    expect(getProjectRole(null, ALICE)).toBe(null);
    expect(getProjectRole(undefined, ALICE)).toBe(null);
    expect(getProjectRole([], ALICE)).toBe(null);
  });

  it('returns null when userId is missing', () => {
    expect(getProjectRole([{ id: ALICE, role: 'owner' }], null)).toBe(null);
    expect(getProjectRole([{ id: ALICE, role: 'owner' }], undefined)).toBe(null);
    expect(getProjectRole([{ id: ALICE, role: 'owner' }], '')).toBe(null);
  });

  it('returns null when user is not in the members list', () => {
    expect(getProjectRole([{ id: 'someone', role: 'owner' }], ALICE)).toBe(null);
  });
});

describe('isReadOnlyForUser', () => {
  const ALICE = 'user-alice';

  it('owners can edit (returns false)', () => {
    expect(isReadOnlyForUser([{ id: ALICE, role: 'owner' }], ALICE)).toBe(false);
  });

  it('editors can edit (returns false)', () => {
    expect(isReadOnlyForUser([{ id: ALICE, role: 'editor' }], ALICE)).toBe(false);
  });

  it('commenters cannot edit (returns true)', () => {
    expect(isReadOnlyForUser([{ id: ALICE, role: 'commenter' }], ALICE)).toBe(true);
  });

  it('viewers cannot edit (returns true)', () => {
    expect(isReadOnlyForUser([{ id: ALICE, role: 'viewer' }], ALICE)).toBe(true);
  });

  it('returns false (editable) when membership has not loaded yet', () => {
    // Brief window during page load before /members responds. Better to
    // stay editable for a moment than to lock an owner out and confuse
    // them; server is the actual gate.
    expect(isReadOnlyForUser([], ALICE)).toBe(false);
    expect(isReadOnlyForUser(null, ALICE)).toBe(false);
    expect(isReadOnlyForUser(undefined, ALICE)).toBe(false);
  });

  it('returns false when userId is missing (auth not ready)', () => {
    expect(isReadOnlyForUser([{ id: ALICE, role: 'owner' }], null)).toBe(false);
    expect(isReadOnlyForUser([{ id: ALICE, role: 'owner' }], undefined)).toBe(false);
    expect(isReadOnlyForUser([{ id: ALICE, role: 'owner' }], '')).toBe(false);
  });

  it('returns false when the user is not in the members list', () => {
    // Shouldn't happen in practice (the project shouldn't have loaded
    // for them at all), but if it does, falling back to read-only could
    // leak "I am here but invisible"; treating as editable + letting the
    // server reject writes is the safe degraded mode.
    expect(isReadOnlyForUser([{ id: 'someone-else', role: 'owner' }], ALICE)).toBe(false);
  });

  it('an unknown future role is treated as read-only (fail closed)', () => {
    // If a "reviewer" role is ever added without updating this helper,
    // they should NOT silently become editors. The helper only returns
    // false for the two explicitly-allowed roles.
    expect(isReadOnlyForUser([{ id: ALICE, role: 'reviewer' }], ALICE)).toBe(true);
    expect(isReadOnlyForUser([{ id: ALICE, role: '' }], ALICE)).toBe(true);
  });
});
