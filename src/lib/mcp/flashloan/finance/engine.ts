import { JsonClient } from '../transport';
import { ResearchError, type Operation } from '../contracts';
import { XrplReader } from '../xrpl';
import type { Repository, StoredJob } from '../storage';
import {
  FINANCE_CONTRACT_DIGEST, RATES_CONTRACT_DIGEST, FinanceError, assertWireResponse, normalizeEvmAddress, semanticIssues,
  validateFinance, validateRates, rayToDecimal, type FinanceErrorCode, type FinanceNetwork,
} from './contracts';
import {
  FinanceEvmReader, aaveAccount, aaveBalances, aavePool, aaveReserves, healthFactorDecimal, isCollateral, morphoMarket, toAssetsDown, toAssetsUp,
  call, sha256, evmObservation, MORPHO_BLUE, type EvmNet,
} from './adapters';
import { accountReport, amendmentEnabled, borrowerLoans, validatedLedger, xrplNetworkIdentity } from './xrpl-read';
import { runXrplLoanPay, xrplLoanPayError, xrplLoanPayReadiness } from './xrpl-loan-pay';
import { lendingRates, ratesConfigFromEnv, type RatesConfig } from './rates';
import type { Header } from '../evm';

/** Operations the worker accepts on /research/finance, per stage. R2+ stays spec-only. */
export const FINANCE_OPERATIONS = ['capabilities', 'positions', 'job', 'status', 'lending-rates', 'xrpl-loan-pay-preview', 'xrpl-loan-pay-verify'] as const;
export type FinanceOperation = typeof FINANCE_OPERATIONS[number];
export const POSITIONS_JOB = 'finance:positions';

export type FinanceOptions = {
  repo: Repository;
  endpoints: Partial<Record<'arbitrum' | 'base' | 'robinhood' | 'xrpl' | 'flare', string>>;
  fetcher?: typeof fetch;
  clock?: () => number;
  rates?: RatesConfig;
  xrplLoanPay?: boolean;
  inlineWaitMs?: number;
  capabilityTtlMs?: number;
};
type Envelope = { requestId: string; network: FinanceNetwork };
type Missing = { capability: string; reasonCode: string };

const LEGACY_TO_FINANCE: Record<string, FinanceErrorCode> = {
  NOT_FOUND: 'NOT_FOUND', IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT', STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE', QUEUE_FULL: 'POLICY_REJECTED',
  AUTH_REQUIRED: 'AUTH_REQUIRED', CANCELLED: 'DEPENDENCY_TIMEOUT', DEADLINE_OR_CANCELLATION: 'DEPENDENCY_TIMEOUT', WORKER_RESTARTED: 'DEPENDENCY_TIMEOUT',
};
export function toFinanceError(e: unknown): FinanceError {
  if (e instanceof FinanceError) return e;
  if (e instanceof ResearchError) return new FinanceError(LEGACY_TO_FINANCE[e.code] ?? (e.retryable ? 'DEPENDENCY_TIMEOUT' : 'COVERAGE_INCOMPLETE'), e.message);
  return new FinanceError('DEPENDENCY_TIMEOUT', 'A dependency failed; retry with the same idempotency key.');
}
const iso = (ms: number) => new Date(ms).toISOString();

export class FinanceService {
  private readonly clock: () => number;
  private readonly evm: Partial<Record<EvmNet, FinanceEvmReader>> = {};
  private readonly xrpl?: XrplReader;
  private readonly rates: RatesConfig;
  private capabilityCache?: { expires: number; rows: Record<string, unknown>[] };
  constructor(readonly options: FinanceOptions) {
    this.clock = options.clock ?? Date.now;
    for (const net of ['arbitrum', 'base', 'flare'] as const) {
      const url = options.endpoints[net];
      if (url) this.evm[net] = new FinanceEvmReader(new JsonClient(url, options.fetcher, 5000), net);
    }
    if (options.endpoints.xrpl) this.xrpl = new XrplReader(new JsonClient(options.endpoints.xrpl, options.fetcher, 5000));
    this.rates = options.rates ?? ratesConfigFromEnv();
  }

