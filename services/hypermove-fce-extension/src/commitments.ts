/**
 * src/commitments.ts
 * -------------------
 * Builds the keccak256(abi.encode(...)) commitment digest for a HyperMove
 * MCP result, per the PRD's commitment_schemes. This digest is what gets
 * signed via tee.client.ts's signWithTee() — it becomes the on-chain-
 * verifiable proof that this extension actually saw a specific HyperMove
 * result, not a fabricated one.
 *
 * Field order and types follow the PRD's commitment_schemes exactly:
 *   SEARCH:       keccak256(abi.encode(
 *                   string 'HYPERMOVE_SEARCH_V1', uint256 chainId,
 *                   string tool, string query, uint256 total,
 *                   string nextCursor, uint256 timestamp))
 *   NEWS_DIGEST:  keccak256(abi.encode(
 *                   string 'HYPERMOVE_NEWS_DIGEST_V1', uint256 chainId,
 *                   string project, string day, bytes32 digestHash,
 *                   uint256 timestamp))
 *
 * Chain ID is sourced from config.ts's FLARE_CHAIN_IDS (never hardcoded),
 * per the plan's Task 6 requirement.
 */
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { FLARE_CHAIN_IDS, DEFAULT_NETWORK } from './config.js';

export function chainIdFor(network: string = DEFAULT_NETWORK): bigint {
  const id = FLARE_CHAIN_IDS[network];
  if (id === undefined) throw new Error(`unknown Flare network "${network}" — no chain id in FLARE_CHAIN_IDS`);
  return BigInt(id);
}

const SEARCH_SCHEME = [
  { type: 'string' },
  { type: 'uint256' },
  { type: 'string' },
  { type: 'string' },
  { type: 'uint256' },
  { type: 'string' },
  { type: 'uint256' },
] as const;

export interface SearchCommitmentInput {
  chainId: bigint;
  tool: string;
  query: string;
  total: number;
  nextCursor: string;
  timestamp: number;
}

/** HYPERMOVE_SEARCH_V1 commitment digest. */
export function buildSearchCommitment(input: SearchCommitmentInput): Hex {
  const encoded = encodeAbiParameters(SEARCH_SCHEME, [
    'HYPERMOVE_SEARCH_V1',
    input.chainId,
    input.tool,
    input.query,
    BigInt(input.total),
    input.nextCursor,
    BigInt(input.timestamp),
  ]);
  return keccak256(encoded);
}

const NEWS_DIGEST_SCHEME = [
  { type: 'string' },
  { type: 'uint256' },
  { type: 'string' },
  { type: 'string' },
  { type: 'bytes32' },
  { type: 'uint256' },
] as const;

export interface NewsDigestCommitmentInput {
  chainId: bigint;
  project: string;
  day: string;
  /** 32-byte hex hash of the digest content — the PRD's `digestHash` field. */
  digestHash: Hex;
  timestamp: number;
}

/** HYPERMOVE_NEWS_DIGEST_V1 commitment digest. */
export function buildNewsDigestCommitment(input: NewsDigestCommitmentInput): Hex {
  const encoded = encodeAbiParameters(NEWS_DIGEST_SCHEME, [
    'HYPERMOVE_NEWS_DIGEST_V1',
    input.chainId,
    input.project,
    input.day,
    input.digestHash,
    BigInt(input.timestamp),
  ]);
  return keccak256(encoded);
}

/** Hash arbitrary JSON content into the bytes32 `digestHash` field
 *  buildNewsDigestCommitment expects — e.g. for a news.digest tool result
 *  that isn't already a 32-byte hash. */
export function hashContent(content: unknown): Hex {
  return keccak256(new TextEncoder().encode(JSON.stringify(content)));
}
