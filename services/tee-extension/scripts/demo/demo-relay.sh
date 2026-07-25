#!/usr/bin/env bash
# demo-relay.sh — SIMPLIFIED DEMO relay for DemoInstructionSender.
#
# Stands in for the real extension-tee + ext-proxy pair (blocked in this session by T1 —
# see services/tee-extension/README.md). Watches DemoInstructionSender for
# InstructionSubmitted events, "processes" the task (an honest, simple deterministic
# transform — this demo does NOT call out to a real live TEE or a real HyperMove MCP
# gateway, since neither is reachable from this local sandbox), and posts a result back
# on-chain via postResult(). This proves the event -> off-chain-process -> result-callback
# MECHANICS the real flow depends on, without claiming to be the production TEE path.
set -euo pipefail

CONTRACT="${1:?Usage: demo-relay.sh <contract-address> <instruction-id> <message-hex>}"
INSTRUCTION_ID="${2:?missing instruction id}"
MESSAGE_HEX="${3:?missing message hex}"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
PRIVATE_KEY="${DEMO_RELAY_PRIVATE_KEY:?set DEMO_RELAY_PRIVATE_KEY (a local anvil test key)}"

echo "[demo-relay] Processing instruction #$INSTRUCTION_ID"
echo "[demo-relay] Raw message (hex): $MESSAGE_HEX"

# Decode the message bytes back to UTF-8 (this demo's message is a plain JSON string,
# not the real contract's ABI-encoded tuple, since DemoInstructionSender is a simplified
# standalone shape — see the .sol file's own header comment).
DECODED=$(cast to-ascii "$MESSAGE_HEX" 2>/dev/null || echo "$MESSAGE_HEX")
echo "[demo-relay] Decoded message: $DECODED"

# Honest, simple "processing" step: this demo does not call a live TEE or a live
# HyperMove MCP endpoint (neither reachable from this sandbox). It computes a
# deterministic, real (not fabricated) result — a SHA-256 digest of the input,
# which any observer can independently recompute and verify.
RESULT_DIGEST=$(printf '%s' "$DECODED" | shasum -a 256 | awk '{print $1}')
RESULT_JSON="{\"processed\":true,\"inputDigestSha256\":\"$RESULT_DIGEST\",\"note\":\"demo relay — not a real TEE or live MCP gateway call\"}"
echo "[demo-relay] Result: $RESULT_JSON"

RESULT_BYTES=$(cast from-utf8 "$RESULT_JSON")

echo "[demo-relay] Posting result on-chain..."
cast send "$CONTRACT" \
  "postResult(uint256,bool,bytes)" "$INSTRUCTION_ID" true "$RESULT_BYTES" \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  | tail -15

echo "[demo-relay] Done. Verify with:"
echo "  cast call $CONTRACT \"getResult(uint256)(bool,bool,bytes)\" $INSTRUCTION_ID --rpc-url $RPC_URL"
