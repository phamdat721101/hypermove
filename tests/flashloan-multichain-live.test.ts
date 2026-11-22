// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { EvmReader, type Deployment } from '../src/lib/mcp/flashloan/evm';
import { quotePool } from '../src/lib/mcp/flashloan/math';
import { DexScreener } from '../src/lib/mcp/flashloan/discovery';
import { operationSchemas } from '../src/lib/mcp/flashloan/contracts';
import { suiSdk, SuiReader, buildSuiTransaction } from '../src/lib/mcp/flashloan/sui';
import { SUI_MAINNET_CHAIN_IDENTIFIER, coinType } from '../src/lib/mcp/flashloan/networks';
import type { SuiDeployment, SuiPlan } from '../src/lib/mcp/flashloan/sui-contracts';
import { JsonClient } from '../src/lib/mcp/flashloan/transport';
const live = process.env.FLASHLOAN_MULTICHAIN_LIVE === '1';
describe.skipIf(!live)('read-only multichain verification (never approves deployment registries)', () => {
  it('AIXBT inventory includes multiple liquid pools and 32-byte IDs', async () => {
    const result = await new DexScreener().discover(operationSchemas.flashloan_discover_arbitrage_pools.parse({ idempotency_key: 'live-inventory', network: 'base', tokens: ['0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825'] }));
    expect(result.token_results[0].discovered_count).toBeGreaterThan(1);
    expect(result.token_results[0].liquidity_eligible_count).toBeGreaterThan(1);
    expect(result.coverage[0].exhaustive).toBe(false);
    console.log(JSON.stringify({ event: 'flashloan.live_inventory_v2', count: result.pools.length, liquid: result.token_results[0].liquidity_eligible_count, observation: result.observed_at, live_trade: false }));
  }, 45000);
  it('Robinhood v3 verifies factory membership and exact native quote parity', async () => {
    const rpc = new JsonClient(process.env.FLASHLOAN_ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
    const reader = new EvmReader(rpc, 'robinhood', []), block = await reader.header();
    const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', usdg = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', factory = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', quoter = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
    const factoryCode = await rpc.rpc<Hex>('eth_getCode', [factory, { blockHash: block.hash, requireCanonical: true }]);
    let found = false;
    for (const fee of [500, 3000, 10000, 100]) {
      const result = await reader.call(factory, 'getPool(address,address,uint24)', [weth, usdg, BigInt(fee)], block);
      const address = '0x' + result[0].toString(16).padStart(40, '0');
      if (result[0] === 0n) continue;
      const code = await rpc.rpc<Hex>('eth_getCode', [address, { blockHash: block.hash, requireCanonical: true }]);
      const deployment: Deployment = { network: 'robinhood', address, adapter: 'UNISWAP_V3', code_hash: keccak256(code), factory, factory_code_hash: keccak256(factoryCode), version: 'live-observed-not-approved' };
      const pool = await new EvmReader(rpc, 'robinhood', [deployment]).pool({ address, adapter: 'UNISWAP_V3', word_range: 0 }, block);
      if (pool.kind !== 'clmm' || BigInt(pool.liquidity) === 0n) continue;
      const amountIn = 1000000000000n;
      const local = quotePool(pool, weth, amountIn);
      const abi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
      const data = encodeFunctionData({ abi, functionName: 'quoteExactInputSingle', args: [{ tokenIn: weth, tokenOut: usdg, amountIn, fee, sqrtPriceLimitX96: 0n }] });
      const native = await rpc.rpc<Hex>('eth_call', [{ to: quoter, data }, { blockHash: block.hash, requireCanonical: true }]);
      expect(local.amount_out).toBeGreaterThan(0n); expect(local.amount_out).toBe(BigInt('0x' + native.slice(2, 66)));
      console.log(JSON.stringify({ event: 'flashloan.live_robinhood_v3_quote', pool: address, block_hash: block.hash, factory_attested: true, amount_out: local.amount_out.toString(), parity: true, registry_approved: false, broadcast: false }));
      found = true; break;
    }
    expect(found).toBe(true);
  }, 120000);
  it('Robinhood v4 quotes match native Quoter at a pinned mainnet block', async () => {
    const rpc = new JsonClient(process.env.FLASHLOAN_ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
    const reader = new EvmReader(rpc, 'robinhood', []), block = await reader.header();
    const manager = '0x8366a39cc670b4001a1121b8f6a443a643e40951', view = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', quoter = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
    const code = async (address: string) => keccak256(await rpc.rpc<Hex>('eth_getCode', [address, { blockHash: block.hash, requireCanonical: true }]));
    const deployment: Deployment = { network: 'robinhood', address: manager, adapter: 'UNISWAP_V4', code_hash: await code(manager), state_view: view, state_view_code_hash: await code(view), version: 'live-observed-not-approved' };
    const reviewed = new EvmReader(rpc, 'robinhood', [deployment]);
    let found = false;
    for (const currency0 of ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x' + '0'.repeat(40)]) {
      for (const [fee, tickSpacing] of [[100, 1], [500, 10], [3000, 60], [10000, 200]]) {
        const key = { currency0, currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee, tickSpacing, hooks: '0x' + '0'.repeat(40) };
        const poolId = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [key.currency0 as Address, key.currency1 as Address, fee, tickSpacing, key.hooks as Address]));
        const slot = await reader.call(view, 'getSlot0(bytes32)', [poolId], block);
        if (!slot[0]) continue;
        const pool = await reviewed.pool({ address: poolId, adapter: 'UNISWAP_V4', manager, pool_key: key, word_range: 0 }, block);
        if (pool.kind !== 'clmm' || BigInt(pool.liquidity) === 0n) continue;
        const amount = 1000000000000n;
        const local = quotePool(pool, currency0, amount);
        const abi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)']);
        const data = encodeFunctionData({ abi, functionName: 'quoteExactInputSingle', args: [{ poolKey: { ...key, currency0: key.currency0 as Address, currency1: key.currency1 as Address, hooks: key.hooks as Address }, zeroForOne: true, exactAmount: amount, hookData: '0x' }] });
        const native = await rpc.rpc<Hex>('eth_call', [{ to: quoter, data }, { blockHash: block.hash, requireCanonical: true }]);
        expect(local.amount_out).toBeGreaterThan(0n);
        expect(local.amount_out).toBe(BigInt('0x' + native.slice(2, 66)));
        console.log(JSON.stringify({ event: 'flashloan.live_robinhood_v4_quote', pool_id: poolId, block_hash: block.hash, amount_out: local.amount_out.toString(), parity: true, registry_approved: false, broadcast: false }));
        found = true; break;
      }
      if (found) break;
    }
    expect(found, 'No initialized no-hook fixture found; configure a current verified market fixture.').toBe(true);
  }, 120000);
  it('Cetus and DeepBook compose into a real unsigned native route', async () => {
    const graphql = process.env.FLASHLOAN_SUI_GRAPHQL_URL ?? 'https://graphql.mainnet.sui.io/graphql';
    const grpc = process.env.FLASHLOAN_SUI_GRPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
    const rpc = new JsonClient(graphql);
    const published = ['0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084', '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497'];
    const config = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
    const data = await rpc.request({ query: 'query Digests($keys:[ObjectKey!]!){multiGetObjects(keys:$keys){address digest}}', variables: { keys: [...published, config].map((address) => ({ address })) } }) as { data: { multiGetObjects: Array<{ address: string; digest: string }> } };
    const digest = (address: string) => data.data.multiGetObjects.find((p) => p.address === address)!.digest;
    const deployments: SuiDeployment[] = [{ protocol: 'CETUS_CLMM', original_package: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb', published_at: published[0], package_digest: digest(published[0]), version: 'live-observed-not-approved', config_id: config, config_digest: digest(config) }, { protocol: 'DEEPBOOK_V3', original_package: '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809', published_at: published[1], package_digest: digest(published[1]), version: 'live-observed-not-approved' }];
    const reader = new SuiReader({ graphql, grpc, chain_identifier: SUI_MAINNET_CHAIN_IDENTIFIER, deployments });
    const first = '0x03d7739b33fe221a830ff101042fa81fd19188feca04a335f7dea4e37c0fca81', second = '0x155a70b448404eb00d2b7f2b1d6dd0bac99874d9ea44e09b4d591eb25f82c9a8', lender = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
    const snapshot = await reader.snapshot({ idempotency_key: 'live-cetus', network: 'sui', pools: [{ object_id: first, protocol: 'CETUS_CLMM' }, { object_id: second, protocol: 'CETUS_CLMM' }], lender: { object_id: lender, protocol: 'DEEPBOOK_V3' } });
    const sui = coinType.parse('0x2::sui::SUI'), usdc = snapshot.pools.find((p) => p.object_id === first)!.coin_a;
    const result = await reader.simulate({ snapshot, sender: '0x' + '0'.repeat(63) + '1', borrow_asset: sui, principal: '1000000000', route: [{ pool: first, token_in: sui, token_out: usdc }, { pool: second, token_in: usdc, token_out: sui }], policy: { max_principal: '1000000000', min_profit: '0', network_cost: '0', max_evaluations: 1 }, expected_profit: '0' });
    if (result.status === 'REJECTED') expect(result.failure).toMatch(/InsufficientCoinBalance|balance|insufficient/i);
    expect(result.checks_enabled).toBe(true);
    expect(result.can_execute).toBe(false);
    console.log(JSON.stringify({ event: 'flashloan.live_sui_route', status: result.status, failure: result.failure, alignment: result.state_alignment, gas_mocked: result.gas_payment_mocked, repayment: result.repayment, registry_approved: false, broadcast: false }));
  }, 120000);
  it('Sui native DeepBook borrow/repay consumes the receipt without signing or broadcasting', async () => {
    const graphql = process.env.FLASHLOAN_SUI_GRAPHQL_URL ?? 'https://graphql.mainnet.sui.io/graphql';
    const grpc = process.env.FLASHLOAN_SUI_GRPC_URL ?? 'https://fullnode.mainnet.sui.io:443';
    const sdk = await suiSdk(); const client = new sdk.SuiGrpcClient({ network: 'mainnet', baseUrl: grpc });
    expect((await client.getChainIdentifier()).chainIdentifier).toBe(SUI_MAINNET_CHAIN_IDENTIFIER);
    const rpc = new JsonClient(graphql);
    const original = '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809';
    const published = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
    const poolId = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';
    const raw = await rpc.request({ query: 'query Package($id:SuiAddress!){object(address:$id){digest}}', variables: { id: published } }) as { data: { object: { digest: string } } };
    const deployment: SuiDeployment = { protocol: 'DEEPBOOK_V3', original_package: original, published_at: published, package_digest: raw.data.object.digest, version: 'live-observed-not-approved' };
    const reader = new SuiReader({ graphql, grpc, chain_identifier: SUI_MAINNET_CHAIN_IDENTIFIER, deployments: [deployment] });
    const snapshot = await reader.snapshot({ idempotency_key: 'live-sui', network: 'sui', pools: [{ object_id: poolId, protocol: 'DEEPBOOK_V3' }], lender: { object_id: poolId, protocol: 'DEEPBOOK_V3' } });
    // This is a funding-only capability probe, not proof of an arbitrage opportunity.
    const plan: SuiPlan = { snapshot, sender: '0x' + '0'.repeat(63) + '1', borrow_asset: coinType.parse('0x2::sui::SUI'), principal: '1000', route: [], policy: { max_principal: '1000', min_profit: '0', network_cost: '0', max_evaluations: 1 }, expected_profit: '0' };
    const built = buildSuiTransaction(sdk.Transaction, plan);
    const result = await client.simulateTransaction({ transaction: built.transaction, checksEnabled: true, doGasSelection: false, include: { effects: true, commandResults: true } });
    expect(result.$kind).toBe('Transaction');
    expect(result.Transaction?.status.success).toBe(true);
    console.log(JSON.stringify({ event: 'flashloan.live_sui_funding', checkpoint: snapshot.checkpoint, native_checks: true, gas_mocked: result.gasPaymentMocked, receipt_consumed: true, full_arbitrage_e2e: false, registry_approved: false, broadcast: false }));
  }, 120000);
});
