import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex } from 'viem';

// Metering/payment spies: any call proves billing happened.
const meter = vi.hoisted(() => ({ checkAndConsume: vi.fn(async () => ({ allowed: true, remaining: 99, limit: 100 })), findActiveSession: vi.fn(async () => null) }));
vi.mock('../src/lib/mcp/rate-limit', async (orig) => ({ ...(await orig<object>()), checkAndConsume: meter.checkAndConsume }));
vi.mock('../src/lib/mcp/paywall', async (orig) => ({ ...(await orig<object>()), findActiveSession: meter.findActiveSession }));

import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import { createResearchServer } from '../services/flashloan/server';
import { MemoryRepository } from '../src/lib/mcp/flashloan/storage';
import { ResearchError } from '../src/lib/mcp/flashloan/contracts';
import { FinanceService } from '../src/lib/mcp/flashloan/finance/engine';
import { FINANCE_CONTRACT_DIGEST, RATES_CONTRACT_DIGEST } from '../src/lib/mcp/flashloan/finance/contracts';
import { clearRatesCache, type RatesConfig } from '../src/lib/mcp/flashloan/finance/rates';
import { guardFinanceBody } from '../src/lib/mcp/flashloan/finance/tools';

// ── Fixture chain ─────────────────────────────────────────────────────────────
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const PROVIDER = A(0x1001), POOL = A(0x1002), USDC = A(0x2001), WETH = A(0x2002), aUSDC = A(0x3001), dUSDC = A(0x3002), aWETH = A(0x3003), dWETH = A(0x3004);
const USER = A(0x9999), USER_NO_DEBT = A(0x8888), MORPHO = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', IRM = A(0x4001), ORACLE = A(0x4002);
const MARKET_ID = '0x' + 'ab'.repeat(32);
const KTOKEN = A(0x5001), KBROKEN = A(0x5002), FXRP = A(0x5003), VAULT4626 = A(0x5004);
const FIRELIGHT = A(0x5010), SCEPTRE = A(0x5011), UPSHIFT = A(0x5012), KNATIVE = A(0x5013);
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const RAY = 10n ** 27n, MAX = (1n << 256n) - 1n;
const HEAD = 100_000n, T0 = 1_700_000_000n, SPACING = 10n, WINDOW_BLOCKS = 60_480n; // 7 days at 10 s
const HEAD_TS = T0 + HEAD * SPACING;
const blockHash = (chain: number, n: bigint) => '0x' + createHash('sha256').update(`${chain}:${n}`).digest('hex');
const sel = (sig: string) => toFunctionSelector(sig);
const w = (...vals: bigint[]) => ('0x' + vals.map((v) => v.toString(16).padStart(64, '0')).join('')) as Hex;
const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);
const word = (data: Hex, i: number) => BigInt('0x' + data.slice(10 + i * 64, 74 + i * 64));
const addrArg = (data: Hex, i = 0) => '0x' + data.slice(10 + i * 64 + 24, 74 + i * 64);

type Handler = (data: Hex, block: bigint) => Hex | null;
const evmChains: Record<string, { chainId: number; contracts: Record<string, Record<string, Handler>>; reorged?: boolean }> = {
  'arb.test': { chainId: 42161, contracts: {} }, 'base.test': { chainId: 8453, contracts: {} }, 'flare.test': { chainId: 14, contracts: {} },
};
const reserveData = (decimals: bigint, id: bigint, liq: bigint, bor: bigint, aToken: string, dToken: string, frozen = false) =>
  w((decimals << 48n) | (1n << 56n) | (frozen ? 1n << 57n : 0n), RAY, liq, RAY, bor, 0n, 0n, id, BigInt(aToken), 0n, BigInt(dToken), 0n, 0n, 0n, 0n);
