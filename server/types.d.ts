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

// Multer attaches `req.file` (single-upload) or `req.files` (multi)
// when its middleware is mounted. Declaring them on Express's
// Request lets @ts-check'd routes read those fields without
// per-call-site casts.
declare global {
  namespace Express {
    interface Request {
      file?: {
        fieldname: string;
        originalname: string;
        encoding: string;
        mimetype: string;
        size: number;
        buffer: Buffer;
      };
      files?: Array<{
        fieldname: string;
        originalname: string;
        encoding: string;
        mimetype: string;
        size: number;
        buffer: Buffer;
      }>;
    }
  }
}

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
    /** Set on first save -- compared to session-store row's `expire` to
     *  detect rolling-renew vs original-issued-time. */
    createdAt?: number;
    /** GitHub OAuth state nonce. Stashed before redirecting to GitHub
     *  so the callback can verify the state belongs to this session
     *  (anti-CSRF for OAuth2). Cleared after consumption. */
    githubOAuthState?: string;
    /** GitHub OAuth post-callback returnTo path. */
    githubOAuthReturnTo?: string;
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
