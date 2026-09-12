#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
docker compose --profile mirror pull mirror
docker compose --profile mirror up -d --no-build --wait --wait-timeout 180 mirror
printf '\nMirror ready: http://127.0.0.1:8080/health\n'
