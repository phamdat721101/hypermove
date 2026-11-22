import type { XrplReader } from '../xrpl';
import { FinanceError, RAY, rayToDecimal } from './contracts';
import { realizedRay, sha256 } from './adapters';

/**
 * Native XRPL reads for Finance. Every read is pinned to ONE validated ledger
 * hash; fees/reserves come from the ledger, never constants. Native loan fields
 * keep native meaning (tenths of a basis point, Ripple epoch, absent LoanScale = null).
 */
export const RIPPLE_EPOCH_OFFSET = 946_684_800;
export type Ledger = { hash: string; index: number; closeTime: number };

export async function validatedLedger(reader: XrplReader, signal?: AbortSignal, index?: number): Promise<Ledger> {
  const r = await reader.call('ledger', { ledger_index: index ?? 'validated', transactions: false, expand: false }, signal);
  const hash = String(r.ledger_hash ?? r.ledger?.ledger_hash ?? '');
  const idx = Number(r.ledger_index ?? r.ledger?.ledger_index);
  const close = Number(r.ledger?.close_time);
  if (!/^[A-Fa-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(idx) || idx <= 0
    || r.validated !== true || (index !== undefined && index !== idx)
    || !Number.isSafeInteger(close) || close < 0) throw new FinanceError('COVERAGE_INCOMPLETE', 'A validated ledger identity and close time are required.');
  return { hash: hash.toUpperCase(), index: idx, closeTime: close };
}
export async function xrplNetworkIdentity(reader: XrplReader, signal?: AbortSignal) {
  const info = await reader.call('server_info', {}, signal);
  return sha256({ family: 'xrpl', networkId: Number(info.info?.network_id ?? 0) });
}
export async function amendmentEnabled(reader: XrplReader, name: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const r = await reader.call('feature', { feature: name }, signal);
    const entry = Object.values(r).find((v): v is { enabled: boolean } => !!v && typeof v === 'object' && 'enabled' in (v as object));
    return entry ? entry.enabled === true : null;
  } catch { return null; }
}
export const rippleToIso = (seconds: number) => new Date((seconds + RIPPLE_EPOCH_OFFSET) * 1000).toISOString();

/** XRPL Number / amount string → {coefficient, exponent}, ≤16 significant digits, canonical zero. */
export function parseXrplNumber(raw: string): { coefficient: string; exponent: number } {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim());
  if (!m) throw new FinanceError('COVERAGE_INCOMPLETE', 'Unparseable native amount.');
  let digits = (m[2] + (m[3] ?? '')).replace(/^0+/, '');
  let exponent = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (!digits) return { coefficient: '0', exponent: 0 };
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
  if (digits.length > 16 || exponent < -96 || exponent > 80) throw new FinanceError('COVERAGE_INCOMPLETE', 'Native amount exceeds issued-decimal precision.');
  return { coefficient: (m[1] && digits ? '-' : '') + digits, exponent };
}
const toRay = (n: { coefficient: string; exponent: number }) => {
  const c = BigInt(n.coefficient);
  return n.exponent >= 0 ? c * 10n ** BigInt(n.exponent) * RAY : (c * RAY) / 10n ** BigInt(-n.exponent);
};

type Amount = { asset: Record<string, unknown>; quantity: Record<string, unknown> };
const xrpAsset = { kind: 'xrp', network: 'xrpl', decimals: 6 } as const;
const drops = (value: string | bigint): Amount => ({ asset: xrpAsset, quantity: { kind: 'atomic', value: String(value) } });

