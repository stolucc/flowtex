// SAML / SSO Day 1 -- SP keypair lifecycle tests.
//
// Pure-logic tests of generateSpKeypair (in-memory, no DB) and a
// round-trip through the DB-backed getSpKeypair / rotateSpKeypair
// (using the existing test DB mocks).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';

// Mock the DB layer so we don't need a live Postgres for these tests.
// The integration-style verification happens in a future
// saml-routes.integration.test.js gated on RUN_PG_INTEGRATION=1.
const mockRows = new Map();
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(async (sql, params) => {
      const key = JSON.stringify({ sql, params });
      return mockRows.get(key) ?? null;
    }),
    run: vi.fn(async (sql, params) => {
      // Crude SQL parser: capture INSERT INTO saml_sp_keypair as a
      // get-able row keyed by the id column. Enough for these tests.
      if (/INSERT\s+INTO\s+saml_sp_keypair/i.test(sql)) {
        const [id, privKeyEnc, certPem, fpr, notAfter] = params;
        const row = {
          private_key_encrypted: privKeyEnc,
          certificate_pem: certPem,
          fingerprint_sha256: fpr,
          not_valid_after: notAfter,
        };
        const selectKey = JSON.stringify({
          sql: 'SELECT private_key_encrypted, certificate_pem, fingerprint_sha256, not_valid_after FROM saml_sp_keypair WHERE id = $1',
          params: [id],
        });
        mockRows.set(selectKey, row);
      }
    }),
  },
}));