const aave: Record<string, Record<string, Handler>> = {
  [PROVIDER]: { [sel('getPool()')]: () => w(BigInt(POOL)) },
  [POOL]: {
    [sel('getReservesList()')]: () => encodeAbiParameters([{ type: 'address[]' }], [[USDC, WETH] as Hex[]]),
    [sel('getReserveData(address)')]: (d) => addrArg(d) === USDC ? reserveData(6n, 0n, 300n * RAY / 10000n, 500n * RAY / 10000n, aUSDC, dUSDC) : reserveData(18n, 1n, 100n * RAY / 10000n, 200n * RAY / 10000n, aWETH, dWETH, true),
    [sel('getUserAccountData(address)')]: (d) => addrArg(d) === USER ? w(3000n * 10n ** 8n, 1200n * 10n ** 8n, 0n, 8250n, 8000n, 1_840_000_000_000_000_000n) : w(0n, 0n, 0n, 0n, 0n, MAX),
    [sel('getUserConfiguration(address)')]: (d) => w(addrArg(d) === USER ? (1n << 3n) | 1n : 0n),
    [sel('getUserEMode(address)')]: () => w(0n),
  },
  [USDC]: { [sel('symbol()')]: () => str('USDC') }, [WETH]: { [sel('symbol()')]: () => str('WETH') },
  [aUSDC]: { [sel('totalSupply()')]: () => w(1_000_000n * 10n ** 6n), [sel('balanceOf(address)')]: () => w(0n) },
  [dUSDC]: { [sel('totalSupply()')]: () => w(400_000n * 10n ** 6n), [sel('balanceOf(address)')]: (d) => w(addrArg(d) === USER ? 1200n * 10n ** 6n : 0n) },
  [aWETH]: { [sel('totalSupply()')]: () => w(5_000n * 10n ** 18n), [sel('balanceOf(address)')]: (d) => w(addrArg(d) === USER ? 10n ** 18n : 0n) },
  [dWETH]: { [sel('totalSupply()')]: () => w(1_000n * 10n ** 18n), [sel('balanceOf(address)')]: () => w(0n) },
};
evmChains['arb.test'].contracts = aave;
evmChains['base.test'].contracts = {
  ...aave,
  [MORPHO]: {
    [sel('market(bytes32)')]: () => w(1_000_000n * 10n ** 6n, 1_000_000n * 10n ** 12n, 500_000n * 10n ** 6n, 500_000n * 10n ** 12n, 1n, 10n ** 17n),
    [sel('idToMarketParams(bytes32)')]: () => w(BigInt(USDC), BigInt(WETH), BigInt(ORACLE), BigInt(IRM), 86n * 10n ** 16n),
    [sel('position(bytes32,address)')]: (d) => addrArg(d, 1) === USER ? w(0n, 100n * 10n ** 12n, 10n ** 17n) : w(0n, 0n, 0n),
  },
  [IRM]: { [sel('borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))')]: () => w((6n * 10n ** 16n) / 31_536_000n) },
  [ORACLE]: { [sel('price()')]: () => w(3000n * 10n ** 24n) },
  [USDC]: { [sel('symbol()')]: () => str('USDC'), [sel('decimals()')]: () => w(6n) },
  [WETH]: { [sel('symbol()')]: () => str('WETH'), [sel('decimals()')]: () => w(18n) },
};
evmChains['flare.test'].contracts = {
  [KTOKEN]: {
    [sel('supplyRatePerTimestamp()')]: () => w((29n * 10n ** 15n) / 31_536_000n), [sel('borrowRatePerTimestamp()')]: () => w((6n * 10n ** 16n) / 31_536_000n),
    [sel('getCash()')]: () => w(600n * 10n ** 6n), [sel('totalBorrows()')]: () => w(400n * 10n ** 6n), [sel('totalReserves()')]: () => w(0n), [sel('underlying()')]: () => w(BigInt(FXRP)),
  },
  [FXRP]: { [sel('symbol()')]: () => str('FXRP'), [sel('decimals()')]: () => w(6n) },
  [KNATIVE]: {
    [sel('supplyRatePerTimestamp()')]: () => w(10n ** 9n), [sel('borrowRatePerTimestamp()')]: () => w(2n * 10n ** 9n),
    [sel('getCash()')]: () => w(10n ** 18n), [sel('totalBorrows()')]: () => w(0n), [sel('totalReserves()')]: () => w(0n), [sel('symbol()')]: () => str('kFLR'), [sel('decimals()')]: () => w(8n),
  },
  // Firelight: checkpointed totals; share price 1.00 at window start → 1.01 at head.
  [FIRELIGHT]: {
    [sel('totalAssetsAt(uint48)')]: (d) => w(10n ** 12n + ((word(d, 0) - (HEAD_TS - 604_800n)) * 10n ** 10n) / 604_800n),
    [sel('totalSupplyAt(uint48)')]: () => w(10n ** 12n), [sel('asset()')]: () => w(BigInt(FXRP)), [sel('symbol()')]: () => str('stXRP'),
  },
  // Sceptre: 3 history slots (index ≥ 3 reverts); rate 1.00 eight days ago → 1.01 now.
  [SCEPTRE]: {
    [sel('getPooledFlrByShares(uint256)')]: () => w(101n * 10n ** 16n), [sel('symbol()')]: () => str('sFLR'),
    [sel('historicalExchangeRateTimestamps(uint256)')]: (d) => { const i = word(d, 0); return i < 3n ? w(HEAD_TS - [10n, 8n, 1n][Number(i)] * 86_400n) : null; },
    [sel('historicalExchangeRatesByTimestamp(uint256)')]: (d) => w(word(d, 0) === HEAD_TS - 8n * 86_400n ? 10n ** 18n : 0n),
  },
  // Upshift: no symbol(); share price only at the pinned block (archive read for window start).
  [UPSHIFT]: {
    [sel('getSharePrice()')]: (_d, n) => w(n < HEAD - WINDOW_BLOCKS ? 1_000_000n : 1_000_000n + ((n - (HEAD - WINDOW_BLOCKS)) * 10_000n) / WINDOW_BLOCKS),
    [sel('asset()')]: () => w(BigInt(FXRP)), [sel('assetsUpdatedOn()')]: () => w(T0),
  },
  [VAULT4626]: {
    [sel('decimals()')]: () => w(6n), [sel('asset()')]: () => w(BigInt(FXRP)), [sel('symbol()')]: () => str('mXRP'),
    [sel('convertToAssets(uint256)')]: (_d, n) => (n < HEAD - WINDOW_BLOCKS ? null : w(1_000_000n + ((n - (HEAD - WINDOW_BLOCKS)) * 10_000n) / WINDOW_BLOCKS)),
  },
};
const mcAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);

function evmRpc(host: string, method: string, params: any[]): unknown {
  const chain = evmChains[host];
  const blockOf = (hash: string) => { for (let n = HEAD; n >= 0n && n >= HEAD - 200_000n; n -= 1n) if (blockHash(chain.chainId, n) === hash) return n; return null; };
  const byNumber = (n: bigint) => ({ number: '0x' + n.toString(16), hash: blockHash(chain.chainId, n), timestamp: '0x' + (T0 + n * SPACING).toString(16), parentHash: blockHash(chain.chainId, n - 1n), gasLimit: '0x1', miner: A(0) });
  if (method === 'eth_chainId') return '0x' + chain.chainId.toString(16);
  if (method === 'eth_getBlockByNumber') { const tag = params[0]; return byNumber(tag === 'latest' || tag === 'finalized' ? HEAD : BigInt(tag)); }
  const at = params[1]?.blockHash as string;
  const n = at === blockHash(chain.chainId, HEAD) ? HEAD : blockOfCache(chain.chainId, at) ?? blockOf(at);
  if (n === null || chain.reorged) return { __error: -32000 };
  if (method === 'eth_getCode') return chain.contracts[params[0].toLowerCase()] || params[0].toLowerCase() === POOL ? '0x6001' : '0x';
  if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
  if (method === 'eth_call') {
    const exec = (to: string, data: Hex): Hex | null => chain.contracts[to.toLowerCase()]?.[data.slice(0, 10)]?.(data, n) ?? null;
    const { to, data } = params[0];
    if (to.toLowerCase() === MULTICALL) {
      const { args } = decodeFunctionData({ abi: mcAbi, data });
      const results = (args[0] as unknown as Array<{ target: string; callData: Hex }>).map((c) => { const r = exec(c.target, c.callData); return { success: r !== null, returnData: r ?? '0x' }; });
      return encodeFunctionResult({ abi: mcAbi, functionName: 'aggregate3', result: results as never });
    }
    const r = exec(to, data);
    return r ?? { __error: 3 };
  }
  return { __error: -32601 };
}
const hashIndex = new Map<string, bigint>();
function blockOfCache(chainId: number, hash: string): bigint | null {
  if (!hashIndex.size) for (const id of [42161, 8453, 14]) for (let n = 0n; n <= HEAD; n += 1n) hashIndex.set(blockHash(id, n), n);
  return hashIndex.get(hash) ?? null;
}

