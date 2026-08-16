#!/usr/bin/env bash
# ============================================================================
#  hypermove-app · scripts/deploy-vps.sh
#  --------------------------------------
#  Deploys hypermove-app (Next.js standalone) + services/llm (llm-service) to
#  the self-managed VPS (PM2 + Caddy — NOT Vercel; vercel.json exists but the
#  app is not deployed there today).
#
#  PRD-A (2026-07-27 dream-cycle-practical-readiness-feedback): captures
#  `git rev-parse HEAD` and a deploy timestamp, injects them as GIT_SHA /
#  DEPLOYED_AT into the VPS's .env for BOTH processes, so /health and
#  /api/mcp/health can report which commit is actually running — a build-time
#  constant, never a runtime `git` call inside the request handler.
#
#  Usage:
#    ./scripts/deploy-vps.sh                 # deploy both services
#    ./scripts/deploy-vps.sh --app-only       # skip llm-service
#    ./scripts/deploy-vps.sh --llm-only       # skip hypermove-app
#
#  Requires: VPS_HOST, VPS_USER, VPS_SSH_KEY env vars (or edit the defaults
#  below). Mirrors the manual sequence this project has used previously:
#  rsync changed files -> pnpm build -> copy public/+.next/static into
#  .next/standalone/ -> pm2 restart -> curl-verify.
# ============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VPS_HOST="${VPS_HOST:-13.212.193.69}"
VPS_USER="${VPS_USER:-ubuntu}"
VPS_SSH_KEY="${VPS_SSH_KEY:-}"
APP_REMOTE_DIR="${APP_REMOTE_DIR:-/home/ubuntu/hypermove-app}"
LLM_REMOTE_DIR="${LLM_REMOTE_DIR:-/home/ubuntu/llm-service}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://hypermove.duckdns.org}"

DEPLOY_APP=1
DEPLOY_LLM=1
for arg in "$@"; do
  case "$arg" in
    --app-only) DEPLOY_LLM=0 ;;
    --llm-only) DEPLOY_APP=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

SSH_OPTS=()
if [[ -n "$VPS_SSH_KEY" ]]; then
  # If the key path contains spaces (e.g. "Telegram Desktop/..."), rsync's
  # own -e/RSYNC_RSH mechanisms re-parse that value through a shell, and no
  # level of manual quoting here survives being re-split by BOTH bash (this
  # script) and rsync's child shell reliably. Sidestep the whole class of
  # bug: symlink the key into a space-free temp path and use that instead.
  if [[ "$VPS_SSH_KEY" == *" "* ]]; then
    SAFE_KEY="$(mktemp -u /tmp/deploy-vps-key.XXXXXX)"
    ln -sf "$VPS_SSH_KEY" "$SAFE_KEY"
    trap 'rm -f "$SAFE_KEY"' EXIT
    VPS_SSH_KEY="$SAFE_KEY"
  fi
  SSH_OPTS+=(-i "$VPS_SSH_KEY")
fi
ssh_cmd()  { ssh "${SSH_OPTS[@]}" "$VPS_USER@$VPS_HOST" "$@"; }
rsync_to() { rsync -avzR -e "ssh ${SSH_OPTS[*]}" "$@" "$VPS_USER@$VPS_HOST:$APP_REMOTE_DIR/"; }

GIT_SHA="$(git rev-parse HEAD)"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "-> deploying commit ${GIT_SHA} at ${DEPLOYED_AT}"

set_env_var() {
  # set_env_var <remote_dir> <KEY> <VALUE> -- idempotent upsert into that
  # remote directory's .env (create the key if absent, replace if present).
  local dir="$1" key="$2" val="$3"
  ssh_cmd "cd '$dir' && touch .env && (grep -q '^${key}=' .env && sed -i \"s|^${key}=.*|${key}=${val}|\" .env || echo '${key}=${val}' >> .env)"
}

if [[ "$DEPLOY_APP" == "1" ]]; then
  echo "-> syncing hypermove-app source changes"
  # Caller is expected to have already run tests/tsc locally; this script
  # only pushes + rebuilds. Add/remove paths here as files change per PRD.
  rsync_to \
    src \
    package.json \
    pnpm-lock.yaml \
    pnpm-workspace.yaml \
    nim.json \
    next.config.mjs

  set_env_var "$APP_REMOTE_DIR" "GIT_SHA" "$GIT_SHA"
  set_env_var "$APP_REMOTE_DIR" "DEPLOYED_AT" "$DEPLOYED_AT"
  set_env_var "$APP_REMOTE_DIR" "NEXT_PUBLIC_MCP_HOST_URL" "$PUBLIC_BASE_URL"
  set_env_var "$APP_REMOTE_DIR" "NEXT_PUBLIC_LLM_API_URL" "${PUBLIC_BASE_URL%/}/llm"

  echo "-> building hypermove-app on VPS (standalone output)"
  ssh_cmd "cd '$APP_REMOTE_DIR' && pnpm install --frozen-lockfile"
  ssh_cmd "cd '$APP_REMOTE_DIR' && pnpm build"
  ssh_cmd "cd '$APP_REMOTE_DIR' && rm -rf .next/standalone/public .next/standalone/.next/static && cp -r public .next/standalone/public && cp -r .next/static .next/standalone/.next/static"
  ssh_cmd "pm2 flush hypermove-app && pm2 restart hypermove-app"
  echo "OK hypermove-app deployed"
fi

if [[ "$DEPLOY_LLM" == "1" ]]; then
  echo "-> syncing services/llm/server.ts + start.sh"
  rsync -avz -e "ssh ${SSH_OPTS[*]}" services/llm/server.ts services/llm/start.sh "$VPS_USER@$VPS_HOST:$LLM_REMOTE_DIR/"
  ssh_cmd "chmod +x '$LLM_REMOTE_DIR/start.sh'"

  set_env_var "$LLM_REMOTE_DIR" "GIT_SHA" "$GIT_SHA"
  set_env_var "$LLM_REMOTE_DIR" "DEPLOYED_AT" "$DEPLOYED_AT"

  # llm-service must be registered under PM2 via start.sh (sources .env
  # fresh on every start) — a plain `pm2 restart` on a process originally
  # started with a bare `tsx server.ts` command does NOT re-read .env, so
  # GIT_SHA/DEPLOYED_AT (and any future new env var) would silently stay
  # stale forever. If already registered via start.sh, a plain restart is
  # sufficient (start.sh itself re-sources .env on every process boot).
  ssh_cmd "pm2 restart llm-service"
  echo "OK llm-service deployed"
fi

sleep 3
echo "-> verifying live health endpoints"
ssh_cmd "curl -s http://localhost:3003/api/mcp/health | head -c 400; echo; curl -s http://localhost:3001/health; echo"
echo "OK deploy complete -- commit ${GIT_SHA:0:12} should now appear in both /health responses"