  // ── Envelopes ──────────────────────────────────────────────────────────────
  private respond(env: Envelope, kind: string, data: unknown, status = 'success', warnings: string[] = [], errors: unknown[] = []) {
    const response = { schemaVersion: 'finance.response/1', contractDigest: FINANCE_CONTRACT_DIGEST, requestId: env.requestId, network: env.network, warnings, execution: false, status, kind, data, errors };
    const issues = semanticIssues(data, env.network);
    if (issues.length) throw new Error('finance response failed semantic validation at ' + issues[0].path);
    assertWireResponse(response, 'finance');
    return response;
  }
  errorResponse(env: Envelope, error: FinanceError) {
    const status = error.code === 'FEATURE_STATE_UNKNOWN' || error.code === 'DEPENDENCY_TIMEOUT' ? 'unknown' : error.retryable ? 'failed' : 'blocked';
    return this.respond(env, 'error', null, status, [], [error.toWire()]);
  }

  /** Validates raw input exactly as the gateway did (defence in depth) and dispatches. */
  async dispatch(owner: string, operation: FinanceOperation, raw: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!owner || owner === 'anonymous' || owner.length > 256) throw new FinanceError('AUTH_REQUIRED', 'An authenticated owner is required.');
    if (operation === 'xrpl-loan-pay-preview' || operation === 'xrpl-loan-pay-verify') {
      try {
        if (!this.options.xrplLoanPay) throw new FinanceError('FEATURE_DISABLED', 'XRPL LoanPay tools are disabled.');
        if (!this.xrpl) throw new FinanceError('CAPABILITY_UNAVAILABLE', 'No Finance XRPL provider is configured.');
        return await runXrplLoanPay(this.xrpl, operation, raw, signal);
      } catch (error) { return xrplLoanPayError(operation, raw, toFinanceError(error)); }
    }
    if (operation === 'lending-rates') {
      const checked = validateRates('RatesRequest', raw);
      if (!checked.ok) throw new FinanceError('INVALID_INPUT', 'Invalid lending-rates request at ' + checked.issues[0].path);
      if (checked.value.ratesContractDigest !== RATES_CONTRACT_DIGEST) throw new FinanceError('CONTRACT_MISMATCH', `Use ratesContractDigest ${RATES_CONTRACT_DIGEST} (from finance_get_capabilities_v1 warnings).`);
      return lendingRates(checked.value, { evm: this.evm, xrpl: this.xrpl, config: this.rates, clock: this.clock }, signal);
    }
    const checked = validateFinance('Request', raw);
    if (!checked.ok) throw new FinanceError('INVALID_INPUT', 'Invalid finance request at ' + checked.issues[0].path);
    const request = checked.value as Record<string, any>;
    if (request.operation !== operation) throw new FinanceError('INVALID_INPUT', 'Request operation does not match the selected tool.');
    const env: Envelope = { requestId: request.requestId, network: request.network };
    const issues = semanticIssues(request, request.network);
    if (issues.length) return this.errorResponse(env, new FinanceError(issues[0].keyword === 'chainMismatch' ? 'WRONG_CHAIN' : 'INVALID_INPUT', 'Request failed semantic validation at ' + issues[0].path));
    if (operation !== 'capabilities' && request.contractDigest !== FINANCE_CONTRACT_DIGEST) return this.errorResponse(env, new FinanceError('CONTRACT_MISMATCH', `Use contractDigest ${FINANCE_CONTRACT_DIGEST} from finance_get_capabilities_v1.`));
    try {
      switch (operation) {
        case 'capabilities': {
          const warnings = [`ratesContractDigest:${RATES_CONTRACT_DIGEST}`];
          if (env.network === 'xrpl' && this.options.xrplLoanPay) {
            const readiness = await (this.xrpl ? xrplLoanPayReadiness(this.xrpl, signal).catch(() => null) : null);
            warnings.push('xrplLoanPay:' + (readiness?.environment ?? 'unknown') + ':' + (readiness?.state ?? 'unknown'));
          }
          return this.respond(env, 'capabilities', (await this.capabilities(signal)).filter((c) => c.network === env.network), 'success', warnings);
        }
        case 'positions': return await this.positions(owner, request, env, signal);
        case 'job': return await this.job(owner, request, env);
        case 'status': return await this.status(owner, request, env);
      }
    } catch (e) { return this.errorResponse(env, toFinanceError(e)); }
    throw new FinanceError('INVALID_INPUT', 'Unknown finance operation.');
  }

  // ── Capabilities (TTL-bound, per-operation; never self-authorises execution) ──
  async capabilities(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const now = this.clock();
    if (this.capabilityCache && this.capabilityCache.expires > now) return this.capabilityCache.rows;
    const ttl = this.options.capabilityTtlMs ?? 60_000;
    const evidence = (probe: unknown) => [{ id: sha256(probe), contentHash: sha256({ probe, at: now }), expiresAt: iso(now + ttl) }];
    const row = (network: string, operation: string, stage: string, reasonCode: string | null, protocol: string | null = null, probe: unknown = { network, operation }) =>
      ({ network, operation, protocol, stage, authority: 'service', reasonCode, observedAt: iso(now), expiresAt: iso(now + ttl), evidence: evidence(probe) });
    const probeEvm = async (net: 'arbitrum' | 'base') => { try { await this.evm[net]?.header(signal); return Boolean(this.evm[net]); } catch { return false; } };
    const [arb, bas] = await Promise.all([probeEvm('arbitrum'), probeEvm('base')]);
    let xrplOk = false, lending: boolean | null = null;
    if (this.xrpl) { try { await validatedLedger(this.xrpl, signal); xrplOk = true; lending = await amendmentEnabled(this.xrpl, 'LendingProtocol', signal); } catch { xrplOk = false; } }
    const writes = ['earn', 'withdraw', 'borrow', 'repay', 'protect', 'flash'];
    const rows: Record<string, unknown>[] = [];
    for (const [net, ok] of [['arbitrum', arb], ['base', bas]] as const) {
      const aave = Boolean(this.rates.aaveProviders[net]);
      rows.push(row(net, 'portfolio', ok ? 'READ_VERIFIED' : 'UNKNOWN', ok ? null : 'PROVIDER_UNAVAILABLE'));
      rows.push(row(net, 'positions', ok && aave ? 'READ_VERIFIED' : 'UNKNOWN', ok ? (aave ? null : 'MARKET_NOT_ADMITTED') : 'PROVIDER_UNAVAILABLE', net === 'base' ? 'aave-v3,morpho-blue' : 'aave-v3'));
      for (const op of writes) rows.push(row(net, op, 'UNSUPPORTED', 'STAGE_R1_READ_ONLY'));
      rows.push(row(net, 'prediction-research', net === 'base' ? 'DOCUMENTED' : 'UNSUPPORTED', net === 'base' ? 'INDEPENDENT_PREDICTION_RUNTIME' : 'NO_PREDICTION_VENUE', net === 'base' ? 'limitless' : null));
      rows.push(row(net, 'prediction-prepare', 'UNSUPPORTED', 'STAGE_R1_READ_ONLY'));
    }
    rows.push(row('robinhood', 'portfolio', 'DOCUMENTED', 'DISCOVERY_ONLY'));
    rows.push(row('robinhood', 'positions', 'UNSUPPORTED', 'ROBINHOOD_LENDER_UNVERIFIED'));
    for (const op of [...writes, 'prediction-research', 'prediction-prepare']) rows.push(row('robinhood', op, 'UNSUPPORTED', op.startsWith('prediction') ? 'NO_PREDICTION_VENUE' : 'ROBINHOOD_LENDER_UNVERIFIED'));
    rows.push(row('xrpl', 'portfolio', xrplOk ? 'READ_VERIFIED' : 'UNKNOWN', xrplOk ? null : 'PROVIDER_UNAVAILABLE', 'xrpl-native'));
    rows.push(row('xrpl', 'positions', lending === true ? 'READ_VERIFIED' : xrplOk ? 'UNKNOWN' : 'UNKNOWN', lending === true ? null : 'FEATURE_STATE_UNKNOWN', 'xls-66'));
    for (const op of writes) rows.push(row('xrpl', op, 'UNSUPPORTED', op === 'flash' ? 'NO_NATIVE_FLASH_LENDER' : 'NATIVE_CREDIT_WRITES_OUT_OF_V1'));
    for (const op of ['prediction-research', 'prediction-prepare']) rows.push(row('xrpl', op, 'UNSUPPORTED', 'NO_PREDICTION_VENUE'));
    this.capabilityCache = { expires: now + ttl, rows };
    return rows;
  }

  // ── Positions: owned job + bounded inline wait ─────────────────────────────
  private async positions(owner: string, request: Record<string, any>, env: Envelope, signal?: AbortSignal) {
    if (env.network === 'robinhood') throw new FinanceError('CAPABILITY_UNAVAILABLE', 'Robinhood positions are not admitted: lender/adapter not independently verified.');
    if (env.network === 'xrpl' ? !this.xrpl : !this.evm[env.network as EvmNet]) throw new FinanceError('CAPABILITY_UNAVAILABLE', `No ${env.network} provider is configured.`);
    if (request.account.family === 'evm') request.account.address = normalizeEvmAddress(request.account.address);
    const job = await this.options.repo.enqueue(owner, POSITIONS_JOB as Operation, { idempotency_key: request.idempotency_key, request });
    const waitUntil = this.clock() + (this.options.inlineWaitMs ?? Math.min(7000, Number(process.env.FINANCE_INLINE_WAIT_MS ?? 7000)));
    let current = job;
    while (['QUEUED', 'RUNNING'].includes(current.state) && this.clock() < waitUntil && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 150));
      current = await this.options.repo.get(owner, job.id);
    }
    if (current.state === 'SUCCEEDED' && current.result_id) return this.fromArtifact(owner, current.result_id, env);
    return this.respond(env, 'job', this.jobView(current));
  }
  private jobView(job: { id: string; state: string; created_at: string; result_id?: string; error?: { code: string; message: string; retryable: boolean } }) {
    return {
      jobId: job.id, state: job.state, operation: 'positions', createdAt: iso(Date.parse(job.created_at)), resultRef: job.result_id ?? null,
      error: job.error ? toFinanceError(new ResearchError(job.error.code, job.error.message, job.error.retryable)).toWire() : null,
    };
  }
  private async fromArtifact(owner: string, ref: string, env: Envelope) {
    const artifact = await this.options.repo.artifact(owner, ref);
    if (artifact.kind !== 'finance-positions') throw new FinanceError('NOT_FOUND', 'No Finance artifact exists under this reference.');
    const data = artifact.data as { network: FinanceNetwork; report: Record<string, any>; warnings: string[] };
    if (data.network !== env.network) throw new FinanceError('WRONG_CHAIN', 'Artifact belongs to a different network.');
    return this.respond(env, 'positions', data.report, data.report.coverage.complete ? 'success' : 'partial', data.warnings);
  }
  private async job(owner: string, request: Record<string, any>, env: Envelope) {
    const job = request.mode === 'cancel' ? await this.options.repo.cancel(owner, request.jobId) : await this.options.repo.get(owner, request.jobId);
    if (job.operation !== POSITIONS_JOB) throw new FinanceError('NOT_FOUND', 'Finance job not found.');
    return this.respond(env, 'job', this.jobView(job));
  }
  private async status(owner: string, request: Record<string, any>, env: Envelope) {
    return this.fromArtifact(owner, request.artifactRef, env);
  }

  /** Worker job execution for finance:positions. Returns an artifact payload. */
  async executePositions(job: StoredJob, signal: AbortSignal): Promise<{ kind: string; data: Record<string, unknown> }> {
    const request = (job.input as { request: Record<string, any> }).request;
    const network = request.network as FinanceNetwork;
    const report = network === 'xrpl' ? await this.xrplReport(request, signal) : await this.evmReport(network as 'arbitrum' | 'base', request, signal);
    semanticIssues(report.report, network).forEach((i) => { throw new FinanceError('COVERAGE_INCOMPLETE', 'Report failed semantic validation at ' + i.path); });
    return { kind: 'finance-positions', data: { network, report: report.report, warnings: report.warnings } };
  }

  private async evmReport(network: 'arbitrum' | 'base', request: Record<string, any>, signal: AbortSignal) {
    const reader = this.evm[network]!;
    const user: string = request.account.address;
    const block = await reader.header(signal);
    const observation = evmObservation(network, block, this.clock(), 60_000, { network, report: 'positions' });
    const missing: Missing[] = []; const warnings: string[] = []; const positions: Record<string, unknown>[] = []; const balances: Record<string, unknown>[] = [];
    if (request.account.model === 'smart-account') warnings.push('Smart-account positions are read only; no module authority is inferred.');
    if (request.scope !== 'lending') {
      try { const wei = await reader.rpc.rpc<string>('eth_getBalance', [user, { blockHash: block.hash, requireCanonical: true }], signal); balances.push({ asset: { kind: 'evm-native', network, decimals: 18 }, quantity: { kind: 'atomic', value: BigInt(wei).toString() } }); }
      catch { missing.push({ capability: `${network}.native-balance`, reasonCode: 'DEPENDENCY_TIMEOUT' }); }
    }
    if (request.scope !== 'portfolio') {
      const provider = this.rates.aaveProviders[network];
      if (!provider) missing.push({ capability: `${network}.aave-v3`, reasonCode: 'MARKET_NOT_ADMITTED' });
      else {
        try {
          const pool = await aavePool(reader, provider, block, signal);
          const reserves = await aaveReserves(reader, pool, block, signal);
          const acct = await aaveAccount(reader, pool, user, block, signal);
          const held = (await aaveBalances(reader, reserves, user, block, signal)).filter((b) => (b.supplied ?? 0n) > 0n || (b.debt ?? 0n) > 0n);
          if (acct.eMode !== 0n) missing.push({ capability: `${network}.aave-v3.emode`, reasonCode: 'UNSUPPORTED_MODE' });
          const asset = (r: { asset: string; decimals: number }) => ({ kind: 'erc20', network, address: r.asset, decimals: r.decimals });
          const amt = (r: { asset: string; decimals: number }, v: bigint) => ({ asset: asset(r), quantity: { kind: 'atomic', value: v.toString() } });
          if (held.length || acct.debtBase > 0n || acct.collateralBase > 0n) {
            const noDebt = acct.debtBase === 0n;
            positions.push({
              kind: 'evm-collateralized', positionId: sha256({ protocol: 'aave-v3', network, pool, user, block: block.hash }), account: request.account, protocol: 'aave-v3',
              deploymentRef: sha256({ network, provider, pool }), marketId: pool,
              supplied: held.filter((b) => (b.supplied ?? 0n) > 0n && !isCollateral(acct.userConfig, b.reserve.id)).map((b) => amt(b.reserve, b.supplied!)),
              shareEvidence: [],
              collateral: held.filter((b) => (b.supplied ?? 0n) > 0n && isCollateral(acct.userConfig, b.reserve.id)).map((b) => amt(b.reserve, b.supplied!)),
              debt: held.filter((b) => (b.debt ?? 0n) > 0n).map((b) => amt(b.reserve, b.debt!)),
              noDebt, healthFactor: noDebt ? null : healthFactorDecimal(acct.healthFactor),
              ltv: acct.collateralBase > 0n ? rayToDecimal((acct.debtBase * 10n ** 27n) / acct.collateralBase, 4) : null,
              liquidationThreshold: acct.liquidationThresholdBps > 0n ? rayToDecimal(acct.liquidationThresholdBps * 10n ** 23n, 4) : null,
              observation,
            });
          }
        } catch (e) { missing.push({ capability: `${network}.aave-v3`, reasonCode: toFinanceError(e).code }); }
      }
      if (network === 'base') for (const id of this.rates.morphoMarkets.base ?? []) {
        try { const p = await this.morphoPosition(reader, id, user, block, request.account, observation, signal); if (p) positions.push(p); }
        catch (e) { missing.push({ capability: 'base.morpho-blue:' + id.slice(0, 10), reasonCode: toFinanceError(e).code }); }
      }
    }
    return { report: { account: request.account, observation, balances, reservedXrp: null, positions: positions.slice(0, request.limit), coverage: { complete: missing.length === 0, missing, cursor: null } }, warnings };
  }
  private async morphoPosition(reader: FinanceEvmReader, id: string, user: string, block: Header, account: unknown, observation: unknown, signal: AbortSignal) {
    const m = await morphoMarket(reader, id, block, signal);
    const [pos, loanDec, colDec, price] = await reader.multi([call(MORPHO_BLUE, 'position(bytes32,address)', [id, user]), call(m.loanToken, 'decimals()'), call(m.collateralToken, 'decimals()'), call(m.oracle, 'price()')], block, signal);
    if (!pos || !loanDec || !colDec) throw new FinanceError('COVERAGE_INCOMPLETE', 'Morpho position data unavailable.');
    const w = pos.slice(2).match(/.{64}/g)!.map((x) => BigInt('0x' + x));
    const [supplyShares, borrowShares, collateral] = w;
    if (supplyShares === 0n && borrowShares === 0n && collateral === 0n) return null;
    const loanAsset = { kind: 'erc20', network: 'base', address: m.loanToken, decimals: Number(BigInt(loanDec)) };
    const colAsset = { kind: 'erc20', network: 'base', address: m.collateralToken, decimals: Number(BigInt(colDec)) };
    const borrowAssets = toAssetsUp(borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
    const supplyAssets = toAssetsDown(supplyShares, m.totalSupplyAssets, m.totalSupplyShares);
    const shareModelRef = sha256('morpho-blue/shares-math/virtual-shares-1e6-virtual-assets-1');
    let healthFactor: string | null = null;
    if (borrowAssets > 0n && price) { const maxBorrow = (collateral * BigInt(price.slice(0, 66)) / 10n ** 36n) * m.lltv / 10n ** 18n; healthFactor = rayToDecimal((maxBorrow * 10n ** 27n) / borrowAssets, 4); }
    return {
      kind: 'evm-collateralized', positionId: sha256({ protocol: 'morpho-blue', id, user, block: block.hash }), account, protocol: 'morpho-blue',
      deploymentRef: sha256({ network: 'base', morpho: MORPHO_BLUE, id }), marketId: id,
      supplied: supplyAssets > 0n ? [{ asset: loanAsset, quantity: { kind: 'atomic', value: supplyAssets.toString() } }] : [],
      shareEvidence: [
        ...(supplyShares > 0n ? [{ role: 'supply', asset: loanAsset, raw: supplyShares.toString(), shareModelRef }] : []),
        ...(borrowShares > 0n ? [{ role: 'borrow', asset: loanAsset, raw: borrowShares.toString(), shareModelRef }] : []),
      ],
      collateral: collateral > 0n ? [{ asset: colAsset, quantity: { kind: 'atomic', value: collateral.toString() } }] : [],
      debt: borrowAssets > 0n ? [{ asset: loanAsset, quantity: { kind: 'atomic', value: borrowAssets.toString() } }] : [],
      noDebt: borrowAssets === 0n, healthFactor: borrowAssets === 0n ? null : healthFactor, ltv: null,
      liquidationThreshold: rayToDecimal(m.lltv * 10n ** 9n, 4), observation,
    };
  }
  private async xrplReport(request: Record<string, any>, signal: AbortSignal) {
    const reader = this.xrpl!;
    const ledger = await validatedLedger(reader, signal);
    const identity = await xrplNetworkIdentity(reader, signal);
    const now = this.clock();
    const observation = { network: 'xrpl', networkIdentityHash: identity, point: { kind: 'xrpl-ledger', index: String(ledger.index), hash: ledger.hash, validated: true }, observedAt: iso(now), expiresAt: iso(now + 60_000), consistency: 'pinned', fidelity: 'chain-read', sources: [{ id: sha256({ xrpl: ledger.hash }), contentHash: sha256({ ledger }), expiresAt: iso(now + 60_000) }] };
    const missing: Missing[] = []; let balances: unknown[] = []; let reservedXrp: unknown = null; const positions: unknown[] = []; const warnings: string[] = [];
    if (request.scope !== 'lending') {
      const acct = await accountReport(reader, request.account.address, ledger, request.limit, signal);
      balances = acct.balances; reservedXrp = acct.reservedXrp; missing.push(...acct.missing);
      warnings.push(`spendable XRP after reserve: ${acct.spendableDrops < 0n ? '0' : acct.spendableDrops.toString()} drops`);
    }
    if (request.scope !== 'portfolio') {
      const lending = await amendmentEnabled(reader, 'LendingProtocol', signal);
      if (lending !== true) missing.push({ capability: 'xrpl.loans', reasonCode: 'FEATURE_STATE_UNKNOWN' });
      else { const l = await borrowerLoans(reader, request.account.address, ledger, request.account, observation, request.limit, signal); positions.push(...l.loans); missing.push(...l.missing); }
    }
    return { report: { account: request.account, observation, balances, reservedXrp, positions: positions.slice(0, request.limit), coverage: { complete: missing.length === 0, missing, cursor: null } }, warnings };
  }
}
