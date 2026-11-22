// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { JsonClient } from '../src/lib/mcp/flashloan/transport';
import { XrplReader } from '../src/lib/mcp/flashloan/xrpl';
import { EvmReader, type Deployment } from '../src/lib/mcp/flashloan/evm';
import { keccak256, type Hex } from 'viem';
import { operationSchemas, riskPolicy } from '../src/lib/mcp/flashloan/contracts';
import { quotePool, solve } from '../src/lib/mcp/flashloan/math';
import { DexScreener } from '../src/lib/mcp/flashloan/discovery';

const live = process.env.FLASHLOAN_LIVE === '1';
describe.skipIf(!live)('live read-only research capabilities (not full adapter parity)', () => {
  for (const [network, fallback] of [['ethereum', 'https://ethereum-rpc.publicnode.com'], ['arbitrum', 'https://arbitrum-one-rpc.publicnode.com'], ['base', 'https://base-rpc.publicnode.com']] as const) {
    it(`${network}: validates chain identity, pinned code reads and unsigned dry-run`, async () => {
      const rpc = new JsonClient(process.env[`FLASHLOAN_${network.toUpperCase()}_RPC_URL`] ?? fallback, fetch, 10000);
      const header = await new EvmReader(rpc, network, []).header();
      const empty = '0x0000000000000000000000000000000000000001';
      const code = await rpc.rpc<string>('eth_getCode', [empty, { blockHash: header.hash, requireCanonical: true }]); expect(code).toMatch(/^0x/);
      const output = await rpc.rpc<string>('eth_call', [{ from: '0x0000000000000000000000000000000000000000', to: '0x0000000000000000000000000000000000000042', data: '0x' }, { blockHash: header.hash, requireCanonical: true }, { '0x0000000000000000000000000000000000000042': { code: '0x602a60005260206000f3' } }]);
      expect(BigInt(output)).toBe(42n);
      console.log(JSON.stringify({ event: 'flashloan.live_capability', network, block_hash: header.hash, pinned_reads: true, unsigned_override_dry_run: true, full_pool_lender_e2e: false }));
    }, 45000);
    it(`${network}: real discovery, Multicall tick hydration, runtime lender fees and sizing`, async () => {
      // Addresses verified against Uniswap sdk-core/addresses.ts and bgd-labs/aave-address-book.
      // Runtime hashes below are observations for this test, never auto-approved production registry entries.
      const fixtures = {
        ethereum: { factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', lender: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' },
        arbitrum: { factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', lender: '0x794a61358d6845594f94dc1db02a252b5b4814ad' },
        base: { factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd', weth: '0x4200000000000000000000000000000000000006', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', lender: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5' },
      }[network];
      const rpc = new JsonClient(process.env[`FLASHLOAN_${network.toUpperCase()}_RPC_URL`] ?? fallback, fetch, 15000);
      const reader = new EvmReader(rpc, network, []); const header = await reader.header();
      const pools: string[] = [];
      for (const tier of [500n, 3000n]) { const result = await reader.call(fixtures.factory, 'getPool(address,address,uint24)', [fixtures.weth, fixtures.usdc, tier], header); pools.push('0x' + result[0].toString(16).padStart(40, '0')); }
      const deployments: Deployment[] = [];
      for (const target of [...pools, fixtures.lender]) {
        const code = await rpc.rpc<Hex>('eth_getCode', [target, { blockHash: header.hash, requireCanonical: true }]); expect(code).not.toBe('0x');
        deployments.push({ network, address: target, adapter: target === fixtures.lender ? 'AAVE_V3' : 'UNISWAP_V3', code_hash: keccak256(code), version: 'live-observed-fixture' });
      }
      const snapshot = await new EvmReader(rpc, network, deployments).snapshot({ idempotency_key: 'live', network, pools: pools.map((address) => ({ address, adapter: 'UNISWAP_V3', word_range: 0 })), lender: { provider: 'AAVE_V3', address: fixtures.lender, asset: fixtures.weth } });
      expect(snapshot.pools).toHaveLength(2); expect(BigInt(snapshot.lender.capacity)).toBeGreaterThan(0n);
      for (const pool of snapshot.pools) expect(quotePool(pool, fixtures.weth, 1000n).amount_out).toBeGreaterThanOrEqual(0n);
      const result = solve(snapshot.pools, fixtures.weth, snapshot.lender, riskPolicy.parse({ max_principal: '1000000000000000', network_cost: '0', max_evaluations: 64 }));
      expect(result.evaluations).toBeGreaterThan(0);
      const discovery = await new DexScreener().discover({ idempotency_key: 'live-discovery', network, tokens: [fixtures.weth], min_liquidity_usd: 15000, exclude_tokens: [] }); expect(discovery.token_results).toHaveLength(1);
      console.log(JSON.stringify({ event: 'flashloan.live_market_pipeline', network, block_hash: snapshot.block.hash, pools, initialized_ticks: snapshot.pools.map((p) => p.kind === 'clmm' ? p.ticks.length : 0), lender_fee_numerator: snapshot.lender.fee_numerator, outcome: result.status, discovery_candidates: discovery.pools.length, discovery_warnings: discovery.warnings, discovery_coverage: discovery.coverage, live_trade: false }));
    }, 90000);
  }
  it('xrpl: validated ledger and native unsigned simulation capability', async () => {
    const reader = new XrplReader(new JsonClient(process.env.FLASHLOAN_XRPL_RPC_URL ?? 'https://xrplcluster.com', fetch, 10000));
    const ledger = await reader.call('ledger', { ledger_index: 'validated' }); expect(ledger.ledger_hash ?? ledger.ledger?.ledger_hash).toBeTruthy();
    const result = await reader.call('simulate', { tx_json: { TransactionType: 'Payment', Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Destination: 'rrrrrrrrrrrrrrrrrrrrBZbvji', Amount: '1' } });
    expect(result.engine_result).toEqual(expect.any(String));
    console.log(JSON.stringify({ event: 'flashloan.live_capability', network: 'xrpl', ledger_hash: ledger.ledger_hash, simulation_ledger_index: result.ledger_index, engine_result: result.engine_result, snapshot_pinned_simulation: false, full_route_e2e: false }));
  }, 45000);
  it('xrpl: reads ledger-pinned native AMM/books and evaluates hypothetical cycles', async () => {
    const reader = new XrplReader(new JsonClient(process.env.FLASHLOAN_XRPL_RPC_URL ?? 'https://xrplcluster.com', fetch, 10000));
    const input = operationSchemas.xrpl_discover_arbitrage_routes.parse({ idempotency_key: 'live-native', network: 'xrpl', assets: [{ kind: 'xrp' }, { kind: 'issued', currency: 'USD', issuer: 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv' }], funding: { mode: 'hypothetical', balances: [{ asset: { kind: 'xrp' }, amount: '100' }] } });
    const snapshot = await reader.discover(input); const report = await reader.simulate(snapshot);
    expect(snapshot.ledger_hash).toBeTruthy(); expect(snapshot.edges.length).toBeGreaterThanOrEqual(2); expect(report.status).toBe('ESTIMATE_ONLY');
    console.log(JSON.stringify({ event: 'flashloan.live_native_market', ledger_hash: snapshot.ledger_hash, edges: snapshot.edges.length, estimate_only: true, warnings: snapshot.warnings }));
  }, 45000);
});
