#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
if [ -f .env ]; then source .env; fi
set +a
export PORT="${PORT:-3003}"
# The trusted reverse proxy is the sole public ingress.
export HOSTNAME=127.0.0.1
exec node .next/standalone/server.js
