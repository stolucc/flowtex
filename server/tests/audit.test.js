import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { run: vi.fn() },
}));

vi.mock('../logger.js', () => ({
  default: { error: vi.fn() },
}));

import db from '../db.js';
import logger from '../logger.js';
import { auditLog } from '../utils/audit.js';

describe('auditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a row with all six positional parameters in order', async () => {
    await auditLog('user-1', 'login', {
      targetType: 'session',
      targetId: 'sess-1',
      detail: 'first login',
      ip: '10.0.0.1',
    });
    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('user_id, action, target_type, target_id, detail, ip');
    expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, $6)');
    expect(params).toEqual(['user-1', 'login', 'session', 'sess-1', 'first login', '10.0.0.1']);
  });

  it('accepts a missing options object and inserts NULLs for all optional fields', async () => {
    await auditLog('user-2', 'logout');
    expect(db.run).toHaveBeenCalledWith(expect.any(String), [
      'user-2', 'logout', null, null, null, null,
    ]);
  });

  it('coerces a null userId to NULL (not undefined)', async () => {
    await auditLog(null, 'system_event');
    const [, params] = db.run.mock.calls[0];
    expect(params[0]).toBeNull();
  });

  it('coerces undefined userId to NULL', async () => {
    await auditLog(undefined, 'system_event');
    const [, params] = db.run.mock.calls[0];
    expect(params[0]).toBeNull();
  });

  it('preserves a non-empty userId verbatim', async () => {
    await auditLog('actual-id', 'login');
    expect(db.run.mock.calls[0][1][0]).toBe('actual-id');
  });

  it('preserves the action string verbatim', async () => {
    await auditLog('u', 'project_delete');
    expect(db.run.mock.calls[0][1][1]).toBe('project_delete');
  });

  it('coerces falsy targetType, targetId, detail, ip to NULL', async () => {
    await auditLog('u', 'a', { targetType: '', targetId: '', detail: '', ip: '' });
    const [, params] = db.run.mock.calls[0];
    expect(params.slice(2)).toEqual([null, null, null, null]);
  });

  it('preserves truthy targetType, targetId, detail, ip values', async () => {
    await auditLog('u', 'a', {
      targetType: 'project',
      targetId: 'p1',
      detail: 'd1',
      ip: '1.1.1.1',
    });
    expect(db.run.mock.calls[0][1].slice(2)).toEqual(['project', 'p1', 'd1', '1.1.1.1']);
  });

  it('does not throw when the database call rejects — logs and swallows', async () => {
    const dbErr = new Error('connection lost');
    db.run.mockRejectedValueOnce(dbErr);
    await expect(auditLog('u', 'a')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith({ err: dbErr }, 'Audit log error');
  });

  it('does not invoke logger.error on a successful insert', async () => {
    db.run.mockResolvedValueOnce(undefined);
    await auditLog('u', 'a');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