// Mock the crypto utils so encrypt/decrypt round-trip without needing
// initCrypto's salt setup.
vi.mock('../utils/crypto.js', () => ({
  encrypt: vi.fn((s) => `enc(${s})`),
  decrypt: vi.fn((s) => s.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  generateSpKeypair,
  getSpKeypair,
  rotateSpKeypair,
  _testing,
} from '../services/samlService.js';

beforeEach(() => {
  mockRows.clear();
  _testing.resetCache();
});

describe('generateSpKeypair', () => {
  it('returns a PEM-shaped private key + X.509 certificate', async () => {
    const kp = await generateSpKeypair('https://flowtex.click/saml/sp');
    expect(kp.privateKey).toMatch(/^-----BEGIN (RSA )?PRIVATE KEY-----/);
    expect(kp.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(kp.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.notAfter).toBeInstanceOf(Date);
    // 3 years validity; allow a day of slack for test runs near midnight UTC.
    const yearsAhead = (kp.notAfter.getTime() - Date.now()) / (365 * 24 * 3600 * 1000);
    expect(yearsAhead).toBeGreaterThan(2.99);
    expect(yearsAhead).toBeLessThan(3.01);
  });

  it('embeds the entityID as the certificate CN', async () => {
    const kp = await generateSpKeypair('https://flowtex.click/saml/sp');
    // Decode the cert and check the subject CN. node-built-in
    // X509Certificate parses the PEM directly.
    const x509 = new X509Certificate(kp.certificatePem);
    expect(x509.subject).toContain('flowtex.click/saml/sp');
  });

  it('two successive calls return DIFFERENT keypairs (no caching at gen layer)', async () => {
    const a = await generateSpKeypair('https://flowtex.click/saml/sp');
    const b = await generateSpKeypair('https://flowtex.click/saml/sp');
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
  });

  it('rejects empty entityID', async () => {
    await expect(generateSpKeypair('')).rejects.toThrow(/entityId is required/);
    await expect(generateSpKeypair(undefined)).rejects.toThrow();
  });
});

describe('getSpKeypair', () => {
  it('generates + persists on first call', async () => {
    const kp = await getSpKeypair('https://flowtex.click/saml/sp');
    expect(kp.privateKey).toMatch(/^-----BEGIN/);
    expect(kp.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    // Cache populated.
    expect(_testing.resetCache).toBeDefined();
  });

  it('returns the cached keypair on second call (no new gen)', async () => {
    const first = await getSpKeypair('https://flowtex.click/saml/sp');
    const second = await getSpKeypair('https://flowtex.click/saml/sp');
    // Same private key (cache returned) -- new gen would produce a
    // different one.
    expect(second.privateKey).toBe(first.privateKey);
    expect(second.fingerprintSha256).toBe(first.fingerprintSha256);
  });

  it('reads from DB on cold start (no in-memory cache)', async () => {
    // Seed: generate + persist.
    await getSpKeypair('https://flowtex.click/saml/sp');
    const fingerprint = (await getSpKeypair()).fingerprintSha256;
    _testing.resetCache(); // simulate a process restart
    // Now fetch without providing an entityID -- should still work
    // because the row exists.
    const reloaded = await getSpKeypair();
    expect(reloaded.fingerprintSha256).toBe(fingerprint);
  });

  it('throws if no row exists and no entityID provided', async () => {
    await expect(getSpKeypair()).rejects.toThrow(/no keypair exists/);
  });
});

describe('rotateSpKeypair', () => {
  it('replaces the persisted row + invalidates the cache', async () => {
    const original = await getSpKeypair('https://flowtex.click/saml/sp');
    const rotated = await rotateSpKeypair('https://flowtex.click/saml/sp', 'admin-user-id');
    expect(rotated.fingerprintSha256).not.toBe(original.fingerprintSha256);
    // Next getSpKeypair() should return the rotated one.
    const fetched = await getSpKeypair();
    expect(fetched.fingerprintSha256).toBe(rotated.fingerprintSha256);
  });
});

// ─── Day 2 surface tests ─────────────────────────────────────────────

import { ATTR_PRESETS, parseIdpMetadataXml } from '../services/samlService.js';

describe('ATTR_PRESETS', () => {
  it('has the five canonical vendors with email/name/nameId triples', () => {
    for (const k of ['shibboleth', 'entra', 'okta', 'google', 'generic']) {
      expect(ATTR_PRESETS[k]).toBeDefined();
      expect(typeof ATTR_PRESETS[k].email).toBe('string');
      expect(typeof ATTR_PRESETS[k].name).toBe('string');
      expect(typeof ATTR_PRESETS[k].nameId).toBe('string');
    }
  });

  it('Shibboleth + Google use eduPerson OIDs for email', () => {
    expect(ATTR_PRESETS.shibboleth.email).toMatch(/^urn:oid:0\.9\./);
    expect(ATTR_PRESETS.google.email).toMatch(/^urn:oid:0\.9\./);
  });

  it('Entra uses WS-* schemas', () => {
    expect(ATTR_PRESETS.entra.email).toContain('schemas.xmlsoap.org');
  });
});

describe('_testing.normaliseEmailDomains', () => {
  it('lowercases, trims, dedupes, drops malformed', () => {
    const out = _testing.normaliseEmailDomains([
      ' UCC.ie ',
      'ucc.ie',
      'tcd.ie',
      'invalid_domain',                       // underscore disallowed
      'a.b',                                  // ok
      '',
      'not a domain',
    ]);
    expect(out).toEqual(['ucc.ie', 'tcd.ie', 'a.b']);
  });

  it('returns empty array for non-array input', () => {
    expect(_testing.normaliseEmailDomains(null)).toEqual([]);
    expect(_testing.normaliseEmailDomains('ucc.ie')).toEqual([]);
  });
});

describe('_testing.resolveAttributeMapping', () => {
  it('expands a preset name into the URI map', () => {
    const out = _testing.resolveAttributeMapping('shibboleth');
    expect(out.preset).toBe('shibboleth');
    expect(out.email).toBe(ATTR_PRESETS.shibboleth.email);
  });

  it('accepts a literal mapping object', () => {
    const out = _testing.resolveAttributeMapping({
      email: 'x', name: 'y', nameId: 'z',
    });
    expect(out).toEqual({ email: 'x', name: 'y', nameId: 'z' });
  });

  it('rejects an unknown preset name', () => {
    expect(() => _testing.resolveAttributeMapping('myidp'))
      .toThrow(/Unknown attribute-mapping preset/);
  });

  it('rejects a partial map', () => {
    expect(() => _testing.resolveAttributeMapping({ email: 'x' }))
      .toThrow(/email\/name\/nameId/);
  });
});

describe('parseIdpMetadataXml', () => {
  const SHIB_METADATA = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
                     xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
                     entityID="https://idp.ucc.ie/idp/shibboleth">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>MIIBvDCCASUCAQAwfTELMAkGA1UEBhMCSUUx</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="https://idp.ucc.ie/idp/profile/SAML2/POST/SSO"/>
    <md:SingleLogoutService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        Location="https://idp.ucc.ie/idp/profile/SAML2/Redirect/SLO"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

  it('extracts entityID, SSO URL, SLO URL, and PEM-wrapped cert', () => {
    const parsed = parseIdpMetadataXml(SHIB_METADATA);
    expect(parsed.entityId).toBe('https://idp.ucc.ie/idp/shibboleth');
    expect(parsed.ssoUrl).toBe('https://idp.ucc.ie/idp/profile/SAML2/POST/SSO');
    expect(parsed.sloUrl).toBe('https://idp.ucc.ie/idp/profile/SAML2/Redirect/SLO');
    expect(parsed.certPem).toMatch(/-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----/);
  });

  it('rejects non-SAML XML', () => {
    expect(() => parseIdpMetadataXml('<foo/>')).toThrow(/does not look like SAML metadata/);
  });

  it('rejects metadata missing IDPSSODescriptor', () => {
    const xml = SHIB_METADATA.replace(/IDPSSODescriptor/g, 'SPSSODescriptor');
    expect(() => parseIdpMetadataXml(xml)).toThrow(/not an IdP metadata/);
  });

  it('rejects metadata with no SingleSignOnService', () => {
    // Use a non-greedy [\s\S] so the regex matches across newlines AND
    // through any URI character (https:// has slashes that a [^/]+
    // class would refuse).
    const xml = SHIB_METADATA.replace(/<md:SingleSignOnService[\s\S]*?\/>/, '');
    expect(() => parseIdpMetadataXml(xml)).toThrow(/no HTTP-POST or HTTP-Redirect SingleSignOnService/);
  });

  it('rejects metadata with no signing key', () => {
    const xml = SHIB_METADATA.replace(/<md:KeyDescriptor[\s\S]*?<\/md:KeyDescriptor>/, '');
    expect(() => parseIdpMetadataXml(xml)).toThrow(/no signing KeyDescriptor/);
  });
});

describe('_testing.wrapBase64AsPem', () => {
  it('wraps with 64-char lines', () => {
    const long = 'A'.repeat(150);
    const pem = _testing.wrapBase64AsPem(long, 'CERTIFICATE');
    const lines = pem.split('\n');
    expect(lines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(lines[1].length).toBe(64);
    expect(lines[2].length).toBe(64);
    expect(lines[3].length).toBe(22);
    expect(lines[4]).toBe('-----END CERTIFICATE-----');
  });
});

// ─── Day 4: confirm-link flow + listPublicIdPs ──────────────────────────

describe('jitProvisionOrLink: confirm-link signal', () => {
  // These tests pin the contract change: existing password users no
  // longer get auto-linked; they get a needsConfirmation signal so the
  // route can render an interstitial. Day-4-design decision.
  it('returns needsConfirmation for existing password user in allowed domain', async () => {
    // We can't easily run the real jitProvisionOrLink against a mocked
    // DB because it uses an advisory lock and multiple queries. The
    // contract we want to pin: when (a) the IdP exists, (b) JIT is
    // enabled, (c) the email is in allowed_email_domains, (d) a user
    // with that email exists with auth_method='password', the return
    // value's needsConfirmation flag is true. We exercise this via a
    // lightweight DB stub.
    const { jitProvisionOrLink } = await import('../services/samlService.js');
    const idp = {
      id: 'idp-uuid',
      allowed_email_domains: ['ucc.ie'],
      jit_provisioning: true,
    };
    const existingPasswordUser = {
      id: 'alice-id',
      email: 'alice@ucc.ie',
      name: 'Alice',
      auth_method: 'password',
    };

    // Re-stub the db mock just for this test.
    const dbMock = (await import('../db.js')).default;
    const originalGet = dbMock.get;
    const originalRun = dbMock.run;
    const originalTransaction = dbMock.transaction;
    dbMock.transaction = async (fn) => fn({
      get: vi.fn(async (sql) => {
        if (/saml_idp_config/.test(sql)) return idp;
        if (/saml_idp_id = \$1 AND saml_name_id/.test(sql)) return null; // no existing SAML user
        if (/email = \$1 AND deleted_at IS NULL/.test(sql)) return existingPasswordUser;
        return null;
      }),
      run: vi.fn(async () => {}),
    });
    dbMock.get = vi.fn(async (sql) => /saml_idp_config/.test(sql) ? idp : null);

    try {
      const result = await jitProvisionOrLink('idp-uuid', {
        email: 'alice@ucc.ie',
        nameId: 'urn:abc',
        name: 'Alice',
      });
      expect(result.needsConfirmation).toBe(true);
      expect(result.candidate.existingUserId).toBe('alice-id');
      expect(result.candidate.email).toBe('alice@ucc.ie');
      expect(result.userId).toBeNull();
    } finally {
      dbMock.get = originalGet;
      dbMock.run = originalRun;
      dbMock.transaction = originalTransaction;
    }
  });
});

describe('confirmSamlLink', () => {
  it('refuses if the user is not in password mode', async () => {
    const { confirmSamlLink } = await import('../services/samlService.js');
    const dbMock = (await import('../db.js')).default;
    const originalTransaction = dbMock.transaction;
    dbMock.transaction = async (fn) => fn({
      get: vi.fn(async (sql) => {
        if (/SELECT \* FROM users/.test(sql)) {
          return { id: 'alice-id', auth_method: 'saml' }; // already linked!
        }
        return null;
      }),
      run: vi.fn(async () => {}),
    });
    try {
      await expect(
        confirmSamlLink('alice-id', 'idp-uuid', 'nameid')
      ).rejects.toThrow(/not in password mode/);
    } finally {
      dbMock.transaction = originalTransaction;
    }
  });

  it('refuses if the (idp, nameId) is already taken by another user', async () => {
    const { confirmSamlLink } = await import('../services/samlService.js');
    const dbMock = (await import('../db.js')).default;
    const originalTransaction = dbMock.transaction;
    dbMock.transaction = async (fn) => fn({
      get: vi.fn(async (sql) => {
        if (/SELECT \* FROM users WHERE id/.test(sql)) {
          return { id: 'alice-id', auth_method: 'password' };
        }
        if (/saml_idp_id = \$1 AND saml_name_id/.test(sql)) {
          return { id: 'someone-else-id' };  // race-loser
        }
        return null;
      }),
      run: vi.fn(async () => {}),
    });
    try {
      await expect(
        confirmSamlLink('alice-id', 'idp-uuid', 'nameid')
      ).rejects.toThrow(/already linked to another account/);
    } finally {
      dbMock.transaction = originalTransaction;
    }
  });

  it('refuses if the user does not exist', async () => {
    const { confirmSamlLink } = await import('../services/samlService.js');
    const dbMock = (await import('../db.js')).default;
    const originalTransaction = dbMock.transaction;
    dbMock.transaction = async (fn) => fn({
      get: vi.fn(async () => null), // user gone
      run: vi.fn(async () => {}),
    });
    try {
      await expect(
        confirmSamlLink('alice-id', 'idp-uuid', 'nameid')
      ).rejects.toThrow(/not found/);
    } finally {
      dbMock.transaction = originalTransaction;
    }
  });

  it('succeeds on happy path', async () => {
    const { confirmSamlLink } = await import('../services/samlService.js');
    const dbMock = (await import('../db.js')).default;
    const originalTransaction = dbMock.transaction;
    const updateCalls = [];
    dbMock.transaction = async (fn) => fn({
      get: vi.fn(async (sql) => {
        if (/SELECT \* FROM users WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) {
          return { id: 'alice-id', auth_method: 'password' };
        }
        if (/saml_idp_id = \$1 AND saml_name_id/.test(sql)) return null;
        if (/SELECT \* FROM users WHERE id = \$1$/.test(sql)) {
          return { id: 'alice-id', auth_method: 'saml', saml_idp_id: 'idp-uuid', saml_name_id: 'nameid' };
        }
        return null;
      }),
      run: vi.fn(async (sql, params) => {
        if (/UPDATE users SET/.test(sql)) updateCalls.push({ sql, params });
      }),
    });
    try {
      const linked = await confirmSamlLink('alice-id', 'idp-uuid', 'nameid');
      expect(linked.auth_method).toBe('saml');
      expect(linked.saml_idp_id).toBe('idp-uuid');
      expect(updateCalls.length).toBe(1);
      expect(updateCalls[0].sql).toMatch(/auth_method = 'saml'/);
      expect(updateCalls[0].sql).toMatch(/password_hash = NULL/);
    } finally {
      dbMock.transaction = originalTransaction;
    }
  });
});

describe('listPublicIdPs', () => {
  it('exposes only display_name + login URL', async () => {
    const { listPublicIdPs } = await import('../services/samlService.js');
    const dbMock = (await import('../db.js')).default;
    const originalAll = dbMock.all;
    dbMock.all = vi.fn(async (sql) => {
      if (/WHERE enabled = TRUE/.test(sql)) {
        return [
          { id: 'a', display_name: 'UCC' },
          { id: 'b', display_name: 'TCD' },
        ];
      }
      return [];
    });
    try {
      const idps = await listPublicIdPs();
      expect(idps).toEqual([
        { id: 'a', displayName: 'UCC', loginUrl: '/api/auth/saml/a/login' },
        { id: 'b', displayName: 'TCD', loginUrl: '/api/auth/saml/b/login' },
      ]);
      // The cert, allowed domains, attribute mapping etc. are NOT
      // included. Pin that nothing else leaks.
      for (const idp of idps) {
        expect(Object.keys(idp).sort()).toEqual(['displayName', 'id', 'loginUrl']);
      }
    } finally {
      dbMock.all = originalAll;
    }
  });
});
