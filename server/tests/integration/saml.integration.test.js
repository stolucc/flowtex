// SAML end-to-end integration test.
//
// Wires a samlify-as-IdP fake against the real FlowTex SAML stack
// (services/samlService.js + DB). Each test mints a real signed
// SAMLResponse, runs it through validateAssertion + jitProvisionOrLink,
// and verifies the outcome (login / link-candidate / JIT-create /
// refusal).
//
// Test isolation: the integration harness wraps each test in BEGIN…
// ROLLBACK on a shared client, so all the IdP rows + users created
// here vanish at end of test.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { initCrypto } from '../../utils/crypto.js';
import {
  createIdP,
  validateAssertion,
  jitProvisionOrLink,
  confirmSamlLink,
  getSpKeypair,
  _testing as samlTesting,
} from '../../services/samlService.js';
import { makeFakeIdP } from './samlIdpHarness.js';

const SP_ENTITY_ID = 'https://test.flowtex/api/auth/saml/sp';
const SP_CALLBACK_URL_BASE = 'https://test.flowtex/api/auth/saml';

beforeAll(async () => {
  // initCrypto wires the encrypt/decrypt key. Required because the
  // SP keypair is encrypted via encrypt(). Done once across the file.
  await initCrypto();
});

beforeEach(async () => {
  // The integration harness opens a BEGIN before each test. Any
  // saml_sp_keypair row created in a prior test run may still be
  // sitting in the DB (the global initSchema ran outside the
  // transaction). Clear inside THIS transaction so we always start
  // from a known state, then invalidate the in-memory cache so
  // getSpKeypair regenerates rather than returning the previous
  // decrypted view.
  await db.run('DELETE FROM saml_sp_keypair');
  samlTesting.resetCache();
});

async function seedIdP(idpCert, allowedDomains, opts = {}) {
  return createIdP({
    displayName: opts.displayName || 'Test IdP',
    entityId: opts.entityId || 'https://fake-idp.test/idp',
    ssoUrl: opts.ssoUrl || 'https://fake-idp.test/idp/sso',
    sloUrl: opts.sloUrl || null,
    certPem: idpCert,
    attributeMapping: opts.attributeMapping || {
      email: 'email',
      name: 'name',
      nameId: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    },
    allowedEmailDomains: allowedDomains,
    jitProvisioning: opts.jitProvisioning ?? true,
    enabled: true,
  });
}

describe('SAML integration: happy path', () => {
  it('mints a signed response, validates, JIT-creates a new user', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp',
      ssoUrl: 'https://fake-idp.test/idp/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    const idp = await seedIdP(fake.idpCert, ['example.test']);

    const samlResponse = await fake.mintResponse({
      email: 'alice@example.test',
      name: 'Alice',
    });

    const kp = await getSpKeypair(SP_ENTITY_ID);
    const attrs = await validateAssertion(idp.id, samlResponse, {
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
      spPrivateKey: kp.privateKey,
    });

    expect(attrs.email).toBe('alice@example.test');
    expect(attrs.name).toBe('Alice');
    expect(attrs.nameId).toBe('alice@example.test');

    const result = await jitProvisionOrLink(idp.id, attrs);
    expect(result.isNew).toBe(true);
    expect(result.user.email).toBe('alice@example.test');
    expect(result.user.auth_method).toBe('saml');
    expect(result.user.password_hash).toBeNull();
    expect(result.user.email_verified).toBe(true);
  });

  it('matches a returning SAML user via (idp, nameID) pair', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp',
      ssoUrl: 'https://fake-idp.test/idp/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    const idp = await seedIdP(fake.idpCert, ['example.test']);

    const kp = await getSpKeypair(SP_ENTITY_ID);
    // First login -- JIT create
    const r1 = await jitProvisionOrLink(idp.id, await validateAssertion(idp.id,
      await fake.mintResponse({ email: 'bob@example.test', name: 'Bob' }),
      { audience: SP_ENTITY_ID, callbackUrl: callback, spPrivateKey: kp.privateKey }));
    expect(r1.isNew).toBe(true);

    // Second login -- match by saml_name_id, no new row
    const r2 = await jitProvisionOrLink(idp.id, await validateAssertion(idp.id,
      await fake.mintResponse({ email: 'bob@example.test', name: 'Bob' }),
      { audience: SP_ENTITY_ID, callbackUrl: callback, spPrivateKey: kp.privateKey }));
    expect(r2.isNew).toBe(false);
    expect(r2.userId).toBe(r1.userId);
  });
});

