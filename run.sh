#!/usr/bin/env bash
# ============================================================================
#  hypermove-app · run.sh
#  ----------------------
#  Single entry point for the full app lifecycle.
#
#  Usage:
#    ./run.sh setup       Install deps, scaffold .env.local, run doctor
#    ./run.sh dev         Boot Next.js dev server on :3003 (zero-config mock mode)
#    ./run.sh test        Run vitest suite (S1 + S2 smoke)
#    ./run.sh build       Production build (standalone output, ready for Docker)
#    ./run.sh start       Boot the production server (after `build`)
#    ./run.sh smoke       Boot prod server + curl every route + assert 200/402
#    ./run.sh report      Regenerate tracking/PERFORMANCE.md
#    ./run.sh docker      Build the Docker image (requires running daemon)
#    ./run.sh docker-run  Run the Docker image on :3003
#    ./run.sh ship        full pipeline: setup → test → build → smoke → report
#    ./run.sh doctor      Check Node/pnpm/npm versions + env vars + ports
#    ./run.sh clean       Remove .next, node_modules, coverage, generated logs
#    ./run.sh help        Show this usage
#
#  No subcommand → defaults to `dev`.
# ============================================================================

set -euo pipefail

# -- config -------------------------------------------------------------------
APP_NAME="hypermove-app"
APP_PORT="${PORT:-3003}"
NODE_MIN_MAJOR=20
LOG_DIR="$HOME/.${APP_NAME}/logs"
PID_FILE="$HOME/.${APP_NAME}/server.pid"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# -- colors -------------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD="$(tput bold 2>/dev/null || true)"
  DIM="$(tput dim 2>/dev/null || true)"
  RED="$(tput setaf 1 2>/dev/null || true)"
  GREEN="$(tput setaf 2 2>/dev/null || true)"
  YELLOW="$(tput setaf 3 2>/dev/null || true)"
  BLUE="$(tput setaf 4 2>/dev/null || true)"
  CYAN="$(tput setaf 6 2>/dev/null || true)"
  RESET="$(tput sgr0 2>/dev/null || true)"
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" CYAN="" RESET=""
fi

log()   { printf "%s▸%s %s\n" "$CYAN"  "$RESET" "$*"; }
ok()    { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }
warn()  { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$*" >&2; }
err()   { printf "%s✗%s %s\n" "$RED"   "$RESET" "$*" >&2; }
fatal() { err "$*"; exit 1; }

banner() {
  printf '%s%s┌──────────────────────────────────────────────────────────┐%s\n' "$BOLD" "$BLUE" "$RESET"
  printf '%s%s│  %-56s│%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s%s└──────────────────────────────────────────────────────────┘%s\n' "$BOLD" "$BLUE" "$RESET"
}

# -- helpers ------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

pick_pm() {
  if have pnpm; then echo "pnpm"
  elif have npm; then echo "npm"
  else fatal "neither pnpm nor npm found — install Node.js + pnpm first"
  fi
}

require_node() {
  have node || fatal "node not installed — install Node ${NODE_MIN_MAJOR}+ from https://nodejs.org"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "0")"
  if (( major < NODE_MIN_MAJOR )); then
    fatal "node $major found; need $NODE_MIN_MAJOR or higher (package.json engines.node)"
  fi
}

ensure_dirs() { mkdir -p "$LOG_DIR" "$(dirname "$PID_FILE")"; }