export async function accountReport(reader: XrplReader, address: string, ledger: Ledger, limit: number, signal?: AbortSignal) {
  const pin = { ledger_hash: ledger.hash };
  const info = await reader.call('account_info', { account: address, ...pin }, signal);
  const data = info.account_data;
  if (!data?.Balance) throw new FinanceError('COVERAGE_INCOMPLETE', 'Account not found at the observed ledger.');
  const state = await reader.call('server_state', {}, signal);
  const vl = state.state?.validated_ledger;
  const base = BigInt(String(vl?.reserve_base ?? '')), inc = BigInt(String(vl?.reserve_inc ?? ''));
  const reserved = base + inc * BigInt(Number(data.OwnerCount ?? 0));
  const lines = await reader.call('account_lines', { account: address, limit: Math.min(limit, 100), ...pin }, signal);
  const balances: Amount[] = [drops(String(data.Balance))];
  const missing: Array<{ capability: string; reasonCode: string }> = [];
  for (const line of (lines.lines ?? []).slice(0, Math.max(0, limit - 1))) {
    try {
      const q = parseXrplNumber(String(line.balance));
      const currency = String(line.currency);
      if (currency === 'XRP') continue;
      balances.push({ asset: { kind: 'xrpl-issued', network: 'xrpl', currency, issuer: String(line.account) }, quantity: { kind: 'issued-decimal', ...q } });
    } catch { missing.push({ capability: 'xrpl.trustline', reasonCode: 'UNPARSEABLE_AMOUNT' }); }
  }
  if (lines.marker) missing.push({ capability: 'xrpl.trustlines', reasonCode: 'PAGE_LIMIT' });
  return { balances, reservedXrp: drops(reserved), spendableDrops: BigInt(String(data.Balance)) - reserved, missing };
}

const LOAN_FLAGS: Array<[number, 'defaulted' | 'impaired' | 'overpayment-allowed']> = [[0x00010000, 'defaulted'], [0x00020000, 'impaired'], [0x00040000, 'overpayment-allowed']];
const objectId = /^[a-fA-F0-9]{64}$/;

async function pinnedCreditRead(reader: XrplReader, ledger: Ledger, method: 'account_objects' | 'ledger_entry', params: Record<string, unknown>, signal?: AbortSignal) {
  const response = await reader.call(method, { ...params, ledger_hash: ledger.hash }, signal);
  if (response.validated !== true || response.ledger_index !== ledger.index
    || typeof response.ledger_hash !== 'string' || response.ledger_hash.toUpperCase() !== ledger.hash) {
    throw new FinanceError('COVERAGE_INCOMPLETE', 'Credit object response did not match its validated ledger.');
  }
  return response;
}

export async function readCreditEntry(reader: XrplReader, ledger: Ledger, index: string, type: 'Loan' | 'LoanBroker' | 'Vault', signal?: AbortSignal) {
  if (typeof index !== 'string' || !objectId.test(index)) throw new FinanceError('COVERAGE_INCOMPLETE', 'Invalid credit object ID.');
  const response = await pinnedCreditRead(reader, ledger, 'ledger_entry', { index }, signal);
  const node = response.node;
  const actualId = response.index ?? node?.index;
  if (node?.LedgerEntryType !== type || typeof actualId !== 'string' || actualId.toUpperCase() !== index.toUpperCase()) {
    throw new FinanceError('COVERAGE_INCOMPLETE', 'Credit object type or ID did not match.');
  }
  return node;
}

export async function resolveLoanAsset(reader: XrplReader, ledger: Ledger, brokerId: string, signal?: AbortSignal) {
  const broker = await readCreditEntry(reader, ledger, brokerId, 'LoanBroker', signal);
  const vault = await readCreditEntry(reader, ledger, broker.VaultID, 'Vault', signal);
  return { vaultId: String(broker.VaultID).toUpperCase(), asset: vault.Asset };
}

export const xrplLoanPositionId = (loanId: string, ledgerHash: string) => sha256({ loan: loanId.toUpperCase(), ledger: ledgerHash });

