/**
 * src/config.ts
 * -------------
 * OPType/OPCommand string constants. These MUST be byte-for-byte identical
 * to whatever Solidity/Go constants they are matched against — Flare's own
 * getting-started guide names this the #1 real-world failure mode
 * ("unsupported op type"/"unsupported op command" comes from a string
 * mismatch, not a logic bug).
 *
 * Encoding scheme (verified against the real vendored Go source, Task 1):
 * OPType/OPCommand hashes are NOT keccak256 — they are Solidity's
 * `bytes32(s)` semantics: raw ASCII bytes, right-padded with zero bytes to
 * 32 bytes, truncated if over 32 chars. Confirmed by reading
 * services/tee-extension/tee-node/pkg/utils/utils.go's real `ToHash()`:
 *   func ToHash(s string) common.Hash {
 *       if len(s) > 32 { s = s[:32] }
 *       x := [32]byte{}; copy(x[:], s); return x
 *   }
 * This matches hypermove-app's existing src/lib/mcp/flare-instruct.ts
 * `opCommandToBytes32()` convention exactly — action-codec.ts's toOpHash()
 * reuses that same scheme rather than inventing a second one.
 *
 * Design decision (Task 2): HyperMove's MCP-specific commands (SEARCH,
 * NEWS_SEARCH, NEWS_DIGEST, NEWS_INSIGHT, CODEMODE_SPEC,
 * CODEMODE_VECTOR_SEARCH, SKILL_RUN) all nest under the EXISTING
 * GENERIC_AGENT_TASK OPType rather than inventing a new OPType.
 * Reasoning: none of these are financial-settlement actions (that's what
 * FINANCIAL_ACTION/SWAP|SETTLE already models, per Sub-PRD A in
 * biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/06-prd-sub-tee-extension-service.md).
 * They are all "run a confidential compute task and return a data result" —
 * exactly GENERIC_AGENT_TASK's definition. Adding a new OPType would require
 * a new Solidity send function + on-chain redeploy for zero behavioral gain;
 * modeling them as new OPCommands under the existing OPType is additive at
 * the Go/TS layer only (WR-04: don't create new surface unless essential).
 *
 * Truncation boundary: any OPCommand string over 32 ASCII characters is
 * silently truncated by Go's ToHash() before hashing — CODEMODE_VECTOR_SEARCH
 * (22 chars) is the longest constant here and is safely under that limit
 * (verified in scripts/verify-hash-equivalence.ts).
 */

/** Flare EVM chain-IDs. Mirrors hypermove-app's chain-constants.ts (kept as a
 *  small local copy — this project is intentionally standalone, see README's
 *  "Isolation" section — not a cross-repo import). */
export const FLARE_CHAIN_IDS: Record<string, number> = {
  flare: 14,
  coston2: 114,
  songbird: 19,
};

export const DEFAULT_NETWORK = 'coston2';

// ─── OPTypes (must match InstructionSender.sol / config.go byte-for-byte) ──

export const OP_TYPE_FINANCIAL_ACTION = 'FINANCIAL_ACTION';
export const OP_TYPE_GENERIC_AGENT_TASK = 'GENERIC_AGENT_TASK';

// ─── OPCommands under FINANCIAL_ACTION (unchanged from Sub-PRD A) ──────────

export const OP_COMMAND_SWAP = 'SWAP';
export const OP_COMMAND_SETTLE = 'SETTLE';

// ─── OPCommands under GENERIC_AGENT_TASK ───────────────────────────────────
// COMPUTE is Sub-PRD A's original generic placeholder command; the seven
// HyperMove-specific commands below are this ship's addition, all routed
// to a HyperMove MCP tool call (see tool-map.ts).

export const OP_COMMAND_COMPUTE = 'COMPUTE';
export const OP_COMMAND_SEARCH = 'SEARCH';
export const OP_COMMAND_NEWS_SEARCH = 'NEWS_SEARCH';
export const OP_COMMAND_NEWS_DIGEST = 'NEWS_DIGEST';
export const OP_COMMAND_NEWS_INSIGHT = 'NEWS_INSIGHT';
export const OP_COMMAND_CODEMODE_SPEC = 'CODEMODE_SPEC';
export const OP_COMMAND_CODEMODE_VECTOR_SEARCH = 'CODEMODE_VECTOR_SEARCH';
export const OP_COMMAND_SKILL_RUN = 'SKILL_RUN';

/** OPTypes this extension recognizes at all (anything else → unsupported). */
export const KNOWN_OP_TYPES = [OP_TYPE_FINANCIAL_ACTION, OP_TYPE_GENERIC_AGENT_TASK] as const;

/** OPCommands this extension can actually fulfil via HyperMove MCP.
 *  FINANCIAL_ACTION's SWAP/SETTLE and GENERIC_AGENT_TASK's COMPUTE are
 *  recognized (routing is real) but return an honest not-yet-implemented
 *  stub — see tee.client.ts's signWithWallet() and index.ts's handler. */
export const HYPERMOVE_OP_COMMANDS = [
  OP_COMMAND_SEARCH,
  OP_COMMAND_NEWS_SEARCH,
  OP_COMMAND_NEWS_DIGEST,
  OP_COMMAND_NEWS_INSIGHT,
  OP_COMMAND_CODEMODE_SPEC,
  OP_COMMAND_CODEMODE_VECTOR_SEARCH,
  OP_COMMAND_SKILL_RUN,
] as const;

export type HyperMoveOpCommand = (typeof HYPERMOVE_OP_COMMANDS)[number];

export const PORTS = {
  /** This extension's own inbound port — matches Flare's real ExtensionPort default. */
  action: 8889,
  /** The TEE node's real SignPort default (internal/settings/settings.go). */
  sign: 8888,
} as const;