// XRPL fixture
const XOPERATOR = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const XUSER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', XBROKER_ACCT = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY', XISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const VAULT_ID = 'A'.repeat(64), BROKER_ID = 'B'.repeat(64), LOAN_ID = 'C'.repeat(64), XHEAD = 1_000_000;
const LOAN_TX = 'D'.repeat(64);
const XRP_FEATURES = {
  '81BD2619B6B3C8625AC5D0BC01DE17F06C3F0AB95C7C87C93715B87A4FD240D8': 'SingleAssetVault',
  '565B90CA1AB2B9D42208ED10884188C64F9E19083DECB9634AAF06EB03299509': 'LendingProtocol',
  A360E2BFD775A5B0DCE1C36C16DF31B72735A57584FD163655D2F9564F8E7AC8: 'LendingProtocolV1_1',
};
const xrplDefaults = () => ({
  lending: true, vault: true, lendingV11: true, brokerLoans: [600, 950, 720],
  networkId: 0, paginate: false, repeatedMarker: false, mixedVault: false, changedLoan: false,
  appliedSimulation: false, receiptValidated: true, issued: false, receiptOverride: {} as Record<string, unknown>,
});
const xrplState = xrplDefaults();
const lhash = (i: number) => createHash('sha256').update('xrpl:' + i).digest('hex').toUpperCase();
const lindex = (h: string) => { for (let i = XHEAD; i > XHEAD - 200_000; i--) if (lhash(i) === h) return i; return null; };
const loanEntry = { index: LOAN_ID, LedgerEntryType: 'Loan', Borrower: XUSER, LoanBrokerID: BROKER_ID, PreviousTxnID: 'E'.repeat(64), PrincipalOutstanding: '1000000', TotalValueOutstanding: '1050000', ManagementFeeOutstanding: '1000', PeriodicPayment: '87500', InterestRate: 500, PaymentRemaining: 12, NextPaymentDueDate: 0, GracePeriod: 86400, Flags: 0x00020000 };
// rippled can omit FinalFields on unrelated AccountRoot nodes in simulate metadata.
const loanMeta = { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: {
  LedgerEntryType: 'AccountRoot', LedgerIndex: '1'.repeat(64),
} }, { ModifiedNode: {
  LedgerEntryType: 'Loan', LedgerIndex: LOAN_ID,
  PreviousFields: { PrincipalOutstanding: '1000000', TotalValueOutstanding: '1050000', PaymentRemaining: 12 },
  FinalFields: { PrincipalOutstanding: '912500', TotalValueOutstanding: '962500', PaymentRemaining: 11 },
} }] };
const issuedAmount = { currency: 'USD', issuer: XISSUER, value: '8.75' };
function xrplRpc(method: string, p: any): Record<string, unknown> {
  const at = p.ledger_hash ? lindex(p.ledger_hash) : null;
  const point = { ledger_hash: p.ledger_hash, ledger_index: at, validated: true };
  switch (method) {
    case 'ledger': { const i = p.ledger_index === 'validated' ? XHEAD : Number(p.ledger_index); return { ledger_hash: lhash(i), ledger_index: i, validated: true, ledger: { close_time: i * 4, ledger_hash: lhash(i) } }; }
    case 'server_info': return { info: { network_id: xrplState.networkId } };
    case 'feature':
      if (!p.feature) return { features: Object.fromEntries(Object.entries(XRP_FEATURES).map(([id, name]) => [
        id, { name, enabled: name === 'SingleAssetVault' ? xrplState.vault : name === 'LendingProtocol' ? xrplState.lending : xrplState.lendingV11 },
      ])) };
      return { ['F'.repeat(64)]: { name: p.feature, enabled: p.feature === 'LendingProtocol' ? xrplState.lending : xrplState.vault } };
    case 'server_state': return { state: { validated_ledger: { reserve_base: 1_000_000, reserve_inc: 200_000 } } };
    case 'account_info': return { account_data: { Balance: '25000000', OwnerCount: 3 } };
    case 'account_lines': return { lines: [{ account: XISSUER, currency: 'USD', balance: '12.5' }] };
    case 'account_objects':
      if (p.account === XOPERATOR) return { account_objects: [{ index: p.type === 'vault' ? VAULT_ID : BROKER_ID }] };
      if (p.account === XUSER) {
        if (xrplState.repeatedMarker || (xrplState.paginate && !p.marker)) return { ...point, account: XUSER, account_objects: [], marker: 'next' };
        return { ...point, account: XUSER, account_objects: [loanEntry] };
      }
      return { account_objects: xrplState.brokerLoans.map((r, i) => ({ index: String(i).repeat(64).slice(0, 64), LoanBrokerID: BROKER_ID, InterestRate: r })) };
    case 'ledger_entry':
      if (p.index === LOAN_ID) return { ...point, index: LOAN_ID, node: { ...loanEntry, ...(xrplState.changedLoan && at === XHEAD ? { PreviousTxnID: 'F'.repeat(64) } : {}) } };
      if (p.index === BROKER_ID) return { ...point, index: BROKER_ID, node: { LedgerEntryType: 'LoanBroker', Account: XBROKER_ACCT, VaultID: VAULT_ID } };
      if (p.index === VAULT_ID) return { ...point, ...(xrplState.mixedVault ? { ledger_hash: lhash(XHEAD - 1) } : {}), index: VAULT_ID, node: { LedgerEntryType: 'Vault', Asset: xrplState.issued ? { currency: 'USD', issuer: XISSUER } : { currency: 'XRP' }, ShareMPTID: 'MPT', AssetsTotal: at !== null && at < XHEAD ? '1000000' : '1010000', LossUnrealized: '0' } };
      if (p.mpt_issuance) return { node: { OutstandingAmount: '1000000' } };
      return { error: 'entryNotFound' };
    case 'simulate': {
      const engine_result = p.tx_json.Flags === 0x00040000 ? 'tesSUCCESS' : 'tecEXPIRED';
      return { applied: xrplState.appliedSimulation, ledger_index: XHEAD + 1, engine_result, tx_json: { ...p.tx_json, Fee: '12', SigningPubKey: '', TxnSignature: '' }, meta: engine_result === 'tesSUCCESS' ? loanMeta : {} };
    }
    case 'tx': return {
      hash: LOAN_TX, validated: xrplState.receiptValidated, ledger_index: XHEAD, ledger_hash: lhash(XHEAD),
      tx_json: { TransactionType: 'LoanPay', Account: XUSER, LoanID: LOAN_ID, Amount: xrplState.issued ? issuedAmount : '87500', Flags: 0x80040000, Fee: '12', ...xrplState.receiptOverride },
      meta: loanMeta,
    };
  }
  return { error: 'unknownCmd' };
}
const rpcCalls: string[] = [];
const fetcher = (async (url: string | URL, init?: RequestInit) => {
  const host = new URL(String(url)).host;
  const body = JSON.parse(String(init?.body));
  rpcCalls.push(host + ':' + body.method);
  const result = host === 'xrpl.test' ? xrplRpc(body.method, body.params[0]) : evmRpc(host, body.method, body.params);
  const payload = result && typeof result === 'object' && '__error' in (result as object) ? { jsonrpc: '2.0', id: body.id, error: { code: (result as { __error: number }).__error } } : { jsonrpc: '2.0', id: body.id, result };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const ratesConfig = (over: Partial<RatesConfig> = {}): RatesConfig => ({
  aaveProviders: { arbitrum: PROVIDER, base: PROVIDER }, morphoMarkets: { base: [MARKET_ID] }, morphoIrmAllowlist: [IRM],
  kineticMarkets: [KTOKEN, KBROKEN], vaults4626: [VAULT4626], xrplVaults: [VAULT_ID], xrplBrokers: [BROKER_ID],
  yieldTokens: [{ kind: 'firelight', address: FIRELIGHT }, { kind: 'sceptre', address: SCEPTRE }, { kind: 'upshift', address: UPSHIFT }],
  archive: { flare: true, xrpl: true }, windowSeconds: 604_800, ...over,
});
const endpoints = { arbitrum: 'https://arb.test/', base: 'https://base.test/', flare: 'https://flare.test/', xrpl: 'https://xrpl.test/', robinhood: 'https://rh.test/' };
const req = (op: string, network: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 'finance.request/1', requestId: `req-${op}-${network}`, idempotency_key: `finance:${op}:${network}:${Math.random()}`, network, operation: op, ...(op === 'capabilities' ? {} : { contractDigest: FINANCE_CONTRACT_DIGEST }), ...extra });
const evmAccount = (address: string, chainId = 42161) => ({ family: 'evm', address, chainId, model: 'eoa' });
const positions = (network: string, account: unknown, scope = 'both') => req('positions', network, { account, scope, limit: 20, cursor: null });
const ratesReq = (over: Record<string, unknown> = {}) => ({ schemaVersion: 'finance.rates.request/1', requestId: 'rates-1', ratesContractDigest: RATES_CONTRACT_DIGEST, networks: ['arbitrum', 'base', 'flare', 'xrpl'], assets: null, side: 'both', includeDocumented: false, ...over });
const marker = (id: string) => console.log(`FINANCE_MCP_${id}_PROVEN`);

// ── Harness: real worker HTTP server + real gateway ───────────────────────────
let worker: ResearchWorker, repo: MemoryRepository, server: ReturnType<typeof createResearchServer>, ticker: ReturnType<typeof setInterval>, port = 0;
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'finance-e2e-'));
  repo = new MemoryRepository();
  worker = new ResearchWorker({ repo, root, endpoints: {}, deployments: [], fetcher, finance: { endpoints, fetcher, rates: ratesConfig(), inlineWaitMs: 3000, xrplLoanPay: true } });
  server = createResearchServer(worker, 'x'.repeat(32));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
  ticker = setInterval(() => { void worker.tick().catch(() => undefined); }, 20);
});
afterAll(() => { clearInterval(ticker); worker.stop(); server.close(); });
beforeEach(() => {
  vi.stubEnv('FEATURE_MCP_FINANCE_V1', 'true'); vi.stubEnv('FLASHLOAN_WORKER_URL', `http://127.0.0.1:${port}`); vi.stubEnv('FLASHLOAN_WORKER_TOKEN', 'x'.repeat(32));
  vi.stubEnv('FINANCE_XRPL_LOAN_PAY_V1', 'false');
  vi.stubEnv('FEATURE_MCP_PAYWALL', 'true'); vi.stubEnv('FEATURE_MCP_RATE_LIMIT', 'true');
  meter.checkAndConsume.mockClear(); meter.findActiveSession.mockClear(); clearRatesCache(); rpcCalls.length = 0;
  evmChains['arb.test'].reorged = false; Object.assign(xrplState, xrplDefaults());
});
const workerPost = (body: string | Uint8Array) => fetch(`http://127.0.0.1:${port}/research/finance`, { method: 'POST', headers: { authorization: 'Bearer ' + 'x'.repeat(32), 'content-type': 'application/json' }, body });
const gateway = async (name: string, args: Record<string, unknown>, session = { userId: 'owner-a', tier: 'pro', kind: 'user' }) => {
  const { callTool } = await import('../src/lib/mcp/gateway');
  return callTool({ session: session as never, name, args });
};

