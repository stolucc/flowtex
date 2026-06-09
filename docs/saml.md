# SAML / SSO operator runbook

How FlowTex's SAML support works, and how to configure it against
common identity providers.

## What it does

FlowTex supports SAML 2.0 SP (Service Provider) for multiple,
independently-managed IdPs in a single deployment. Different email
domains can route to different IdPs; non-institutional users continue
to use email + password.

| User                         | Login method                                                |
| ---------------------------- | ----------------------------------------------------------- |
| `alice@gmail.com`            | email + password (gmail.com not claimed by any IdP)         |
| `bob@ucc.ie` (new)           | "Continue with UCC" → SAML, JIT-provisioned                 |
| `carol@ucc.ie` (legacy pwd)  | sees password form AND "Continue with UCC" — picks one      |
| When picks UCC               | one-time interstitial: "Link this account?" → links account |
| After link                   | always uses SAML (password is gone)                         |

## Architecture

```
┌─────────────────┐                       ┌────────────────────┐
│   Browser       │ ─── 1. /login ──────► │ FlowTex Login Page │
│                 │ ◄── form + buttons ── │                    │
│                 │                       └────────────────────┘
│                 │
│                 │ ─── 2. click "Continue with UCC"
│                 │
│                 │ ─── GET /api/auth/saml/<id>/login ─────────┐
│                 │                                            │
│                 │ ◄── 3. 302 with signed AuthnRequest ──────►│ Web tier
│                 │                                            │
│                 │ ─── 4. POST to IdP SSO URL ────────────────►
│                 │                                  ┌───────────┐
│                 │ ◄── 5. user authenticates at IdP │ UCC IdP   │
│                 │                                  └───────────┘
│                 │ ─── 6. browser-auto-submits SAMLResponse ───►
│                 │
│                 │ ─── POST /api/auth/saml/<id>/acs ──────────►┐
│                 │                                            │
│                 │                                            │ Web tier
│                 │                                            │  - validate signature
│                 │                                            │  - check audience
│                 │                                            │  - check expiry (±30s)
│                 │                                            │  - jitProvisionOrLink
│                 │                                            │
│                 │ ◄── 7. session cookie + 302 to / ──────────│
└─────────────────┘                                            └────────────────────┘
```

Multi-tenant routing happens at the URL level: each IdP has its own
`/api/auth/saml/<idpId>/...` family of routes. The IdP only ever
talks to its own ACS, with its own signing key. There's no
ambiguity about which IdP a response came from.

## How to configure an IdP (in FlowTex's admin UI)

1. Sign in as an admin and open **Admin → SSO**.
2. Copy the "SP entityID" — your IdP needs this.
3. Click **Add identity provider**.
4. Either:
   - **Paste metadata XML** (the simplest path; most IdPs publish
     theirs at a stable URL like `https://idp.example.org/idp/shibboleth`),
     or
   - Switch to **Field-by-field** and fill in entityID, SSO URL,
     SLO URL (optional), and the IdP's signing certificate PEM.
