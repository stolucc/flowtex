// SAML / SSO Phase 1 Day 3 — per-IdP HTTP routes.
//
// All routes mount under /api/auth/saml/:idpId/...
//
//   GET  metadata   SP metadata XML (operator gives to IdP)
//   GET  login      302 to IdP SSO URL with signed AuthnRequest
//   POST acs        ACS — IdP delivers SAMLResponse here
//   GET  logout     302 to IdP SLO URL with LogoutRequest
//   POST sls        SLS — IdP delivers LogoutResponse here
//
// The routes are intentionally tiny -- they're thin wrappers over the
// service-layer functions in services/samlService.js. The service has
// the only interesting logic; the route adds HTTP-shaped concerns:
// session establishment, RelayState round-trip, error rendering.

import { Router } from 'express';
import { SAML } from '@node-saml/node-saml';
import crypto from 'node:crypto';
import logger from '../logger.js';
import * as samlService from '../services/samlService.js';
import { auditLog } from '../utils/audit.js';

const router = Router({ mergeParams: true });

// ─── Helpers ───────────────────────────────────────────────────────────

/** SP entityID convention: `${APP_URL}/api/auth/saml/sp`. Operators
 *  publish this in their IdP config. Consistent across all IdPs --
 *  multi-tenant doesn't mean multiple SP identities, it means multiple
 *  IdP relationships from one SP. */
function spEntityId() {
  const appUrl = (process.env.APP_URL || 'http://localhost:3001').replace(/\/+$/, '');
  return `${appUrl}/api/auth/saml/sp`;
}

/** Build a SAML instance for the given IdP, using the SP's keypair.
 *  Cached lookups would be a perf win but each request is already
 *  bottlenecked by IO (assertion validation) -- premature optimisation. */
async function getSamlForIdP(idpId, callbackUrl) {
  const idp = await samlService.getIdP(idpId);
  if (!idp) {
    const err = new Error('Unknown IdP');
    err.status = 404;
    throw err;
  }
  const kp = await samlService.getSpKeypair(spEntityId());
  return new SAML({
    issuer: spEntityId(),
    callbackUrl,
    entryPoint: idp.sso_url,
    logoutUrl: idp.slo_url || undefined,
    idpCert: idp.cert_pem,
    audience: spEntityId(),
    privateKey: kp.privateKey,
    // Sign our outgoing AuthnRequests + LogoutRequests.
    authnRequestBinding: 'HTTP-Redirect',
    // Strict signature/audience checks on responses.
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    acceptedClockSkewMs: 30 * 1000,
    idpIssuer: idp.entity_id,
    identifierFormat: null,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  });
}

/** ACS callback URL for a given IdP. Used both as the issuer-side claim
 *  (in AuthnRequest) and the audience check on the way back. */
function acsUrlFor(req, idpId) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/auth/saml/${idpId}/acs`;
}

/** Validate a RelayState URL. We round-trip user-supplied "where I was
 *  going" through the IdP, but the IdP's POST back to our ACS includes
 *  that string verbatim. An attacker could craft a phishing flow that
 *  posts to our ACS with RelayState=https://evil.com -- we'd then
 *  302 the post-login user to evil.com.
 *
 *  Defence: allow only same-origin relative paths. Anything else
 *  silently falls back to /. */
function safeRelayState(raw) {
  if (typeof raw !== 'string') return '/';
  if (raw.length === 0 || raw.length > 1024) return '/';
  // Reject absolute URLs (incl. protocol-relative //evil.com).
  if (raw.startsWith('//') || raw.startsWith('http://') || raw.startsWith('https://')) return '/';
  // Require leading slash; reject backslash (Windows path injection).
  if (!raw.startsWith('/') || raw.includes('\\')) return '/';
  // Prevent SAML route loops.
  if (raw.startsWith('/api/auth/saml/')) return '/';
  return raw;
}

/** Render a SAML-error page. Used by every catch. Intentionally generic
 *  -- the actual error goes to the operator log; the user sees nothing
 *  about which IdP, which assertion field, which signature failed. */
function renderSamlError(res, code, message) {
  res.status(code).send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSO Error</title></head>
     <body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:1rem">
       <h1>Sign-in failed</h1>
       <p>${message}</p>
       <p><a href="/login">Back to sign-in</a></p>
     </body></html>`,
  );
}

