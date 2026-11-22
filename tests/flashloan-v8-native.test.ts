// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { keccak256, type Hex } from 'viem';
import { DiscoveryRegistry } from '../src/lib/mcp/flashloan/discovery-registry';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';
import { JsonClient, delay } from '../src/lib/mcp/flashloan/transport';
import { watchlistV1Schema } from '../src/lib/mcp/flashloan/v8-contracts';
import { fixtureV8, A8, Q8, P8, P82, F8, F82 } from './fixtures/flashloan-v8';

describe.skipIf(process.env.FLASHLOAN_V8_NATIVE !== '1')('v8 native Anvil/fork read proof', () => {
  it('builds a verified watchlist from actual EVM factory and state calls without signing or sending', async () => {
    if (process.env.FLASHLOAN_V8_REQUIRE_FORK === '1' && (!process.env.FLASHLOAN_V8_FORK_RPC_URL || !process.env.FLASHLOAN_V8_FORK_BLOCK)) throw new Error('Fork proof requires FLASHLOAN_V8_FORK_RPC_URL and FLASHLOAN_V8_FORK_BLOCK; a skipped/unpinned fork is not delivery evidence.');
    const reservation = createServer(); await new Promise<void>((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); }); const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done) => reservation.close(() => done()));
    const fork = process.env.FLASHLOAN_V8_FORK_RPC_URL;
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '8453', '--silent', ...(fork ? ['--fork-url', fork, ...(process.env.FLASHLOAN_V8_FORK_BLOCK ? ['--fork-block-number', process.env.FLASHLOAN_V8_FORK_BLOCK] : [])] : [])], { stdio: 'ignore' });
    let error: Error | undefined; child.on('error', (cause) => { error = cause; });
    const rpc = new JsonClient('http://127.0.0.1:' + port, fetch, 1000);
    try {
      let ready = false; const startupDeadline = Date.now() + (fork ? 12000 : 4000);
      while (Date.now() < startupDeadline) { if (error) throw error; if (child.exitCode !== null) throw new Error('Anvil exited before readiness.'); try { const response = await fetch(rpc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(150) }); if ((await response.json()).result) { ready = true; break; } } catch { /* Poll only during bounded local startup. */ } await delay(50); }
      if (!ready) throw new Error('Anvil RPC startup deadline exceeded; fork dependency evidence is unavailable.');
      const artifact = async (name: string) => { const value = JSON.parse(await readFile('services/flashloan/out/DiscoveryV8.t.sol/' + name + '.json', 'utf8')).deployedBytecode.object as string; return (value.startsWith('0x') ? value : '0x' + value) as Hex; };
      const token = await artifact('DiscoveryV8Token'), pair = await artifact('DiscoveryV8Pair'), factory = await artifact('DiscoveryV8Factory');
      for (const [to, code] of [[A8, token], [Q8, token], [P8, pair], [P82, pair], [F8, factory], [F82, factory]]) await rpc.rpc('anvil_setCode', [to, code]);
      await rpc.rpc('evm_mine', []);
      const fixture = fixtureV8(), raw = JSON.parse(JSON.stringify(fixture.registry.config));
      for (const venue of raw.networks.base.venues) { venue.factory_code_hash = keccak256(factory); venue.pool_code_hash = keccak256(pair); }
      const registry = new DiscoveryRegistry(raw), calls: string[] = [];
      const e = new ResearchEngine({ endpoints: { base: rpc.url }, deployments: [], discoveryRegistry: registry, fetcher: async (url, init) => {
        if (String(url) === rpc.url) { const body = JSON.parse(String(init?.body)), list = Array.isArray(body) ? body : [body]; calls.push(...list.map((r: { method: string }) => r.method)); return fetch(url, init); }
        return fixture.fetcher(url, init);
      } });
      const result = watchlistV1Schema.parse(await e.watchlist({ network: 'base', seed_tokens: [A8] }));
      expect(result.pools).toHaveLength(2); expect(result.tokens).toHaveLength(1); expect(result.pools.every((p) => p.liquidity_eligible && p.depth.virtual_depth_usd === '20000')).toBe(true);
      expect(calls).toContain('eth_call'); expect(calls.some((method) => /send|sign|anvil_/.test(method))).toBe(false);
      console.log(JSON.stringify({ event: 'flashloan.v8.native', marker: 'FLV8_MCP_NATIVE_E2E', passed: true, rpc: fork ? 'anvil-fork' : 'anvil-local', fork_block: process.env.FLASHLOAN_V8_FORK_BLOCK ?? null, no_broadcast: true }));
    } finally { child.kill('SIGTERM'); await new Promise<void>((done) => { if (child.exitCode !== null) done(); else child.once('exit', () => done()); }); vi.unstubAllEnvs(); }
  }, 60000);
});
