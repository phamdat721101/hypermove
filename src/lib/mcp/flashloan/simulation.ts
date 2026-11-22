import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encodeFunctionData, parseAbi, keccak256, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { ResearchError, hash, LENDER_PROVIDERS, type Input } from './contracts';
import { EvmReader, evmSnapshotSchema, type EvmSnapshot } from './evm';
import { quotePool, lenderRoutablePools, type Pool } from './math';

export const planSchema = z.object({ snapshot_id: z.string(), snapshot: evmSnapshotSchema, borrow_asset: z.string(), policy: z.object({ network_cost: z.string(), min_profit: z.string() }).passthrough(), solution: z.object({ principal: z.string(), allocations: z.array(z.object({ route: z.object({ id: z.string(), hops: z.array(z.object({ pool: z.string(), token_in: z.string(), token_out: z.string() })) }), amount: z.string() })), expected_profit: z.string() }).passthrough() }).passthrough();
export type Plan = z.infer<typeof planSchema>;
const executorAbi = parseAbi(['function executeMixed(address source,uint8 provider,address token,uint256 amount,(address pool,address tokenIn,address tokenOut,uint8 kind,uint256 amountIn,uint256 minOut)[] steps,(uint256 index,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)[] extra,uint256 minProfit) returns(uint256 profit)', 'function execute(address source,uint8 provider,address token,uint256 amount,(address pool,address tokenIn,address tokenOut,uint8 kind,uint256 amountIn,uint256 minOut)[] steps,uint256 minProfit) returns(uint256 profit)']);
export function compilePlan(plan: Plan, executor: string) {
  const state = new Map<string, Pool>(plan.snapshot.pools.map((p) => [p.address, p]));
  const steps: Array<{ pool: Address; tokenIn: Address; tokenOut: Address; kind: number; amountIn: bigint; minOut: bigint }> = [];
  const extra: Array<{ index: bigint; key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } }> = [];
  for (const allocation of plan.solution.allocations) {
    let amount = BigInt(allocation.amount);
    for (const hop of allocation.route.hops) {
      const pool = state.get(hop.pool); if (!pool) throw new ResearchError('INVALID_ROUTE', 'Plan references missing pool.');
      if (!lenderRoutablePools([pool], plan.snapshot.lender).length) throw new ResearchError('LENDER_POOL_LOCK', 'Flash lender pool cannot also be swapped during its callback.');
      const quote = quotePool(pool, hop.token_in, amount);
      if (pool.kind === 'clmm' && pool.v4) extra.push({ index: BigInt(steps.length), key: pool.v4.key as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address } });
      steps.push({ pool: (pool.kind === 'wrap' ? pool.wrapped_native : pool.kind === 'clmm' && pool.v4 ? pool.v4.manager : pool.address) as Address, tokenIn: hop.token_in as Address, tokenOut: hop.token_out as Address, kind: pool.kind === 'wrap' ? pool.direction === 'unwrap' ? 3 : 4 : pool.kind === 'v2' ? 0 : pool.v4 ? 2 : 1, amountIn: amount, minOut: quote.amount_out });
      state.set(pool.address, quote.pool); amount = quote.amount_out;
    }
  }
  const provider = (LENDER_PROVIDERS as readonly string[]).indexOf(plan.snapshot.lender.provider);
  if (provider < 0) throw new ResearchError('UNSUPPORTED_LENDER', 'Plan lender is unsupported.');
  const args = [plan.snapshot.lender.address as Address, provider, plan.borrow_asset as Address, BigInt(plan.solution.principal), steps] as const;
  const minProfit = BigInt(plan.policy.min_profit) + BigInt(plan.policy.network_cost);
  const data = extra.length ? encodeFunctionData({ abi: executorAbi, functionName: 'executeMixed', args: [...args, extra, minProfit] }) : encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [...args, minProfit] });
  return { to: executor, data, calldata_hash: keccak256(data), plan_hash: hash(plan) };
}
const engineOutput = z.object({ version: z.literal(1), success: z.boolean(), gas_used: z.string().regex(/^\d+$/), output: z.string(), logs: z.array(z.object({ address: z.string(), topics: z.array(z.string()), data: z.string() })), engine: z.string(), chain_native: z.literal(false) });
export type EngineOutput = z.infer<typeof engineOutput>;
export type EngineAdapter = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<EngineOutput>;
export const runNativeEngine: EngineAdapter = (request, signal) => new Promise((resolveResult, reject) => {
  const binary = process.env.FLASHLOAN_ENGINE ?? resolve('services/flashloan/target/release/flashloan-engine');
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV } });
  let output = '', diagnostics = ''; let settled = false;
  const end = (error?: Error, value?: EngineOutput) => {
    if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); child.kill('SIGKILL');
    const settle = () => { if (error) reject(error); else resolveResult(value!); };
    if (child.exitCode !== null || child.signalCode !== null) settle();
    else child.once('close', settle);
  };
  const abort = () => end(new ResearchError('CANCELLED', 'EVM simulation cancelled.'));
  const timer = setTimeout(() => end(new ResearchError('SIMULATION_TIMEOUT', 'Rust simulation exceeded its deadline.', true)), 45000);
  if (signal?.aborted) { abort(); return; } signal?.addEventListener('abort', abort, { once: true });
  child.on('error', () => end(new ResearchError('ENGINE_UNAVAILABLE', 'Build the configured Rust simulation engine.')));
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 8_000_000) end(new ResearchError('ENGINE_OUTPUT_BUDGET', 'Rust output exceeded its byte budget.')); });
  child.stderr.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4000); });
  child.on('close', (code) => {
    if (code !== 0) { end(new ResearchError('ENGINE_FAILED', 'Rust engine exited without a verified report.')); return; }
    try { const parsed = JSON.parse(output); if (!parsed.ok) throw new ResearchError('SIMULATION_INCONCLUSIVE', `Fork execution failed: ${String(parsed.error).slice(0, 100)}`); end(undefined, engineOutput.parse(parsed.data)); }
    catch (e) { end(e instanceof ResearchError ? e : new ResearchError('ENGINE_PROTOCOL', 'Invalid Rust engine response.')); }
    void diagnostics;
  });
  child.stdin.on('error', () => end(new ResearchError('ENGINE_PROTOCOL', 'Engine input channel failed.')));
  child.stdin.end(JSON.stringify(request) + '\n');
});
export async function simulatePlan(reader: EvmReader, rawPlan: unknown, input: Input<'flashloan_simulate_atomic_revm'>, engine: EngineAdapter = runNativeEngine, signal?: AbortSignal) {
  const plan = planSchema.parse(rawPlan); const snapshot: EvmSnapshot = plan.snapshot;
  const current = await reader.rpc.rpc<{ hash: string } | null>('eth_getBlockByNumber', [snapshot.block.number, false], signal);
  if (!current || current.hash !== snapshot.block.hash) throw new ResearchError('REORG', 'Plan block is no longer canonical.');
  const compiled = compilePlan(plan, input.executor);
  const assumptions: string[] = ['Execution uses a Cancun-configured generic EVM; chain-specific hardfork and precompile parity must be checked against the reference node.', 'Network cost in the funding asset is an explicit sizing-policy assumption, not a live USD valuation.'];
  let executorCode: Hex; let executorStorage: Record<string, string> = {};
  try {
    const artifact = JSON.parse(await readFile(process.env.FLASHLOAN_EXECUTOR_ARTIFACT ?? resolve('services/flashloan/out/ResearchExecutor.sol/ResearchExecutor.json'), 'utf8'));
    executorCode = artifact.deployedBytecode.object;
    if (!/^0x[0-9a-fA-F]+$/.test(executorCode)) throw Error('invalid bytecode');
  } catch { throw new ResearchError('EXECUTOR_UNAVAILABLE', 'Build the reviewed ResearchExecutor contract artifact.'); }
  if (input.executor_mode === 'existing') {
    const actual = await reader.rpc.rpc<Hex>('eth_getCode', [input.executor, { blockHash: snapshot.block.hash, requireCanonical: true }], signal);
    if (keccak256(actual) !== keccak256(executorCode)) throw new ResearchError('EXECUTOR_MISMATCH', 'Existing executor does not match the reviewed runtime.');
  } else {
    const existing = await reader.rpc.rpc<Hex>('eth_getCode', [input.executor, { blockHash: snapshot.block.hash, requireCanonical: true }], signal);
    if (existing !== '0x') throw new ResearchError('EXECUTOR_ADDRESS_OCCUPIED', 'Fixture overrides require an address without deployed code.');
    executorStorage = { ['0x' + '0'.repeat(64)]: '0x' + input.caller.slice(2).padStart(64, '0') };
    assumptions.push('Executor runtime and owner storage are injected at an empty address in the local fork only.');
  }
  const request = { version: 1, rpc_url: reader.rpc.url, block_hash: snapshot.block.hash, block_number: snapshot.block.number, timestamp: snapshot.block.timestamp, base_fee: snapshot.block.baseFeePerGas ?? '0x0', gas_limit: snapshot.block.gasLimit, coinbase: snapshot.block.miner, chain_id: snapshot.chain_id, caller: input.caller, executor: input.executor, calldata: compiled.data, ...(input.executor_mode === 'fixture' ? { executor_code: executorCode, executor_storage: executorStorage } : {}) };
  const local = await engine(request, signal);
  let reference: { matched: boolean; output?: string; error?: string };
  try {
    const params: unknown[] = [{ from: input.caller, to: input.executor, data: compiled.data, gas: '0x1c9c380', gasPrice: snapshot.block.baseFeePerGas ?? '0x0' }, { blockHash: snapshot.block.hash, requireCanonical: true }];
    if (input.executor_mode === 'fixture') params.push({ [input.executor]: { code: executorCode, stateDiff: executorStorage } });
    const output = await reader.rpc.rpc<string>('eth_call', params, signal);
    reference = { matched: local.success && output.toLowerCase() === local.output.toLowerCase(), output };
  } catch { reference = { matched: false, error: 'Reference eth_call unavailable or reverted; chain parity is not established.' }; }
  const profit = local.success && /^0x[a-fA-F0-9]{64}$/.test(local.output) ? BigInt(local.output).toString() : null;
  let network_fee: { status: string; gas_limit?: string; gas_price_wei?: string; estimated_fee_wei?: string; observed_at?: string; note: string };
  try {
    const request: Record<string, unknown> = { from: input.caller, to: input.executor, data: compiled.data };
    const params: unknown[] = [request, snapshot.block.number];
    if (input.executor_mode === 'fixture') params.push({ [input.executor]: { code: executorCode, stateDiff: executorStorage } });
    const [gas, price] = await Promise.all([reader.rpc.rpc<string>('eth_estimateGas', params, signal), reader.rpc.rpc<string>('eth_gasPrice', [], signal)]);
    if (!/^0x[0-9a-fA-F]+$/.test(gas) || !/^0x[0-9a-fA-F]+$/.test(price)) throw Error('Invalid fee estimate.');
    network_fee = { status: 'RPC_ESTIMATE', gas_limit: BigInt(gas).toString(), gas_price_wei: BigInt(price).toString(), estimated_fee_wei: (BigInt(gas) * BigInt(price)).toString(), observed_at: new Date().toISOString(), note: 'Native wei estimate; Robinhood RPC includes L1 data costs. Funding-asset conversion remains the explicit policy.network_cost assumption.' };
  } catch { network_fee = { status: 'UNAVAILABLE', note: 'RPC fee estimation failed; no fee was fabricated. policy.network_cost remains an explicit assumption.' }; }
  return { status: !local.success ? 'REJECTED' : reference.matched ? 'REFERENCE_DRY_RUN' : 'INCONCLUSIVE', verification_level: reference.matched ? 'RETURN_DATA_PARITY' : 'LOCAL_EVM_ONLY', network_fee, snapshot_hash: hash(snapshot), snapshot_block: snapshot.block, ...compiled, executor_code_hash: keccak256(executorCode), engine: local.engine, gas_used: local.gas_used, gross_profit_funding_units: profit, expected_net_profit_funding_units: profit === null ? null : (BigInt(profit) - BigInt(plan.policy.network_cost)).toString(), repayment: local.success ? 'CALLBACK_COMPLETED' : 'UNPROVEN', transfer_restrictions: local.success ? 'EXACT_ROUTE_PASSED' : 'CONTEXTUAL_REVERT', logs: local.logs, reference, assumptions, chain_native_verified: false, can_execute: false };
}
