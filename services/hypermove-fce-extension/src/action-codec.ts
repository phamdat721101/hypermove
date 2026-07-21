/**
 * src/action-codec.ts
 * --------------------
 * Decodes the REAL wire-format `Action` the Flare TEE node posts to
 * `POST /action`, and encodes the `ActionResult` this extension returns.
 *
 * Ground truth for both shapes was read directly from the vendored Go
 * source (not assumed from the original PRD, which described a different,
 * flatter JSON schema that does not exist in the real pipeline):
 *  - services/tee-extension/tee-node/pkg/types/actions.go (Action, ActionData, ActionResult)
 *  - services/tee-extension/extension-examples/extension-scaffold/internal/extension/extension_test.go
 *    (buildTestAction() — the exact JSON shape of Data.Message, confirmed by a
 *    real, passing Go test in this same vendored tree)
 *  - services/tee-extension/extension-examples/extension-scaffold/pkg/types/types.go
 *    (the ABI tuple layout of originalMessage for FINANCIAL_ACTION / GENERIC_AGENT_TASK)
 *
 * `Action.Data.Message` is JSON (not raw hex) containing a `DataFixed`-shaped
 * object: { instructionId, teeId, timestamp, rewardEpochId, opType, opCommand,
 * cosigners, cosignersThreshold, originalMessage }, where opType/opCommand are
 * bytes32(s)-encoded hex hashes (see config.ts's doc comment for the exact
 * encoding — right-padded raw bytes, NOT keccak256) and `originalMessage` is
 * a hex string containing a Solidity ABI-encoded tuple.
 *
 * HyperMove's new OPCommands (SEARCH, NEWS_SEARCH, etc., nested under
 * GENERIC_AGENT_TASK per config.ts) reuse the EXACT SAME ABI tuple shape as
 * GENERIC_AGENT_TASK/COMPUTE — { taskType: string, payload: bytes } — rather
 * than inventing a new tuple layout per command. `taskType` carries the
 * OPCommand name redundantly (useful for logging/debugging) and `payload` is
 * the JSON-encoded HyperMove tool arguments, UTF-8 bytes. This keeps the
 * on-chain/Go-side ABI surface unchanged — HyperMove's new commands are a
 * pure decode-layer addition, no Solidity/Go change required (WR-03/WR-04).
 */
import { decodeAbiParameters, encodeAbiParameters, pad, toHex, type Hex } from 'viem';
import {
  HYPERMOVE_OP_COMMANDS,
  OP_TYPE_FINANCIAL_ACTION,
  OP_TYPE_GENERIC_AGENT_TASK,
  OP_COMMAND_SWAP,
  OP_COMMAND_SETTLE,
  OP_COMMAND_COMPUTE,
  type HyperMoveOpCommand,
} from './config.js';

/** Solidity's bytes32(s): raw ASCII bytes, right-padded with zero bytes to 32
 *  bytes, truncated at 32 chars. Matches Go's teeutils.ToHash() exactly (see
 *  config.ts's doc comment) — verified in scripts/verify-hash-equivalence.ts. */
export function toOpHash(s: string): Hex {
  const truncated = s.length > 32 ? s.slice(0, 32) : s;
  const bytes = new TextEncoder().encode(truncated);
  return pad(toHex(bytes), { size: 32, dir: 'right' });
}

/** Inverse of toOpHash: strip trailing zero bytes, decode as ASCII. Used only
 *  for human-readable logging (e.g. an "unsupported op type" message) — never
 *  for routing decisions, which always compare raw hash values. */
