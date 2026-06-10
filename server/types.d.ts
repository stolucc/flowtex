// Server-side TypeScript ambient declarations.
//
// Augments the SessionData interface from express-session with the
// custom fields FlowTex stores in req.session: userId, userName,
// csrfToken, authMethod, and the SAML confirm-link interstitial
// state.
//
// Anything that's a JS file with `// @ts-check` and reads
// `req.session.<custom-field>` needs this augmentation to flow.
// Place this file in the tsconfig's include list so tsc picks it
// up automatically.

import 'express-session';

declare module 'express-session' {
  interface SessionData {
    /** Set on successful login; cleared on logout / session.destroy. */
    userId?: string;
    /** Cached for downstream display (toolbar, audit log, etc.). */
    userName?: string;
    /** Double-submit CSRF token, paired with the csrf-token cookie. */
    csrfToken?: string;
    /** How the user authenticated: 'password' (default) or 'saml'. */
    authMethod?: 'password' | 'saml';
    /** When authMethod=='saml', which IdP authenticated them. */
    samlIdpId?: string;
    /** When authMethod=='saml', the IdP's canonical user identifier. */
    samlNameId?: string;
    /** When authMethod=='saml', for SLO LogoutRequest construction. */
    samlSessionIndex?: string;
    /** SAML confirm-link interstitial state. Set on /acs when an
     *  existing password user logs in via SAML; cleared by
     *  /confirm-link or /cancel-link. 10-minute TTL enforced via
     *  the `expiresAt` field. */
    pendingSamlLink?: {
      idpId: string;
      nameId: string;
      sessionIndex?: string;
      email: string;
      existingUserId: string;
      existingName: string;
      relayState: string;
      /** Date.now() + 10*60*1000 at the time the link was registered. */
      expiresAt: number;
    };
  }
}
