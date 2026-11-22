import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, type Hex } from 'viem';
import { z } from 'zod';
import { ResearchError, uint, xrplAccount } from './contracts';
import type { ResearchEngine } from './engine';
import { address, bytes32, CHAINS } from './networks';
import { boundedBody, JsonClient } from './transport';
import { assetKey, decimal } from './xrpl';

export const XRPL_RLUSD = { kind: 'issued', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', currency: '524C555344000000000000000000000000000000' } as const;
const TOKENS = {
  base: { rlusd: '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  ethereum: { rlusd: '0x8292bb45bf1ee4d140127049757c2e0ff06317ed', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
} as const;
const BASE_QUOTER = '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a';
const ETHEREUM_CURVE = '0xd001ae433f254283fece51d4acce8c53263aa186';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RELAY = 'https://api.relay.link/currencies/v2';
const SQUID = 'https://v2.api.squidrouter.com/v2/chains';
const relayXrplId = 537724;
const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)']);
const curveAbi = parseAbi(['function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)']);

const network = z.enum(['base', 'ethereum']);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/);
const positiveUint = uint.refine((s) => s !== '0', 'Amount must be positive.');
const positiveDecimal = z.string().max(100).regex(/^\d+(?:\.\d+)?(?:[eE][+-]?\d{1,2})?$/).refine((s) => {
  try { return decimal(s).n > 0n; } catch { return false; }
}, 'Expected a positive bounded XRPL amount.');
const index = z.number().int().min(0).max(0xffffffff);
export const rlusdDevtoolsSchema = z.object({ request: z.discriminatedUnion('action', [
  z.object({ action: z.literal('check_providers') }).strict(),
  z.object({ action: z.literal('quote_spot'), network, amount_in_raw: positiveUint }).strict(),
  z.object({ action: z.literal('verify_xrpl_payment'), tx_hash: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toUpperCase()), payer: xrplAccount, recipient: xrplAccount, amount: positiveDecimal, destination_tag: index.optional() }).strict(),
  z.object({ action: z.literal('verify_evm_transfer'), network, asset: z.enum(['rlusd', 'usdc']), tx_hash: bytes32, sender: address, recipient: address, amount_raw: positiveUint, log_index: index }).strict(),
]) }).strict();
type Request = z.infer<typeof rlusdDevtoolsSchema>['request'];
const blockSchema = z.object({ number: quantity, hash: bytes32 });
const catalog = z.array(z.object({ chainId: z.number().int(), address: z.string().max(256) })).max(100);
const xrplTx = z.object({ TransactionType: z.string(), Account: xrplAccount, Destination: xrplAccount, DestinationTag: index.optional(), hash: z.string().optional() });
const xrplResult = z.object({ validated: z.boolean(), hash: z.string().optional(), ledger_index: z.number().int().positive(), tx_json: xrplTx.optional(), meta: z.object({ TransactionResult: z.string(), delivered_amount: z.object({ currency: z.string(), issuer: xrplAccount, value: positiveDecimal }) }) });
const evmReceipt = z.object({ transactionHash: bytes32, status: quantity, blockNumber: quantity, blockHash: bytes32,
  logs: z.array(z.object({ address, logIndex: quantity, removed: z.boolean().optional(), topics: z.array(bytes32), data: z.string() })).max(5000),
});

function parsed<T>(schema: z.ZodType<T>, raw: unknown, description: string) {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ResearchError('INVALID_RESPONSE', description);
  return result.data;
}

async function checkRelay(fetcher: typeof fetch, signal: AbortSignal) {
  const rpc = new JsonClient(RELAY, fetcher, 5000);
  const official = TOKENS.base.rlusd;
  const [symbolEntries, exact] = await Promise.all([
    rpc.request({ chainIds: [relayXrplId, CHAINS.base, CHAINS.ethereum], symbol: 'RLUSD', limit: 20 }, signal),
    rpc.request({ chainIds: [CHAINS.base], address: official, limit: 20 }, signal),
  ]);
  const entries = parsed(catalog, symbolEntries, 'Invalid Relay catalog.');
  return {
    status: entries.some((entry) => entry.chainId === relayXrplId) ? 'issuer_qualification_required' : 'xrpl_rlusd_not_listed',
    base_official_address: official,
    base_official_address_listed: parsed(catalog, exact, 'Invalid Relay address lookup.').some((entry) => entry.chainId === CHAINS.base && entry.address.toLowerCase() === official),
    base_other_symbol_addresses: [...new Set(entries.filter((entry) => entry.chainId === CHAINS.base).map((entry) => entry.address.toLowerCase()).filter((value) => address.safeParse(value).success && value !== official))].sort(),
  };
}