/** Loans for a borrower, joined Loan → LoanBroker → Vault (asset) at the same ledger. */
export async function borrowerLoans(reader: XrplReader, address: string, ledger: Ledger, account: Record<string, unknown>, observation: Record<string, unknown>, limit: number, signal?: AbortSignal) {
  const loans: Record<string, unknown>[] = []; const missing: Array<{ capability: string; reasonCode: string }> = [];
  const seen = new Set<string>();
  const markers = new Set<string>();
  const assets = new Map<string, Awaited<ReturnType<typeof resolveLoanAsset>>>();
  let marker: unknown;
  let cursorIncomplete = false;
  for (let page = 0; page < 4; page++) {
    let response;
    try {
      response = await pinnedCreditRead(reader, ledger, 'account_objects', {
        account: address, type: 'loan', limit: 50, ...(marker !== undefined ? { marker } : {}),
      }, signal);
      if (!Array.isArray(response.account_objects) || response.account_objects.length > 50 || response.account !== address) {
        throw new FinanceError('COVERAGE_INCOMPLETE', 'Invalid borrower directory response.');
      }
    } catch {
      signal?.throwIfAborted();
      missing.push({ capability: 'xrpl.loans', reasonCode: 'DIRECTORY_INCOMPLETE' });
      break;
    }
    for (const loan of response.account_objects) {
      if (loans.length >= limit) { cursorIncomplete = true; break; }
      const loanId = typeof loan?.index === 'string' && objectId.test(loan.index) ? loan.index.toUpperCase() : null;
      if (loan?.LedgerEntryType !== 'Loan' || loan.Borrower !== address || !loanId || seen.has(loanId)) {
        missing.push({ capability: 'xrpl.loans', reasonCode: 'DIRECTORY_INCOMPLETE' });
        continue;
      }
      seen.add(loanId);
      try {
        const brokerId = String(loan.LoanBrokerID).toUpperCase();
        let resolved = assets.get(brokerId);
        if (!resolved) {
          resolved = await resolveLoanAsset(reader, ledger, brokerId, signal);
          assets.set(brokerId, resolved);
        }
        const { asset, vaultId } = resolved;
        const amount = (field: string): Amount => {
          const raw = String(loan[field] ?? '0');
          if (asset === 'XRP' || (asset?.currency === 'XRP' && asset.issuer === undefined)) {
            if (!/^\d+$/.test(raw)) throw new FinanceError('COVERAGE_INCOMPLETE', 'XRP loan amount is not integral drops.');
            return drops(raw);
          }
          if (!asset?.currency || !asset?.issuer) throw new FinanceError('COVERAGE_INCOMPLETE', 'Loan asset is not an issued currency (MPT unsupported in v1).');
          return { asset: { kind: 'xrpl-issued', network: 'xrpl', currency: asset.currency, issuer: asset.issuer }, quantity: { kind: 'issued-decimal', ...parseXrplNumber(raw) } };
        };
        const flags = Number(loan.Flags ?? 0);
        loans.push({
          kind: 'xrpl-loan', positionId: xrplLoanPositionId(loanId, ledger.hash), account,
          loanId, loanBrokerId: brokerId,
          assetResolutionRef: sha256({ broker: brokerId, vault: vaultId, asset, ledger: ledger.hash }),
          principalOutstanding: amount('PrincipalOutstanding'), totalValueOutstanding: amount('TotalValueOutstanding'),
          managementFeeOutstanding: amount('ManagementFeeOutstanding'), periodicPayment: amount('PeriodicPayment'),
          interestRateTenthsBps: Number(loan.InterestRate ?? 0), paymentRemaining: Number(loan.PaymentRemaining ?? 0),
          nextDueAt: loan.NextPaymentDueDate === undefined ? null : rippleToIso(Number(loan.NextPaymentDueDate)),
          gracePeriodSeconds: Number(loan.GracePeriod ?? 0), loanScale: loan.LoanScale === undefined ? null : Number(loan.LoanScale),
          flags: LOAN_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name), observation,
        });
      } catch {
        signal?.throwIfAborted();
        missing.push({ capability: 'xrpl.loan:' + loanId.slice(0, 16), reasonCode: 'JOIN_INCOMPLETE' });
      }
    }
    marker = response.marker ?? undefined;
    if (marker === undefined) break;
    const markerKey = JSON.stringify(marker);
    if (loans.length >= limit || markers.has(markerKey) || page === 3) { cursorIncomplete = true; break; }
    markers.add(markerKey);
  }
  if (cursorIncomplete) missing.push({ capability: 'xrpl.loans', reasonCode: 'PAGE_LIMIT' });
  return { loans, missing };
}

/** Native annual rate: InterestRate is tenths of a basis point → fraction = raw / 100000. */
export const tenthsBpsToFraction = (raw: number) => rayToDecimal((BigInt(raw) * RAY) / 100_000n, 7);

/** Finance Asset for an XLS-65 vault's `Asset` field (XRP or issued currency; MPT assets → null). */
export function xrplAsset(a: { currency?: string; issuer?: string; mpt_issuance_id?: string } | undefined) {
  if (!a || a.currency === 'XRP') return { asset: { kind: 'xrp', network: 'xrpl', decimals: 6 } as Record<string, unknown>, label: 'XRP' };
  if (a.currency && a.issuer) return { asset: { kind: 'xrpl-issued', network: 'xrpl', currency: a.currency, issuer: a.issuer } as Record<string, unknown>, label: a.currency.length === 3 ? a.currency : 'IOU' };
  return { asset: null, label: 'MPT' };
}