ensure_env_local() {
  if [[ ! -f .env.local ]]; then
    if [[ -f .env.example ]]; then
      cp .env.example .env.local
      ok "scaffolded .env.local from .env.example (LIVE_AGENT_MODE=mock — zero-config)"
    else
      warn ".env.example missing; skipping .env.local creation"
    fi
  fi
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_for_url() {
  local url=$1 timeout=${2:-30} elapsed=0
  while ! curl -sf -o /dev/null "$url"; do
    sleep 1
    elapsed=$((elapsed + 1))
    (( elapsed >= timeout )) && return 1
  done
  return 0
}

assert_http() {
  local method=$1 url=$2 expected=$3 hdr=${4:-}
  local actual
  if [[ -n "$hdr" ]]; then
    actual=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" -H "$hdr" "$url")
  else
    actual=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$url")
  fi
  if [[ "$actual" == "$expected" ]]; then
    printf "    %s%s %s%s%-22s %s→ HTTP %s%s\n" "$DIM" "$method" "$RESET" "$BOLD" "$url" "$GREEN" "$actual" "$RESET"
    return 0
  else
    printf "    %s%s %s%s%-22s %s→ HTTP %s (expected %s)%s\n" "$DIM" "$method" "$RESET" "$BOLD" "$url" "$RED" "$actual" "$expected" "$RESET"
    return 1
  fi
}

# -- subcommands --------------------------------------------------------------
cmd_doctor() {
  banner "doctor — environment + ports"
  require_node
  ok "node $(node --version)"
  if have pnpm; then ok "pnpm $(pnpm --version)"; else warn "pnpm not installed (npm fallback works)"; fi
  if have npm;  then ok "npm  $(npm  --version)"; fi
  if have docker; then
    if docker info >/dev/null 2>&1; then ok "docker daemon reachable ($(docker --version))"
    else warn "docker CLI present, daemon not running"; fi
  else
    warn "docker not installed (only needed for ./run.sh docker)"
  fi
  if port_busy "$APP_PORT"; then
    warn "port $APP_PORT busy — set PORT=<n> before ./run.sh dev|start"
  else
    ok "port $APP_PORT free"
  fi
  [[ -f .env.local ]] && ok ".env.local present" || warn ".env.local missing (will be created by ./run.sh setup)"
  [[ -d node_modules ]] && ok "node_modules present" || warn "node_modules missing (run ./run.sh setup)"
  [[ -f tracking/task-log.json ]] && ok "tracking/task-log.json present" || warn "tracking missing"
}

cmd_setup() {
  banner "setup — install deps + bootstrap env"
  require_node
  ensure_dirs
  ensure_env_local
  local PM
  PM=$(pick_pm)
  log "installing with $PM (this is a one-time cost; ~25s on cold cache)"
  $PM install
  ok "dependencies installed"
  cmd_doctor
  ok "ready — try: ./run.sh dev"
}

cmd_dev() {
  [[ -d node_modules ]] || cmd_setup
  ensure_env_local
  banner "dev — Next.js on :$APP_PORT (zero-config mock mode)"
  log "open http://localhost:$APP_PORT  ·  Ctrl+C to stop"
  exec $(pick_pm) dev
}

cmd_test() {
  [[ -d node_modules ]] || cmd_setup
  banner "test — vitest (S1 + S2 smoke)"
  $(pick_pm) test
  ok "all tests passed"
}

cmd_build() {
  [[ -d node_modules ]] || cmd_setup
  banner "build — Next.js production (standalone output)"
  $(pick_pm) build
  if [[ -f .next/standalone/server.js ]]; then
    local size
    size=$(du -sh .next/standalone/ | awk '{print $1}')
    ok "build complete · .next/standalone/ ($size) ready for Docker"
  else
    fatal "standalone artifact missing; check next.config.mjs output:'standalone'"
  fi
}

cmd_start() {
  ensure_dirs
  [[ -d .next ]] || cmd_build
  banner "start — production server on :$APP_PORT"
  log "logs → $LOG_DIR/server.log  ·  ./run.sh stop or Ctrl+C"
  exec $(pick_pm) start
}

cmd_start_bg() {
  ensure_dirs
  [[ -d .next ]] || cmd_build
  $(pick_pm) start >"$LOG_DIR/server.log" 2>&1 &
  echo $! >"$PID_FILE"
  if ! wait_for_url "http://localhost:$APP_PORT/" 30; then
    cmd_stop_bg || true
    fatal "server did not become ready in 30s (see $LOG_DIR/server.log)"
  fi
  ok "production server up on :$APP_PORT (pid $(cat "$PID_FILE"))"
}

cmd_stop_bg() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      ok "server pid $pid stopped"
    fi
    rm -f "$PID_FILE"
  fi
}