async function checkSquid(fetcher: typeof fetch, signal: AbortSignal) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 5000);
  try {
    const response = await fetcher(SQUID, { redirect: 'error', signal: controller.signal });
    if (response.ok) {
      await response.body?.cancel();
      return { status: 'catalog_reachable_route_unverified' };
    }
    const detail = await boundedBody(response, 4096, controller.signal);
    return { status: [400, 401, 403].includes(response.status) && detail.toString().toLowerCase().includes('x-integrator-id') ? 'integrator_id_required' : 'unavailable', http_status: response.status };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function checkProviders(fetcher: typeof fetch, signal: AbortSignal) {
  const [relay, squid] = await Promise.allSettled([checkRelay(fetcher, signal), checkSquid(fetcher, signal)]);
  signal.throwIfAborted();
  return {
    status: 'provider_check', scope: 'catalog_only', route_ready: false,
    origin: { network: 'xrpl', ...XRPL_RLUSD }, destinations: TOKENS,
    providers: { relay: relay.status === 'fulfilled' ? relay.value : { status: 'unavailable' }, squid: squid.status === 'fulfilled' ? squid.value : { status: 'unavailable' } },
  };
}

async function evmRpc(engine: ResearchEngine, chain: z.infer<typeof network>, signal: AbortSignal) {
  const client = engine.rpc(chain);
  const chainId = parsed(quantity, await client.rpc('eth_chainId', [], signal), 'RPC omitted the EVM chain ID.');
  if (BigInt(chainId) !== BigInt(CHAINS[chain])) throw new ResearchError('NETWORK_MISMATCH', 'EVM RPC chain ID differs from the requested chain.');
  return client;
}

async function readBlock(rpc: JsonClient, block: string, signal: AbortSignal) {
  return parsed(blockSchema, await rpc.rpc('eth_getBlockByNumber', [block, false], signal), 'RPC omitted a canonical block header.');
}

async function quoteSpot(engine: ResearchEngine, request: Extract<Request, { action: 'quote_spot' }>, signal: AbortSignal) {
  const { network: chain, amount_in_raw: raw } = request;
  const client = await evmRpc(engine, chain, signal);
  const tokens = TOKENS[chain];
  const block = await readBlock(client, 'latest', signal);
  const quote = chain === 'base'
    ? { to: BASE_QUOTER, data: encodeFunctionData({ abi: quoterAbi, args: [{ tokenIn: tokens.rlusd, tokenOut: tokens.usdc, amountIn: BigInt(raw), fee: 100, sqrtPriceLimitX96: 0n }] }) }
    : { to: ETHEREUM_CURVE, data: encodeFunctionData({ abi: curveAbi, args: [1n, 0n, BigInt(raw)] }) };
  const result = await client.rpc<Hex>('eth_call', [quote, block.number], signal);
  const amount = chain === 'base' ? decodeFunctionResult({ abi: quoterAbi, data: result })[0] : decodeFunctionResult({ abi: curveAbi, data: result });
  if (amount <= 0n) throw new ResearchError('ZERO_QUOTE', 'Venue returned no USDC output.');
  if ((await readBlock(client, block.number, signal)).hash !== block.hash) throw new ResearchError('REORG', 'Quote block is no longer canonical.');
  return { status: 'quoted', scope: 'same_chain_conversion', network: chain, chain_id: CHAINS[chain], block, venue: quote.to,
    input_token: tokens.rlusd, output_token: tokens.usdc, input_amount_raw: raw, output_amount_raw: amount.toString(),
    output_usdc: formatUnits(amount, 6), gas_included: false };
}

async function verifyXrpl(engine: ResearchEngine, request: Extract<Request, { action: 'verify_xrpl_payment' }>, signal: AbortSignal) {
  const envelope = await engine.rpc('xrpl').request({ method: 'tx', params: [{ transaction: request.tx_hash, api_version: 2 }] }, signal) as { result?: unknown };
  const receipt = parsed(xrplResult, envelope.result, 'XRPL receipt is missing validated payment delivery data.');
  const tx = receipt.tx_json ?? parsed(xrplTx, envelope.result, 'XRPL transaction fields are missing.');
  const delivered = receipt.meta.delivered_amount;
  const actual = decimal(delivered.value), expected = decimal(request.amount);
  if (!receipt.validated || receipt.meta.TransactionResult !== 'tesSUCCESS' || tx.TransactionType !== 'Payment'
    || (receipt.hash ?? tx.hash)?.toUpperCase() !== request.tx_hash || tx.Account !== request.payer || tx.Destination !== request.recipient
    || tx.DestinationTag !== request.destination_tag || assetKey({ kind: 'issued', ...delivered }) !== assetKey(XRPL_RLUSD)
    || actual.n * expected.d !== expected.n * actual.d) throw new ResearchError('RECEIPT_MISMATCH', 'XRPL receipt differs from the expected issued-token payment.');
  return { status: 'verified', scope: 'xrpl_payment_only', tx_hash: request.tx_hash, ledger_index: receipt.ledger_index,
    payer: request.payer, recipient: request.recipient, destination_tag: request.destination_tag ?? null, delivered_amount: delivered };
}

async function verifyEvm(engine: ResearchEngine, request: Extract<Request, { action: 'verify_evm_transfer' }>, signal: AbortSignal) {
  const { network: chain } = request;
  const client = await evmRpc(engine, chain, signal);
  const receipt = parsed(evmReceipt, await client.rpc('eth_getTransactionReceipt', [request.tx_hash], signal), 'EVM receipt is missing or malformed.');
  const token = TOKENS[chain][request.asset];
  const destination = '0x' + request.recipient.slice(2).padStart(64, '0');
  const sender = '0x' + request.sender.slice(2).padStart(64, '0');
  const matches = receipt.logs.filter((log) => BigInt(log.logIndex) === BigInt(request.log_index) && !log.removed && log.address === token
    && log.topics.length === 3 && log.topics[0] === TRANSFER && log.topics[1] === sender && log.topics[2] === destination
    && /^0x[0-9a-fA-F]{64}$/.test(log.data) && BigInt(log.data) === BigInt(request.amount_raw));
  if (receipt.transactionHash !== request.tx_hash || receipt.status !== '0x1' || matches.length !== 1) throw new ResearchError('RECEIPT_MISMATCH', 'No official token transfer matches the expected EVM receipt.');
  const finalized = await readBlock(client, 'finalized', signal);
  const canonical = await readBlock(client, receipt.blockNumber, signal);
  if (canonical.hash !== receipt.blockHash) throw new ResearchError('REORG', 'Receipt block is no longer canonical.');
  return { status: BigInt(finalized.number) >= BigInt(receipt.blockNumber) ? 'verified' : 'pending_finality', scope: 'evm_transfer_only',
    network: chain, chain_id: CHAINS[chain], tx_hash: request.tx_hash, token, log_index: request.log_index, amount_raw: request.amount_raw,
    sender: request.sender, recipient: request.recipient, block: canonical, finalized_block: finalized.number };
}

export function runRlusdDevtools(engine: ResearchEngine, { request }: z.infer<typeof rlusdDevtoolsSchema>, signal: AbortSignal) {
  switch (request.action) {
    case 'check_providers': return checkProviders(engine.options.fetcher ?? fetch, signal);
    case 'quote_spot': return quoteSpot(engine, request, signal);
    case 'verify_xrpl_payment': return verifyXrpl(engine, request, signal);
    case 'verify_evm_transfer': return verifyEvm(engine, request, signal);
  }
}
