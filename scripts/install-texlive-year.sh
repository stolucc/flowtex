#!/usr/bin/env bash
# install-texlive-year.sh — install a specific TeX Live annual release into
# /usr/local/texlive/$YEAR/, alongside any existing system TeX Live, so the
# "TeX Live Distribution" picker in Project Settings has more than one option
# to choose from.
#
# Why this is needed: detectTexDistributions() in server/compiler.js scans
# /usr/local/texlive/<year>/bin/<arch>/pdflatex. Ubuntus apt-installed
# texlive-full lives at /usr/share/texlive/ and is therefore not detected as
# a switchable distribution — only the default PATH. This script puts a TUG
# net-installed release at the expected path so the picker can list it.
#
# Usage (run as root, e.g. via sudo):
#   ./install-texlive-year.sh 2024
#   ./install-texlive-year.sh 2024 medium     # change scheme
#   FORCE=1 ./install-texlive-year.sh 2024    # overwrite an existing year
#
# Scheme defaults to "basic" — smallest scheme that includes pdflatex +
# common packages. Pass "small" / "medium" / "full" for more packages at
# the cost of more disk + a longer download. "full" can be multiple GB and
# take a long time; user previously hit timeouts on texlive-full.
#
# Schemes available in TL: minimal, basic, small, medium, full, plus tex,
# context, gust, latex, infraonly. See `tlmgr help` for the canonical list.

set -euo pipefail

YEAR="${1:-}"
SCHEME="${2:-basic}"
FORCE="${FORCE:-0}"

if [ -z "$YEAR" ]; then
  echo "Usage: $0 <year> [scheme]" >&2
  echo "Example: $0 2024 basic" >&2
  exit 64
fi

if ! [[ "$YEAR" =~ ^[0-9]{4}$ ]]; then
  echo "Year must be a 4-digit number (got: $YEAR)" >&2
  exit 64
fi

CURRENT_YEAR="$(date +%Y)"
TARGET_DIR="/usr/local/texlive/$YEAR"

if [ "$EUID" -ne 0 ]; then
  echo "This script writes to /usr/local/texlive/ — run as root (sudo)." >&2
  exit 77
fi

if [ -d "$TARGET_DIR" ] && [ "$FORCE" != "1" ]; then
  echo "$TARGET_DIR already exists. Re-run with FORCE=1 to wipe and reinstall." >&2
  exit 0
fi

# Pick the right tarball URL. Current year lives at the live mirror; older
# years live in the historic archive (ftp.math.utah.edu mirrors TUG).
if [ "$YEAR" = "$CURRENT_YEAR" ]; then
  TARBALL_URL="https://mirror.ctan.org/systems/texlive/tlnet/install-tl-unx.tar.gz"
  REPOSITORY="https://mirror.ctan.org/systems/texlive/tlnet"
else
  TARBALL_URL="https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/$YEAR/install-tl-unx.tar.gz"
  REPOSITORY="https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/$YEAR/tlnet-final"
fi

echo "==> Installing TeX Live $YEAR (scheme: $SCHEME) into $TARGET_DIR"
echo "    tarball:    $TARBALL_URL"
echo "    repository: $REPOSITORY"

# Clean previous attempts if any.
if [ -d "$TARGET_DIR" ]; then
  echo "==> FORCE=1: removing existing $TARGET_DIR"
  rm -rf "$TARGET_DIR"
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$WORKDIR"
echo "==> Downloading install-tl"
curl -fSL --retry 3 -o install-tl.tar.gz "$TARBALL_URL"
tar xzf install-tl.tar.gz
INSTALL_DIR="$(find . -maxdepth 1 -name 'install-tl-*' -type d | head -n1)"
if [ -z "$INSTALL_DIR" ]; then
  echo "Failed to locate extracted install-tl directory" >&2
  exit 1
fi

cat >"$WORKDIR/texlive.profile" <<EOF
selected_scheme scheme-$SCHEME
TEXDIR $TARGET_DIR
TEXMFLOCAL $TARGET_DIR/texmf-local
TEXMFSYSCONFIG $TARGET_DIR/texmf-config
TEXMFSYSVAR $TARGET_DIR/texmf-var
instopt_adjustpath 0
instopt_adjustrepo 1
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
tlpdbopt_autobackup 0
EOF

echo "==> Running install-tl (this can take several minutes)"
"$INSTALL_DIR/install-tl" \
  -profile "$WORKDIR/texlive.profile" \
  -repository "$REPOSITORY" \
  -no-interaction

# Verify by invoking pdflatex from the new install.
ARCH_BIN=""
for arch in x86_64-linux aarch64-linux universal-darwin x86_64-darwin; do
  if [ -x "$TARGET_DIR/bin/$arch/pdflatex" ]; then
    ARCH_BIN="$TARGET_DIR/bin/$arch"
    break
  fi
done

if [ -z "$ARCH_BIN" ]; then
  echo "Install completed but pdflatex was not found in $TARGET_DIR/bin/*/" >&2
  exit 1
fi

echo
echo "==> Installed:"
"$ARCH_BIN/pdflatex" --version | head -n 2
echo
echo "==> Done. The FlowTex distribution detector (server/compiler.js) caches"
echo "    its results for 60s; restart the FlowTex server or wait a minute"
echo "    before the new option appears in the project picker."
