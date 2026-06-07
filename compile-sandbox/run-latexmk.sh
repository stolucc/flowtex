#!/bin/sh
# SAAS-FOUNDATIONS item 1 -- compile-sandbox entrypoint.
#
# Forwards argv to latexmk verbatim. Kept as a separate script so the
# image can grow auxiliary work (cgroup probes, profile flushes, log
# dumps) without changing the docker run argv on the server.
#
# Defence-in-depth: TeX itself is constrained at the engine level by
# the caller (--no-shell-escape, etc.). At THIS layer we also:
#   - clamp $HOME so kpsewhich doesn't try to read ~/.texlive
#   - clamp TEXMFHOME so per-user texmf trees are ignored
#   - hard-disable openin_any / openout_any for paranoia (caller
#     should set these too; doing it here is belt-and-braces)

set -eu

export HOME=/tmp
export TEXMFHOME=/tmp/texmf
export TEXMFCACHE=/tmp/texmf-cache
export TEXMFVAR=/tmp/texmf-var
export TEXMFCONFIG=/tmp/texmf-config

# Required by some packages (microtype) that try to mkdir under
# $TEXMFVAR on first use.
mkdir -p "$TEXMFHOME" "$TEXMFCACHE" "$TEXMFVAR" "$TEXMFCONFIG"

# openin_any=p (paranoid) -- TeX may only open files in or under the
# current dir. openout_any=p same for writes. The caller also passes
# --no-shell-escape but these are the engine-level kill switch.
export openin_any=p
export openout_any=p

exec /usr/bin/latexmk "$@"
