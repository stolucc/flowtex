#!/usr/bin/env bash
# build-app.sh — turn a Mach-O binary into a minimal macOS .app bundle.
#
# Usage: build-app.sh <binary> <output.app> <arch>
#
# The bundle structure mirrors what Xcode produces for a plain Cocoa
# app, minus the Resources/ assets (no icon, no nib). LSUIElement=true
# makes it a "menu-bar-only" app — no Dock tile, no menu bar of its own.
#
# The binary is ad-hoc codesigned (`codesign --sign -`) so Apple Silicon
# doesn't kill it with "Killed: 9" on first launch. Ad-hoc is free and
# defeats the worst of Gatekeeper; for a notarized release the caller
# can re-sign with a Developer ID afterwards.

set -euo pipefail

BIN="${1:?usage: build-app.sh <binary> <output.app> <arch>}"
APP="${2:?usage: build-app.sh <binary> <output.app> <arch>}"
ARCH="${3:?usage: build-app.sh <binary> <output.app> <arch>}"

if [ ! -f "$BIN" ]; then
  echo "binary not found: $BIN" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/flowtex-helper"
chmod +x "$APP/Contents/MacOS/flowtex-helper"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>FlowTex Helper</string>
  <key>CFBundleDisplayName</key>
  <string>FlowTex Helper</string>
  <key>CFBundleIdentifier</key>
  <string>click.flowtex.helper</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>flowtex-helper</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

# Ad-hoc codesign. --deep is harmless here (we have no nested code) and
# keeps parity with the install.sh flow. Re-signing with a Developer ID
# can be layered on top by callers that have one.
codesign --force --deep --sign - "$APP"

echo "built: $APP ($ARCH)"
