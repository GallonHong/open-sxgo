#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
docker compose --profile mirror pull mirror
if command -v sha256sum >/dev/null 2>&1; then
  root_hash=$(sha256sum bootstrap/demo-root.json | cut -c1-16)
else
  root_hash=$(shasum -a 256 bootstrap/demo-root.json | cut -c1-16)
fi
# Preserve old snapshots when the operator changes the pinned trust root.
export MIRROR_VOLUME_NAME="open-sxgo-mirror-$root_hash"
docker compose --profile mirror up -d --no-build --wait --wait-timeout 180 mirror
printf '\nMirror ready: http://127.0.0.1:8080/health\n'
