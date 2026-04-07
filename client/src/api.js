const BASE = '';

/** @returns {string} CSRF token from the cookie, or empty string. */
export function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/);
  return match ? match[1] : '';
}

/**
 * Internal fetch wrapper that attaches credentials, CSRF token, and handles 401.
 * @param {string} path - API path (appended to BASE)
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<Response>}
 */
async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  // Attach CSRF token to state-changing requests
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase())) {
    headers['X-CSRF-Token'] = getCsrfToken();
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event('auth:expired'));
    throw new Error('Not authenticated');
  }
  return res;
}

/** @param {string} path @returns {Promise<Response>} */
export async function get(path) {
  return request(path);
}

/** @param {string} path @param {*} [body] @returns {Promise<Response>} */
export async function post(path, body) {
  return request(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
}

/** @param {string} path @param {*} body @returns {Promise<Response>} */
export async function put(path, body) {
  return request(path, { method: 'PUT', body: JSON.stringify(body) });
}

/** @param {string} path @param {*} body @returns {Promise<Response>} */
export async function patch(path, body) {
  return request(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/** @param {string} path @returns {Promise<Response>} */
export async function del(path) {
  return request(path, { method: 'DELETE' });
}
