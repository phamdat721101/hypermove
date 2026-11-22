import { decodeEventLog, encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';
import { EvmReader, type Deployment, type Header } from './evm';
import { ResearchError } from './contracts';
import type { ResearchEngine } from './engine';
import { RoundBudget } from './transport';
import { assetId, currencyAddress, evidence, integrationNetwork, unsupportedSupport, validateIntegration, ZERO_ADDRESS, type EvidenceRef, type PoolKey, type PoolReference, type ResolvedPool, type ResolutionReport, type State } from './integration-contracts';

const initializeAbi = parseAbi(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);
const initializeTopic = keccak256(new TextEncoder().encode('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'));
type InitLog = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean };
export type InitializationLocator = { network: string; manager: string; poolId: string; blockHash: string };
// Only immutable event locators are cached. Every use rereads the canonical event.
const caches = new WeakMap<Deployment[], Map<string, InitializationLocator>>();
export function managerMapping(engine: ResearchEngine, chainId: string, roundId: string) {
  const network = integrationNetwork(chainId);
  return evidence('configuration', engine.options.deployments.filter((d) => d.network === network && d.adapter === 'UNISWAP_V4').sort((a, b) => a.address.localeCompare(b.address)), 'registry:v4-managers/' + chainId, roundId);
}
export function canonicalPoolId(key: PoolKey) {
  return keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [key.currency0 as Address, key.currency1 as Address, key.fee, key.tickSpacing, key.hooks as Address]));
}
export function stateIdentity(chainId: string, block: Header, source: unknown): State {
  return { chainId, blockNumber: BigInt(block.number).toString(), blockHash: block.hash, parentHash: block.parentHash, observedAt: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), finality: 'latest', stateDigest: evidence('canonical-state', source, 'state', 'digest').contentHash };
}
async function findInitialization(engine: ResearchEngine, manager: Deployment, poolId: string, block: Header, budget: RoundBudget): Promise<InitLog> {
  let cache = caches.get(engine.options.deployments);
  if (!cache) { cache = new Map(); caches.set(engine.options.deployments, cache); }
  const cacheKey = manager.network + ':' + manager.address + ':' + poolId + ':' + manager.version + ':' + manager.code_hash;
  const locator = cache.get(cacheKey) ?? engine.options.initializations?.find((r) => r.network === manager.network && r.manager === manager.address && r.poolId === poolId);
  const rpc = engine.rpc(manager.network);
  const read = async (filter: object) => {
    const result = await rpc.rpc<InitLog[]>('eth_getLogs', [{ address: manager.address, topics: [initializeTopic, poolId], ...filter }], budget.signal);
    const v8 = process.env.FLASHLOAN_INVENTORY_V3 === 'true';
    if (!Array.isArray(result) || result.length > (v8 ? 2000 : 100)) throw new ResearchError('CONFLICTING_INITIALIZATION', 'Initialization log response exceeds bounds.');
    return result.filter((l) => !l.removed && l.address.toLowerCase() === manager.address && BigInt(l.blockNumber) <= BigInt(block.number) && (!v8 || l.topics[0] === initializeTopic && l.topics[1] === poolId && (!('blockHash' in filter) || l.blockHash === (filter as { blockHash: string }).blockHash) && (!('fromBlock' in filter) || BigInt(l.blockNumber) >= BigInt((filter as { fromBlock: string }).fromBlock)) && (!('toBlock' in filter) || BigInt(l.blockNumber) <= BigInt((filter as { toBlock: string }).toBlock))));
  };
  let matches: InitLog[] = [];
  if (locator) {
    try { matches = await read({ blockHash: locator.blockHash }); }
    catch (error) { cache.delete(cacheKey); throw error; }
    if (!matches.length) { cache.delete(cacheKey); throw new ResearchError('BLOCK_REORG', 'Cached initialization is no longer canonical; refresh its locator.'); }
  } else {
    if (manager.initialization_block === undefined) throw new ResearchError('ARCHIVE_UNAVAILABLE', 'Supply a reviewed initialization locator or manager scan start block.');
    const start = BigInt(manager.initialization_block), head = BigInt(block.number);
    for (let page = 0; page < 5 && start + BigInt(page * 2000) <= head; page++) {
      budget.check();
      const from = start + BigInt(page * 2000), to = from + 1999n < head ? from + 1999n : head;
      matches.push(...await read({ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }));
      if (matches.length) break;
    }
    if (!matches.length) throw new ResearchError('UNRESOLVED_POOL_KEY', 'No initialization in the five reviewed 2000-block pages; supply an indexed locator.');
  }
  if (matches.length !== 1) throw new ResearchError('CONFLICTING_INITIALIZATION', 'More than one matching initialization.');
  const log = matches[0];
  const canonical = await rpc.rpc<Header | null>('eth_getBlockByNumber', [log.blockNumber, false], budget.signal);
  if (!canonical || canonical.hash !== log.blockHash) { cache.delete(cacheKey); throw new ResearchError('BLOCK_REORG', 'Initialization block is not canonical.'); }
  if (!/^0x[0-9a-f]{64}$/.test(log.transactionHash) || !/^0x[0-9a-f]+$/.test(log.logIndex)) throw new ResearchError('UNRESOLVED_POOL_KEY', 'Initialization lacks transaction/log provenance.');
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { network: manager.network, manager: manager.address, poolId, blockHash: log.blockHash });
  return log;
}

