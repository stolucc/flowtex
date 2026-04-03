import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Stub browser globals needed by api.js (runs in vitest's Node environment)
if (typeof document === 'undefined') {
  vi.stubGlobal('document', { cookie: '' });
}
if (typeof window === 'undefined') {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
}
if (typeof Event === 'undefined') {
  vi.stubGlobal(
    'Event',
    class Event {
      constructor(type) {
        this.type = type;
      }
    },
  );
}

let getCsrfToken, get, post, put, patch, del;

beforeAll(async () => {
  const mod = await import('../../api.js');
  getCsrfToken = mod.getCsrfToken;
  get = mod.get;
  post = mod.post;
  put = mod.put;
  patch = mod.patch;
  del = mod.del;
});

describe('getCsrfToken', () => {
  afterEach(() => {
    // Expire all cookies (document.cookie setter is append-only in browsers/happy-dom)
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0].trim();
      if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    });
  });

  it('extracts CSRF token from cookie', () => {
    document.cookie = 'csrf-token=abc123; other=val';
    expect(getCsrfToken()).toBe('abc123');
  });

  it('extracts token when csrf-token is the only cookie', () => {
    document.cookie = 'csrf-token=xyz';
    expect(getCsrfToken()).toBe('xyz');
  });

  it('returns empty string when no csrf-token cookie', () => {
    document.cookie = 'session=abc; other=val';
    expect(getCsrfToken()).toBe('');
  });

  it('returns empty string for empty cookie', () => {
    document.cookie = '';
    expect(getCsrfToken()).toBe('');
  });
});

describe('API request functions', () => {
  let fetchSpy;
  let dispatchSpy;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    dispatchSpy = vi.fn();
    window.dispatchEvent = dispatchSpy;
    document.cookie = 'csrf-token=test-token-123';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.cookie = '';
  });

  // ── GET ──

  describe('get', () => {
    it('calls fetch with correct path', async () => {
      await get('/api/projects');
      expect(fetchSpy).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ credentials: 'include' }));
    });

    it('uses GET method by default (no explicit method set)', async () => {
      await get('/api/projects');
      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.method).toBeUndefined();
    });

    it('does NOT include CSRF token for GET requests', async () => {
      await get('/api/projects');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['X-CSRF-Token']).toBeUndefined();
    });

    it('sets Content-Type to application/json', async () => {
      await get('/api/projects');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  // ── POST ──

  describe('post', () => {
    it('sends POST with JSON body', async () => {
      await post('/api/projects', { name: 'test' });
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/projects');
      expect(opts.method).toBe('POST');
      expect(opts.body).toBe(JSON.stringify({ name: 'test' }));
    });

    it('includes CSRF token', async () => {
      await post('/api/projects', { name: 'test' });
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['X-CSRF-Token']).toBe('test-token-123');
    });

    it('handles undefined body (no body key)', async () => {
      await post('/api/projects');
      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.body).toBeUndefined();
    });

    it('handles empty object body', async () => {
      await post('/api/projects', {});
      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.body).toBe('{}');
    });
  });

  // ── PUT ──

  describe('put', () => {
    it('sends PUT with JSON body', async () => {
      await put('/api/projects/1', { name: 'updated' });
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/projects/1');
      expect(opts.method).toBe('PUT');
      expect(opts.body).toBe(JSON.stringify({ name: 'updated' }));
    });

    it('includes CSRF token', async () => {
      await put('/api/projects/1', {});
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['X-CSRF-Token']).toBe('test-token-123');
    });
  });

  // ── PATCH ──

  describe('patch', () => {
    it('sends PATCH with JSON body', async () => {
      await patch('/api/projects/1', { name: 'patched' });
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/projects/1');
      expect(opts.method).toBe('PATCH');
      expect(opts.body).toBe(JSON.stringify({ name: 'patched' }));
    });

    it('includes CSRF token', async () => {
      await patch('/api/projects/1', {});
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['X-CSRF-Token']).toBe('test-token-123');
    });
  });

  // ── DELETE ──

  describe('del', () => {
    it('sends DELETE request', async () => {
      await del('/api/projects/1');
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/projects/1');
      expect(opts.method).toBe('DELETE');
    });

    it('includes CSRF token', async () => {
      await del('/api/projects/1');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['X-CSRF-Token']).toBe('test-token-123');
    });
  });

  // ── 401 Handling ──

  describe('401 handling', () => {
    it('dispatches auth:expired event on 401 for non-auth paths', async () => {
      fetchSpy.mockResolvedValue({ status: 401, ok: false });
      await expect(get('/api/projects')).rejects.toThrow('Not authenticated');
      expect(dispatchSpy).toHaveBeenCalled();
      const event = dispatchSpy.mock.calls[0][0];
      expect(event.type).toBe('auth:expired');
    });

    it('does NOT dispatch auth:expired for /api/auth/ paths', async () => {
      fetchSpy.mockResolvedValue({ status: 401, ok: false });
      const res = await get('/api/auth/session');
      expect(res.status).toBe(401);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('throws "Not authenticated" error on 401', async () => {
      fetchSpy.mockResolvedValue({ status: 401, ok: false });
      await expect(post('/api/data', {})).rejects.toThrow('Not authenticated');
    });
  });

  // ── Non-401 Error Responses ──

  describe('non-401 error responses', () => {
    it('returns the response for 404 without throwing', async () => {
      fetchSpy.mockResolvedValue({ status: 404, ok: false });
      const res = await get('/api/projects/999');
      expect(res.status).toBe(404);
    });

    it('returns the response for 500 without throwing', async () => {
      fetchSpy.mockResolvedValue({ status: 500, ok: false });
      const res = await get('/api/projects');
      expect(res.status).toBe(500);
    });
  });

  // ── Credentials ──

  describe('credentials', () => {
    it('always includes credentials: include', async () => {
      await get('/api/test');
      expect(fetchSpy.mock.calls[0][1].credentials).toBe('include');

      await post('/api/test', {});
      expect(fetchSpy.mock.calls[1][1].credentials).toBe('include');

      await del('/api/test');
      expect(fetchSpy.mock.calls[2][1].credentials).toBe('include');
    });
  });
});
