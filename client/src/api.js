const BASE = '';

export function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/);
  return match ? match[1] : '';
}

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

export async function get(path) {
  return request(path);
}

export async function post(path, body) {
  return request(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
}

export async function put(path, body) {
  return request(path, { method: 'PUT', body: JSON.stringify(body) });
}

export async function patch(path, body) {
  return request(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function del(path) {
  return request(path, { method: 'DELETE' });
}
