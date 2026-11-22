// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';
import { EvmReader } from '../src/lib/mcp/flashloan/evm';
import { JsonClient } from '../src/lib/mcp/flashloan/transport';
import { hash, VERSION } from '../src/lib/mcp/flashloan/contracts';
import { researchVerified, registryHash, implementationFingerprint } from '../src/lib/mcp/flashloan/verification';
import { SuiReader, suiSdk, suiClosedRoutes, buildSuiTransaction, suiRuntimeSupported } from '../src/lib/mcp/flashloan/sui';
import { SUI_MAINNET_CHAIN_IDENTIFIER, coinType } from '../src/lib/mcp/flashloan/networks';
import { suiSnapshotSchema, type SuiPlan, type SuiSnapshot } from '../src/lib/mcp/flashloan/sui-contracts';
const addr = (n: string) => '0x' + n.repeat(40), id = (n: string) => '0x' + n.repeat(64);
const a = coinType.parse('0x2::sui::SUI'), b = coinType.parse('0x3::usdc::USDC');
const deployment = { protocol: 'DEEPBOOK_V3' as const, original_package: id('4'), published_at: id('5'), package_digest: 'package-digest', version: 'fixture' };
const pool = (n: string) => ({ object_id: id(n), protocol: 'DEEPBOOK_V3' as const, coin_a: a, coin_b: b, version: '1', digest: 'pool-digest-' + n, funding_fee: { pips: 0, source: 'PROTOCOL_VERSION' as const, observed_at: new Date().toISOString() }, content_bcs: 'AA==', initial_shared_version: '1', deployment });
const snapshot: SuiSnapshot = { network: 'sui', chain_identifier: SUI_MAINNET_CHAIN_IDENTIFIER, checkpoint: { sequence_number: '100', digest: 'checkpoint-digest' }, pools: [pool('1'), pool('2'), pool('3')], lender: { object_id: id('1'), protocol: 'DEEPBOOK_V3' }, observed_at: new Date().toISOString(), warnings: [] };
const plan: SuiPlan = { snapshot, sender: id('9'), borrow_asset: a, principal: '100', route: [{ pool: id('2'), token_in: a, token_out: b }, { pool: id('3'), token_in: b, token_out: a }], policy: { max_principal: '100', min_profit: '0', network_cost: '1', max_evaluations: 8 }, expected_profit: '10' };
describe('multichain native boundaries', () => {
  it('enforces registry-bound live evidence independently of discovery', async () => {
    const engine = new ResearchEngine({ endpoints: { robinhood: 'https://example.com' }, deployments: [] });
    expect(engine.capabilities().find((c) => c.network === 'robinhood')).toMatchObject({ discovery: true, research: false });
    expect(() => engine.requireResearch('robinhood')).toThrow('verification evidence');
    const evidence = { network: 'robinhood' as const, registry_hash: registryHash([]), engine_version: VERSION as typeof VERSION, build_fingerprint: implementationFingerprint(), verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), source: 'https://example.com/proof', checks: ['deterministic', 'local_e2e', 'live_quote', 'live_simulation'] as const };
    expect(researchVerified('robinhood', [{ ...evidence, checks: [...evidence.checks] }], registryHash([]))).toBe(true);
    expect(researchVerified('robinhood', [{ ...evidence, checks: [...evidence.checks] }], registryHash([{ changed: true }]))).toBe(false);
    expect(researchVerified('robinhood', [{ ...evidence, checks: ['deterministic'] }], registryHash([]))).toBe(false);
  });
  it('rejects unreviewed v4 hooks and mismatched PoolKeys before any RPC', async () => {
    const fetcher = vi.fn(); const reader = new EvmReader(new JsonClient('https://example.com', fetcher), 'robinhood', []);
    const key = { currency0: addr('1'), currency1: addr('2'), fee: 3000, tickSpacing: 60, hooks: addr('0') };
    const block = { number: '0x1', hash: id('1'), timestamp: '0x1', parentHash: id('0'), gasLimit: '0x100000', miner: addr('0') };
    await expect(reader.pool({ address: id('1'), adapter: 'UNISWAP_V4', manager: addr('3'), pool_key: { ...key, hooks: addr('4') }, word_range: 0 }, block)).rejects.toMatchObject({ code: 'UNSUPPORTED_HOOK' });
    await expect(reader.pool({ address: id('1'), adapter: 'UNISWAP_V4', manager: addr('3'), pool_key: key, word_range: 0 }, block)).rejects.toMatchObject({ code: 'POOL_ID_MISMATCH' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not advertise SDK support below Node 22.12', () => {
    expect(suiRuntimeSupported('20.19.0')).toBe(false); expect(suiRuntimeSupported('22.11.0')).toBe(false);
    expect(suiRuntimeSupported('22.12.0')).toBe(true); expect(suiRuntimeSupported('23.6.0')).toBe(true);
  });
  it('reads v4 slot, bitmap and fee at one block and preserves bytes32 IDs', async () => {
    const key = { currency0: addr('1'), currency1: addr('2'), fee: 3000, tickSpacing: 60, hooks: addr('0') };
    const poolId = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [key.currency0 as `0x${string}`, key.currency1 as `0x${string}`, 3000, 60, key.hooks as `0x${string}`]));
    const rpc = new JsonClient('https://example.com');
    const reader = new EvmReader(rpc, 'robinhood', [{ network: 'robinhood', adapter: 'UNISWAP_V4', address: addr('3'), state_view: addr('4'), state_view_code_hash: keccak256('0x6000'), code_hash: keccak256('0x6000'), version: 'test' }]);
    const read = vi.spyOn(rpc, 'rpc').mockResolvedValue('0x6000');
    vi.spyOn(reader, 'call').mockImplementation(async (_to, signature) => signature.startsWith('getSlot0') ? [1n << 96n, 0n, 0n, 3000n] : signature.startsWith('getLiquidity') ? [100000000n] : signature.startsWith('decimals') ? [18n] : [0n]);
    const block = { number: '0x1', hash: id('1'), timestamp: '0x1', parentHash: id('0'), gasLimit: '0x100000', miner: addr('0') };
    const result = await reader.pool({ address: poolId, adapter: 'UNISWAP_V4', manager: addr('3'), pool_key: key, word_range: 0 }, block);
    expect(result).toMatchObject({ address: poolId, kind: 'clmm', fee_pips: 3000, v4: { key } });
    expect(read.mock.calls.every(([, params]) => JSON.stringify(params).includes(block.hash))).toBe(true);
  });
  it('builds real SDK PTBs with borrow, both swaps, repayment and residual consumption', async () => {
    const sdk = await suiSdk(); const built = buildSuiTransaction(sdk.Transaction, plan);
    const serialized = JSON.stringify(built.transaction.getData());
    expect(serialized).toContain('borrow_flashloan_base'); expect(serialized).toContain('return_flashloan_base');
    expect(serialized).toContain('swap_exact_base_for_quote'); expect(serialized).toContain('swap_exact_quote_for_base');
    expect(built.profit_command).toBeGreaterThan(3);
    expect(serialized).not.toContain('signAndExecute');
  });
  it('builds Cetus Q64.64 swaps and principal-plus-fee funding without EVM math', async () => {
    const sdk = await suiSdk();
    const cetus = { ...deployment, protocol: 'CETUS_CLMM' as const, config_id: id('6'), config_digest: 'config-digest' };
    const changed = { ...plan, snapshot: { ...snapshot, pools: snapshot.pools.map((p) => ({ ...p, protocol: 'CETUS_CLMM' as const, deployment: cetus, funding_fee: { pips: 3000, source: 'NATIVE_CURRENT_VIEW' as const, observed_at: new Date().toISOString() } })), lender: { ...snapshot.lender, protocol: 'CETUS_CLMM' as const } } };
    const serialized = JSON.stringify(buildSuiTransaction(sdk.Transaction, changed).transaction.getData());
    expect(serialized).toContain('flash_loan'); expect(serialized).toContain('repay_flash_loan'); expect(serialized).toContain('flash_swap'); expect(serialized).toContain('repay_flash_swap');
  });
  it('finds connected cycles and excludes lender-pool locks', () => {
    const routes = suiClosedRoutes(snapshot, a); expect(routes).toHaveLength(2);
    expect(routes.flat().some((h) => h.pool === snapshot.lender.object_id)).toBe(false);
    expect(suiClosedRoutes({ ...snapshot, pools: snapshot.pools.slice(0, 2) }, a)).toEqual([]);
  });
  it('rejects disconnected and mismatched-asset plans before serializing', async () => {
    const sdk = await suiSdk();
    expect(() => buildSuiTransaction(sdk.Transaction, { ...plan, route: [{ pool: id('1'), token_in: a, token_out: b }] })).toThrow('Disconnected');
    expect(suiSnapshotSchema.safeParse({ ...snapshot, pools: [{ ...pool('1'), coin_a: id('2') }] }).success).toBe(false);
  });
  it('follows empty native pages with a next cursor and discloses remaining coverage', async () => {
    const fetcher = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({ data: { chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER, objects: { nodes: body.variables.after ? [{ address: id('1'), asMoveObject: { contents: { type: { repr: deployment.original_package + '::pool::Pool<' + a + ',' + b + '>' } } } }] : [], pageInfo: { hasNextPage: true, endCursor: body.variables.after ? 'cursor-2' : 'cursor-1' } } } }));
    });
    const reader = new SuiReader({ graphql: 'https://example.com', grpc: 'https://example.com', chain_identifier: SUI_MAINNET_CHAIN_IDENTIFIER, deployments: [deployment], fetcher });
    const inventory = await reader.inventory([a], {}, 50, 2);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(inventory.pools).toHaveLength(1);
    expect(inventory.coverage[0]).toMatchObject({ retrieval_complete: false, exhaustive: false, next_cursor: 'cursor-2' });
  });
  it('keeps funding-asset book leftovers in the PTB until repayment', async () => {
    const sdk = await suiSdk(); const data = buildSuiTransaction(sdk.Transaction, plan).transaction.getData();
    const kinds = data.commands.map((c) => c.$kind);
    expect(kinds).toContain('MergeCoins');
    const merge = kinds.indexOf('MergeCoins');
    expect(merge).toBeLessThan(kinds.lastIndexOf('SplitCoins'));
  });
  it('classifies current native state separately from the historical checkpoint', async () => {
    const sdk = await suiSdk();
    const fetcher = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const objects = body.variables.keys.map(({ address }: { address: string }) => {
        const p = snapshot.pools.find((p) => p.object_id === address);
        return { address, version: p?.version ?? '1', digest: p?.digest ?? deployment.package_digest, asMovePackage: p ? null : { __typename: 'MovePackage' } };
      });
      expect(body.variables.cp).toBe(100);
      return new Response(JSON.stringify({ data: { checkpoint: { sequenceNumber: '100', digest: snapshot.checkpoint.digest, query: { multiGetObjects: objects } } } }));
    });
    const simulateTransaction = vi.fn(async ({ transaction }: { transaction: import('@mysten/sui/transactions').Transaction; checksEnabled?: boolean }) => {
      const count = transaction.getData().commands.length;
      const commandResults = Array.from({ length: count }, () => ({ returnValues: [{ bcs: new Uint8Array(8) }], mutatedReferences: [] }));
      const profit = Buffer.alloc(8); profit.writeBigUInt64LE(10n); commandResults[count - 2].returnValues[0].bcs = profit;
      return { $kind: 'Transaction', gasPaymentMocked: true, commandResults, Transaction: { status: { success: true, error: null }, effects: { gasUsed: {}, changedObjects: snapshot.pools.map((p) => ({ objectId: p.object_id, inputVersion: '2', inputDigest: 'current-' + p.digest })), unchangedConsensusObjects: [] } } };
    });
    const native = { getChainIdentifier: async () => ({ chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER }), simulateTransaction } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
    const reader = new SuiReader({ graphql: 'https://example.com', grpc: 'https://example.com', chain_identifier: SUI_MAINNET_CHAIN_IDENTIFIER, deployments: [deployment], fetcher, nativeClient: async () => native });
    const result = await reader.simulate(plan);
    expect(result).toMatchObject({ status: 'NATIVE_DRY_RUN', expected_net_profit_funding_units: '9', gas_payment_mocked: true, historical_execution_verified: false, state_alignment: 'CURRENT_NATIVE_STATE' });
    expect(simulateTransaction.mock.calls[0][0].checksEnabled).toBe(true);
  });
  it('times out a stalled response body with an explicit retryable error', async () => {
    const rpc = new JsonClient('https://example.com', async () => new Response(new ReadableStream()), 10);
    await expect(rpc.request({ test: true })).rejects.toMatchObject({ code: 'DEPENDENCY_TIMEOUT', retryable: true });
  });

  it('rejects changed or unproven Sui configuration around native execution', async () => {
    const cetus = { ...deployment, protocol: 'CETUS_CLMM' as const, config_id: id('6'), config_digest: 'reviewed-config' };
    const updated = { ...plan, snapshot: { ...snapshot, pools: snapshot.pools.map((p) => ({ ...p, protocol: 'CETUS_CLMM' as const, deployment: cetus })), lender: { ...snapshot.lender, protocol: 'CETUS_CLMM' as const } } };
    for (const mode of ['post-change', 'native-change', 'unproven'] as const) {
      let currentReads = 0;
      const fetcher = vi.fn(async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        const current = body.variables.cp === null;
        if (current) currentReads++;
        const objects = body.variables.keys.map(({ address }: { address: string }) => {
          const p = updated.snapshot.pools.find((p) => p.object_id === address);
          return { address, version: '1', digest: p?.digest ?? (address === cetus.config_id ? mode === 'post-change' && currentReads > 1 ? 'changed-config' : cetus.config_digest : cetus.package_digest) };
        });
        return new Response(JSON.stringify({ data: { checkpoint: { sequenceNumber: '100', digest: snapshot.checkpoint.digest, query: { multiGetObjects: objects } } } }));
      });
      const native = { getChainIdentifier: async () => ({ chainIdentifier: SUI_MAINNET_CHAIN_IDENTIFIER }), simulateTransaction: async () => ({ $kind: 'Transaction', gasPaymentMocked: true, commandResults: [], Transaction: { status: { success: true, error: null }, effects: { gasUsed: {}, changedObjects: [], unchangedConsensusObjects: mode === 'native-change' ? [{ objectId: cetus.config_id, version: '2', digest: 'changed-config' }] : [] } } }) } as unknown as import('@mysten/sui/grpc').SuiGrpcClient;
      const reader = new SuiReader({ graphql: 'https://example.com', grpc: 'https://example.com', chain_identifier: SUI_MAINNET_CHAIN_IDENTIFIER, deployments: [cetus], fetcher, nativeClient: async () => native });
      if (mode === 'unproven') expect(await reader.simulate(updated)).toMatchObject({ status: 'INCONCLUSIVE', native_configuration_inputs: [{ verified: false }] });
      else await expect(reader.simulate(updated)).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH' });
    }
  });

});
