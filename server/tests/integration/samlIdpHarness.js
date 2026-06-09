// samlify-as-IdP harness for SAML integration tests.
//
// Provides:
//   makeFakeIdP({ entityId, ssoUrl, audience, callbackUrl })
//     -> { idpCert, mintResponse({ email, name, nameId, ... }) }
//
// The mintResponse function returns a real, signed SAMLResponse
// (base64-encoded form-encoded body string) that the FlowTex SP can
// process through the actual @node-saml/node-saml validator.
//
// Why this approach over a simple mocked validate function:
//   - It exercises the real signature path (xml-crypto under the
//     hood), which catches signature-wrapping defects the unit
//     tests can't.
//   - It rotates through samlify's tag substitution + node-saml's
//     parse, which is exactly the round-trip a production deploy
//     hits.

import samlify from 'samlify';
import * as validator from '@authenio/samlify-node-xmllint';
import selfsigned from 'selfsigned';
import { createRequire } from 'node:module';

// libsaml is a CJS module exporting a default function; reaching its
// public surface (defaultLoginResponseTemplate, replaceTagsByValue)
// requires CJS-style require. Vitest's ESM loader doesn't expose
// the .default cleanly for this nested-internal-of-CJS shape, so we
// use createRequire to fall back to the CJS resolver.
const cjsRequire = createRequire(import.meta.url);
const libsaml = cjsRequire('samlify/build/src/libsaml.js').default;

// samlify requires a schema validator to be plugged in at module load
// time. Using xmllint -- the only Node-compatible option that ships
// with samlify -- so the response XML is checked against the SAML
// schema before signature wrapping is applied.
samlify.setSchemaValidator(validator);

// Embed AttributeStatement directly in the template (rather than via
// samlify's `attributes` config which routes through XML-escaping and
// hides the values from @node-saml's profile). The two placeholders
// {Email} and {Name} get substituted at mint time.
const RESPONSE_TEMPLATE = libsaml.defaultLoginResponseTemplate.context.replace(
  '{AttributeStatement}',
  '<saml:AttributeStatement>'
    + '<saml:Attribute Name="email" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">'
      + '<saml:AttributeValue xsi:type="xs:string">{Email}</saml:AttributeValue>'
    + '</saml:Attribute>'
    + '<saml:Attribute Name="name" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">'
      + '<saml:AttributeValue xsi:type="xs:string">{Name}</saml:AttributeValue>'
    + '</saml:Attribute>'
    + '</saml:AttributeStatement>',
);

/**
 * Build a fake IdP that can mint signed SAMLResponses against the
 * given SP coordinates.
 *
 * @param {object} opts
 * @param {string} opts.entityId    - IdP entityID
 * @param {string} opts.ssoUrl      - IdP SSO URL (used only in IdP metadata)
 * @param {string} opts.sloUrl      - IdP SLO URL (samlify requires it set)
 * @param {string} opts.audience    - SP entityID (the response's Audience)
 * @param {string} opts.callbackUrl - SP ACS URL (the response's Destination)
 * @returns {Promise<{
 *   idpCert: string,
 *   spPrivateKey: string,
 *   spCert: string,
 *   mintResponse: (user: { email: string, name?: string, nameId?: string,
 *                          notBeforeOffsetMs?: number,
 *                          notOnOrAfterOffsetMs?: number,
 *                          overrideAudience?: string,
 *                          overrideIssuer?: string }) => Promise<string>
 * }>}
 */
export async function makeFakeIdP(opts) {
  // selfsigned keypair for the IdP (signs assertions + response).
  const idpPems = await selfsigned.generate(
    [{ name: 'commonName', value: 'fake-idp' }],
    { keySize: 2048, days: 365, algorithm: 'sha256' },
  );
  // SP keypair (only used to satisfy node-saml's privateKey arg --
  // we don't actually decrypt anything).
  const spPems = await selfsigned.generate(
    [{ name: 'commonName', value: 'flowtex-sp' }],
    { keySize: 2048, days: 365, algorithm: 'sha256' },
  );

  const idp = samlify.IdentityProvider({
    entityID: opts.entityId,
    privateKey: idpPems.private,
    signingCert: idpPems.cert,
    singleSignOnService: [{
      Binding: samlify.Constants.namespace.binding.post,
      Location: opts.ssoUrl,
    }],
    singleLogoutService: [{
      Binding: samlify.Constants.namespace.binding.redirect,
      Location: opts.sloUrl || (opts.ssoUrl + '/slo'),
    }],
    loginResponseTemplate: { context: RESPONSE_TEMPLATE, attributes: [] },
  });
  const sp = samlify.ServiceProvider({
    entityID: opts.audience,
    assertionConsumerService: [{
      Binding: samlify.Constants.namespace.binding.post,
      Location: opts.callbackUrl,
    }],
    wantMessageSigned: true,
    wantAssertionsSigned: true,
    signingCert: spPems.cert,
  });

  async function mintResponse(user) {
    const now = new Date();
    const notBefore = new Date(now.getTime() + (user.notBeforeOffsetMs || 0));
    const notOnOrAfter = new Date(
      now.getTime() + (user.notOnOrAfterOffsetMs ?? 5 * 60 * 1000),
    );
    const id = '_' + Math.random().toString(36).slice(2);
    const reqInfo = {
      extract: { request: { id: 'req-' + id, issueInstant: now.toISOString() } },
    };
    const customTag = (template) => ({
      id,
      context: libsaml.replaceTagsByValue(template, {
        ID: id,
        AssertionID: id + '_a',
        Destination: opts.callbackUrl,
        Audience: user.overrideAudience || opts.audience,
        Issuer: user.overrideIssuer || opts.entityId,
        IssueInstant: now.toISOString(),
        ConditionsNotBefore: notBefore.toISOString(),
        ConditionsNotOnOrAfter: notOnOrAfter.toISOString(),
        SubjectConfirmationDataNotOnOrAfter: notOnOrAfter.toISOString(),
        NameIDFormat: user.nameIdFormat
          || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        NameID: user.nameId || user.email,
        SubjectRecipient: opts.callbackUrl,
        StatusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
        InResponseTo: 'req-' + id,
        AuthnStatement: '',
        Email: user.email,
        Name: user.name || user.email,
      }),
    });
    const result = await idp.createLoginResponse(
      sp,
      reqInfo,
      'post',
      { email: user.email, name: user.name },
      customTag,
    );
    // result.context is base64-encoded SAMLResponse body, ready for ACS.
    return result.context;
  }

  return {
    idpCert: idpPems.cert,
    spPrivateKey: spPems.private,
    spCert: spPems.cert,
    mintResponse,
  };
}