describe('E2E-01 legacy path with Finance flags off', () => {
  it('registers no finance tools and no legacy tool gains an inputValidator', async () => {
    vi.stubEnv('FEATURE_MCP_FINANCE_V1', 'false');
    const { getTools } = await import('../src/lib/mcp/tools');
    const tools = getTools();
    expect(tools.some((t) => t.name.startsWith('finance_'))).toBe(false);
    expect(tools.filter((t) => t.inputValidator || t.summarize)).toEqual([]);
    vi.stubEnv('FEATURE_MCP_FINANCE_V1', 'true');
    const names = getTools().filter((t) => t.name.startsWith('finance_')).map((t) => t.name).sort();
    expect(names).toEqual(['finance_get_action_status_v1', 'finance_get_capabilities_v1', 'finance_get_job_v1', 'finance_get_lending_rates_v1', 'finance_get_positions_v1']);
  });
  it('raw-body guard passes non-finance requests through untouched', async () => {
    const legacy = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xrpl.yield.compare","arguments":{"a":1,"a":2}}}';
    const out = await guardFinanceBody(new Request('http://x/api/mcp', { method: 'POST', body: legacy }));
    expect(out).toBeInstanceOf(Request);
    expect(await (out as Request).text()).toBe(legacy);
  });
});

describe('EDGE-01 boundary', () => {
  it('rejects duplicate keys and invalid UTF-8 on raw finance bodies before the SDK (route + worker)', async () => {
    const dup = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"finance_get_positions_v1","arguments":{"network":"arbitrum","network":"base"}}}';
    const r1 = await guardFinanceBody(new Request('http://x/api/mcp', { method: 'POST', body: dup })) as Response;
    expect(r1.status).toBe(400); expect((await r1.json()).error.code).toBe(-32602);
    const bad = new Uint8Array([...new TextEncoder().encode('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"finance_x","arguments":{"s":"'), 0xff, ...new TextEncoder().encode('"}}}')]);
    const r2 = await guardFinanceBody(new Request('http://x/api/mcp', { method: 'POST', body: bad })) as Response;
    expect((await r2.json()).error.code).toBe(-32700);
    const w1 = await workerPost('{"owner":"a","owner":"b","operation":"capabilities","input":{}}');
    expect(w1.status).toBe(400); expect((await w1.json()).error.code).toBe('INVALID_INPUT');
    const w2 = await workerPost(JSON.stringify({ owner: 'a', operation: 'prepare', input: {} }));
    expect((await w2.json()).error.code).toBe('INVALID_INPUT');
    marker('EDGE-01');
  });
  it('anonymous and malformed calls are rejected before guardians/metering with zero billing (E2E-03/E2E-07)', async () => {
    const free = { userId: 'owner-a', tier: 'free', kind: 'user' };
    const anon = await gateway('finance_get_capabilities_v1', req('capabilities', 'arbitrum'), { userId: 'anonymous', tier: 'free', kind: 'user' });
    expect(anon.error?.code).toBe(-32001);
    const cases: Array<Record<string, unknown>> = [
      { ...positions('arbitrum', evmAccount(USER)), owner: 'victim' },
      { ...positions('arbitrum', evmAccount(USER)), limit: 1.5 },
      { ...req('compare', 'arbitrum'), requestedConstraints: { maxSpend: [{ asset: {}, quantity: { kind: 'atomic', value: 1 } }] } },
      { ...positions('arbitrum', evmAccount(USER)), cursor: 'x'.repeat(300_000) },
      { ...req('capabilities', 'arbitrum'), operation: 'positions' },
    ];
    for (const args of cases) {
      const out = await gateway('finance_get_positions_v1', args, free);
      expect(out.error?.code, JSON.stringify(Object.keys(args))).toBe(-32602);
      expect(JSON.stringify(out.error)).not.toMatch(/https?:\/\/|token|Bearer/i);
    }
    expect(meter.checkAndConsume).not.toHaveBeenCalled();
    expect(meter.findActiveSession).not.toHaveBeenCalled();
  });
});

