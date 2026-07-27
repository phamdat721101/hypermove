#!/usr/bin/env bash
# Starts llm-service (services/llm/server.ts) with .env loaded fresh into the
# process environment on every start/restart. Without this, PM2 only
# captures env vars at the moment of the ORIGINAL `pm2 start` — a later
# `pm2 restart` (even with --update-env) does not re-read this directory's
# .env file, so a value added after the process was first started (e.g.
# GIT_SHA/DEPLOYED_AT, added 2026-07-27 for PRD-A) would silently stay null
# forever on every subsequent deploy. Matches hypermove-app's own
# start-standalone.sh wrapper, same rationale.
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
[ -f ./.env ] && source ./.env
set +a
exec npx tsx server.ts
