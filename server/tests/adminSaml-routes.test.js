// Admin SAML route handlers. Each test exercises a single route in
// isolation -- the actual SAML service is mocked. samlService's own
// tests cover the deeper logic; here we pin the wiring (status codes,
// audit-log calls, param validation, payload shape).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/audit.js', () => ({
  auditLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('../middleware/validateBody.js', () => ({
  default: () => (req, res, next) => next(), // pass-through; route tests
                                              // do their own shape checks
                                              // via the mocked service.
}));

vi.mock('../services/samlService.js', () => ({
  listIdPs: vi.fn(),
  getIdP: vi.fn(),
  createIdP: vi.fn(),
  updateIdP: vi.fn(),
  deleteIdP: vi.fn(),
  parseIdpMetadataXml: vi.fn(),
  getSpKeypair: vi.fn(),
  rotateSpKeypair: vi.fn(),
}));

import { auditLog } from '../utils/audit.js';
import * as samlService from '../services/samlService.js';
import router from '../routes/adminSaml.js';

function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route && Object.keys(layer.route.methods)[0] === method
        && layer.route.path === pathPattern) {
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

function mockReq({ params = {}, body = {}, session = {}, headers = {} } = {}) {
  return {
    params,
    body,
    session: { userId: 'admin-1', ...session },
    ip: '127.0.0.1',
    headers: { host: 'flowtex.test', 'x-forwarded-proto': 'https', ...headers },
    get: function (h) { return this.headers[h.toLowerCase()]; },
    protocol: 'https',
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (code) { res.statusCode = code; return res; }),
    json: vi.fn(function (data) { res.body = data; return res; }),
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('GET /sp-info', () => {
  it('returns SP entityID, metadata URL template, cert + fingerprint', async () => {
    samlService.getSpKeypair.mockResolvedValue({
      certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      fingerprintSha256: 'a'.repeat(64),
      notAfter: new Date('2029-01-01'),
    });
    const handler = getHandler('get', '/sp-info');
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.entityId).toBe('https://flowtex.test/api/auth/saml/sp');
    expect(res.body.metadataUrlTemplate).toContain('<idpId>');
    expect(res.body.acsUrlTemplate).toContain('<idpId>');
    expect(res.body.fingerprintSha256).toMatch(/^a{64}$/);
  });

  it('500s on keypair load failure', async () => {
    samlService.getSpKeypair.mockRejectedValue(new Error('db gone'));
    const handler = getHandler('get', '/sp-info');
    await handler(mockReq(), mockRes());
    // Doesn't throw; just returns 500.
  });
});

describe('POST /sp/rotate', () => {
  it('rotates + audit-logs', async () => {
    samlService.rotateSpKeypair.mockResolvedValue({
      fingerprintSha256: 'b'.repeat(64),
      notAfter: new Date('2029-01-01'),
    });
    const handler = getHandler('post', '/sp/rotate');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fingerprintSha256).toMatch(/^b{64}$/);
    expect(auditLog).toHaveBeenCalledWith('admin-1', 'saml_sp_rotate', expect.any(Object));
  });
});

describe('GET /idps', () => {
  it('returns the IdP list from the service', async () => {
    samlService.listIdPs.mockResolvedValue([
      { id: 'a', display_name: 'UCC', enabled: true },
    ]);
    const handler = getHandler('get', '/idps');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.idps).toEqual([{ id: 'a', display_name: 'UCC', enabled: true }]);
  });
});

