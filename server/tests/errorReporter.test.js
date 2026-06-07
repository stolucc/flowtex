import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerErrorReporter,
  captureException,
  setUserContext,
  setTag,
  isErrorReporterRegistered,
  errorReporterMiddleware,
  _clearErrorReporter,
} from '../services/errorReporter.js';
import logger from '../logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  _clearErrorReporter();
});

describe('errorReporter default (no-op)', () => {
  it('reports as not registered before any registration', () => {
    expect(isErrorReporterRegistered()).toBe(false);
  });

  it('captureException is a silent NOP when no implementation is registered', () => {
    expect(() => captureException(new Error('boom'))).not.toThrow();
  });

  it('setUserContext and setTag are silent NOPs', () => {
    expect(() => setUserContext({ id: 'u1' })).not.toThrow();
    expect(() => setTag('flag', 'val')).not.toThrow();
  });
});

describe('errorReporter with a registered implementation', () => {
  it('forwards captureException with the supplied context', () => {
    const impl = {
      captureException: vi.fn(),
      setUserContext: vi.fn(),
      setTag: vi.fn(),
    };
    registerErrorReporter(impl);
    expect(isErrorReporterRegistered()).toBe(true);

    const err = new Error('hello');
    captureException(err, { url: '/api/projects', statusCode: 500 });
    expect(impl.captureException).toHaveBeenCalledWith(err, {
      url: '/api/projects',
      statusCode: 500,
    });
  });

  it('forwards setUserContext and setTag', () => {
    const impl = {
      captureException: vi.fn(),
      setUserContext: vi.fn(),
      setTag: vi.fn(),
    };
    registerErrorReporter(impl);
    setUserContext({ id: 'u1', email: '[redacted]' });
    setTag('release', 'a428b75');
    expect(impl.setUserContext).toHaveBeenCalledWith({ id: 'u1', email: '[redacted]' });
    expect(impl.setTag).toHaveBeenCalledWith('release', 'a428b75');
  });

  it('logs but swallows a throwing implementation -- never propagates', () => {
    const impl = {
      captureException: () => { throw new Error('reporter broke'); },
      setUserContext: () => { throw new Error('reporter broke'); },
      setTag: () => { throw new Error('reporter broke'); },
    };
    registerErrorReporter(impl);

    expect(() => captureException(new Error('app err'))).not.toThrow();
    expect(() => setUserContext({ id: 'u' })).not.toThrow();
    expect(() => setTag('a', 'b')).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('refuses invalid implementations and logs a warning', () => {
    registerErrorReporter(null);
    expect(isErrorReporterRegistered()).toBe(false);
    registerErrorReporter('not-an-object');
    expect(isErrorReporterRegistered()).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('errorReporterMiddleware', () => {
  it('calls captureException with request context then forwards via next', () => {
    const impl = {
      captureException: vi.fn(),
      setUserContext: vi.fn(),
      setTag: vi.fn(),
    };
    registerErrorReporter(impl);

    const err = new Error('boom');
    const req = {
      method: 'POST',
      originalUrl: '/api/projects/1/files',
      session: { userId: 'u1' },
    };
    const res = { statusCode: 500 };
    const next = vi.fn();

    errorReporterMiddleware(err, req, res, next);

    expect(impl.captureException).toHaveBeenCalledWith(err, {
      method: 'POST',
      url: '/api/projects/1/files',
      userId: 'u1',
      statusCode: 500,
    });
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not throw even if req/res are missing fields', () => {
    expect(() => errorReporterMiddleware(new Error('x'), {}, {}, () => {})).not.toThrow();
  });
});