5. Pick an **attribute mapping preset** for your IdP type. The
   presets cover the common URI conventions:

   | Preset      | Email attribute URI                                                  |
   | ----------- | -------------------------------------------------------------------- |
   | Shibboleth  | `urn:oid:0.9.2342.19200300.100.1.3` (mail)                           |
   | Entra       | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |
   | Okta        | `email` (Okta's friendlyName)                                        |
   | Google      | same as Shibboleth (eduPerson OIDs)                                  |
   | Generic     | `email`, `name`                                                      |

   For an IdP that doesn't fit any preset, the admin UI doesn't
   currently expose the literal-mapping override; in the meantime,
   you can `PATCH /api/admin/saml/idps/<id>` with
   `attribute_mapping: {email: "...", name: "...", nameId: "..."}`.

6. Enter **allowed email domains** (comma-separated). Users with
   emails in these domains will see this IdP on the login page.
   FlowTex enforces that no two enabled IdPs claim the same domain.

7. Leave **JIT provisioning** on if you want new users created
   automatically when they sign in for the first time. Off if you
   want to pre-provision users separately.

8. Leave **Enabled** off until you've completed the IdP-side
   configuration, then enable.

## On the IdP side (the operator's other half)

The IdP needs:

| Field                         | Where in FlowTex's admin UI                                    |
| ----------------------------- | -------------------------------------------------------------- |
| SP entityID                   | "FlowTex SP information" card                                  |
| ACS URL                       | template — replace `<idpId>` with the IdP's row UUID           |
| Metadata URL                  | template — same substitution                                   |
| Signing certificate           | "Show certificate PEM" toggle in the SP info card              |

Most IdPs (Shibboleth, Entra, Okta) can ingest the metadata URL
directly and pull all of the above. Some (older Shibboleth, plain
SAML.NET) need the values pasted individually.

## Required attributes

FlowTex needs three things from every assertion:

| Attribute | Purpose                                                            |
| --------- | ------------------------------------------------------------------ |
| email     | User identity + JIT user creation + link to existing password user |
| name      | Display name (defaults to email if missing)                        |
| NameID    | Canonical identifier used to match returning users                 |

The IdP must release `email` for any user that signs in.

## Testing against samltest.id

samltest.id is a public SAML test IdP run by the Shibboleth
Consortium. Useful for end-to-end testing against an IdP you don't
control. Requires FlowTex to be reachable from the internet.

### Step-by-step

1. Make FlowTex reachable. Either:
   - Deploy to a public host (Caddy + your domain).
   - Use ngrok for short-lived testing: `ngrok http 3001`. Note
     the assigned `https://....ngrok-free.app` URL.

2. In **Admin → SSO**, set up the IdP using these samltest.id
   values:

   ```text
   Display name:           samltest.id (test IdP)
   Metadata XML:           paste the contents of
                           https://samltest.id/saml/idp
   Attribute mapping:      Shibboleth (samltest.id uses eduPerson)
   Allowed email domains:  example.org
                           (samltest.id's test users have @example.org
                            emails)
   JIT provisioning:       on
   Enabled:                on
   ```

3. Click **Save**. Note the IdP's UUID in the list.

4. Tell samltest.id about FlowTex. samltest.id has a self-service
   metadata upload at <https://samltest.id/upload.php>. Paste:
   - your SP metadata XML, available at
     `https://<your-flowtex-host>/api/auth/saml/<idpId>/metadata`

   samltest.id verifies the metadata is parseable and accepts it
   immediately.

5. Sign out of FlowTex (or use an incognito window). On the login
   page you should see "Continue with samltest.id (test IdP)".

6. Click it. You're redirected to samltest.id. Sign in with their
   well-known test credentials:

   ```text
   Username: morty
   Password: panic
   ```

7. samltest.id POSTs the SAMLResponse to FlowTex's ACS. You should
   land back on FlowTex, signed in as `morty@example.org`.

### Cleanup

When you're done testing:
- In FlowTex admin: toggle the IdP **Enabled = off**, then **Delete**
  (delete refuses if any test users are still linked; sign in as one
  of them and delete the user first, then retry).
- Optionally, in samltest.id's metadata UI: remove the SP entry.

## Linking an existing password account

When a user with an existing email-and-password account signs in via
SAML for the first time, FlowTex doesn't auto-link them. Instead, the
ACS handler redirects them to `/login/confirm-saml-link`, where they
see:

- The IdP they signed in to.
- The email the IdP asserted.
- The existing FlowTex account that uses that email.
- An explicit warning: "If you link these accounts, your future
  sign-ins will go through <IdP> only — your FlowTex password will
  be removed."

Two buttons: **Yes, link** or **Cancel**. Cancel destroys the
pending-link state (server-side); the user can still sign in with
their password as before.

The link is final: once the user opts in, the `password_hash` is
NULLed. Recovery requires an admin to use the password-reset flow,
which works for SAML users but routes through a different audit
trail (the reset is logged as `password_reset` not `saml_link`).

## Rotating the SP signing keypair

FlowTex auto-generates a self-signed RSA-2048 keypair on first run,
valid for 3 years. To rotate:

1. **Admin → SSO → Rotate keypair** (two-step confirm).
2. The new certificate is published in the metadata immediately.
3. Coordinate with each IdP admin to re-fetch FlowTex's SP metadata.
   Until they do, signed AuthnRequests from FlowTex will fail
   signature verification on the IdP side.

Audit log: rotations are recorded as `saml_sp_rotate` with the new
SHA-256 fingerprint.

## Disabling SSO for one user

Two options:

1. **Operator-level**: delete the IdP. Refused if any users are
   linked to it. The intended sequence is to convert the linked
   users back to password auth first.
2. **Per-user**: an admin uses the password-reset flow against the
   user's email. The reset establishes a password and switches the
   user's `auth_method` back to `password`.

There is no UI for either operation yet — both are
operator-via-admin-route or SQL.

## CSP

The SAML feature adds no new external script sources. Browser flow
is:
- Same-origin POST to ACS (Origin check bypassed because IdP-initiated)
- Same-origin redirect after ACS
- Strict signature validation on assertion

No CSP changes required when adding an IdP.

## Why FlowTex's SAML doesn't do X

| X                              | Status / reason                                                       |
| ------------------------------ | --------------------------------------------------------------------- |
| Single Logout (SLO)            | Implemented, but only if the IdP publishes an SLO URL. Optional.     |
| SCIM provisioning              | Not implemented. Use JIT.                                            |
| Encrypted assertions           | Validated when received but FlowTex doesn't currently require them.  |
| IdP-initiated SSO              | Not yet supported. SP-initiated only.                                |
| Multi-tenant SP entities       | Not yet; one SP, multiple IdPs.                                      |
| Force-SAML for a domain        | Not yet; users can still use password if they have one.              |

## Troubleshooting

| Symptom                                                              | Likely cause                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| "Sign-in failed. Contact your administrator." after IdP redirect     | Signature, audience, expiry, or issuer mismatch. Check `journalctl -u flowtex` |
| User redirected back to login without signing in                     | Their email domain isn't in the IdP's `allowed_email_domains`                  |
| ACS returns 404 "Unknown identity provider"                          | The IdP's UUID in the URL is wrong, or the IdP was deleted between request and response |
| ACS returns 400 "SAML response too large"                            | Assertion exceeded 256 KB. Possibly an attribute-bomb attack or a misconfigured IdP releasing very many attributes |
| Existing user sees "Cannot be linked to this IdP"                    | Their email domain isn't in the IdP's `allowed_email_domains` (different domain than the IdP claims) |
| User signs in but immediately sees the unconfirmed-link interstitial | Working as designed. They have an existing password account that needs explicit linking |

## Logs to watch

On the operator side, these are the relevant log message patterns:

```text
"SAML ACS rejected assertion"        — a validation failure; check `err`
"SAML ACS handler error"             — an unexpected exception (500)
"SAML SP keypair rotated"            — operator rotated; new fingerprint shipped
"control-channel: signature mismatch"— cluster control channel forgery attempt (audit round 3)
"yjsWorker: oversize update"         — unrelated; here for visibility
```

Audit log actions:

| Action               | When                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `saml_jit_provision` | A new user was JIT-created on first SAML login                    |
| `saml_link`          | An existing password user was linked to SAML (via confirm-link)   |
| `saml_login`         | A returning SAML user signed in                                   |
| `saml_sp_rotate`     | Operator rotated the SP keypair                                   |
| `saml_idp_create`    | Operator added an IdP                                             |
| `saml_idp_update`    | Operator edited an IdP                                            |
| `saml_idp_delete`    | Operator deleted an IdP                                           |