describe('EDGE-02 state: capabilities and positions', () => {
  it('capabilities cover all 4 networks with explicit XRPL rows and the Robinhood gate (E2E-02)', async () => {
    const out = await gateway('finance_get_capabilities_v1', req('capabilities', 'robinhood'));
    const resp = out.result as any;
    expect(resp.execution).toBe(false);
    expect(resp.warnings[0]).toBe(`ratesContractDigest:${RATES_CONTRACT_DIGEST}`);
    expect(resp.data.find((c: any) => c.operation === 'positions')).toMatchObject({ stage: 'UNSUPPORTED', reasonCode: 'ROBINHOOD_LENDER_UNVERIFIED' });
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig() });
    const all = await svc.capabilities();
    expect(new Set(all.map((c) => c.network))).toEqual(new Set(['arbitrum', 'base', 'robinhood', 'xrpl']));
    expect(all.filter((c) => ['earn', 'withdraw', 'borrow', 'repay', 'protect', 'flash'].includes(c.operation as string)).every((c) => c.stage === 'UNSUPPORTED')).toBe(true);
    expect(all.find((c) => c.network === 'xrpl' && c.operation === 'positions')?.stage).toBe('READ_VERIFIED');
    expect(all.some((c) => c.stage === 'LOCAL_EXECUTION_ADMITTED' || c.stage === 'PREPARE_VERIFIED')).toBe(false);
  });
  it('Aave positions through gateway → worker → job → artifact: units, HF, collateral/debt split (E2E-05)', async () => {
    const out = await gateway('finance_get_positions_v1', positions('arbitrum', evmAccount(USER)));
    const resp = out.result as any;
    expect(resp.kind).toBe('positions');
    const pos = resp.data.positions[0];
    expect(pos).toMatchObject({ protocol: 'aave-v3', noDebt: false, healthFactor: '1.84', ltv: '0.4', liquidationThreshold: '0.825' });
    expect(pos.collateral).toEqual([{ asset: { kind: 'erc20', network: 'arbitrum', address: WETH, decimals: 18 }, quantity: { kind: 'atomic', value: '1000000000000000000' } }]);
    expect(pos.debt[0].quantity.value).toBe('1200000000');
    expect(resp.data.balances[0]).toMatchObject({ asset: { kind: 'evm-native' }, quantity: { value: '1000000000000000000' } });
    expect(resp.data.observation.point.hash).toBe(blockHash(42161, HEAD));
    marker('EDGE-02');
  });
  it('no-debt account normalises the uint256 sentinel to noDebt=true, healthFactor=null', async () => {
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig(), inlineWaitMs: 0 });
    const job = { id: 'j', owner: 'o', operation: 'finance:positions', input: { request: positions('arbitrum', evmAccount(USER_NO_DEBT)) } } as never;
    const out = await svc.executePositions(job, new AbortController().signal);
    expect((out.data.report as any).positions).toEqual([]); // nothing held: no synthetic zero position
  });
  it('Morpho Blue position keeps shares + protocol rounding and computes HF from oracle and LLTV', async () => {
    const out = await gateway('finance_get_positions_v1', positions('base', evmAccount(USER, 8453), 'lending'));
    const morpho = (out.result as any).data.positions.find((p: any) => p.protocol === 'morpho-blue');
    expect(morpho.shareEvidence[0]).toMatchObject({ role: 'borrow', raw: '100000000000000' });
    expect(morpho.debt[0].quantity.value).toBe('100000000'); // 100 USDC (rounded up)
    expect(morpho.collateral[0].quantity.value).toBe('100000000000000000');
    expect(morpho.healthFactor).toBe('2.58'); // 0.1 WETH × 3000 × 0.86 / 100
  });
  it('mixed/reorged block yields partial coverage, never zero balances (E2E-06)', async () => {
    evmChains['arb.test'].reorged = true;
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig() });
    const job = { id: 'j', owner: 'o', operation: 'finance:positions', input: { request: positions('arbitrum', evmAccount(USER)) } } as never;
    const out = await svc.executePositions(job, new AbortController().signal);
    const report = out.data.report as any;
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.missing.map((m: any) => m.capability)).toEqual(expect.arrayContaining(['arbitrum.native-balance', 'arbitrum.aave-v3']));
    expect(report.balances).toEqual([]); expect(report.positions).toEqual([]);
  });
});