cmd_smoke() {
  banner "smoke — boot prod server + curl every route"
  cmd_build
  cmd_start_bg
  trap cmd_stop_bg EXIT
  local failed=0
  log "pages"
  assert_http GET "http://localhost:$APP_PORT/"                 200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/docs/n-payment"   200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/docs/quickstart"  200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/pricing"          200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/portal"           200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/dashboard"        200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/registry"         200 || failed=$((failed+1))
  log "machine endpoints"
  assert_http GET "http://localhost:$APP_PORT/.well-known/webmcp.json" 200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/.well-known/agent.json"  200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/bundles.json"            200 || failed=$((failed+1))
  log "api"
  assert_http GET "http://localhost:$APP_PORT/api/revenue"       200 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/api/mcp"           200 || failed=$((failed+1))
  log "x402 paywall contract"
  assert_http GET "http://localhost:$APP_PORT/api/paid-endpoint" 402 || failed=$((failed+1))
  assert_http GET "http://localhost:$APP_PORT/api/paid-endpoint" 200 "x-payment: mock-sig" || failed=$((failed+1))
  log "verifying WWW-Authenticate header"
  if curl -s -i "http://localhost:$APP_PORT/api/paid-endpoint" | grep -qi 'www-authenticate:.*x402-USDC'; then
    ok "WWW-Authenticate: x402-USDC contract confirmed"
  else
    err "WWW-Authenticate header missing or wrong"
    failed=$((failed+1))
  fi
  log "/portal bundle-request form (Server Action)"
  local portal_html
  portal_html=$(curl -s "http://localhost:$APP_PORT/portal")
  if printf '%s' "$portal_html" | grep -q 'Request bundle'; then
    ok "/portal renders bundle catalog + email request form"
  else
    err "/portal HTML missing 'Request bundle' CTA"
    failed=$((failed+1))
  fi
  if printf '%s' "$portal_html" | grep -q 'data-tool-name\|bundle-card\|x402-base-starter'; then
    ok "/portal lists at least one bundle from public/bundles.json"
  else
    # Check for any bundle id from the catalog as fallback
    if printf '%s' "$portal_html" | grep -qE 'x402-(base|multi)|btc-treasury|paid-mcp|xrpl-rlusd'; then
      ok "/portal lists at least one bundle from public/bundles.json"
    else
      err "/portal HTML missing bundle catalog entries"
      failed=$((failed+1))
    fi
  fi
  log "/api/agent SSE stream"
  local sse_ctype sse_body
  sse_ctype=$(curl -s -o /dev/null -N --max-time 1 -w '%{content_type}' "http://localhost:$APP_PORT/api/agent" || true)
  if [[ "$sse_ctype" == text/event-stream* ]]; then
    ok "Content-Type: $sse_ctype"
  else
    err "/api/agent did not return text/event-stream (got '$sse_ctype')"
    failed=$((failed+1))
  fi
  sse_body=$(curl -s -N --max-time 3 "http://localhost:$APP_PORT/api/agent" 2>/dev/null | head -c 400 || true)
  if printf '%s' "$sse_body" | grep -q 'event: frame'; then
    ok "first SSE frame received"
  else
    err "no 'event: frame' in first 400 bytes (got: $(printf '%s' "$sse_body" | head -c 80))"
    failed=$((failed+1))
  fi
  cmd_stop_bg
  trap - EXIT
  if (( failed > 0 )); then fatal "$failed smoke check(s) failed"; fi
  ok "all smoke checks passed"
}