describe('SAML integration: confirm-link flow', () => {
  it('signals needsConfirmation for existing password user; confirmSamlLink completes the link', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp2',
      ssoUrl: 'https://fake-idp.test/idp2/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    const idp = await seedIdP(fake.idpCert, ['example.test'], {
      entityId: 'https://fake-idp.test/idp2',
      ssoUrl: 'https://fake-idp.test/idp2/sso',
    });

    // Seed an existing password user matching the email.
    const userId = uuid();
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, email_verified, auth_method)
       VALUES ($1, $2, $3, $4, FALSE, 'password')`,
      [userId, 'carol@example.test', 'Carol', '$2a$04$xxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    );

    const kp = await getSpKeypair(SP_ENTITY_ID);
    const samlResponse = await fake.mintResponse({
      email: 'carol@example.test',
      name: 'Carol from IdP',
    });
    const attrs = await validateAssertion(idp.id, samlResponse, {
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
      spPrivateKey: kp.privateKey,
    });

    // First call -- signals confirm-link, doesn't mutate.
    const interim = await jitProvisionOrLink(idp.id, attrs);
    expect(interim.needsConfirmation).toBe(true);
    expect(interim.userId).toBeNull();
    expect(interim.candidate.existingUserId).toBe(userId);
    expect(interim.candidate.email).toBe('carol@example.test');

    // Confirm the link -- now it mutates.
    const linked = await confirmSamlLink(userId, idp.id, attrs.nameId);
    expect(linked.auth_method).toBe('saml');
    expect(linked.saml_idp_id).toBe(idp.id);
    expect(linked.saml_name_id).toBe(attrs.nameId);
    expect(linked.password_hash).toBeNull();
    expect(linked.email_verified).toBe(true);

    // Next SAML login finds the linked user via (idp, nameId).
    const next = await jitProvisionOrLink(idp.id, attrs);
    expect(next.isNew).toBe(false);
    expect(next.needsConfirmation).toBeFalsy();
    expect(next.userId).toBe(userId);
  });
});

describe('SAML integration: refusal paths', () => {
  it('rejects an assertion with a tampered signature', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp3',
      ssoUrl: 'https://fake-idp.test/idp3/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    const idp = await seedIdP(fake.idpCert, ['example.test'], {
      entityId: 'https://fake-idp.test/idp3',
      ssoUrl: 'https://fake-idp.test/idp3/sso',
    });

    let samlResponse = await fake.mintResponse({
      email: 'dave@example.test',
      name: 'Dave',
    });
    // Flip a byte in the middle of the base64 payload. This corrupts
    // the signed bytes; xml-crypto must reject.
    const buf = Buffer.from(samlResponse, 'base64');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    samlResponse = buf.toString('base64');

    const kp = await getSpKeypair(SP_ENTITY_ID);
    await expect(
      validateAssertion(idp.id, samlResponse, {
        audience: SP_ENTITY_ID,
        callbackUrl: callback,
        spPrivateKey: kp.privateKey,
      }),
    ).rejects.toThrow();
  });

  it('rejects an assertion with NotOnOrAfter in the past (expired)', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp4',
      ssoUrl: 'https://fake-idp.test/idp4/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    const idp = await seedIdP(fake.idpCert, ['example.test'], {
      entityId: 'https://fake-idp.test/idp4',
      ssoUrl: 'https://fake-idp.test/idp4/sso',
    });

    const samlResponse = await fake.mintResponse({
      email: 'eve@example.test',
      name: 'Eve',
      // Push NotOnOrAfter well into the past so the 30s clock skew
      // tolerance is irrelevant.
      notOnOrAfterOffsetMs: -10 * 60 * 1000,
    });

    const kp = await getSpKeypair(SP_ENTITY_ID);
    await expect(
      validateAssertion(idp.id, samlResponse, {
        audience: SP_ENTITY_ID,
        callbackUrl: callback,
        spPrivateKey: kp.privateKey,
      }),
    ).rejects.toThrow();
  });

  it('rejects an assertion with the wrong audience', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp5',
      ssoUrl: 'https://fake-idp.test/idp5/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    const idp = await seedIdP(fake.idpCert, ['example.test'], {
      entityId: 'https://fake-idp.test/idp5',
      ssoUrl: 'https://fake-idp.test/idp5/sso',
    });

    const samlResponse = await fake.mintResponse({
      email: 'frank@example.test',
      name: 'Frank',
      overrideAudience: 'https://different-sp.example/saml',
    });

    const kp = await getSpKeypair(SP_ENTITY_ID);
    await expect(
      validateAssertion(idp.id, samlResponse, {
        audience: SP_ENTITY_ID,
        callbackUrl: callback,
        spPrivateKey: kp.privateKey,
      }),
    ).rejects.toThrow();
  });

  it('refuses an existing password user whose email is NOT in the IdPs allowed domains', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp6',
      ssoUrl: 'https://fake-idp.test/idp6/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    // IdP allows only example.test
    const idp = await seedIdP(fake.idpCert, ['example.test'], {
      entityId: 'https://fake-idp.test/idp6',
      ssoUrl: 'https://fake-idp.test/idp6/sso',
    });

    // Pre-existing user with an email in a DIFFERENT domain. If a
    // future schema change relaxes the email-domain gate this test
    // will start passing -- intentional.
    const userId = uuid();
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, email_verified, auth_method)
       VALUES ($1, $2, $3, $4, TRUE, 'password')`,
      [userId, 'grace@other.test', 'Grace', '$2a$04$yyyyyyyyyyyyyyyyyyyyyy.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'],
    );

    const samlResponse = await fake.mintResponse({
      email: 'grace@other.test',
      name: 'Grace',
    });

    const kp = await getSpKeypair(SP_ENTITY_ID);
    const attrs = await validateAssertion(idp.id, samlResponse, {
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
      spPrivateKey: kp.privateKey,
    });

    await expect(jitProvisionOrLink(idp.id, attrs)).rejects.toThrow(
      /cannot be linked to this IdP/,
    );
  });

  it('refuses JIT-create when the IdP has jit_provisioning=false', async () => {
    const callback = `${SP_CALLBACK_URL_BASE}/${uuid()}/acs`;
    const fake = await makeFakeIdP({
      entityId: 'https://fake-idp.test/idp7',
      ssoUrl: 'https://fake-idp.test/idp7/sso',
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
    });
    const idp = await seedIdP(fake.idpCert, ['example.test'], {
      entityId: 'https://fake-idp.test/idp7',
      ssoUrl: 'https://fake-idp.test/idp7/sso',
      jitProvisioning: false,
    });

    const samlResponse = await fake.mintResponse({
      email: 'henry@example.test',
      name: 'Henry',
    });

    const kp = await getSpKeypair(SP_ENTITY_ID);
    const attrs = await validateAssertion(idp.id, samlResponse, {
      audience: SP_ENTITY_ID,
      callbackUrl: callback,
      spPrivateKey: kp.privateKey,
    });

    await expect(jitProvisionOrLink(idp.id, attrs)).rejects.toThrow(
      /JIT provisioning refused/,
    );
  });
});