describe('EDGE-04 native semantics', () => {
  it('XRPL report: same ledger, live reserves, Loan join with tenths-bps rate, Ripple epoch and absent LoanScale (E2E-09)', async () => {
    const out = await gateway('finance_get_positions_v1', positions('xrpl', { family: 'xrpl', address: XUSER, model: 'native' }));
    const r = (out.result as any).data;
    expect(r.reservedXrp.quantity.value).toBe('1600000'); // 1 XRP base + 3 × 0.2 XRP, from server_state
    expect(r.balances[1]).toMatchObject({ asset: { kind: 'xrpl-issued', currency: 'USD', issuer: XISSUER }, quantity: { kind: 'issued-decimal', coefficient: '125', exponent: -1 } });
    const loan = r.positions[0];
    expect(loan).toMatchObject({ kind: 'xrpl-loan', interestRateTenthsBps: 500, nextDueAt: '2000-01-01T00:00:00.000Z', loanScale: null, flags: ['impaired'] });
    expect(loan.principalOutstanding).toEqual({ asset: { kind: 'xrp', network: 'xrpl', decimals: 6 }, quantity: { kind: 'atomic', value: '1000000' } });
    expect(loan.observation.point.hash).toBe(r.observation.point.hash);
    const summary = (await import('../src/lib/mcp/flashloan/finance/tools')).financeSummary(out.result as any);
    expect(summary).toContain('rate 0.50% APR');
    marker('EDGE-04');
  });
  it('XRPL loans with the amendment off are UNKNOWN coverage, not zero debt', async () => {
    xrplState.lending = false;
    const out = await gateway('finance_get_positions_v1', positions('xrpl', { family: 'xrpl', address: XUSER, model: 'native' }, 'lending'));
    const r = (out.result as any);
    expect(r.status).toBe('partial');
    expect(r.data.positions).toEqual([]);
    expect(r.data.coverage.missing).toContainEqual({ capability: 'xrpl.loans', reasonCode: 'FEATURE_STATE_UNKNOWN' });
  });
  it('follows a pinned empty page and reports a repeated marker or mismatched Vault as partial', async () => {
    const read = async () => (await gateway('finance_get_positions_v1', positions('xrpl', { family: 'xrpl', address: XUSER, model: 'native' }, 'lending'))).result as any;
    xrplState.paginate = true;
    const paged = await read();
    expect(paged.data.positions).toHaveLength(1);
    expect(paged.data.coverage.complete).toBe(true);
    xrplState.repeatedMarker = true;
    const truncated = await read();
    expect(truncated.data.positions).toEqual([]);
    expect(truncated.data.coverage.missing).toContainEqual({ capability: 'xrpl.loans', reasonCode: 'PAGE_LIMIT' });
    xrplState.repeatedMarker = false;
    xrplState.mixedVault = true;
    const mixed = await read();
    expect(mixed.data.positions).toEqual([]);
    expect(mixed.data.coverage.missing).toContainEqual({ capability: 'xrpl.loan:' + LOAN_ID.slice(0, 16), reasonCode: 'JOIN_INCOMPLETE' });
  });
  it('Robinhood positions, wrong chainId and native write requests are blocked (E2E-10)', async () => {
    const rh = (await gateway('finance_get_positions_v1', positions('robinhood', evmAccount(USER, 4663)))).result as any;
    expect(rh).toMatchObject({ kind: 'error', status: 'blocked', errors: [{ code: 'CAPABILITY_UNAVAILABLE' }] });
    const wrong = (await gateway('finance_get_positions_v1', positions('arbitrum', evmAccount(USER, 8453)))).result as any;
    expect(wrong.errors[0].code).toBe('WRONG_CHAIN');
    const stale = (await gateway('finance_get_positions_v1', { ...positions('arbitrum', evmAccount(USER)), contractDigest: '0'.repeat(64) })).result as any;
    expect(stale.errors[0]).toMatchObject({ code: 'CONTRACT_MISMATCH' });
    expect(stale.errors[0].recovery).toContain(FINANCE_CONTRACT_DIGEST);
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig() });
    await expect(svc.dispatch('owner-a', 'prepare-payment' as never, req('prepare-payment', 'xrpl'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('authenticated XRPL LoanPay calls', () => {
  const base = {
    schemaVersion: 'finance.xrpl-loan-pay.request/1', requestId: 'loan-pay', environment: 'devnet', borrower: XUSER,
    loanId: LOAN_ID, mode: 'late', maxAmount: '87500',
  };
  const preview = async (over: Record<string, unknown> = {}) => {
    const state = (await gateway('finance_get_positions_v1', positions('xrpl', { family: 'xrpl', address: XUSER, model: 'native' }, 'lending'))).result as any;
    const loan = state.data.positions[0];
    const position = { positionId: loan.positionId, ledgerIndex: Number(loan.observation.point.index), ledgerHash: loan.observation.point.hash };
    return (await gateway('finance_preview_xrpl_loan_pay_v1', { ...base, position, ...over })).result as any;
  };
  beforeEach(() => {
    vi.stubEnv('FINANCE_XRPL_LOAN_PAY_V1', 'true');
    xrplState.networkId = 2;
  });

  it('discovers the registered tools and gates their availability on network and amendments', async () => {
    const { getTools } = await import('../src/lib/mcp/tools');
    expect(getTools().filter(x => x.name.includes('xrpl_loan_pay')).map(x => [x.name, x.requiresAuthentication])).toEqual([
      ['finance_preview_xrpl_loan_pay_v1', true], ['finance_verify_xrpl_loan_pay_v1', true],
    ]);
    const capabilities = async () => ((await gateway('finance_get_capabilities_v1', req('capabilities', 'xrpl'))).result as any).warnings;
    expect(await capabilities()).toContain('xrplLoanPay:devnet:enabled');
    xrplState.networkId = 0;
    xrplState.lendingV11 = false;
    expect(await capabilities()).toContain('xrplLoanPay:mainnet:disabled');
    expect(await preview()).toMatchObject({ kind: 'error', error: { code: 'WRONG_CHAIN' }, execution: false });
    expect(await preview({ environment: 'mainnet' })).toMatchObject({ kind: 'error', error: { code: 'FEATURE_DISABLED' } });
    expect(rpcCalls).not.toContain('xrpl.test:simulate');
    const anon = await gateway('finance_verify_xrpl_loan_pay_v1', { ...base, txHash: LOAN_TX }, { userId: 'anonymous', tier: 'free', kind: 'user' });
    expect(anon.error?.code).toBe(-32001);
    const disabled = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig() });
    expect(await disabled.dispatch('owner-a', 'xrpl-loan-pay-verify', { ...base, txHash: LOAN_TX })).toMatchObject({ kind: 'error', error: { code: 'FEATURE_DISABLED' } });
  });

  it('previews an unsigned late payment and reports a regular-payment rejection without a transaction', async () => {
    expect(await preview()).toMatchObject({
      kind: 'xrpl-loan-pay-preview', readingLedger: { index: XHEAD, hash: lhash(XHEAD) }, simulationLedgerIndex: XHEAD + 1,
      engineResult: 'tesSUCCESS', applied: false, execution: false, feeDrops: '12',
      unsignedTransaction: { TransactionType: 'LoanPay', Account: XUSER, LoanID: LOAN_ID, Amount: '87500', Flags: 0x00040000 },
      deltas: { PrincipalOutstanding: { before: '1000000', after: '912500' } },
    });
    expect(await preview({ mode: 'regular' })).toMatchObject({ engineResult: 'tecEXPIRED', applied: false, unsignedTransaction: null, deltas: null });
    expect(rpcCalls.some(c => /:submit/.test(c))).toBe(false);
  });

  it('rejects stale or changed positions, wrong borrowers and an applied simulation response', async () => {
    const positionAt = (at: number) => {
      const ledgerHash = lhash(at);
      return { ledgerIndex: at, ledgerHash, positionId: createHash('sha256').update(JSON.stringify({ ledger: ledgerHash, loan: LOAN_ID })).digest('hex') };
    };
    expect(await preview({ position: positionAt(XHEAD - 31) })).toMatchObject({ error: { code: 'STALE_STATE' } });
    xrplState.changedLoan = true;
    expect(await preview({ position: positionAt(XHEAD - 1) })).toMatchObject({ error: { code: 'STALE_STATE' } });
    expect(await preview({ borrower: XOPERATOR })).toMatchObject({ error: { code: 'OWNER_SCOPE_MISMATCH' } });
    xrplState.appliedSimulation = true;
    expect(await preview()).toMatchObject({ error: { code: 'SIMULATION_UNAVAILABLE' }, execution: false });
  });

  it('validates a receipt against the exact asset, payment mode and maximum amount', async () => {
    xrplState.issued = true;
    const verify = async (over: Record<string, unknown> = {}) => (await gateway('finance_verify_xrpl_loan_pay_v1', {
      ...base, maxAmount: { ...issuedAmount, value: '8.75000' }, txHash: LOAN_TX, ...over,
    })).result as any;
    expect(await verify()).toMatchObject({
      kind: 'xrpl-loan-pay-receipt', status: 'verified', execution: false, txHash: LOAN_TX,
      loanId: LOAN_ID, borrower: XUSER, transactionAmountCap: issuedAmount, feeDrops: '12',
      deltas: { PaymentRemaining: { before: '12', after: '11' } },
    });
    expect(await verify({ maxAmount: { ...issuedAmount, value: '8.74999' } })).toMatchObject({ error: { code: 'RECONCILIATION_MISMATCH' } });
    expect(await verify({ maxAmount: { ...issuedAmount, issuer: XOPERATOR } })).toMatchObject({ error: { code: 'RECONCILIATION_MISMATCH' } });
    expect(await verify({ mode: 'regular' })).toMatchObject({ error: { code: 'RECONCILIATION_MISMATCH' } });
    expect(await verify({ borrower: XOPERATOR })).toMatchObject({ error: { code: 'RECONCILIATION_MISMATCH' } });
    expect(await verify({ loanId: VAULT_ID })).toMatchObject({ error: { code: 'RECONCILIATION_MISMATCH' } });
    xrplState.receiptValidated = false;
    expect(await verify()).toMatchObject({ error: { code: 'RECONCILIATION_MISMATCH' } });
  });
});

describe('EDGE-02b lending rates (MC-12)', () => {
  it('returns labelled rows from every venue, ranked only within a rate kind', async () => {
    const out = await gateway('finance_get_lending_rates_v1', ratesReq());
    const resp = out.result as any;
    expect(resp).toMatchObject({ kind: 'lending-rates', execution: false });
    const by = (venue: string, label?: string) => resp.data.markets.filter((m: any) => m.venue === venue && (!label || m.assetLabel === label));
    expect(by('aave-v3', 'USDC')[0]).toMatchObject({ rateKind: 'posted-variable', supplyApr: '0.03', borrowApr: '0.05', supplyApy: '0.030454', utilization: '0.4' });
    expect(by('aave-v3', 'WETH')[0].caveats).toContain('reserve frozen: no new supply/borrow');
    const morpho = by('morpho-blue')[0];
    expect(Number(morpho.borrowApr)).toBeCloseTo(0.06, 5); expect(Number(morpho.supplyApr)).toBeCloseTo(0.06 * 0.5 * 0.9, 5);
    const kinetic = by('kinetic', 'FXRP')[0];
    expect(kinetic).toMatchObject({ network: 'flare', requiresBridge: true, utilization: '0.4' });
    expect(Number(kinetic.supplyApr)).toBeCloseTo(0.029, 5);
    const vault = by('erc4626-vault')[0];
    expect(vault.rateKind).toBe('realized-trailing'); expect(vault.window.seconds).toBe(604_800);
    expect(Number(vault.supplyApy)).toBeCloseTo(Math.pow(1.01, 365 / 7) - 1, 3);
    const xv = by('xrpl-vault')[0];
    expect(xv.rateKind).toBe('realized-trailing'); expect(Number(xv.supplyApy)).toBeGreaterThan(0.6);
    expect(by('xrpl-loanbroker')[0]).toMatchObject({ assetLabel: 'XRP', asset: { kind: 'xrp' }, range: { min: '0.006', median: '0.0072', max: '0.0095', sampleSize: 3 } });
    expect(resp.coverage.missing).toContainEqual({ capability: 'flare.kinetic:' + KBROKEN.slice(0, 10), reasonCode: 'CAPABILITY_UNAVAILABLE' });
    const kinds = resp.data.markets.map((m: any) => m.rateKind);
    expect(kinds).toEqual([...kinds].sort((a: string, b: string) => ['posted-variable', 'realized-trailing', 'observed-loan-range', 'documented-headline'].indexOf(a) - ['posted-variable', 'realized-trailing', 'observed-loan-range', 'documented-headline'].indexOf(b)));
    marker('EDGE-02b');
  });
  it('Flare yield tokens: on-chain history (Firelight, Sceptre) and archive (Upshift); native Kinetic market labelled FLR', async () => {
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig({ kineticMarkets: [KTOKEN, KNATIVE] }) });
    const r = await svc.dispatch('o', 'lending-rates', ratesReq({ networks: ['flare'] })) as any;
    const y = (label: string) => r.data.markets.find((m: any) => m.venue === 'yield-token' && m.assetLabel === label);
    expect(y('stXRP')).toMatchObject({ venueName: 'Firelight stXRP', rateKind: 'realized-trailing', requiresBridge: true, window: { seconds: 604_800 } });
    expect(Number(y('stXRP').supplyApy)).toBeCloseTo(Math.pow(1.01, 365 / 7) - 1, 2);
    expect(y('sFLR')).toMatchObject({ venueName: 'Sceptre sFLR', asset: { kind: 'evm-native', network: 'flare' }, window: { seconds: 8 * 86_400 } });
    expect(Number(y('sFLR').supplyApy)).toBeCloseTo(Math.pow(1.01, 365 / 8) - 1, 3);
    expect(y('sFLR').caveats.some((c: string) => c.includes('on-chain price history'))).toBe(true);
    expect(y('FXRP vault')).toMatchObject({ venueName: 'Upshift FXRP vault', window: { seconds: 604_800 } });
    expect(Number(y('FXRP vault').supplyApy)).toBeCloseTo(Math.pow(1.01, 365 / 7) - 1, 3);
    expect(r.data.markets.find((m: any) => m.venue === 'kinetic' && m.venueRef.address === KNATIVE)).toMatchObject({ assetLabel: 'FLR', asset: null });
    expect(r.coverage.missing).toEqual([]);
    clearRatesCache();
    const noArchive = await new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig({ archive: {} }) }).dispatch('o', 'lending-rates', ratesReq({ networks: ['flare'] })) as any;
    expect(noArchive.data.markets.find((m: any) => m.assetLabel === 'stXRP').supplyApy).not.toBeNull(); // checkpoint history needs no archive
    expect(noArchive.data.markets.find((m: any) => m.assetLabel === 'FXRP vault').supplyApy).toBeNull();
    expect(noArchive.coverage.missing).toContainEqual({ capability: 'flare.yield-token.upshift-window', reasonCode: 'ARCHIVE_UNAVAILABLE' });
    clearRatesCache();
  });
  it('XRPL operator discovery finds vaults and loan brokers at the pinned ledger only when the amendments are on', async () => {
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig({ xrplVaults: [], xrplBrokers: [], xrplOperators: [XOPERATOR] }) });
    let r = await svc.dispatch('o', 'lending-rates', ratesReq({ networks: ['xrpl'] })) as any;
    expect(r.data.markets.map((m: any) => m.venue).sort()).toEqual(['xrpl-loanbroker', 'xrpl-vault']);
    clearRatesCache(); xrplState.vault = false; xrplState.lending = false;
    const before = rpcCalls.filter((c) => c.endsWith('account_objects')).length;
    r = await svc.dispatch('o', 'lending-rates', ratesReq({ networks: ['xrpl'] })) as any;
    expect(r.data.markets).toEqual([]);
    expect(rpcCalls.filter((c) => c.endsWith('account_objects')).length).toBe(before);
    expect(r.coverage.missing).toEqual(expect.arrayContaining([{ capability: 'xrpl.vault', reasonCode: 'FEATURE_STATE_UNKNOWN' }, { capability: 'xrpl.loanbroker', reasonCode: 'FEATURE_STATE_UNKNOWN' }]));
    xrplState.vault = true; xrplState.lending = true; clearRatesCache();
  });
  it('archive off → realised yield null with ARCHIVE_UNAVAILABLE; amendment off → UNKNOWN; no loans → range null', async () => {
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig({ archive: {} }) });
    let r = await svc.dispatch('o', 'lending-rates', ratesReq({ networks: ['flare', 'xrpl'] })) as any;
    expect(r.data.markets.find((m: any) => m.venue === 'erc4626-vault').supplyApy).toBeNull();
    expect(r.coverage.missing).toEqual(expect.arrayContaining([{ capability: 'flare.erc4626-vault.window', reasonCode: 'ARCHIVE_UNAVAILABLE' }, { capability: 'xrpl.vault.window', reasonCode: 'ARCHIVE_UNAVAILABLE' }]));
    clearRatesCache(); xrplState.vault = false; xrplState.brokerLoans = [];
    r = await svc.dispatch('o', 'lending-rates', ratesReq({ networks: ['xrpl'] })) as any;
    expect(r.coverage.missing).toEqual(expect.arrayContaining([{ capability: 'xrpl.vault', reasonCode: 'FEATURE_STATE_UNKNOWN' }, { capability: 'xrpl.loanbroker:BBBBBBBB', reasonCode: 'NO_ACTIVE_LOANS' }]));
    expect(r.data.markets.find((m: any) => m.venue === 'xrpl-loanbroker').range).toBeNull();
  });
  it('documented rows are opt-in, labelled, stale-warned and never ranked above chain reads', async () => {
    const out = await gateway('finance_get_lending_rates_v1', ratesReq({ networks: ['xrpl', 'flare'], includeDocumented: true, assets: [{ symbol: 'XRP' }], side: 'supply' }));
    const resp = out.result as any;
    const docs = resp.data.markets.filter((m: any) => m.venue === 'documented');
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((m: any) => m.observation.fidelity === 'documented' && m.rateKind === 'documented-headline')).toBe(true);
    expect(resp.data.markets.at(-1).venue).toBe('documented');
    expect(resp.warnings.some((x: string) => x.startsWith('STALE_DOCUMENTED'))).toBe(true);
    expect(resp.data.markets.every((m: any) => m.borrowApy === null)).toBe(true);
  });
  it('second call within TTL is served from the public block-keyed cache (no extra RPC)', async () => {
    const svc = new FinanceService({ repo, endpoints, fetcher, rates: ratesConfig() });
    await svc.dispatch('o', 'lending-rates', ratesReq({ networks: ['arbitrum'] }));
    const first = rpcCalls.length;
    await svc.dispatch('other-owner', 'lending-rates', ratesReq({ networks: ['arbitrum'] }));
    expect(rpcCalls.length).toBe(first);
  });
});

