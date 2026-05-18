# macOS code signing for flowtex-helper

By default the helper binaries published to GitHub Releases are
**unsigned**. macOS users see a Gatekeeper warning on first launch
("Apple cannot verify that this app is free of malware") and have to
run a one-line `xattr -d com.apple.quarantine` to allow it. The
in-app install guide walks them through this; it's a one-time
annoyance, not a blocker.

This doc explains how to flip on full code-signing + Apple
notarization so end users get a clean first-launch experience with
no extra steps. The CI workflow already has the signing logic
wired up — it just no-ops as long as the secrets aren't configured.

> **Cost: $99 USD / year** for the Apple Developer Program. Skip this
> doc if that doesn't pencil out — the `xattr` workaround is fine
> for low-volume distribution.

## What you get when this is set up

| Before | After |
| --- | --- |
| User downloads binary | User downloads binary |
| Run binary → "Cannot verify developer" warning | Run binary → just runs |
| User runs `xattr -d com.apple.quarantine` | (no extra step) |
| User runs binary → works | |

Notarization is the second half: Apple actually scans your signed
binary for malware. A *signed* but un-notarized binary still hits a
"verify with Apple" warning on first run; a *signed + notarized*
binary runs silently.

## Prerequisites

1. **Apple Developer Program membership** ($99/yr, signs up at
   developer.apple.com). Individual or Organization tier, both work.
2. **A Developer ID Application certificate** generated in Xcode or
   the Apple Developer portal. This is the production-distribution
   cert, NOT the Mac App Store one.
3. **An app-specific password** for your Apple ID, generated at
   [appleid.apple.com](https://appleid.apple.com) → Sign-In and
   Security → App-Specific Passwords → Generate. Notarization uses
   this rather than your real Apple ID password.

## Export the certificate

In **Keychain Access**:

1. Find your "Developer ID Application: Your Name (TEAMID)" cert
   in the login keychain.
2. Right-click → **Export "Developer ID Application: ..."** →
   Save as `flowtex-codesign.p12`. Set a strong password — you'll
   add this to GitHub Secrets in a minute.
3. Encode the `.p12` as base64 (so it survives as a GitHub Secret
   string):

```bash
base64 -i flowtex-codesign.p12 -o flowtex-codesign.p12.b64
```

## Find your codesign identity + team ID

```bash
# The full name to pass to `codesign --sign`:
security find-identity -p codesigning -v
# Output line looks like:
#   1) 0123456789ABCDEF... "Developer ID Application: Jane Doe (XYZ1234567)"
# Copy "Developer ID Application: Jane Doe (XYZ1234567)" verbatim.

# Just the 10-char Team ID:
# Same line, the part inside (parentheses) → XYZ1234567
```

## Add the secrets to GitHub

Repo → **Settings → Secrets and variables → Actions → New repository
secret**. Add all six:

| Name | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12` | Contents of the `.p12.b64` file you just made (copy-paste the full base64 blob). |
| `MACOS_CERTIFICATE_PASSWORD` | Password you set when exporting the .p12. |
| `MACOS_CODESIGN_IDENTITY` | The full `Developer ID Application: Jane Doe (XYZ1234567)` string. |
| `APPLE_ID` | Your Apple ID email. |
| `APPLE_TEAM_ID` | The 10-char Team ID (e.g. `XYZ1234567`). |
| `APPLE_APP_PASSWORD` | The app-specific password from appleid.apple.com. |

All six must be set for full signing + notarization. The CI workflow
auto-skips both steps if any of the first three are missing
(unsigned binary), or skips just notarization if any of the last
three are missing (signed but not notarized).

## Trigger a release

Push a new `helper-v*` tag:

```bash
git tag helper-v0.1.2
git push origin helper-v0.1.2
```

The release workflow runs. Watch it at `Actions → helper-release`.
The "Code-sign + notarize (macOS, optional)" step should now
actually sign and notarize. A successful notarization takes 1-3
minutes (Apple's side); the step waits for completion.

## Verify the result

Download the new mac binary from the release. Run:

```bash
# Should print "valid on disk" + "satisfies its Designated Requirement"
codesign --verify --deep --strict --verbose=2 flowtex-helper-darwin-arm64

# Notarization check (online lookup):
spctl -a -t exec -vvv flowtex-helper-darwin-arm64
# Should say: "accepted, source=Notarized Developer ID"
```

If both pass, downstream users no longer need to `xattr`. You can
also update the in-app install guide to drop the
quarantine-removal step — see
`client/src/components/MfaSetupModal.jsx`'s `HelperInstallGuide`
component, the "After download" details element.

## Rotating the cert

Developer ID Application certs are valid for 5 years. When yours
expires, generate a new one, re-export to .p12, re-encode to base64,
and update the `MACOS_CERTIFICATE_P12` secret. No code change
required. Re-tag and re-release.

## What's NOT signed

The `flowtex-helper-linux-amd64` binary. Linux doesn't have a
Gatekeeper analogue; users just `chmod +x` and run. The SHA256SUMS
file in the release is enough for verification.

The `install.sh` script is also unsigned, but it verifies the
binary it downloads against SHA256SUMS, so a compromised CDN can't
swap the binary out without users noticing.
