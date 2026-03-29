import { describe, it, expect, vi } from 'vitest';

// Mock db before importing
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
  },
}));

import { requireAuth } from '../middleware/auth.js';

describe('requireAuth middleware', () => {
  it('returns 401 when no session userId', () => {
    const req = { session: {} };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when session is undefined', () => {
    const req = {};
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('calls next() when userId exists', () => {
    const req = { session: { userId: 'user-123' } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