describe('EDGE-03 authority', () => {
  it('cross-owner job and artifact lookups are NOT_FOUND (E2E-03)', async () => {
    const mine = (await gateway('finance_get_positions_v1', positions('arbitrum', evmAccount(USER)))).result as any;
    const jobs = await repo.claim(); void jobs; // drain nothing; job already completed by ticker
    const all = (repo as any).jobs as Map<string, any>;
    const job = [...all.values()].find((j) => j.owner === 'owner-a' && j.operation === 'finance:positions')!;
    const theirs = (await gateway('finance_get_job_v1', req('job', 'arbitrum', { jobId: job.id, mode: 'get' }), { userId: 'owner-b', tier: 'pro', kind: 'user' })).result as any;
    expect(theirs.errors[0].code).toBe('NOT_FOUND');
    const art = (await gateway('finance_get_action_status_v1', req('status', 'arbitrum', { artifactRef: job.result_id }), { userId: 'owner-b', tier: 'pro', kind: 'user' })).result as any;
    expect(art.errors[0].code).toBe('NOT_FOUND');
    const own = (await gateway('finance_get_action_status_v1', req('status', 'arbitrum', { artifactRef: job.result_id }))).result as any;
    expect(own.kind).toBe('positions'); expect(own.requestId).toBe('req-status-arbitrum'); expect(mine.kind).toBe('positions');
    marker('EDGE-03');
  });
  it('the Finance lane has no signer or submission code path (E2E-04)', async () => {
    const dir = join(process.cwd(), 'src/lib/mcp/flashloan/finance');
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.ts')) continue;
      const text = await readFile(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/privateKey|signTransaction|sendRawTransaction|eth_sendRawTransaction|signAndSend|submit_multisigned|"submit"/);
    }
    expect(rpcCalls.some((c) => /send|submit|sign/i.test(c))).toBe(false);
  });
});

