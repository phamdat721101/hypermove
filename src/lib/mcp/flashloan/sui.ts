import { z } from 'zod';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Transaction, TransactionArgument, TransactionObjectArgument } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { hash, ResearchError } from './contracts';
import { normalizeCoinType, suiObjectId, SUI_MAINNET_CHAIN_IDENTIFIER } from './networks';
import { inventoryPoolSchema, type PoolInventory } from './discovery';
import { JsonClient, boundedBody } from './transport';
import { suiSnapshotSchema, suiPlanSchema, type SuiSnapshot, type SuiPlan, type SuiDeployment, type suiOperations } from './sui-contracts';

// Explicit Node host adapter. Node 22.12+ supports synchronous ESM loading without eval.
// Loading stays inside the Sui path; public EVM discovery never loads the SDK.
const sdkRequire = createRequire(resolve('package.json'));
export function suiRuntimeSupported(version = process.versions.node) { const [major, minor] = version.split('.').map(Number); return major > 22 || major === 22 && minor >= 12; }
export async function suiSdk() {
  if (!suiRuntimeSupported()) throw new ResearchError('SUI_RUNTIME_UNSUPPORTED', 'Sui research requires Node 22.12 or newer.');
  return { ...(sdkRequire('@mysten/sui/transactions') as typeof import('@mysten/sui/transactions')), ...(sdkRequire('@mysten/sui/grpc') as typeof import('@mysten/sui/grpc')) };
}
const objectSchema = z.object({ address: suiObjectId, version: z.union([z.number().int().nonnegative(), z.string()]).transform(String), digest: z.string(), asMoveObject: z.object({ contents: z.object({ bcs: z.string(), type: z.object({ repr: z.string() }) }) }).nullable().optional(), asMovePackage: z.unknown().optional(), owner: z.object({ __typename: z.string(), initialSharedVersion: z.union([z.number().int().nonnegative(), z.string()]).optional() }).optional() });
const readSchema = z.object({ data: z.object({ checkpoint: z.object({ sequenceNumber: z.union([z.number().int(), z.string()]).transform(String), digest: z.string(), query: z.object({ multiGetObjects: z.array(objectSchema.nullable()) }) }).nullable() }) });
const snapshotQuery = `query ResearchState($keys:[ObjectKey!]!,$cp:UInt53){checkpoint(sequenceNumber:$cp){sequenceNumber digest query{multiGetObjects(keys:$keys){address version digest asMovePackage{__typename} asMoveObject{contents{bcs type{repr}}} owner{__typename ... on Shared{initialSharedVersion}}}}}}`;
type Ingest = z.infer<typeof suiOperations.sui_ingest_pool_state>;
type Solve = z.infer<typeof suiOperations.sui_solve_arbitrage_routes>;
export type SuiOptions = { graphql: string; grpc: string; chain_identifier: string; deployments: SuiDeployment[]; nativeClient?: () => Promise<SuiGrpcClient>; fetcher?: typeof fetch };
export class SuiReader {
  constructor(readonly options: SuiOptions) { if (options.chain_identifier !== SUI_MAINNET_CHAIN_IDENTIFIER) throw new ResearchError('CHAIN_MISMATCH', 'Only Sui mainnet is supported.'); new JsonClient(options.graphql); new JsonClient(options.grpc); }
  private async client(signal?: AbortSignal): Promise<SuiGrpcClient> {
    const sdk = await suiSdk();
    const fetcher: typeof fetch = async (url, init) => {
      const timeout = AbortSignal.timeout(15000);
      const response = await (this.options.fetcher ?? fetch)(url, { ...init, redirect: 'error', signal: (AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }).any([timeout, ...(signal ? [signal] : [])]) });
      // Bound native protobuf responses before passing them to the SDK.
      return new Response(await boundedBody(response, 4_000_000, signal), { status: response.status, headers: response.headers });
    };
    const client = this.options.nativeClient ? await this.options.nativeClient() : new sdk.SuiGrpcClient({ network: 'mainnet', baseUrl: this.options.grpc, fetch: fetcher });
    const chain = await client.getChainIdentifier({ signal });
    if (chain.chainIdentifier !== this.options.chain_identifier) throw new ResearchError('CHAIN_MISMATCH', 'Sui endpoint serves a different genesis checkpoint.');
    return client;
  }
  private async read(ids: string[], checkpoint?: string, signal?: AbortSignal) {
    if (checkpoint && BigInt(checkpoint) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ResearchError('INVALID_SNAPSHOT', 'Checkpoint exceeds the GraphQL scalar range.');
    const raw = await new JsonClient(this.options.graphql, this.options.fetcher).request({ query: snapshotQuery, variables: { keys: ids.map((address) => ({ address })), cp: checkpoint ? Number(checkpoint) : null } }, signal);
    const parsed = readSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.data.checkpoint) throw new ResearchError('STALE_SNAPSHOT', 'Checkpoint state is unavailable or outside retention.');
    return parsed.data.data.checkpoint;
  }
  async inventory(tokens: string[], cursors: Record<string, string> = {}, pageSize = 50, maxPages = 2, signal?: AbortSignal) {
    const pools: PoolInventory['pools'] = [], coverage: PoolInventory['coverage'] = [], diagnostics: PoolInventory['diagnostics'] = [];
    const observed_at = new Date().toISOString();
    const query = `query Inventory($type:String!,$after:String,$first:Int!){chainIdentifier objects(first:$first,after:$after,filter:{type:$type}){nodes{address asMoveObject{contents{type{repr}}}}pageInfo{hasNextPage endCursor}}}`;
    const schema = z.object({ data: z.object({ chainIdentifier: z.string(), objects: z.object({ nodes: z.array(z.object({ address: suiObjectId, asMoveObject: z.object({ contents: z.object({ type: z.object({ repr: z.string() }) }) }) })), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }) }) });
    for (const deployment of this.options.deployments) {
      const source = 'sui:graphql:' + deployment.protocol;
      let cursor: string | null = cursors[deployment.protocol] ?? null;
      let raw_count = 0, valid_count = 0, more = false, failed = false;
      try {
        for (let page = 0; page < maxPages; page++) {
          signal?.throwIfAborted();
          const result = schema.parse(await new JsonClient(this.options.graphql, this.options.fetcher).request({ query, variables: { type: deployment.original_package + '::pool::Pool', after: cursor, first: pageSize } }, signal));
          if (result.data.chainIdentifier !== this.options.chain_identifier) throw new ResearchError('CHAIN_MISMATCH', 'Sui index serves a different network.');
          const data = result.data.objects;
          raw_count += data.nodes.length;
          for (const node of data.nodes) {
            const normalized = normalizeCoinType(node.asMoveObject.contents.type.repr), prefix = deployment.original_package + '::pool::Pool<';
            if (!normalized.startsWith(prefix)) continue;
            const body = normalized.slice(prefix.length, -1); let depth = 0, split = -1;
            for (let i = 0; i < body.length; i++) { if (body[i] === '<') depth++; else if (body[i] === '>') depth--; else if (body[i] === ',' && depth === 0) { split = i; break; } }
            if (split < 0) continue;
            const assets = [body.slice(0, split), body.slice(split + 1)];
            if (!tokens.some((t) => assets.includes(t))) continue;
            const reference = { kind: 'sui_object' as const, network: 'mainnet' as const, objectId: node.address };
            const state = { status: 'unverified', reason: 'NATIVE_SNAPSHOT_REQUIRED' };
            pools.push(inventoryPoolSchema.parse({ id: hash(reference), reference, asset_ids: assets, protocol: deployment.protocol, labels: [], liquidity_usd: null, price_usd: null, liquidity_eligible: null, eligibility_reasons: ['LIQUIDITY_UNKNOWN'], capabilities: { state, quote: state, funding: state, simulation: state }, provenance: [{ source, provider_pool_id: node.address, observed_at }] })); valid_count++;
          }
          more = data.pageInfo.hasNextPage;
          const next = data.pageInfo.endCursor;
          if (more && (!next || next === cursor)) throw new ResearchError('INVALID_CURSOR', 'Sui pagination did not advance.');
          cursor = next;
          if (!more) break;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failed = true;
        diagnostics.push({ source, token: '*', code: error instanceof ResearchError ? error.code : 'INVALID_NATIVE_RESPONSE', retryable: true });
      }
      coverage.push({ source, token: '*', scope: 'protocol_registry', status: failed ? 'FAILED' : 'SUCCESS', raw_count, valid_count, retrieval_complete: !failed && !more, exhaustive: false, next_cursor: more ? cursor : null, observed_at });
    }
    return { pools, coverage, diagnostics };
  }
  async snapshot(input: Ingest, signal?: AbortSignal): Promise<SuiSnapshot> {
    const client = await this.client(signal);
    const refs = [...input.pools, input.lender];
    const unique = [...new Map(refs.map((p) => [p.object_id, p])).values()];
    if (input.pools.length !== new Set(input.pools.map((p) => p.object_id)).size) throw new ResearchError('DUPLICATE_POOL', 'Sui pool references must be unique.');
    const deployments = refs.map((ref) => {
      const d = this.options.deployments.find((d) => d.protocol === ref.protocol);
      if (!d || d.protocol === 'CETUS_CLMM' && (!d.config_id || !d.config_digest)) throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Reviewed Sui package and configuration are required.');
      return d;
    });
    const ids = [...new Set([...unique.map((p) => p.object_id), ...deployments.flatMap((d) => [d.published_at, ...(d.config_id ? [d.config_id] : [])])])];
    const state = await this.read(ids, undefined, signal);
    const objects = new Map(state.query.multiGetObjects.filter((o): o is NonNullable<typeof o> => o !== null).map((o) => [o.address, o]));
    for (const d of deployments) {
      const pkg = objects.get(d.published_at);
      if (!pkg?.asMovePackage || pkg.digest !== d.package_digest || d.config_id && objects.get(d.config_id)?.digest !== d.config_digest) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Sui package or global configuration differs from the reviewed registry.');
    }
    const pools = await Promise.all(unique.map(async (ref) => {
      const o = objects.get(ref.object_id), d = deployments.find((d) => d.protocol === ref.protocol)!;
      const type = o?.asMoveObject?.contents.type.repr;
      if (!o || !type || o.owner?.__typename !== 'Shared' || o.owner.initialSharedVersion === undefined) throw new ResearchError('INVALID_POOL', 'Expected a shared Move pool object.');
      const normalized = normalizeCoinType(type);
      const prefix = d.original_package + '::pool::Pool<';
      if (!normalized.startsWith(prefix) || !normalized.endsWith('>')) throw new ResearchError('INVALID_POOL', 'Pool type does not belong to the reviewed package.');
      const body = normalized.slice(prefix.length, -1); let depth = 0, split = -1;
      for (let i = 0; i < body.length; i++) { if (body[i] === '<') depth++; else if (body[i] === '>') depth--; else if (body[i] === ',' && depth === 0) { split = i; break; } }
      if (split < 0) throw new ResearchError('INVALID_POOL', 'Pool must have two coin types.');
      let fee_pips = 0;
      if (ref.protocol === 'CETUS_CLMM') {
        const sdk = await suiSdk(), tx = new sdk.Transaction(); tx.setSender('0x0');
        tx.moveCall({ target: `${d.published_at}::pool::fee_rate`, typeArguments: [body.slice(0, split), body.slice(split + 1)], arguments: [tx.object(ref.object_id)] });
        const fee = await client.simulateTransaction({ transaction: tx, checksEnabled: true, doGasSelection: false, include: { commandResults: true }, signal });
        const value = fee.commandResults?.[0]?.returnValues[0]?.bcs;
        if (fee.$kind !== 'Transaction' || value?.length !== 8) throw new ResearchError('UNKNOWN_POOL_FEE', 'Native Cetus fee read failed.');
        fee_pips = Number(Buffer.from(value).readBigUInt64LE());
      }
      return { ...ref, funding_fee: { pips: fee_pips, source: ref.protocol === 'CETUS_CLMM' ? 'NATIVE_CURRENT_VIEW' : 'PROTOCOL_VERSION', observed_at: new Date().toISOString() }, coin_a: normalizeCoinType(body.slice(0, split)), coin_b: normalizeCoinType(body.slice(split + 1)), version: o.version, digest: o.digest, content_bcs: o.asMoveObject!.contents.bcs, initial_shared_version: String(o.owner.initialSharedVersion), deployment: d };
    }));
    const snapshot = suiSnapshotSchema.parse({ network: 'sui', chain_identifier: this.options.chain_identifier, checkpoint: { sequence_number: state.sequenceNumber, digest: state.digest }, pools, lender: input.lender, observed_at: new Date().toISOString(), warnings: ['Quotes and funding are checked by native PTB execution, not an EVM model.', 'Simulation uses current native state; checkpoint-pinned execution is not implied.'] });
    await this.canonical(snapshot, signal);
    return snapshot;
  }
  async canonical(snapshot: SuiSnapshot, signal?: AbortSignal) {
    if (snapshot.chain_identifier !== this.options.chain_identifier) throw new ResearchError('CHAIN_MISMATCH', 'Snapshot belongs to a different Sui chain.');
    const ids = [...new Set(snapshot.pools.flatMap((p) => [p.object_id, p.deployment.published_at, ...(p.deployment.config_id ? [p.deployment.config_id] : [])]))];
    const state = await this.read(ids, snapshot.checkpoint.sequence_number, signal);
    if (state.digest !== snapshot.checkpoint.digest) throw new ResearchError('INVALID_SNAPSHOT', 'Checkpoint identity changed.');
    for (const p of snapshot.pools) {
      const current = state.query.multiGetObjects.find((o) => o?.address === p.object_id);
      if (!current || current.digest !== p.digest || current.version !== p.version) throw new ResearchError('INVALID_SNAPSHOT', 'Sui pool state does not match the declared checkpoint.');
      const d = this.options.deployments.find((d) => d.protocol === p.protocol);
      if (!d || hash(d) !== hash(p.deployment) || state.query.multiGetObjects.find((o) => o?.address === d.published_at)?.digest !== d.package_digest || d.config_id && state.query.multiGetObjects.find((o) => o?.address === d.config_id)?.digest !== d.config_digest) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Sui deployment review or package/configuration digest changed.');
    }
  }
  private async attestCurrentConfig(snapshot: SuiSnapshot, signal?: AbortSignal) {
    const configIds = [...new Set(snapshot.pools.flatMap((p) => p.deployment.config_id ? [p.deployment.config_id] : []))];
    if (configIds.length) {
      const current = await this.read(configIds, undefined, signal);
      for (const p of snapshot.pools) if (p.deployment.config_id && current.query.multiGetObjects.find((o) => o?.address === p.deployment.config_id)?.digest !== p.deployment.config_digest) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Current Sui configuration changed after registry review.');
    }
  }
  async simulate(raw: unknown, signal?: AbortSignal) {
    const plan = suiPlanSchema.parse(raw);
    await this.canonical(plan.snapshot, signal);
    await this.attestCurrentConfig(plan.snapshot, signal);
    const client = await this.client(signal), sdk = await suiSdk();
    const { transaction, profit_command, residual_commands } = buildSuiTransaction(sdk.Transaction, plan);
    const result = await client.simulateTransaction({ transaction, checksEnabled: true, doGasSelection: false, include: { effects: true, balanceChanges: true, commandResults: true }, signal });
    await this.canonical(plan.snapshot, signal);
    await this.attestCurrentConfig(plan.snapshot, signal);
    const tx = result.Transaction ?? result.FailedTransaction;
    const success = result.$kind === 'Transaction' && tx.status.success;
    const bytes = result.commandResults?.[profit_command]?.returnValues[0]?.bcs;
    const residual = success && bytes?.length === 8 ? Buffer.from(bytes).readBigUInt64LE().toString() : null;
    const net = residual === null ? null : BigInt(residual) - BigInt(plan.policy.network_cost);
    const residual_assets = residual_commands.map((r) => { const value = result.commandResults?.[r.command]?.returnValues[0]?.bcs; return { coin_type: r.coin_type, amount: value?.length === 8 ? Buffer.from(value).readBigUInt64LE().toString() : null }; });
    const meetsPolicy = net !== null && net > BigInt(plan.policy.min_profit);
    const used = new Set([plan.snapshot.lender.object_id, ...plan.route.map((h) => h.pool)]);
    const nativeInputs = (tx.effects?.changedObjects ?? []).filter((o) => used.has(o.objectId)).map((o) => ({ object_id: o.objectId, version: o.inputVersion, digest: o.inputDigest }));
    const matches = [...used].every((id) => { const p = plan.snapshot.pools.find((p) => p.object_id === id), input = nativeInputs.find((p) => p.object_id === id); return p && input && p.version === input.version && p.digest === input.digest; });
    const configEvidence = configIdsFrom(plan.snapshot).map((id) => {
      const changed = tx.effects?.changedObjects.find((o) => o.objectId === id);
      const unchanged = tx.effects?.unchangedConsensusObjects.find((o) => o.objectId === id);
      const digest = changed?.inputDigest ?? unchanged?.digest ?? null;
      const expected = plan.snapshot.pools.find((p) => p.deployment.config_id === id)!.deployment.config_digest;
      if (digest && digest !== expected) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Native simulation used unreviewed Sui configuration.');
      return { object_id: id, version: changed?.inputVersion ?? unchanged?.version ?? null, digest, verified: Boolean(digest && digest === expected) };
    });
    const configurationVerified = configEvidence.every((c) => c.verified);
    return { status: !success ? 'REJECTED' : !configurationVerified ? 'INCONCLUSIVE' : meetsPolicy ? 'NATIVE_DRY_RUN' : 'NO_OPPORTUNITY', verification_level: 'SUI_NODE_DRY_RUN', native_configuration_inputs: configEvidence, state_alignment: matches && configurationVerified ? 'SNAPSHOT_INPUTS_MATCH' : 'CURRENT_NATIVE_STATE', native_input_objects: nativeInputs, snapshot_checkpoint: plan.snapshot.checkpoint, snapshot_hash: hash(plan.snapshot), residual_assets, repayment: success ? 'RECEIPT_CONSUMED' : 'UNPROVEN', gross_profit_funding_units: residual, expected_net_profit_funding_units: net?.toString() ?? null, gas_payment_mocked: result.gasPaymentMocked, gas: tx.effects?.gasUsed ?? null, failure: success ? null : tx.status.error?.message.slice(0, 500) ?? 'Native PTB rejected.', unsigned_transaction: await transaction.toJSON(), checks_enabled: true, historical_execution_verified: false, chain_native_verified: false, can_execute: false, assumptions: ['Gas may be mocked; no sender-funding or historical execution guarantee.', 'Profit policy is checked against native simulation output. This research artifact is not an execution authorization.'] };
  }
  async solve(raw: unknown, input: Solve, signal?: AbortSignal) {
    const snapshot = suiSnapshotSchema.parse(raw);
    await this.canonical(snapshot, signal);
    const lender = snapshot.pools.find((p) => p.object_id === snapshot.lender.object_id);
    if (!lender || ![lender.coin_a, lender.coin_b].includes(input.borrow_asset)) throw new ResearchError('INVALID_ASSET', 'Lender does not contain the funding asset.');
    const routes = suiClosedRoutes(snapshot, input.borrow_asset);
    let evaluations = 0; const rejected: Record<string, number> = {}; let best: SuiPlan | undefined;
    for (let scale = 1; scale <= 4 && evaluations < input.policy.max_evaluations; scale++) {
      for (const route of routes) {
        if (evaluations >= input.policy.max_evaluations) break;
        signal?.throwIfAborted();
        const principal = BigInt(input.policy.max_principal) * BigInt(scale) / 4n;
        if (!principal) continue;
        evaluations++;
        const plan: SuiPlan = { snapshot, sender: input.sender, borrow_asset: input.borrow_asset, principal: principal.toString(), route, policy: input.policy, expected_profit: '0' };
        const result = await this.simulate(plan, signal);
        if (result.status === 'NATIVE_DRY_RUN' && result.expected_net_profit_funding_units !== null) {
          if (!best || BigInt(result.expected_net_profit_funding_units) > BigInt(best.expected_profit)) best = { ...plan, expected_profit: result.expected_net_profit_funding_units };
        } else rejected[result.status] = (rejected[result.status] ?? 0) + 1;
      }
    }
    return { status: best ? 'FEASIBLE' : evaluations >= input.policy.max_evaluations || rejected.REJECTED ? 'INCONCLUSIVE' : 'NO_OPPORTUNITY', solution: best ?? null, routes_considered: routes.length, evaluations, rejected_evaluations: rejected, funding: { capacity: null, verification: 'PER_CANDIDATE_NATIVE_BORROW_REPAY' }, search: { classification: 'BOUNDED_NATIVE_PTB_SEARCH', global_optimum_proven: false }, can_execute: false };
  }
}
function configIdsFrom(snapshot: SuiSnapshot) { return [...new Set(snapshot.pools.flatMap((p) => p.deployment.config_id ? [p.deployment.config_id] : []))]; }
export function suiClosedRoutes(snapshot: SuiSnapshot, asset: string): SuiPlan['route'][] {
  const routes: SuiPlan['route'][] = [];
  const visit = (token: string, hops: SuiPlan['route'], used: Set<string>) => {
    if (hops.length >= 4 || routes.length >= 64) return;
    for (const p of snapshot.pools) {
      if (p.object_id === snapshot.lender.object_id || used.has(p.object_id) || ![p.coin_a, p.coin_b].includes(token)) continue;
      const next = token === p.coin_a ? p.coin_b : p.coin_a;
      const step = [...hops, { pool: p.object_id, token_in: token, token_out: next }];
      if (next === asset && step.length >= 2) routes.push(step);
      else if (!hops.some((h) => h.token_in === next)) visit(next, step, new Set([...used, p.object_id]));
      if (routes.length >= 64) break;
    }
  };
  visit(asset, [], new Set()); return routes;
}

