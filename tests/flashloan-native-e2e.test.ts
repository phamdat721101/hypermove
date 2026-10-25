// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { MemoryRepository } from '../src/lib/mcp/flashloan/storage';
import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import { JsonClient, delay } from '../src/lib/mcp/flashloan/transport';
import type { Operation } from '../src/lib/mcp/flashloan/contracts';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), P = '0x' + '3'.repeat(40), Q = '0x' + '4'.repeat(40), L = '0x' + '9'.repeat(40), E = '0x' + 'e'.repeat(40), C = '0x' + 'a'.repeat(40);
const slot = (value: bigint) => '0x' + value.toString(16).padStart(64, '0');
describe.skipIf(process.env.FLASHLOAN_NATIVE !== '1')('real local Anvil + Rust fork + executor pipeline', () => {
  it('snapshots, sizes, proves repayment, and rejects tax/cooldown traps without broadcasting', async () => {
    const reservation = createServer(); await new Promise<void>((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
    const port = (reservation.address() as { port: number }).port; await new Promise<void>((done) => reservation.close(() => done()));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--hardfork', 'cancun', '--base-fee', '0', '--silent'], { stdio: 'ignore' });
    let startupError: Error | undefined; child.on('error', (e) => { startupError = e; });
    const rpc = new JsonClient(`http://127.0.0.1:${port}`, fetch, 2000); const root = await mkdtemp(join(tmpdir(), 'flashloan-native-'));
    const artifact = async (name: string) => JSON.parse(await readFile(resolve(`services/flashloan/out/ResearchExecutor.t.sol/${name}.json`), 'utf8')).deployedBytecode.object as Hex;
    let worker: ResearchWorker | undefined;
    try {
      let ready = false; for (let i = 0; i < 30; i++) { if (startupError) throw startupError; try { await rpc.rpc('eth_chainId', []); ready = true; break; } catch { await delay(50); } } expect(ready).toBe(true);
      const [token, pair, lender, multicall] = await Promise.all([artifact('ResearchToken'), artifact('ResearchPair'), artifact('ResearchLender'), artifact('ResearchMulticall')]);
      for (const [address, code] of [[A, token], [B, token], [P, pair], [Q, pair], [L, lender]]) await rpc.rpc('anvil_setCode', [address, code]);
      await rpc.rpc('anvil_setCode', ['0xca11bde05977b3631167028862be2a173976ca11', multicall]);
      const balance = async (tokenAddress: string, account: string, value: bigint) => rpc.rpc('anvil_setStorageAt', [tokenAddress, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account as Hex, 0n])), slot(value)]);
      await balance(A, L, 1000000n);
      for (const [pool, r1] of [[P, 2000000n], [Q, 1000000n]] as const) { await balance(A, pool, 1000000n); await balance(B, pool, r1); await rpc.rpc('anvil_setStorageAt', [pool, slot(0n), slot(1000000n + (r1 << 112n))]); }
      await rpc.rpc('anvil_setBalance', [C, '0xde0b6b3a7640000']); await rpc.rpc('evm_mine', []);
      const repo = new MemoryRepository();
      worker = new ResearchWorker({ repo, root, endpoints: { ethereum: rpc.url }, deployments: [P, Q].map((address) => ({ network: 'ethereum' as const, address, adapter: 'UNISWAP_V2' as const, code_hash: keccak256(pair), version: 'local-uniswap-v2', fee_pips: 3000 })).concat([{ network: 'ethereum', address: L, adapter: 'AAVE_V3' as never, code_hash: keccak256(lender), version: 'local-aave', fee_pips: 0 }]) });
      vi.stubEnv('FLASHLOAN_ENGINE', process.env.FLASHLOAN_ENGINE ?? resolve('services/flashloan/target/debug/flashloan-engine'));
      const run = async (operation: Operation, input: Record<string, unknown>) => { const job = await worker!.dispatch('native-e2e', operation, input) as { id: string }; await worker!.tick(); const done = await repo.get('native-e2e', job.id); expect(done.error).toBeUndefined(); expect(done.state).toBe('SUCCEEDED'); return repo.artifact('native-e2e', done.result_id!); };
      const pipeline = async (key: string) => {
        const snapshot = await run('flashloan_ingest_l2_tickmap_and_reserves', { idempotency_key: key + '-snapshot', network: 'ethereum', pools: [P, Q].map((address) => ({ address, adapter: 'UNISWAP_V2' })), lender: { provider: 'AAVE_V3', address: L, asset: A } });
        const plan = await run('flashloan_solve_dynamic_route_split', { idempotency_key: key + '-plan', snapshot_id: snapshot.id, borrow_asset: A, policy: { max_principal: '1000', network_cost: '0' } }); expect(plan.kind).toBe('plan');
        return run('flashloan_simulate_atomic_revm', { idempotency_key: key + '-simulation', plan_id: plan.id, caller: C, executor_mode: 'fixture', executor: E });
      };
      const clean = await pipeline('clean'); expect((clean.data as { repayment: string }).repayment).toBe('CALLBACK_COMPLETED'); expect((clean.data as { status: string }).status).toBe('REFERENCE_DRY_RUN');
      for (const mode of [1n, 2n]) { await rpc.rpc('anvil_setStorageAt', [B, slot(2n), slot(mode)]); await rpc.rpc('evm_mine', []); const report = await pipeline('trap-' + mode); expect((report.data as { status: string }).status).toBe('REJECTED'); }
      // No RPC submit/send method is used anywhere in this test; all modifications target local Anvil fixtures.
      console.log(JSON.stringify({ event: 'flashloan.native_e2e', repayment: true, tax_rejected: true, same_block_lock_rejected: true, broadcast: false }));
    } finally { worker?.stop(); child.kill('SIGTERM'); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }, 90000);
});