/** Observed interest-rate range of a LoanBroker's active loans (loans live under the broker pseudo-account). */
export async function brokerRateRange(reader: XrplReader, brokerId: string, ledger: Ledger, signal?: AbortSignal) {
  const pin = { ledger_hash: ledger.hash };
  const broker = (await reader.call('ledger_entry', { index: brokerId, ...pin }, signal)).node;
  if (!broker?.Account) throw new FinanceError('COVERAGE_INCOMPLETE', 'LoanBroker not found at the observed ledger.');
  const vault = broker.VaultID ? (await reader.call('ledger_entry', { index: broker.VaultID, ...pin }, signal).catch(() => ({ node: null }))).node : null;
  const objs = await reader.call('account_objects', { account: broker.Account, type: 'loan', limit: 100, ...pin }, signal);
  // Absent InterestRate is the native default 0; a pseudo-account can only hold its own broker's loans, but filter anyway.
  const rates = (objs.account_objects ?? []).filter((l: { LoanBrokerID?: string }) => String(l.LoanBrokerID ?? '').toUpperCase() === brokerId)
    .map((l: { InterestRate?: number }) => Number(l.InterestRate ?? 0)).filter((r: number) => Number.isInteger(r) && r >= 0 && r <= 100000).sort((a: number, b: number) => a - b);
  const asset = vault ? xrplAsset(vault.Asset) : { asset: null, label: 'BROKER' };
  if (!rates.length) return { range: null, broker, asset, truncated: Boolean(objs.marker) };
  const median = rates.length % 2 ? rates[(rates.length - 1) / 2] : Math.floor((rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2);
  return { range: { min: tenthsBpsToFraction(rates[0]), median: tenthsBpsToFraction(median), max: tenthsBpsToFraction(rates[rates.length - 1]), sampleSize: rates.length }, broker, asset, truncated: Boolean(objs.marker) };
}

/** Vault and LoanBroker objects owned by operator accounts at one validated ledger (bounded; no ledger scan). */
export async function operatorObjects(reader: XrplReader, accounts: string[], ledger: Ledger, signal?: AbortSignal) {
  const pin = { ledger_hash: ledger.hash };
  const vaults = new Set<string>(); const brokers = new Set<string>(); const failed: string[] = [];
  for (const account of accounts) {
    try {
      for (const [type, set] of [['vault', vaults], ['loan_broker', brokers]] as const) {
        const r = await reader.call('account_objects', { account, type, limit: 50, ...pin }, signal);
        for (const o of r.account_objects ?? []) if (/^[A-Fa-f0-9]{64}$/.test(String(o.index))) set.add(String(o.index).toUpperCase());
      }
    } catch { failed.push(account); }
  }
  return { vaults: [...vaults].slice(0, 32), brokers: [...brokers].slice(0, 32), failed };
}

/** XLS-65 share value = (AssetsTotal − LossUnrealized) / outstanding share MPT, in ray. */
export async function vaultShareValue(reader: XrplReader, vaultId: string, ledger: Ledger, signal?: AbortSignal) {
  const pin = { ledger_hash: ledger.hash };
  const vault = (await reader.call('ledger_entry', { index: vaultId, ...pin }, signal)).node;
  if (!vault?.ShareMPTID) throw new FinanceError('COVERAGE_INCOMPLETE', 'Vault not found at the observed ledger.');
  const issuance = (await reader.call('ledger_entry', { mpt_issuance: vault.ShareMPTID, ...pin }, signal)).node;
  const assets = toRay(parseXrplNumber(String(vault.AssetsTotal ?? '0'))) - toRay(parseXrplNumber(String(vault.LossUnrealized ?? '0')));
  const shares = BigInt(String(issuance?.OutstandingAmount ?? '0'));
  if (shares === 0n) return { value: null, vault };
  return { value: assets / shares, vault };
}
export const xrplRealized = (now: bigint, then: bigint, seconds: number) => rayToDecimal(realizedRay(now, then, BigInt(seconds)), 6);