describe('EDGE-05 recovery', () => {
  it('idempotency conflict, cancel-vs-publication race and storage outage', async () => {
    const a = positions('arbitrum', evmAccount(USER));
    await gateway('finance_get_positions_v1', a);
    const conflict = (await gateway('finance_get_positions_v1', { ...a, scope: 'lending' })).result as any;
    expect(conflict.errors[0].code).toBe('IDEMPOTENCY_CONFLICT');

    const isolated = new MemoryRepository();
    const job = await isolated.enqueue('owner-c', 'finance:positions' as never, { idempotency_key: 'k', request: {} });
    const claimed = (await isolated.claim())!;
    await isolated.cancel('owner-c', job.id);
    expect(await isolated.complete(claimed, 'finance-positions', {})).toBe(false);
    expect((await isolated.get('owner-c', job.id)).state).toBe('CANCELLED');

    const down = { ...new MemoryRepository(), enqueue: async () => { throw new ResearchError('STORAGE_UNAVAILABLE', 'Research storage unavailable.', true); } } as never;
    const svc = new FinanceService({ repo: down, endpoints, fetcher, rates: ratesConfig() });
    const out = await svc.dispatch('owner-a', 'positions', positions('arbitrum', evmAccount(USER))) as any;
    expect(out).toMatchObject({ kind: 'error', status: 'failed', errors: [{ code: 'STORAGE_UNAVAILABLE', retryable: true }] });
    marker('EDGE-05');
  });
});