/** All market arithmetic happens in the reviewed Move packages, including Q64.64 and book fees. */
export function buildSuiTransaction(TransactionClass: new () => Transaction, plan: SuiPlan) {
  const tx = new TransactionClass(); tx.setSender(plan.sender);
  const pools = new Map(plan.snapshot.pools.map((p) => [p.object_id, p]));
  const lender = pools.get(plan.snapshot.lender.object_id);
  if (!lender || ![lender.coin_a, lender.coin_b].includes(plan.borrow_asset)) throw new ResearchError('INVALID_ASSET', 'Invalid funding pool.');
  const obj = (p: SuiSnapshot['pools'][number]) => tx.sharedObjectRef({ objectId: p.object_id, initialSharedVersion: p.initial_shared_version, mutable: true });
  const move = (target: string, types: string[], args: TransactionArgument[]) => tx.moveCall({ target: target as `${string}::${string}::${string}`, typeArguments: types, arguments: args });
  const zero = (type: string) => move('0x2::balance::zero', [type], []);
  const fromBalance = (type: string, balance: TransactionArgument) => move('0x2::coin::from_balance', [type], [balance]);
  const intoBalance = (type: string, coin: TransactionArgument) => move('0x2::coin::into_balance', [type], [coin]);
  const destroy = (type: string, balance: TransactionArgument) => { move('0x2::balance::destroy_zero', [type], [balance]); };
  const types = [lender.coin_a, lender.coin_b], a = plan.borrow_asset === lender.coin_a;
  let current: TransactionObjectArgument, receipt: TransactionArgument;
  if (lender.protocol === 'DEEPBOOK_V3') {
    const loan = move(lender.deployment.published_at + '::pool::borrow_flashloan_' + (a ? 'base' : 'quote'), types, [obj(lender), tx.pure.u64(plan.principal)]);
    current = loan[0]; receipt = loan[1];
  } else {
    const loan = move(lender.deployment.published_at + '::pool::flash_loan', types, [tx.object(lender.deployment.config_id!), obj(lender), tx.pure.bool(a), tx.pure.u64(plan.principal)]);
    current = fromBalance(plan.borrow_asset, loan[a ? 0 : 1]); receipt = loan[2]; destroy(a ? lender.coin_b : lender.coin_a, loan[a ? 1 : 0]);
  }
  const fundingResiduals: TransactionObjectArgument[] = [];
  const residual_commands: Array<{ coin_type: string; command: number }> = [];
  const residual = (type: string, coin: TransactionObjectArgument) => { if (type === plan.borrow_asset) fundingResiduals.push(coin); else { residual_commands.push({ coin_type: type, command: tx.getData().commands.length }); move('0x2::coin::value', [type], [coin]); tx.transferObjects([coin], plan.sender); } };
  let token = plan.borrow_asset;
  for (const hop of plan.route) {
    const p = pools.get(hop.pool);
    if (!p || p.object_id === lender.object_id || token !== hop.token_in || ![p.coin_a, p.coin_b].includes(token) || hop.token_out !== (token === p.coin_a ? p.coin_b : p.coin_a)) throw new ResearchError('INVALID_ROUTE', 'Disconnected route or lending pool reused.');
    const forward = token === p.coin_a, pair = [p.coin_a, p.coin_b];
    if (p.protocol === 'CETUS_CLMM') {
      const amount = move('0x2::coin::value', [token], [current]);
      const swap = move(p.deployment.published_at + '::pool::flash_swap', pair, [tx.object(p.deployment.config_id!), obj(p), tx.pure.bool(forward), tx.pure.bool(true), amount, tx.pure.u128(forward ? '4295048017' : '79226673515401279992447579055'), tx.object('0x6')]);
      const payment = intoBalance(token, current), empty = zero(hop.token_out);
      move(p.deployment.published_at + '::pool::repay_flash_swap', pair, [tx.object(p.deployment.config_id!), obj(p), forward ? payment : empty, forward ? empty : payment, swap[2]]);
      destroy(token, swap[forward ? 0 : 1]); current = fromBalance(hop.token_out, swap[forward ? 1 : 0]);
    } else {
      // Empty DEEP coin explicitly selects input-token fees in reviewed DeepBook v3.
      const deepType = '0xdeeb7a4662eec9f2f3def03fb9376518cfca7b8c7c6e4f327d6eb78a2343bfa97::deep::DEEP';
      const deep = move('0x2::coin::zero', [deepType], []);
      const swap = move(p.deployment.published_at + '::pool::swap_exact_' + (forward ? 'base_for_quote' : 'quote_for_base'), pair, [obj(p), current, deep, tx.pure.u64(0), tx.object('0x6')]);
      residual(token, swap[forward ? 0 : 1]); residual(deepType, swap[2]); current = swap[forward ? 1 : 0];
    }
    token = hop.token_out;
  }
  if (token !== plan.borrow_asset) throw new ResearchError('INVALID_ROUTE', 'Route does not repay in its starting asset.');
  if (fundingResiduals.length) tx.mergeCoins(current, fundingResiduals);
  let repayment: TransactionArgument;
  if (lender.protocol === 'DEEPBOOK_V3') {
    [repayment] = tx.splitCoins(current, [tx.pure.u64(plan.principal)]);
    move(lender.deployment.published_at + '::pool::return_flashloan_' + (a ? 'base' : 'quote'), types, [obj(lender), repayment, receipt]);
  } else {
    const fee = (BigInt(plan.principal) * BigInt(lender.funding_fee.pips) + 999999n) / 1000000n;
    [repayment] = tx.splitCoins(current, [tx.pure.u64(BigInt(plan.principal) + fee)]);
    const paid = intoBalance(plan.borrow_asset, repayment), empty = zero(a ? lender.coin_b : lender.coin_a);
    move(lender.deployment.published_at + '::pool::repay_flash_loan', types, [tx.object(lender.deployment.config_id!), obj(lender), a ? paid : empty, a ? empty : paid, receipt]);
  }
  const profit_command = tx.getData().commands.length;
  move('0x2::coin::value', [plan.borrow_asset], [current]); tx.transferObjects([current], plan.sender);
  return { transaction: tx, profit_command, residual_commands };
}
