#!/usr/bin/env bash
# Build both Docker images in order. The base image (Node + TeX Live, ~1.5GB)
# rarely changes and is cached aggressively; the runtime image rebuilds
# whenever you change app code.
#
# Usage:
#   scripts/docker-build.sh             # build both, tag as :latest
#   scripts/docker-build.sh v1.2.3      # build both, tag with version
#   scripts/docker-build.sh --base-only # rebuild only the base (after Node/TeX upgrades)
#
# After this completes, `docker compose up -d` will start the stack.

set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-latest}"
BASE_ONLY=false
if [[ "${TAG}" == "--base-only" ]]; then
  BASE_ONLY=true
  TAG="latest"
fi

echo "── 1/2  Building flowtex-base (Node 22 + TeX Live, this can take 5-10 min on first build)"
docker build -f Dockerfile.base -t "flowtex-base:${TAG}" -t flowtex-base:latest .

if [[ "${BASE_ONLY}" == "true" ]]; then
  echo "── Done (base only). Skipping app image."
  exit 0
fi

echo "── 2/2  Building flowtex (app)"
docker build -t "flowtex:${TAG}" -t flowtex:latest .

echo
echo "Done. Images:"
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' | grep -E '^flowtex' | head -10
echo
echo "Next: docker compose up -d"
