#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a
if [ -f services/flashloan/.env ]; then source services/flashloan/.env; fi
set +a
exec node services/flashloan/dist/services/flashloan/server.js --serve