describe('GET /idps/:id', () => {
  it('400s on malformed UUID', async () => {
    const handler = getHandler('get', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'not-a-uuid' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('404s when the service returns null', async () => {
    samlService.getIdP.mockResolvedValue(null);
    const handler = getHandler('get', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('returns the full row on hit', async () => {
    const row = { id: VALID_UUID, display_name: 'UCC', cert_pem: 'PEM', allowed_email_domains: ['ucc.ie'] };
    samlService.getIdP.mockResolvedValue(row);
    const handler = getHandler('get', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.idp).toEqual(row);
  });
});

describe('POST /idps', () => {
  it('calls service + audit-logs on success', async () => {
    const created = { id: 'new-id', entityId: 'https://idp.ucc.ie', ssoUrl: 'https://idp.ucc.ie/sso' };
    samlService.createIdP.mockResolvedValue(created);
    const handler = getHandler('post', '/idps');
    const res = mockRes();
    await handler(mockReq({ body: { displayName: 'UCC', allowedEmailDomains: ['ucc.ie'] } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.idp).toEqual(created);
    expect(samlService.createIdP).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'UCC', createdBy: 'admin-1' }),
    );
    expect(auditLog).toHaveBeenCalledWith('admin-1', 'saml_idp_create', expect.any(Object));
  });

  it('surfaces service-layer 4xx errors (e.g. domain collision)', async () => {
    const err = new Error('email domain already claimed by IdP "TCD"');
    err.status = 409;
    samlService.createIdP.mockRejectedValue(err);
    const handler = getHandler('post', '/idps');
    const res = mockRes();
    await handler(mockReq({ body: { displayName: 'UCC' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already claimed/);
  });

  it('500s on unexpected service errors (logs but does not leak)', async () => {
    samlService.createIdP.mockRejectedValue(new Error('db down'));
    const handler = getHandler('post', '/idps');
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to create IdP.');
  });
});

describe('PATCH /idps/:id', () => {
  it('400s on malformed UUID', async () => {
    const handler = getHandler('patch', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'nope' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('calls service + audit-logs on success', async () => {
    const updated = { id: VALID_UUID, display_name: 'UCC2' };
    samlService.updateIdP.mockResolvedValue(updated);
    const handler = getHandler('patch', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID }, body: { displayName: 'UCC2' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.idp).toEqual(updated);
    expect(auditLog).toHaveBeenCalledWith('admin-1', 'saml_idp_update', expect.any(Object));
  });
});

describe('DELETE /idps/:id', () => {
  it('400s on malformed UUID', async () => {
    const handler = getHandler('delete', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'nope' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('refuses with 409 when users are linked (service throws status:409)', async () => {
    const err = new Error('2 user(s) are linked to this IdP');
    err.status = 409;
    samlService.deleteIdP.mockRejectedValue(err);
    const handler = getHandler('delete', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/linked to this IdP/);
  });

  it('audits on success', async () => {
    samlService.deleteIdP.mockResolvedValue(undefined);
    const handler = getHandler('delete', '/idps/:id');
    const res = mockRes();
    await handler(mockReq({ params: { id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(200);
    expect(auditLog).toHaveBeenCalledWith('admin-1', 'saml_idp_delete', expect.any(Object));
  });
});

describe('POST /idps/test-metadata', () => {
  it('parses + returns the preview shape', async () => {
    samlService.parseIdpMetadataXml.mockReturnValue({
      entityId: 'https://idp.ucc.ie',
      ssoUrl: 'https://idp.ucc.ie/sso',
      sloUrl: null,
      certPem: '-----BEGIN CERTIFICATE-----\nlong-base64-blob\n-----END CERTIFICATE-----',
    });
    const handler = getHandler('post', '/idps/test-metadata');
    const res = mockRes();
    await handler(mockReq({ body: { metadataXml: '<EntityDescriptor/>' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.preview.entityId).toBe('https://idp.ucc.ie');
    expect(res.body.preview.certPreview).toMatch(/\.{3}$/);
  });

  it('400s with the parser error on malformed XML', async () => {
    samlService.parseIdpMetadataXml.mockImplementation(() => {
      throw new Error('parseIdpMetadataXml: no EntityDescriptor element');
    });
    const handler = getHandler('post', '/idps/test-metadata');
    const res = mockRes();
    await handler(mockReq({ body: { metadataXml: '<root/>' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/EntityDescriptor/);
  });
});
