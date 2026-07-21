/**
 * scripts/verify-hash-equivalence.ts
 * -----------------------------------
 * Task 1 — throwaway verification (not shipped in src/): confirms the exact
 * byte-encoding scheme this extension must use to match Go's
 * `teeutils.ToHash()` when comparing OPType/OPCommand values.
 *
 * CORRECTION (caught by this exact script on its first run): the initial
 * assumption in this task was that `teeutils.ToHash()` computes a keccak256
 * digest of the string. That was WRONG. The real implementation — read
 * directly from services/tee-extension/tee-node/pkg/utils/utils.go — is:
 *
 *   func ToHash(s string) common.Hash {
 *       if len(s) > 32 { s = s[:32] }
 *       x := [32]byte{}
 *       copy(x[:], s)
 *       return x
 *   }
 *
 * This is Solidity's `bytes32(s)` semantics: the string's raw ASCII bytes,
 * right-padded with zero bytes to 32 bytes total (NOT hashed). This is the
 * SAME scheme hypermove-app's existing src/lib/mcp/flare-instruct.ts already
 * implements as `opCommandToBytes32()` — confirming this extension should
 * reuse that exact convention, not invent a new one (WR-02: don't repeat a
 * mistake pattern once caught).
 *
 * This script now verifies viem-based TS code produces byte-identical output
 * to that Go function for every OPType/OPCommand string this project uses.
 *
 * Run: npx tsx scripts/verify-hash-equivalence.ts
 */
import { toHex, pad } from 'viem';

/** TypeScript equivalent of Go's teeutils.ToHash(s) — right-pad raw ASCII
 *  bytes to 32 bytes (bytes32(s) semantics), NOT a hash. */
function toOpHash(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s.length > 32 ? s.slice(0, 32) : s);
  return pad(toHex(bytes), { size: 32, dir: 'right' });
}

// Verified structurally rather than against a second hand-transcribed hex
// literal: Task 1's own postmortem showed a hand-typed hex constant was
// wrong on the very first attempt in this session. Instead, assert the
// byte-level invariants that Go's `copy(x[:], s)` guarantees directly from
// TextEncoder output (raw ASCII bytes) — no second fragile transcription.
function assertOpHash(s: string): void {
  const h = toOpHash(s);
  const hex = h.slice(2);
  if (hex.length !== 64) throw new Error(`${s}: expected 64 hex chars (32 bytes), got ${hex.length}`);
  const raw = new TextEncoder().encode(s);
  const prefixHex = Array.from(raw).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!hex.startsWith(prefixHex)) {
    throw new Error(`${s}: expected hash to start with raw-byte prefix ${prefixHex}, got ${hex}`);
  }
  const paddingHex = hex.slice(prefixHex.length);
  if (!/^0*$/.test(paddingHex)) {
    throw new Error(`${s}: expected zero-byte padding after the raw prefix, got ${paddingHex}`);
  }
  console.log(`PASS ${s.padEnd(24)} -> ${h}`);
}

const opStrings = [
  'FINANCIAL_ACTION',
  'GENERIC_AGENT_TASK',
  'SWAP',
  'SETTLE',
  'COMPUTE',
  'SEARCH',
  'NEWS_SEARCH',
  'NEWS_DIGEST',
  'NEWS_INSIGHT',
  'CODEMODE_SPEC',
  'CODEMODE_VECTOR_SEARCH', // 22 chars — still under the 32-char truncation limit
  'SKILL_RUN',
];

console.log('--- OPType/OPCommand bytes32(s) encoding (Solidity bytes32-literal semantics, matches Go teeutils.ToHash) ---');
let ok = true;
for (const s of opStrings) {
  try {
    assertOpHash(s);
  } catch (err) {
    ok = false;
    console.log(`FAIL ${s}: ${(err as Error).message}`);
  }
}

// Explicit truncation-boundary check: teeutils.ToHash silently truncates
// anything over 32 chars. CODEMODE_VECTOR_SEARCH is 22 chars (safe); flag
// this boundary explicitly so nobody adds a 33+ char OPCommand later
// without noticing it would silently truncate on the Go side.
for (const s of opStrings) {
  if (s.length > 32) {
    console.log(`WARNING: "${s}" is ${s.length} chars — Go's teeutils.ToHash truncates at 32, this would silently corrupt the match.`);
    ok = false;
  }
}

console.log(`\n${ok ? 'ALL CHECKS PASSED' : 'CHECK FAILURE'} — toOpHash() in action-codec.ts must reuse this exact bytes32(s) scheme, matching flare-instruct.ts's existing opCommandToBytes32() convention in hypermove-app.`);
process.exit(ok ? 0 : 1);