// ─── GET /api/auth/saml/:idpId/metadata ────────────────────────────────
// SP metadata XML. Operator copies the URL into their IdP config; the
// IdP refetches periodically. No auth required (publishing metadata
// is the whole point).
router.get('/:idpId/metadata', async (req, res) => {
  try {
    const saml = await getSamlForIdP(req.params.idpId, acsUrlFor(req, req.params.idpId));
    const kp = await samlService.getSpKeypair(spEntityId());
    const xml = saml.generateServiceProviderMetadata(kp.certificatePem, kp.certificatePem);
    res.setHeader('Content-Type', 'application/samlmetadata+xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    if (err.status === 404) return renderSamlError(res, 404, 'Unknown identity provider.');
    logger.error({ err, idpId: req.params.idpId }, 'SAML metadata generation failed');
    return renderSamlError(res, 500, 'Sign-in is temporarily unavailable.');
  }
});

// ─── GET /api/auth/saml/:idpId/login ───────────────────────────────────
// Build a signed AuthnRequest and redirect. RelayState is the URL the
// user was trying to reach when they hit the login wall.
router.get('/:idpId/login', async (req, res) => {
  try {
    const saml = await getSamlForIdP(req.params.idpId, acsUrlFor(req, req.params.idpId));
    const relay = safeRelayState(req.query.RelayState);
    const url = await saml.getAuthorizeUrlAsync(relay, req.get('host'), {});
    res.redirect(url);
  } catch (err) {
    if (err.status === 404) return renderSamlError(res, 404, 'Unknown identity provider.');
    logger.error({ err, idpId: req.params.idpId }, 'SAML login redirect failed');
    return renderSamlError(res, 500, 'Sign-in is temporarily unavailable.');
  }
});

// ─── POST /api/auth/saml/:idpId/acs ────────────────────────────────────
// Trust boundary. Validate, link/provision, establish session, redirect.
router.post('/:idpId/acs', async (req, res) => {
  const { idpId } = req.params;
  const samlResponseB64 = req.body?.SAMLResponse;
  const relayState = safeRelayState(req.body?.RelayState);

  if (typeof samlResponseB64 !== 'string' || samlResponseB64.length === 0) {
    return renderSamlError(res, 400, 'No SAML response.');
  }
  if (samlResponseB64.length > 256 * 1024) {
    // 256 KB is far more than any legitimate assertion. Cap early so
    // we don't burn CPU parsing an attacker's gigantic XML.
    return renderSamlError(res, 400, 'SAML response too large.');
  }

  try {
    const kp = await samlService.getSpKeypair(spEntityId());
    const audience = spEntityId();
    const callbackUrl = acsUrlFor(req, idpId);

    const attrs = await samlService.validateAssertion(idpId, samlResponseB64, {
      audience,
      callbackUrl,
      spPrivateKey: kp.privateKey,
    });

    const result = await samlService.jitProvisionOrLink(idpId, attrs);

    // Session establishment. Regenerate to defeat session fixation
    // (an attacker who had us pre-create their session ID via a cookie
    // injection couldn't carry that over the regenerate).
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) {
          req.session.destroy(() => {});
          return reject(err);
        }
        req.session.userId = result.userId;
        req.session.userName = result.user.name;
        req.session.authMethod = 'saml';
        req.session.samlIdpId = idpId;
        req.session.samlNameId = attrs.nameId;
        req.session.samlSessionIndex = attrs.sessionIndex;
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        res.cookie('csrf-token', req.session.csrfToken, {
          httpOnly: false,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
        });
        req.session.save((saveErr) => {
          if (saveErr) {
            req.session.destroy(() => {});
            return reject(saveErr);
          }
          resolve();
        });
      });
    });

    await auditLog(result.userId, result.isNew ? 'saml_jit_provision' : (result.isLinked ? 'saml_link' : 'saml_login'), {
      idpId,
      nameId: attrs.nameId,
      ip: req.ip,
    }).catch((err) => logger.error({ err }, 'SAML audit log failed'));

    res.redirect(relayState);
  } catch (err) {
    // Categorise: 4xx-shaped errors get the matching code; the
    // expected-bad-input ones stay generic to avoid oracling which
    // attribute mapping / which domain mismatch led to the rejection.
    const status = err.status || 500;
    if (status >= 500) {
      logger.error({ err, idpId }, 'SAML ACS handler error');
      return renderSamlError(res, 500, 'Sign-in is temporarily unavailable.');
    }
    // Known 4xx-class rejections (user/email/IdP mismatch, etc.):
    // log the operator-readable version but tell the user nothing
    // about which check failed.
    logger.warn({ err: err.message, idpId }, 'SAML ACS rejected assertion');
    return renderSamlError(res, status, 'Sign-in failed. Contact your administrator.');
  }
});

// ─── GET /api/auth/saml/:idpId/logout ──────────────────────────────────
// If the IdP has an SLO URL configured, build a signed LogoutRequest
// and redirect. Otherwise destroy the local session and redirect to
// /login.
router.get('/:idpId/logout', async (req, res) => {
  const { idpId } = req.params;
  try {
    const idp = await samlService.getIdP(idpId);
    if (!idp) return renderSamlError(res, 404, 'Unknown identity provider.');

    const samlIdpInSession = req.session?.samlIdpId === idpId;
    // SLO requires both an SLO URL AND a session linked to this IdP.
    // Without the session, we have no NameID to put in the LogoutRequest.
    if (idp.slo_url && samlIdpInSession) {
      const saml = await getSamlForIdP(idpId, acsUrlFor(req, idpId));
      const profile = {
        nameID: req.session.samlNameId,
        nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
        sessionIndex: req.session.samlSessionIndex,
      };
      const url = await saml.getLogoutUrlAsync(profile, '/', {});
      // Destroy local session BEFORE redirecting -- once the user is
      // bouncing through the IdP we can't be sure they'll come back.
      req.session.destroy(() => {});
      return res.redirect(url);
    }

    // Local logout only.
    req.session?.destroy(() => {});
    res.redirect('/login');
  } catch (err) {
    logger.error({ err, idpId }, 'SAML logout failed');
    // Even on failure, destroy the local session so the user is at
    // least signed out HERE.
    req.session?.destroy(() => {});
    res.redirect('/login');
  }
});

// ─── POST /api/auth/saml/:idpId/sls ────────────────────────────────────
// SLS endpoint -- IdP POSTs a LogoutResponse (or a LogoutRequest if
// the logout was IdP-initiated). Either way, end the local session.
// We DON'T validate the LogoutResponse signature strictly here --
// a forged response only ends ONE user's session, not a privilege
// escalation. But we do require the session to belong to this IdP
// to prevent a cross-IdP forced-logout DoS.
router.post('/:idpId/sls', async (req, res) => {
  const { idpId } = req.params;
  if (req.session?.samlIdpId === idpId) {
    req.session.destroy(() => {});
  }
  res.redirect('/login');
});

// Test-only exports.
export const _testing = { safeRelayState };

export default router;
