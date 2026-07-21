/**
 * src/tee.client.ts
 * ------------------
 * Calls the real Flare TEE node's signing API on localhost:8888 — the
 * loopback-only, unauthenticated "trusted local TEE boundary" (per the PRD
 * and confirmed by the real Go source having no auth middleware on this
 * server: services/tee-extension/tee-node/internal/extension/server/server.go).
 *
 * Ground truth (read directly from server.go):
 *  - POST /sign            body {"message":"0x<hex>"} — the TEE node
 *    keccak256-hashes the message INTERNALLY before signing
 *    (signWithTeeHandler: `msgHash := crypto.Keccak256(signRequest.Message)`).
 *    Callers must send the RAW commitment digest as `message`, NOT a
 *    pre-hashed value — hashing it twice would sign the wrong digest.
 *  - POST /sign/{walletID}/{keyID}  same body shape, but walletID/keyID
 *    address a specific Protocol Managed Wallet key instead of the TEE's own
 *    identity key. walletID MUST be a 32-byte hex hash — server.go's
 *    hashParam() rejects anything else with 400 Bad Request (strips an
 *    optional 0x prefix, lowercases, then requires exactly 64 hex chars).
 *    This client validates walletID client-side before ever making the
 *    request, so a malformed id fails fast with a clear message instead of
 *    a generic HTTP 400 from the TEE node.
 *  - Both endpoints return { message, signature } (types.SignResponse).
 */

const WALLET_ID_HEX64 = /^[0-9a-fA-F]{64}$/;

export interface TeeSignResult {
  message: string;
  signature: string;
}

export type TeeClientResult =
  | { ok: true; result: TeeSignResult }
  | { ok: false; code: 'invalid_wallet_id' | 'network_error' | 'tee_error'; message: string };

/** Sign a digest with the TEE node's own identity key (POST /sign).
 *  `digestHex` must be the RAW commitment digest (e.g. straight out of
 *  viem's keccak256() in commitments.ts) — the TEE node hashes it again
 *  internally, matching signWithTeeHandler's real behavior. */
export async function signWithTee(baseUrl: string, digestHex: string, timeoutMs = 5000): Promise<TeeClientResult> {
  return postSign(`${baseUrl.replace(/\/$/, '')}/sign`, digestHex, timeoutMs);
}

/**
 * Sign with a specific Protocol Managed Wallet key (POST /sign/{walletID}/{keyID}).
 * `walletId` is validated as a 32-byte hex hash BEFORE any network call —
 * server.go's own hashParam() would reject anything else, but failing fast
 * client-side gives a clearer error and avoids a wasted round trip.
 *
 * NOTE — honest stub boundary (see README "TEE_WALLET honest-stub boundary"):
 * this function performs the real HTTP call/validation, but Protocol Managed
 * Wallets' third-party invocation ABI (which real-world walletId/keyId values
 * to use, and what raw transaction bytes to sign) is not published as of this
 * ship (same blocker named in Sub-PRD A / providers/flare.ts's
 * executeFccConfidential()). Callers in index.ts use this function only
 * behind an explicit "not yet implemented" result — never fabricating a
 * settlement flow around it.
 */
export async function signWithWallet(
  baseUrl: string,
  walletId: string,
  keyId: string | number,
  rawTxHex: string,
  timeoutMs = 5000,
): Promise<TeeClientResult> {
  const normalized = walletId.startsWith('0x') || walletId.startsWith('0X') ? walletId.slice(2) : walletId;
  if (!WALLET_ID_HEX64.test(normalized)) {
    return {
      ok: false,
      code: 'invalid_wallet_id',
      message: `walletId must be a 32-byte hex hash (64 hex chars, optional 0x prefix); got ${JSON.stringify(walletId)}`,
    };
  }
  return postSign(`${baseUrl.replace(/\/$/, '')}/sign/${normalized}/${keyId}`, rawTxHex, timeoutMs);
}

async function postSign(url: string, message: string, timeoutMs: number): Promise<TeeClientResult> {
  const hexMessage = message.startsWith('0x') ? message : `0x${message}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: hexMessage }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, code: 'network_error', message: err instanceof Error ? err.message : String(err) };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, code: 'network_error', message: `non-JSON response from TEE node: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) {
    const msg = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: false, code: 'tee_error', message: `TEE node returned HTTP ${res.status}: ${msg}` };
  }

  const b = body as Partial<TeeSignResult>;
  if (typeof b.message !== 'string' || typeof b.signature !== 'string') {
    return { ok: false, code: 'tee_error', message: `TEE node response missing message/signature: ${JSON.stringify(body)}` };
  }
  return { ok: true, result: { message: b.message, signature: b.signature } };
}
