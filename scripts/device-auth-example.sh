#!/usr/bin/env bash
# hypermove-device-auth.sh — get an MCP bearer token with no browser,
# no wallet extension, no email. Just this terminal.
#
# Usage: ./hypermove-device-auth.sh [origin]   (defaults to https://hypermove.duckdns.org)
set -euo pipefail
ORIGIN="${1:-https://hypermove.duckdns.org}"

# 1) Start — mint a device_code (for polling) + user_code (for you to approve).
start=$(curl -s -X POST "$ORIGIN/api/mcp/device/start")
device_code=$(echo "$start" | node -pe 'JSON.parse(require("fs").readFileSync(0)).device_code')
user_code=$(echo "$start" | node -pe 'JSON.parse(require("fs").readFileSync(0)).user_code')
interval=$(echo "$start" | node -pe 'JSON.parse(require("fs").readFileSync(0)).interval')

echo "Your code: $user_code"
read -p "Approve this agent? [y/n] " decision

# 2) Approve — right here, in this terminal. No browser tab, ever.
curl -s -X POST "$ORIGIN/api/mcp/device/approve" \
  -H 'content-type: application/json' \
  -d "{\"user_code\":\"$user_code\",\"decision\":\"$decision\"}" > /dev/null

# 3) Poll — wait for the approval to land, respecting the server's interval.
while true; do
  sleep "$interval"
  poll=$(curl -s -X POST "$ORIGIN/api/mcp/device/poll" \
    -H 'content-type: application/json' \
    -d "{\"device_code\":\"$device_code\"}")
  status=$(echo "$poll" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')

  case "$status" in
    approved)
      token=$(echo "$poll" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
      echo "$token"   # your bearer token — store it now, it won't be shown again
      break
      ;;
    denied|expired) echo "Sign-in $status." >&2; exit 1 ;;
    pending) continue ;;
  esac
done