export function fromOpHash(hash: Hex): string {
  const hex = hash.slice(2).replace(/00+$/, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

// ─── Wire-format types (mirrors Go's teetypes.Action / ActionResult) ──────

export interface WireActionData {
  id: Hex;
  type?: 'instruction' | 'direct';
  submissionTag?: string;
  /** JSON string or JSON-decoded object (see decodeAction()'s parseDataFixed
   *  for robustness against both wire representations). */
  message: unknown;
}

export interface WireAction {
  data: WireActionData;
  additionalVariableMessages?: Hex[];
  timestamps?: number[];
  additionalActionData?: Hex;
  signatures?: Hex[];
}

export interface WireActionResult {
  id: Hex;
  submissionTag: string;
  status: 0 | 1;
  log: string;
  opType: Hex;
  opCommand: Hex;
  additionalResultStatus?: Hex;
  version: string;
  data: Hex;
}

/** The DataFixed shape nested inside Action.Data.Message — see
 *  extension_test.go's buildTestAction() for the confirmed real field set. */
interface DataFixed {
  instructionId?: Hex;
  teeId?: Hex;
  timestamp?: number;
  rewardEpochId?: number;
  opType: Hex;
  opCommand: Hex;
  cosigners?: string[];
  cosignersThreshold?: number;
  originalMessage: Hex;
}

export type DecodeError =
  | { kind: 'bad_data_message'; message: string }
  | { kind: 'unsupported_op_type'; receivedHash: Hex; receivedLabel: string }
  | { kind: 'unsupported_op_command'; opTypeLabel: string; receivedHash: Hex; receivedLabel: string }
  | { kind: 'bad_original_message'; message: string };

export interface DecodedAction {
  id: Hex;
  submissionTag: string;
  opType: typeof OP_TYPE_FINANCIAL_ACTION | typeof OP_TYPE_GENERIC_AGENT_TASK;
  opCommand: string;
  /** Present only for FINANCIAL_ACTION. */
  financial?: { action: string; amount: string; chain: string };
  /** Present only for GENERIC_AGENT_TASK (including HyperMove's nested commands).
   *  `taskType` echoes opCommand; `argumentsJson` is the decoded payload bytes
   *  parsed as UTF-8 JSON (HyperMove tool arguments), or null if empty/unparsable. */
  generic?: { taskType: string; argumentsJson: Record<string, unknown> | null; payloadBytes: number };
}

// ABI shapes match the REAL Go source exactly: a single `tuple`-typed
// argument with named components (abi.NewType("tuple", "", [...]) in
// types.go), NOT three/two flat top-level parameters. Verified live: viem's
// decodeAbiParameters only returns named fields (decoded.action, etc.) for
// this single-tuple-parameter shape — a flat multi-parameter list decodes to
// a positional array instead, which silently breaks every named-field access
// below (caught by this project's own test suite on first run).
const FINANCIAL_TUPLE = [
  {
    name: '',
    type: 'tuple',
    components: [
      { name: 'action', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'chain', type: 'string' },
    ],
  },
] as const;

const GENERIC_TUPLE = [
  {
    name: '',
    type: 'tuple',
    components: [
      { name: 'taskType', type: 'string' },
      { name: 'payload', type: 'bytes' },
    ],
  },
] as const;

function parseDataFixed(rawMessage: unknown): DataFixed | { error: string } {
  try {
    const obj = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
    if (!obj || typeof obj !== 'object') return { error: 'Data.Message did not decode to an object' };
    const o = obj as Record<string, unknown>;
    if (typeof o.opType !== 'string' || typeof o.opCommand !== 'string' || typeof o.originalMessage !== 'string') {
      return { error: 'Data.Message missing required opType/opCommand/originalMessage string fields' };
    }
    return o as unknown as DataFixed;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Decode a real wire-format Action into a clean internal shape, or a typed
 * DecodeError. Never throws — every failure path returns a tagged error so
 * callers (index.ts) can build the exact "unsupported op type"-style
 * ActionResult.log message the Go extension-scaffold's own tests assert on,
 * for cross-implementation consistency.
 */
export function decodeAction(action: WireAction): DecodedAction | DecodeError {
  const df = parseDataFixed(action.data.message);
  if ('error' in df) return { kind: 'bad_data_message', message: df.error };

  const financialHash = toOpHash(OP_TYPE_FINANCIAL_ACTION).toLowerCase();
  const genericHash = toOpHash(OP_TYPE_GENERIC_AGENT_TASK).toLowerCase();

  const opTypeHash = df.opType.toLowerCase();
  if (opTypeHash === financialHash) {
    return decodeFinancialAction(action.data.id, action.data.submissionTag ?? 'submit', df);
  }
  if (opTypeHash === genericHash) {
    return decodeGenericAgentTask(action.data.id, action.data.submissionTag ?? 'submit', df);
  }
  return { kind: 'unsupported_op_type', receivedHash: df.opType, receivedLabel: safeFromOpHash(df.opType) };
}

function safeFromOpHash(hash: Hex): string {
  try {
    return fromOpHash(hash);
  } catch {
    return '(undecodable)';
  }
}

function decodeFinancialAction(id: Hex, submissionTag: string, df: DataFixed): DecodedAction | DecodeError {
  const swapHash = toOpHash(OP_COMMAND_SWAP).toLowerCase();
  const settleHash = toOpHash(OP_COMMAND_SETTLE).toLowerCase();
  const cmdHash = df.opCommand.toLowerCase();
  if (cmdHash !== swapHash && cmdHash !== settleHash) {
    return {
      kind: 'unsupported_op_command',
      opTypeLabel: 'FINANCIAL_ACTION',
      receivedHash: df.opCommand,
      receivedLabel: safeFromOpHash(df.opCommand),
    };
  }
  try {
    const [decoded] = decodeAbiParameters(FINANCIAL_TUPLE, df.originalMessage);
    return {
      id,
      submissionTag,
      opType: 'FINANCIAL_ACTION',
      opCommand: cmdHash === swapHash ? 'SWAP' : 'SETTLE',
      financial: { action: decoded.action, amount: decoded.amount, chain: decoded.chain },
    };
  } catch (err) {
    return { kind: 'bad_original_message', message: err instanceof Error ? err.message : String(err) };
  }
}

function decodeGenericAgentTask(id: Hex, submissionTag: string, df: DataFixed): DecodedAction | DecodeError {
  const computeHash = toOpHash(OP_COMMAND_COMPUTE).toLowerCase();
  const hyperMoveHashes = new Map<string, HyperMoveOpCommand>(
    HYPERMOVE_OP_COMMANDS.map((c) => [toOpHash(c).toLowerCase(), c]),
  );
  const cmdHash = df.opCommand.toLowerCase();

  let opCommandLabel: string | undefined;
  if (cmdHash === computeHash) opCommandLabel = 'COMPUTE';
  else if (hyperMoveHashes.has(cmdHash)) opCommandLabel = hyperMoveHashes.get(cmdHash);

  if (!opCommandLabel) {
    return {
      kind: 'unsupported_op_command',
      opTypeLabel: 'GENERIC_AGENT_TASK',
      receivedHash: df.opCommand,
      receivedLabel: safeFromOpHash(df.opCommand),
    };
  }

  try {
    const [decoded] = decodeAbiParameters(GENERIC_TUPLE, df.originalMessage);
    const payloadHex = decoded.payload as Hex;
    const payloadBytes = payloadHex.length > 2 ? (payloadHex.length - 2) / 2 : 0;
    let argumentsJson: Record<string, unknown> | null = null;
    if (payloadBytes > 0) {
      try {
        const text = Buffer.from(payloadHex.slice(2), 'hex').toString('utf8');
        const parsed = JSON.parse(text);
        argumentsJson = parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        argumentsJson = null; // payload wasn't JSON — leave null, never throw
      }
    }
    return {
      id,
      submissionTag,
      opType: 'GENERIC_AGENT_TASK',
      opCommand: opCommandLabel,
      generic: { taskType: decoded.taskType, argumentsJson, payloadBytes },
    };
  } catch (err) {
    return { kind: 'bad_original_message', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Encode a HyperMove tool-call payload into the ABI tuple GENERIC_AGENT_TASK
 *  expects — the inverse of decodeGenericAgentTask's payload parsing. Exposed
 *  for tests and for anything building a synthetic Action (e.g. Task 7's
 *  integration tests) to construct a realistic originalMessage hex string. */
export function encodeGenericAgentTaskMessage(taskType: string, argumentsJson: Record<string, unknown>): Hex {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(argumentsJson));
  const payloadHex = `0x${Buffer.from(payloadBytes).toString('hex')}` as Hex;
  return encodeAbiParameters(GENERIC_TUPLE, [{ taskType, payload: payloadHex }]);
}

/** Build the wire ActionResult this extension returns from POST /action.
 *  `dataPayload` is JSON-stringified then hex-encoded into the `data` field —
 *  matching FinancialActionResponse/GenericAgentTaskResponse's real
 *  "JSON payload returned in ActionResult.Data" convention (types.go doc
 *  comments), not an ABI-encoded tuple (the request and response payload
 *  encodings are deliberately different in the real Go source — verified by
 *  reading types.go, not assumed). */
export function encodeActionResult(input: {
  id: Hex;
  submissionTag: string;
  status: 0 | 1;
  log: string;
  opType: Hex;
  opCommand: Hex;
  version: string;
  dataPayload: unknown;
}): WireActionResult {
  const json = JSON.stringify(input.dataPayload ?? null);
  const dataHex = `0x${Buffer.from(json, 'utf8').toString('hex')}` as Hex;
  return {
    id: input.id,
    submissionTag: input.submissionTag,
    status: input.status,
    log: input.log,
    opType: input.opType,
    opCommand: input.opCommand,
    version: input.version,
    data: dataHex,
  };
}

/** Build the exact "unsupported op type/command" log message the Go
 *  extension-scaffold's own tests assert substrings of — reused verbatim so
 *  a client cross-referencing both implementations sees consistent wording. */
export function unsupportedOpTypeLog(receivedHash: Hex, receivedLabel: string): string {
  const financial = toOpHash(OP_TYPE_FINANCIAL_ACTION);
  const generic = toOpHash(OP_TYPE_GENERIC_AGENT_TASK);
  return (
    `unsupported op type: received ${receivedHash} (${receivedLabel}), expected ` +
    `${financial} (FINANCIAL_ACTION) or ${generic} (GENERIC_AGENT_TASK)`
  );
}

export function unsupportedOpCommandLog(
  opTypeLabel: string,
  receivedHash: Hex,
  receivedLabel: string,
  validCommands: readonly string[],
): string {
  const options = validCommands.map((c) => `${toOpHash(c)} (${c})`).join(', ');
  return `unsupported op command for ${opTypeLabel}: received ${receivedHash} (${receivedLabel}), expected one of [${options}]`;
}
