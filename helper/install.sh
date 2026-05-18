#!/usr/bin/env bash
#
# flowtex-helper installer. Downloads the right pre-built binary from
# the latest GitHub Release, drops it in /usr/local/bin (or $HOME/bin
# as a fallback), and prints next steps.
#
# Usage:
#   curl -sSL https://github.com/stolucc/flowtex/releases/latest/download/install.sh | bash
#
# Or for a specific version:
#   curl -sSL https://github.com/stolucc/flowtex/releases/download/helper-v0.1.0/install.sh | bash
#
# No sudo by default. Falls back to $HOME/bin if /usr/local/bin is not
# writable, and tells the user how to add it to PATH.

set -euo pipefail

REPO="stolucc/flowtex"
BINARY_NAME="flowtex-helper"

# ── Detect OS + arch ──────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux  ;;
  *)
    echo "Unsupported OS: $(uname -s). Windows users should follow the README to build from source." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=amd64 ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

# Mac amd64 binaries don't exist for arm64 hardware — bail rather than
# silently downloading a Rosetta-only binary on Apple Silicon.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "amd64" ]; then
  echo "Note: building amd64 binary on Apple Silicon will need Rosetta 2." >&2
fi

ASSET="${BINARY_NAME}-${OS}-${ARCH}"

# ── Pick install dir ──────────────────────────────────────────────────
if [ -w "/usr/local/bin" ] 2>/dev/null; then
  INSTALL_DIR="/usr/local/bin"
elif [ -d "/opt/homebrew/bin" ] && [ -w "/opt/homebrew/bin" ] 2>/dev/null; then
  INSTALL_DIR="/opt/homebrew/bin"
else
  INSTALL_DIR="$HOME/bin"
  mkdir -p "$INSTALL_DIR"
fi

# ── Resolve download URL ──────────────────────────────────────────────
# This script ships as part of a release; we expect the same release to
# contain the binary alongside us. Try a few URL shapes so the script
# works whether the user piped the latest installer or a tagged one.
if [ -n "${FLOWTEX_HELPER_VERSION:-}" ]; then
  TAG="helper-v${FLOWTEX_HELPER_VERSION}"
else
  # Resolve "latest" via the GitHub API. The script is small and runs
  # rarely, so the 60-req/hour anon rate limit is fine.
  echo "Looking up latest flowtex-helper release..." >&2
  TAG=$(curl -sSL "https://api.github.com/repos/${REPO}/releases" \
      | grep -oE '"tag_name":\s*"helper-v[^"]+"' \
      | head -1 \
      | sed -E 's/.*"helper-v([^"]+)".*/helper-v\1/')
  if [ -z "$TAG" ]; then
    echo "Could not resolve latest helper release. Pass FLOWTEX_HELPER_VERSION=x.y.z to force a version." >&2
    exit 1
  fi
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS"

echo "Downloading $ASSET from $TAG ..." >&2
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -sSL -f -o "$TMP/$ASSET" "$URL"
curl -sSL -f -o "$TMP/SHA256SUMS" "$CHECKSUMS_URL" || {
  echo "Warning: could not fetch SHA256SUMS — skipping checksum verification." >&2
}

# ── Verify checksum (if available) ────────────────────────────────────
if [ -f "$TMP/SHA256SUMS" ]; then
  EXPECTED=$(grep "  $ASSET$" "$TMP/SHA256SUMS" | awk '{print $1}' || true)
  if [ -n "$EXPECTED" ]; then
    if command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
    else
      ACTUAL=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
    fi
    if [ "$EXPECTED" != "$ACTUAL" ]; then
      echo "Checksum mismatch! Expected $EXPECTED, got $ACTUAL. Refusing to install." >&2
      exit 1
    fi
    echo "Checksum verified." >&2
  fi
fi

# ── Install ───────────────────────────────────────────────────────────
chmod +x "$TMP/$ASSET"
mv "$TMP/$ASSET" "$INSTALL_DIR/$BINARY_NAME"

echo
echo "Installed $BINARY_NAME to $INSTALL_DIR"
echo

# ── Next steps ────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "WARNING: $INSTALL_DIR is not on your PATH. Add this line to your shell rc:"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    echo
    ;;
esac

echo "Next steps:"
echo "  1. Run the helper in a terminal:"
echo "       $BINARY_NAME"
echo
echo "  2. In FlowTex (any tab), open Account Settings → Compile."
echo "     The status should turn yellow (helper running, not paired) within ~3s."
echo
echo "  3. To pair, in a second terminal:"
echo "       $BINARY_NAME pair"
echo "     Copy the 6-digit code into the FlowTex pairing dialog."
echo
echo "  4. Set your default compile location to 'My local TeX Live'"
echo "     in the same Compile tab."
echo