cmd_report() {
  [[ -d node_modules ]] || cmd_setup
  banner "report — regenerate tracking/PERFORMANCE.md"
  $(pick_pm) report
  ok "tracking/PERFORMANCE.md updated"
}

cmd_docker() {
  have docker || fatal "docker not installed"
  docker info >/dev/null 2>&1 || fatal "docker daemon not running (open Docker Desktop)"
  banner "docker build — $APP_NAME"
  docker build -t "$APP_NAME:latest" .
  local size
  size=$(docker image inspect "$APP_NAME:latest" --format='{{.Size}}' | awk '{printf "%.0f MB", $1/1024/1024}')
  ok "image built · $APP_NAME:latest ($size)"
}

cmd_docker_run() {
  have docker || fatal "docker not installed"
  docker info >/dev/null 2>&1 || fatal "docker daemon not running"
  banner "docker run — $APP_NAME on :$APP_PORT"
  exec docker run --rm -it -p "$APP_PORT:3003" \
    --env-file ".env.local" \
    --name "$APP_NAME" \
    "$APP_NAME:latest"
}

cmd_ship() {
  banner "ship — setup → test → build → smoke → report"
  cmd_setup
  cmd_test
  cmd_build
  cmd_smoke
  cmd_report
  banner "✓ ship complete"
  ok "everything green. deploy: vercel deploy   OR   ./run.sh docker && ./run.sh docker-run"
}

cmd_clean() {
  banner "clean — remove generated artifacts"
  rm -rf .next out node_modules coverage "$LOG_DIR" 2>/dev/null || true
  ok "removed: .next, out, node_modules, coverage, $LOG_DIR"
}

cmd_help() {
  cat <<'USAGE'
hypermove-app · run.sh
----------------------
Single entry point for the full app lifecycle.

Usage:
  ./run.sh setup        Install deps, scaffold .env.local, run doctor
  ./run.sh dev          Boot Next.js dev server on :3003 (zero-config mock mode)
  ./run.sh test         Run vitest suite (S1 + S2 smoke)
  ./run.sh build        Production build (standalone output, ready for Docker)
  ./run.sh start        Boot the production server (after `build`)
  ./run.sh stop         Stop the background production server started by smoke
  ./run.sh smoke        Boot prod server + curl every route + assert 200/402
  ./run.sh report       Regenerate tracking/PERFORMANCE.md
  ./run.sh docker       Build the Docker image (requires running daemon)
  ./run.sh docker-run   Run the Docker image on :3003
  ./run.sh ship         full pipeline: setup → test → build → smoke → report
  ./run.sh doctor       Check Node/pnpm/npm versions + env vars + ports
  ./run.sh clean        Remove .next, node_modules, coverage, generated logs
  ./run.sh help         Show this usage

No subcommand → defaults to `dev`.

Env vars:
  PORT=<n>              Override the listen port (default 3003)
  LIVE_AGENT_MODE       mock (default) | real (requires ANTHROPIC_API_KEY)
USAGE
}

# -- dispatcher ---------------------------------------------------------------
main() {
  local sub=${1:-dev}
  shift || true
  case "$sub" in
    setup)        cmd_setup       "$@" ;;
    dev)          cmd_dev         "$@" ;;
    test)         cmd_test        "$@" ;;
    build)        cmd_build       "$@" ;;
    start)        cmd_start       "$@" ;;
    stop)         cmd_stop_bg     "$@" ;;
    smoke)        cmd_smoke       "$@" ;;
    report)       cmd_report      "$@" ;;
    docker)       cmd_docker      "$@" ;;
    docker-run)   cmd_docker_run  "$@" ;;
    ship)         cmd_ship        "$@" ;;
    doctor)       cmd_doctor      "$@" ;;
    clean)        cmd_clean       "$@" ;;
    help|-h|--help) cmd_help ;;
    *) cmd_help; fatal "unknown subcommand: $sub" ;;
  esac
}

main "$@"