/** Resolve identity independently of full research admission; never issue snapshot proofs here. */
export async function resolveInventory(engine: ResearchEngine, chainId: string, roundId: string, references: PoolReference[], mappingRef: EvidenceRef | null, atBlock: string | null, budget: RoundBudget, maxPools: number): Promise<ResolutionReport> {
  const started = performance.now();
  const network = integrationNetwork(chainId), expectedMapping = managerMapping(engine, chainId, roundId);
  const report: ResolutionReport = { schema: 'pool-resolution-report/1', roundId, chainId, resolved: [], unresolved: [], complete: true, rpcCallsUsed: 0, sourceRefs: [] };
  const managers = engine.options.deployments.filter((d) => d.network === network && d.adapter === 'UNISWAP_V4');
  const mismatch = mappingRef && (mappingRef.contentHash !== expectedMapping.contentHash || mappingRef.kind !== 'configuration' || mappingRef.expiresAt !== null && Date.parse(mappingRef.expiresAt) <= Date.now());
  let block: Header | undefined;
  const reader = new EvmReader(engine.rpc(network), network, engine.options.deployments);
  const unique = new Set<string>();
  for (const ref of references) {
    try {
      budget.check();
      if (mismatch) throw new ResearchError('MAPPING_REVISION_MISMATCH', 'Refresh the reviewed manager mapping reference.');
      if (!managers.length) throw new ResearchError('MANAGER_MAPPING_REQUIRED', 'A server-reviewed v4 manager mapping is required.');
      if (!/^0x[0-9a-f]{64}$/.test(ref.providerPoolId)) throw new ResearchError('INVALID_PROVIDER_REFERENCE', 'Provider reference is not a canonical v4 bytes32 ID.');
      ref.assetIds.forEach((id) => currencyAddress(chainId, id));
      const prior = report.resolved.find((p) => p.poolId === ref.providerPoolId);
      if (prior) {
        if (new Set(ref.assetIds).size !== 2 || !ref.assetIds.includes(prior.asset0.assetId) || !ref.assetIds.includes(prior.asset1.assetId)) throw new ResearchError('CURRENCY_MISMATCH', 'Provider alias currencies differ from the resolved PoolKey.');
        if (prior.sourceRefs.length >= 16) throw new ResearchError('RESOLUTION_BUDGET', 'Resolved pool provenance export limit reached.');
        prior.sourceRefs.push(evidence('source', ref, 'provider:' + ref.provider, roundId));
        continue;
      }
      if (unique.size >= maxPools) throw new ResearchError('RESOLUTION_BUDGET', 'Canonical pool selection limit reached.');
      block ??= await reader.header(budget.signal, atBlock ?? undefined);
      const found: Array<{ manager: Deployment; log: InitLog }> = [];
      const failures: ResearchError[] = [];
      for (const manager of managers) {
        try {
          await reader.attest(manager.address, 'UNISWAP_V4', block, budget.signal);
          found.push({ manager, log: await findInitialization(engine, manager, ref.providerPoolId, block, budget) });
        } catch (e) { if (!(e instanceof ResearchError)) throw e; if (['CANCELLED', 'ROUND_DEADLINE', 'RESOLUTION_BUDGET'].includes(e.code)) throw e; failures.push(e); }
      }
      if (found.length > 1) throw new ResearchError('CONFLICTING_INITIALIZATION', 'Pool ID exists under multiple reviewed managers.');
      if (!found.length) throw failures[0] ?? new ResearchError('UNRESOLVED_POOL_KEY', 'No canonical initialization found.');
      if (failures.length) throw new ResearchError('UNRESOLVED_POOL_KEY', 'A reviewed manager could not be checked; resolve ambiguity before admitting identity.');
      const { manager, log } = found[0];
      const event = decodeEventLog({ abi: initializeAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const a = event.args;
      const key: PoolKey = { currency0: a.currency0.toLowerCase(), currency1: a.currency1.toLowerCase(), fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks.toLowerCase() };
      if (BigInt(key.currency0) >= BigInt(key.currency1) || canonicalPoolId(key) !== ref.providerPoolId || a.id !== ref.providerPoolId) throw new ResearchError('POOL_ID_MISMATCH', 'Initialization PoolKey does not match canonical pool identity.');
      if (new Set(ref.assetIds).size !== 2 || !ref.assetIds.includes(assetId(chainId, key.currency0)) || !ref.assetIds.includes(assetId(chainId, key.currency1))) throw new ResearchError('CURRENCY_MISMATCH', 'Provider currencies differ from initialized PoolKey.');
      if (!manager.state_view || !manager.state_view_code_hash) throw new ResearchError('UNRESOLVED_POOL_KEY', 'Reviewed StateView is required to verify current initialization.');
      const code = await reader.rpc.rpc<Hex>('eth_getCode', [manager.state_view, { blockHash: block.hash, requireCanonical: true }], budget.signal);
      if (keccak256(code) !== manager.state_view_code_hash) throw new ResearchError('MANAGER_CODE_MISMATCH', 'StateView code differs from reviewed mapping.');
      const slot = await reader.call(manager.state_view, 'getSlot0(bytes32)', [ref.providerPoolId], block, budget.signal);
      if (!slot[0]) throw new ResearchError('UNINITIALIZED_POOL', 'Pool is not initialized at the accepted block.');
      const metadata = async (currency: string) => {
        const decimals = currency === ZERO_ADDRESS ? 18 : Number((await reader.call(currency, 'decimals()', [], block!, budget.signal))[0]);
        return { assetId: assetId(chainId, currency), chainId, kind: currency === ZERO_ADDRESS ? 'native' as const : 'erc20' as const, address: currency === ZERO_ADDRESS ? null : currency, decimals, metadataRef: evidence('canonical-state', { currency, decimals, blockHash: block!.hash }, 'rpc:currency-metadata', roundId) };
      };
      const asset0 = await metadata(key.currency0), asset1 = await metadata(key.currency1);
      const supported = key.hooks === ZERO_ADDRESS && key.fee < 1000000 && Number(slot[3]) === key.fee && asset0.decimals <= 36 && asset1.decimals <= 36;
      const record: ResolvedPool = { schema: 'resolved-pool/1', chainId, protocol: 'uniswap-v4', provider: ref.provider, providerPoolId: ref.providerPoolId, manager: manager.address, managerCodeHash: manager.code_hash, poolId: ref.providerPoolId, key, asset0, asset1, state: stateIdentity(chainId, block, { block, manager: manager.address, key, slot: slot.map(String) }), initializationRef: evidence('canonical-state', log, 'rpc:initialize/' + log.transactionHash + '/' + log.logIndex, roundId), mappingRef: expectedMapping, support: { ...unsupportedSupport(...supported ? [] : ['UNSUPPORTED_HOOK_OR_FEE']), read: true, quote: supported }, sourceRefs: [evidence('source', ref, 'provider:' + ref.provider, roundId)] };
      validateIntegration('ResolvedPool', record);
      const canonical = manager.address + ':' + ref.providerPoolId;
      const previous = report.resolved.find((p) => p.manager === manager.address && p.poolId === ref.providerPoolId);
      if (previous) previous.sourceRefs = [...previous.sourceRefs, ...record.sourceRefs].slice(0, 16);
      else { unique.add(canonical); report.resolved.push(record); }
    } catch (error) {
      const e = error instanceof ResearchError ? error : new ResearchError('UNRESOLVED_POOL_KEY', 'Malformed or unavailable canonical initialization.');
      const code = ({ CHAIN_MISMATCH: 'WRONG_CHAIN', DEPLOYMENT_MISMATCH: 'MANAGER_CODE_MISMATCH', REORG: 'BLOCK_REORG', ROUND_DEADLINE: 'RESOLUTION_BUDGET', RPC_METHOD_FAILED: 'ARCHIVE_UNAVAILABLE', RPC_UNAVAILABLE: 'ARCHIVE_UNAVAILABLE', DEPENDENCY_TIMEOUT: 'ARCHIVE_UNAVAILABLE' } as Record<string, string>)[e.code] ?? e.code;
      const reasons = ['WRONG_CHAIN', 'MANAGER_CODE_MISMATCH', 'BLOCK_REORG', 'RESOLUTION_BUDGET', 'ARCHIVE_UNAVAILABLE', 'CANCELLED', 'MAPPING_REVISION_MISMATCH', 'MANAGER_MAPPING_REQUIRED', 'INVALID_PROVIDER_REFERENCE', 'CONFLICTING_INITIALIZATION', 'POOL_ID_MISMATCH', 'CURRENCY_MISMATCH', 'UNINITIALIZED_POOL', 'UNRESOLVED_POOL_KEY'];
      report.unresolved.push({ provider: ref.provider, providerPoolId: ref.providerPoolId, reasonCode: reasons.includes(code) ? code : 'UNRESOLVED_POOL_KEY', nextDependency: e.message.slice(0, 512) });
      report.complete = false;
    }
  }
  if (block && report.resolved.length) {
    try {
      const canonical = await reader.rpc.rpc<Header | null>('eth_getBlockByNumber', [block.number, false], budget.signal);
      if (!canonical || canonical.hash !== block.hash) throw new ResearchError('BLOCK_REORG', 'Accepted resolution block changed before export.');
    } catch (error) {
      const reorg = error instanceof ResearchError && error.code === 'BLOCK_REORG';
      if (reorg) caches.delete(engine.options.deployments);
      for (const ref of references) if (!report.unresolved.some((r) => r.provider === ref.provider && r.providerPoolId === ref.providerPoolId)) report.unresolved.push({ provider: ref.provider, providerPoolId: ref.providerPoolId, reasonCode: reorg ? 'BLOCK_REORG' : 'RESOLUTION_BUDGET', nextDependency: reorg ? 'Refresh canonical initialization and accepted state.' : 'Reserve RPC/time budget for final canonicality verification.' });
      report.resolved = []; report.complete = false;
    }
  }
  report.rpcCallsUsed = budget.rpcCallsUsed;
  console.info(JSON.stringify({ event: 'flashloan.pool_resolution', round_id: roundId, resolved: report.resolved.length, unresolved: report.unresolved.length, reasons: Object.fromEntries([...new Set(report.unresolved.map((r) => r.reasonCode))].map((code) => [code, report.unresolved.filter((r) => r.reasonCode === code).length])), rpc_calls_used: report.rpcCallsUsed, elapsed_ms: Math.round(performance.now() - started) }));
  return validateIntegration<ResolutionReport>('PoolResolutionReport', report);
}
