import { ResearchError, hash, type Input, type XrplAsset } from './contracts';
import { JsonClient } from './transport';

type Fraction = { n: bigint; d: bigint };
export function decimal(value: string): Fraction {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > 100 || Math.abs(Number(match[4] ?? 0)) > 80) throw new ResearchError('INVALID_DECIMAL', 'Invalid bounded XRPL decimal.');
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0); const n = BigInt((match[1] ?? '') + match[2] + (match[3] ?? ''));
  return scale >= 0 ? { n, d: 10n ** BigInt(scale) } : { n: n * 10n ** BigInt(-scale), d: 1n };
}
function add(a: Fraction, b: Fraction): Fraction { return { n: a.n * b.d + b.n * a.d, d: a.d * b.d }; }
function mul(a: Fraction, b: Fraction): Fraction { return { n: a.n * b.n, d: a.d * b.d }; }
function div(a: Fraction, b: Fraction): Fraction { if (b.n <= 0n) throw new ResearchError('INVALID_LIQUIDITY', 'Nonpositive XRPL liquidity.'); return { n: a.n * b.d, d: a.d * b.n }; }
function less(a: Fraction, b: Fraction) { return a.n * b.d < b.n * a.d; }
export function decimalText(value: Fraction, precision = 16): string {
  if (value.n === 0n) return '0';
  const negative = value.n < 0n, numerator = negative ? -value.n : value.n;
  let exponent = numerator.toString().length - value.d.toString().length;
  if (exponent >= 0 ? numerator < value.d * 10n ** BigInt(exponent) : numerator * 10n ** BigInt(-exponent) < value.d) exponent--;
  const places = Math.max(0, precision - 1 - exponent);
  if (places > 100) throw new ResearchError('DECIMAL_RANGE', 'XRPL decimal exceeds supported precision range.');
  const scaled = numerator * 10n ** BigInt(places) / value.d;
  const digits = scaled.toString().padStart(places + 1, '0');
  const text = places ? (digits.slice(0, -places) + '.' + digits.slice(-places)).replace(/\.?0+$/, '') : digits;
  return (negative ? '-' : '') + text;
}
function currencyKey(currency: string): string { return currency.length === 40 ? currency.toUpperCase() : currency; }
export function assetKey(a: XrplAsset): string { return a.kind === 'xrp' ? 'XRP' : currencyKey(a.currency) + ':' + a.issuer; }
function wireAsset(a: XrplAsset) { return a.kind === 'xrp' ? { currency: 'XRP' } : { currency: a.currency, issuer: a.issuer }; }
function amount(value: unknown): { asset: string; amount: Fraction } {
  if (typeof value === 'string') return { asset: 'XRP', amount: div(decimal(value), decimal('1000000')) };
  const a = value as { currency?: string; issuer?: string; value?: string };
  if (!a || typeof a.value !== 'string' || !a.currency || !a.issuer) throw new ResearchError('INVALID_RESPONSE', 'Invalid XRPL amount.');
  return { asset: currencyKey(a.currency) + ':' + a.issuer, amount: decimal(a.value) };
}
export type XrplEdge = { id: string; venue?: string; kind: 'amm' | 'book'; from: string; to: string; reserve_in?: string; reserve_out?: string; fee_units?: number; offers?: Array<{ input: string; output: string }>; restrictions: string[] };
export type XrplSnapshot = { network: 'xrpl'; ledger_hash: string; ledger_index: number; funding: Input<'xrpl_discover_arbitrage_routes'>['funding']; edges: XrplEdge[]; balances: Record<string, string>; account_evidence?: unknown; warnings: string[]; estimate_only: true };
export function quoteXrpl(edge: XrplEdge, input: string): string {
  let quantity = decimal(input); if (quantity.n < 0n) throw new ResearchError('INVALID_AMOUNT', 'Negative input.');
  if (edge.kind === 'amm') {
    const net = mul(quantity, { n: BigInt(100000 - edge.fee_units!), d: 100000n });
    return decimalText(div(mul(decimal(edge.reserve_out!), net), add(decimal(edge.reserve_in!), net)));
  }
  let total = decimal('0');
  for (const offer of edge.offers ?? []) {
    const capacity = decimal(offer.input); const used = less(quantity, capacity) ? quantity : capacity;
    total = add(total, mul(used, div(decimal(offer.output), capacity)));
    quantity = add(quantity, { n: -used.n, d: used.d }); if (quantity.n === 0n) return decimalText(total);
  }
  if (quantity.n > 0n) throw new ResearchError('INSUFFICIENT_BOOK_DEPTH', 'Quote exceeds loaded funded order-book depth.');
  return decimalText(total);
}
export function xrplCycles(snapshot: XrplSnapshot) {
  const started = performance.now(); let timeLimited = false;
  const routes: Array<{ id: string; funding_asset: string; input: string; estimated_output: string; estimated_profit: string; edges: string[]; status: 'ESTIMATE_ONLY' }> = [];
  let evaluations = 0;
  for (const [fundingAsset, balance] of Object.entries(snapshot.balances)) {
    const principal = decimalText(div(decimal(balance), decimal('10')));
    if (decimal(principal).n <= 0n) continue;
    const walk = (token: string, amountIn: string, hops: XrplEdge[], venues: Set<string>) => {
      if (hops.length >= 4 || evaluations >= 2000 || routes.length >= 100) return;
      for (const edge of snapshot.edges) {
        if (performance.now() - started >= 5000) { timeLimited = true; return; }
        if (edge.from !== token || edge.restrictions.length || venues.has(edge.venue ?? edge.id)) continue;
        evaluations++;
        try {
          const output = quoteXrpl(edge, amountIn); const path = [...hops, edge];
          if (edge.to === fundingAsset && path.length >= 2) {
            const profit = add(decimal(output), { n: -decimal(principal).n, d: decimal(principal).d });
            routes.push({ id: hash(path.map((h) => h.id)), funding_asset: fundingAsset, input: principal, estimated_output: output, estimated_profit: decimalText(profit), edges: path.map((h) => h.id), status: 'ESTIMATE_ONLY' });
          } else if (!hops.some((h) => h.from === edge.to)) walk(edge.to, output, path, new Set([...venues, edge.venue ?? edge.id]));
        } catch (e) { if (!(e instanceof ResearchError)) throw e; }
        if (evaluations >= 2000 || routes.length >= 100) break;
      }
    };
    walk(fundingAsset, principal, [], new Set());
  }
  return { routes, evaluations, complete: !timeLimited && evaluations < 2000 && routes.length < 100, time_budget_ms: 5000, time_limited: timeLimited, assumptions: ['Sizing samples 10% of declared available balances; no optimality claim.', 'Network and issuer transfer costs are not included in estimated_profit.', 'Each route uses distinct liquidity venues; multi-transaction atomicity is unproven.'] };
}
export class XrplReader {
  constructor(readonly rpc: JsonClient) {}
  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    const value = await this.rpc.rpc<Record<string, any>>(method, [params], signal);
    if (value.status === 'error' || value.error) throw new ResearchError('XRPL_METHOD_FAILED', `XRPL ${method} failed (${String(value.error ?? 'invalid response').slice(0, 80)}).`);
    return value;
  }
  async discover(input: Input<'xrpl_discover_arbitrage_routes'>, signal?: AbortSignal): Promise<XrplSnapshot> {
    const ledger = await this.call('ledger', { ledger_index: 'validated', transactions: false, expand: false }, signal);
    const ledgerHash = ledger.ledger_hash ?? ledger.ledger?.ledger_hash; const index = Number(ledger.ledger_index ?? ledger.ledger?.ledger_index);
    if (!ledgerHash || !index || ledger.validated === false) throw new ResearchError('INVALID_SNAPSHOT', 'A validated ledger identity is required.');
    const read = async (method: string, args: Record<string, unknown>) => {
      const data = await this.call(method, { ...args, ledger_hash: ledgerHash }, signal);
      if (data.ledger_hash !== ledgerHash) throw new ResearchError('MIXED_SNAPSHOT', 'XRPL response does not match the requested ledger.'); return data;
    };
    const edges: XrplEdge[] = [], warnings: string[] = ['XRPL market quotes are estimates; issuer transfer rules and transaction semantics require native simulation.'];
    const assets = [...new Map(input.assets.map((a) => [assetKey(a), a])).values()];
    for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) {
      const a = assets[i], b = assets[j];
      try {
        const result = await read('amm_info', { asset: wireAsset(a), asset2: wireAsset(b), ...(input.funding.mode === 'account' ? { account: input.funding.account } : {}) });
        const amm = result.amm; const left = amount(amm.amount), right = amount(amm.amount2);
        const fee = Number(amm.trading_fee);
        if (!Number.isInteger(fee) || fee < 0 || fee > 1000) throw new ResearchError('INVALID_RESPONSE', 'Invalid native AMM trading fee.');
        const restrictions = [amm.asset_frozen ? left.asset + ':frozen' : '', amm.asset2_frozen ? right.asset + ':frozen' : ''].filter(Boolean);
        for (const [from, to] of [[left, right], [right, left]]) edges.push({ id: hash({ amm: amm.account, from: from.asset, to: to.asset }), venue: 'amm:' + amm.account, kind: 'amm', from: from.asset, to: to.asset, reserve_in: decimalText(from.amount), reserve_out: decimalText(to.amount), fee_units: fee, restrictions });
        if (amm.auction_slot) warnings.push('Auction-slot discounts are reported by native simulation; estimate conservatively uses the undiscounted fee.');
      } catch (e) { if (e instanceof ResearchError && e.code === 'XRPL_METHOD_FAILED') warnings.push(`AMM unavailable: ${assetKey(a)}/${assetKey(b)}`); else throw e; }
      for (const [from, to] of [[a, b], [b, a]]) {
        const book = await read('book_offers', { taker_gets: wireAsset(to), taker_pays: wireAsset(from), limit: 200 });
        const offers: Array<{ input: string; output: string }> = [];
        for (const o of book.offers ?? []) {
          const inputAmount = amount(o.taker_pays_funded ?? o.TakerPays), outputAmount = amount(o.taker_gets_funded ?? o.TakerGets);
          if (inputAmount.asset !== assetKey(from) || outputAmount.asset !== assetKey(to) || inputAmount.amount.n <= 0n || outputAmount.amount.n <= 0n) continue;
          // Never assume a fully funded offer where the node supplied less owner funding.
          if (o.owner_funds !== undefined && less(decimal(String(o.owner_funds)), (to.kind === 'xrp' ? mul(outputAmount.amount, decimal('1000000')) : outputAmount.amount)) && o.taker_gets_funded === undefined) continue;
          offers.push({ input: decimalText(inputAmount.amount), output: decimalText(outputAmount.amount) });
        }
        edges.push({ id: hash({ book: [assetKey(from), assetKey(to)] }), venue: 'book:' + [assetKey(from), assetKey(to)].sort().join('/'), kind: 'book', from: assetKey(from), to: assetKey(to), offers, restrictions: [] });
        if ((book.offers?.length ?? 0) >= 200) warnings.push('Order-book depth is capped at 200 offers; quotes beyond it are rejected.');
      }
    }
    const balances: Record<string, string> = {}; let accountEvidence: unknown;
    if (input.funding.mode === 'hypothetical') for (const b of input.funding.balances) balances[assetKey(b.asset)] = b.amount;
    else {
      const [info, lines] = await Promise.all([read('account_info', { account: input.funding.account }), read('account_lines', { account: input.funding.account, limit: 400 })]);
      accountEvidence = { account: info.account_data, lines: lines.lines, ledger_hash: ledgerHash };
      // Reserve settings must belong to the exact same validated ledger, never a newer head.
      try {
        const state = await this.call('server_state', {}, signal); const settings = state.state?.validated_ledger;
        if (settings?.hash !== ledgerHash || settings.reserve_base === undefined || settings.reserve_inc === undefined) throw new ResearchError('UNKNOWN_RESERVES', 'Reserve settings do not match the account snapshot.');
        const spendable = BigInt(info.account_data.Balance) - BigInt(settings.reserve_base) - BigInt(settings.reserve_inc) * BigInt(info.account_data.OwnerCount);
        if (spendable > 0n) balances.XRP = decimalText({ n: spendable, d: 1000000n });
      } catch { warnings.push('XRP spendable balance is unknown: reserve settings were unavailable at the account snapshot; native simulation checks reserves.'); }
      if (lines.marker) warnings.push('Trust-line response is incomplete; unavailable balances remain unknown.');
      for (const line of lines.lines ?? []) {
        if (!assets.some((a) => assetKey(a) === currencyKey(line.currency) + ':' + line.account)) continue;
        if (line.freeze || line.freeze_peer || decimal(String(line.balance)).n <= 0n) continue;
        const issuer = await read('account_info', { account: line.account });
        const flags = Number(issuer.account_data.Flags);
        if (flags & 0x00400000 || flags & 0x00040000 && !line.peer_authorized) continue;
        balances[currencyKey(line.currency) + ':' + line.account] = line.balance;
        if (issuer.account_data.TransferRate && issuer.account_data.TransferRate !== 1000000000) warnings.push(`Issuer transfer rate for ${line.currency}:${line.account} requires native simulation; quote profit excludes issuer charges.`);
      }
    }
    return { network: 'xrpl', ledger_hash: ledgerHash, ledger_index: index, funding: input.funding, edges, balances, ...(accountEvidence ? { account_evidence: accountEvidence } : {}), warnings, estimate_only: true };
  }
  async simulate(snapshot: XrplSnapshot, transaction?: Record<string, unknown>, signal?: AbortSignal) {
    if (!transaction) return { status: 'ESTIMATE_ONLY', snapshot_ledger_hash: snapshot.ledger_hash, funding_mode: snapshot.funding.mode, ...xrplCycles(snapshot), warnings: snapshot.warnings, atomicity_proven: false };
    if (snapshot.funding.mode !== 'account') throw new ResearchError('HYPOTHETICAL_ONLY', 'Native RPC simulation cannot apply hypothetical balance overrides.');
    if (transaction.Account !== snapshot.funding.account || !['Payment', 'OfferCreate'].includes(String(transaction.TransactionType))) throw new ResearchError('INVALID_TRANSACTION', 'Native research supports a Payment or OfferCreate from the snapshot account.');
    if (transaction.TxnSignature || transaction.Signers || transaction.SigningPubKey) throw new ResearchError('SIGNED_TRANSACTION', 'Only unsigned native transactions are accepted.');
    const response = await this.call('simulate', { tx_json: transaction, binary: false }, signal);
    if (typeof response.engine_result !== 'string' || !Number.isInteger(response.ledger_index) || response.engine_result === 'tesSUCCESS' && (!response.meta || !response.tx_json)) throw new ResearchError('INVALID_RESPONSE', 'Native simulation omitted required execution context or metadata.');
    return { status: response.engine_result === 'tesSUCCESS' ? 'NATIVE_DRY_RUN' : 'REJECTED', quote_ledger_hash: snapshot.ledger_hash, simulation_context: { ledger_index: response.ledger_index, snapshot_pinned: false }, engine_result: response.engine_result, transaction: response.tx_json, metadata: response.meta, applied: false, atomicity_proven: false, warnings: ['Native simulate uses its own ledger context; this is not a historical snapshot-pinned or flashloan proof.'] };
  }
}
