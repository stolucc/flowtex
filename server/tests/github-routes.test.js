import { describe, it, expect, vi, beforeEach } from 'vitest';

// A1 regression cover: when the commenter role landed, five github.js
// routes were still only rejecting viewer. A commenter could push the
// project's files to GitHub (exfiltration!), pull (overwrite file
// content), link/unlink a repo, or change auto-push settings. The fix
// extends each `role === 'viewer'` check to also reject 'commenter';
// these tests pin that posture per route.

vi.mock('../middleware/auth.js', () => ({
  requireMember: vi.fn(),
  UUID_RE: /^[0-9a-fA-F-]{36}$/,
}));

vi.mock('../services/githubService.js', () => ({
  linkProject: vi.fn(),
  getProjectLink: vi.fn(),
  unlinkProject: vi.fn(),
  updateAutoPush: vi.fn(),
  pushProject: vi.fn(),
  pullProject: vi.fn(),
  fetchUserRepos: vi.fn(),
  createRepo: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { requireMember } from '../middleware/auth.js';
import * as gh from '../services/githubService.js';
import router from '../routes/github.js';

function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        return layer.route.stack[layer.route.stack.length - 1].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

function mockReq(params = {}, body = {}, session = {}) {
  return {
    params,
    body,
    ip: '127.0.0.1',
    session: { userId: 'user-1', ...session },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (c) { res.statusCode = c; return res; }),
    json: vi.fn(function (d) { res.body = d; return res; }),
  };
  return res;
}

const COMMENTER = { role: 'commenter' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('A1 — commenter rejection on github routes', () => {
  it('PUT /link/:projectId rejects commenter (link repo)', async () => {
    requireMember.mockResolvedValueOnce(COMMENTER);
    const handler = getHandler('put', '/link/:projectId');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { repo: 'owner/repo' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toMatch(/only editors/i);
    expect(gh.linkProject).not.toHaveBeenCalled();
  });

  it('PATCH /link/:projectId/auto-push rejects commenter', async () => {
    requireMember.mockResolvedValueOnce(COMMENTER);
    const handler = getHandler('patch', '/link/:projectId/auto-push');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { enabled: true }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(gh.updateAutoPush).not.toHaveBeenCalled();
  });

  it('DELETE /link/:projectId rejects commenter (unlink repo)', async () => {
    requireMember.mockResolvedValueOnce(COMMENTER);
    const handler = getHandler('delete', '/link/:projectId');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(gh.unlinkProject).not.toHaveBeenCalled();
  });

  it('POST /push/:projectId rejects commenter (would exfiltrate files)', async () => {
    requireMember.mockResolvedValueOnce(COMMENTER);
    const handler = getHandler('post', '/push/:projectId');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { message: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toMatch(/only editors/i);
    expect(gh.pushProject).not.toHaveBeenCalled();
  });

  it('POST /pull/:projectId rejects commenter (would overwrite files)', async () => {
    requireMember.mockResolvedValueOnce(COMMENTER);
    const handler = getHandler('post', '/pull/:projectId');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(gh.pullProject).not.toHaveBeenCalled();
  });

  // Negative control: viewers were rejected before; verify the new
  // check didn't accidentally let them through.
  it('still rejects viewers on push (negative control)', async () => {
    requireMember.mockResolvedValueOnce({ role: 'viewer' });
    const handler = getHandler('post', '/push/:projectId');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { message: 'hi' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(gh.pushProject).not.toHaveBeenCalled();
  });

  // Positive control: editors still go through.
  it('allows editors on push (positive control)', async () => {
    requireMember.mockResolvedValueOnce({ role: 'editor' });
    gh.pushProject.mockResolvedValueOnce({ commit: 'abc123' });
    const handler = getHandler('post', '/push/:projectId');

    const res = mockRes();
    await handler(mockReq({ projectId: 'proj-1' }, { message: 'hi' }), res);

    expect(gh.pushProject).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, commit: 'abc123' });
  });
});
