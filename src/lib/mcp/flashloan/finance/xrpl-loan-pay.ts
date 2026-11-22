import { z } from 'zod';
import type { XrplReader } from '../xrpl';
import { FinanceError } from './contracts';
import { parseXrplNumber, readCreditEntry, resolveLoanAsset, validatedLedger, xrplLoanPositionId, type Ledger } from './xrpl-read';

const index = z.number().int().positive().max(0xffffffff);
const hash = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const account = z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
const unsigned = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/);
const positive = z.string().regex(/^[1-9][0-9]{0,19}$/);
const decimal = z.string().max(100).regex(/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]{1,3})?$/);
const currency = z.string().regex(/^(?:[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}|[A-Fa-f0-9]{40})$/);
const issuance = z.string().regex(/^[A-Fa-f0-9]{48}$/);
const nativeAmount = z.union([
  positive,
  z.strictObject({ currency, issuer: account, value: decimal }),
  z.strictObject({ mpt_issuance_id: issuance, value: positive }),
]);
const mode = z.enum(['regular', 'overpayment', 'full', 'late']);
const modeFlag = { regular: 0, overpayment: 0x00010000, full: 0x00020000, late: 0x00040000 } as const;
const environment = z.enum(['mainnet', 'devnet']);
const request = {
  schemaVersion: z.literal('finance.xrpl-loan-pay.request/1'),
  requestId: z.string().min(1).max(128),
  environment,
  borrower: account,
  loanId: hash,
  mode,
  maxAmount: nativeAmount,
};
export const xrplLoanPayRequests = {
  'xrpl-loan-pay-preview': z.strictObject({
    ...request,
    position: z.strictObject({ positionId: hash, ledgerIndex: index, ledgerHash: hash }),
  }),
  'xrpl-loan-pay-verify': z.strictObject({ ...request, txHash: hash }),
};
export type XrplLoanPayOperation = keyof typeof xrplLoanPayRequests;
type Preview = z.infer<typeof xrplLoanPayRequests['xrpl-loan-pay-preview']>;
type Verify = z.infer<typeof xrplLoanPayRequests['xrpl-loan-pay-verify']>;
type NativeAmount = z.infer<typeof nativeAmount>;
type Environment = z.infer<typeof environment>;

const networkIds = { mainnet: 0, devnet: 2 } as const;
const amendments = [
  ['SingleAssetVault', '81BD2619B6B3C8625AC5D0BC01DE17F06C3F0AB95C7C87C93715B87A4FD240D8'],
  ['LendingProtocol', '565B90CA1AB2B9D42208ED10884188C64F9E19083DECB9634AAF06EB03299509'],
  ['LendingProtocolV1_1', 'A360E2BFD775A5B0DCE1C36C16DF31B72735A57584FD163655D2F9564F8E7AC8'],
] as const;

export async function xrplLoanPayReadiness(reader: XrplReader, signal?: AbortSignal) {
  const info = await reader.call('server_info', {}, signal);
  const configuredEnvironment = Object.keys(networkIds).find(key => networkIds[key as Environment] === info.info?.network_id) as Environment | undefined;
  if (!configuredEnvironment) return { environment: null, state: 'unknown' } as const;
  const result = await reader.call('feature', {}, signal).catch(() => null);
  signal?.throwIfAborted();
  const states = amendments.map(([name, id]) => {
    const feature = (result?.features ?? result)?.[id];
    return feature?.name === name && typeof feature.enabled === 'boolean' ? feature.enabled : null;
  });
  return { environment: configuredEnvironment, state: states.includes(false) ? 'disabled' : states.every(state => state === true) ? 'enabled' : 'unknown' } as const;
}

function currencyKey(value: string) {
  return value.length === 40 ? value.toUpperCase() : value;
}
function assetKey(amount: NativeAmount) {
  if (typeof amount === 'string') return 'XRP';
  if ('mpt_issuance_id' in amount) return 'mpt:' + amount.mpt_issuance_id.toUpperCase();
  return currencyKey(amount.currency) + ':' + amount.issuer;
}
function vaultAssetKey(asset: unknown) {
  if (asset === 'XRP' || (asset && typeof asset === 'object' && 'currency' in asset && asset.currency === 'XRP' && !('issuer' in asset))) return 'XRP';
  const parsed = nativeAmount.safeParse({ ...(asset as object), value: '1' });
  if (!parsed.success) throw new FinanceError('COVERAGE_INCOMPLETE', 'Vault asset could not be resolved.');
  return assetKey(parsed.data);
}
function quantity(amount: NativeAmount) {
  if (typeof amount === 'string' || 'mpt_issuance_id' in amount) {
    return { n: BigInt(typeof amount === 'string' ? amount : amount.value), exponent: 0 };
  }
  try {
    const value = parseXrplNumber(amount.value);
    if (BigInt(value.coefficient) <= 0n) throw new Error('zero amount');
    return { n: BigInt(value.coefficient), exponent: value.exponent };
  } catch {
    throw new FinanceError('INVALID_INPUT', 'Amount must be positive and within XRPL issued-asset precision.');
  }
}
function compareAmount(a: NativeAmount, b: NativeAmount) {
  if (assetKey(a) !== assetKey(b)) throw new FinanceError('RECONCILIATION_MISMATCH', 'The transaction and expected amount use different assets.');
  const left = quantity(a), right = quantity(b);
  const lowest = Math.min(left.exponent, right.exponent);
  const diff = left.n * 10n ** BigInt(left.exponent - lowest) - right.n * 10n ** BigInt(right.exponent - lowest);
  return diff === 0n ? 0 : diff < 0n ? -1 : 1;
}

const loanTx = z.object({
  TransactionType: z.literal('LoanPay'),
  Account: account,
  LoanID: hash,
  Amount: nativeAmount,
  Flags: z.number().int().min(0).max(0xffffffff).optional(),
  Fee: unsigned.optional(),
});
function matchTx(raw: unknown, input: Preview | Verify, exactAmount: boolean) {
  const tx = loanTx.safeParse(raw);
  if (!tx.success || tx.data.Account !== input.borrower || tx.data.LoanID.toUpperCase() !== input.loanId.toUpperCase()
    || ((tx.data.Flags ?? 0) & 0x7fffffff) !== modeFlag[input.mode]) {
    throw new FinanceError('RECONCILIATION_MISMATCH', 'LoanPay transaction does not match the borrower, loan, or payment mode.');
  }
  const comparison = compareAmount(tx.data.Amount, input.maxAmount);
  if (comparison > 0 || (exactAmount && comparison !== 0)) throw new FinanceError('RECONCILIATION_MISMATCH', 'LoanPay Amount did not match its expected cap.');
  return tx.data;
}

const accountingFields = ['PrincipalOutstanding', 'TotalValueOutstanding', 'ManagementFeeOutstanding', 'PaymentRemaining'] as const;
const accountingAmount = z.string().max(100).regex(/^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]{1,3})?$/);
const fieldDelta = z.strictObject({ before: accountingAmount, after: accountingAmount.nullable() });
const loanDeltaSchema = z.strictObject(Object.fromEntries(accountingFields.map(field => [field, fieldDelta.optional()])));
const affectedNodes = z.object({ AffectedNodes: z.array(z.object({
  ModifiedNode: z.object({ LedgerEntryType: z.string(), LedgerIndex: hash }).passthrough().optional(),
})) });
const loanFields = z.object({
  PreviousFields: z.record(z.string(), z.unknown()).optional(),
  FinalFields: z.record(z.string(), z.unknown()),
});
function loanDelta(raw: unknown, loanId: string) {
  const parsed = affectedNodes.safeParse(raw);
  const matching = parsed.success ? parsed.data.AffectedNodes.flatMap(({ ModifiedNode: node }) =>
    node?.LedgerEntryType === 'Loan' && node.LedgerIndex.toUpperCase() === loanId ? [node] : []) : [];
  if (matching.length !== 1) throw new FinanceError('RECONCILIATION_MISMATCH', 'Metadata did not identify one modified Loan for this payment.');
  const fields = loanFields.safeParse(matching[0]);
  if (!fields.success) throw new FinanceError('RECONCILIATION_MISMATCH', 'The matching Loan metadata is incomplete.');
  const { PreviousFields, FinalFields } = fields.data;
  const deltas: Record<string, unknown> = {};
  for (const field of accountingFields) {
    if (!Object.hasOwn(PreviousFields ?? {}, field)) continue;
    const before = PreviousFields![field];
    const after = FinalFields[field];
    // Missing final fields are kept unknown, even when the ledger may omit zero defaults.
    const normalize = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    deltas[field] = { before: normalize(before), after: after === undefined ? null : normalize(after) };
  }
  return loanDeltaSchema.parse(deltas);
}

const ledgerPoint = z.strictObject({ index, hash, closeTime: z.number().int().nonnegative() });
const response = {
  schemaVersion: z.literal('finance.xrpl-loan-pay.response/1'), requestId: request.requestId,
  environment, execution: z.literal(false),
};
const previewResponse = z.strictObject({
  ...response, kind: z.literal('xrpl-loan-pay-preview'), readingLedger: ledgerPoint,
  simulationLedgerIndex: index, engineResult: z.string().regex(/^(?:tes|tec|tef|tel|tem|ter)[A-Z0-9_]+$/),
  applied: z.literal(false), feeDrops: unsigned.nullable(), deltas: loanDeltaSchema.nullable(),
  unsignedTransaction: loanTx.nullable(),
});
const receiptResponse = z.strictObject({
  ...response, kind: z.literal('xrpl-loan-pay-receipt'), ledger: ledgerPoint,
  status: z.literal('verified'), txHash: hash, borrower: account, loanId: hash, mode,
  transactionAmountCap: nativeAmount, feeDrops: unsigned, deltas: loanDeltaSchema,
});
const errorResponse = z.strictObject({
  ...response, kind: z.literal('error'), status: z.enum(['blocked', 'unknown']),
  error: z.strictObject({ code: z.string(), retryable: z.boolean(), recovery: z.string() }),
});
const core = (input: Preview | Verify) => ({
  schemaVersion: 'finance.xrpl-loan-pay.response/1', requestId: input.requestId, environment: input.environment, execution: false,
});
export function xrplLoanPayError(operation: XrplLoanPayOperation, raw: unknown, error: FinanceError) {
  const input = xrplLoanPayRequests[operation].safeParse(raw);
  if (!input.success) throw error;
  return errorResponse.parse({
    ...core(input.data), kind: 'error',
    status: error.retryable || error.code === 'FEATURE_STATE_UNKNOWN' ? 'unknown' : 'blocked',
    error: error.toWire(),
  });
}
async function loadLoan(reader: XrplReader, ledger: Ledger, input: Preview | Verify, signal?: AbortSignal) {
  const loan = await readCreditEntry(reader, ledger, input.loanId.toUpperCase(), 'Loan', signal);
  if (loan.Borrower !== input.borrower) throw new FinanceError('OWNER_SCOPE_MISMATCH', 'Borrower does not match the native Loan.');
  return loan;
}
function verifyAsset(asset: unknown, amount: NativeAmount) {
  if (assetKey(amount) !== vaultAssetKey(asset)) throw new FinanceError('RECONCILIATION_MISMATCH', 'Amount asset does not match the loan vault.');
  quantity(amount);
}

async function preview(reader: XrplReader, input: Preview, signal?: AbortSignal) {
  const loanId = input.loanId.toUpperCase(), positionHash = input.position.ledgerHash.toUpperCase();
  if (xrplLoanPositionId(loanId, positionHash) !== input.position.positionId.toLowerCase()) {
    throw new FinanceError('STALE_STATE', 'Position reference does not match the loan and reading ledger.');
  }
  const readingLedger = await validatedLedger(reader, signal);
  if (input.position.ledgerIndex > readingLedger.index) throw new FinanceError('STALE_STATE', 'Position ledger is beyond the validated head.');
  const positionLedger = input.position.ledgerIndex === readingLedger.index ? readingLedger : await validatedLedger(reader, signal, input.position.ledgerIndex);
  const positionAge = readingLedger.closeTime - positionLedger.closeTime;
  if (positionLedger.hash !== positionHash || positionAge < 0 || positionAge > 120) {
    throw new FinanceError('STALE_STATE', 'Refresh the XRPL loan position before previewing a payment.');
  }
  const loan = await loadLoan(reader, readingLedger, input, signal);
  if (positionLedger.index !== readingLedger.index) {
    const previous = await loadLoan(reader, positionLedger, input, signal);
    if (!hash.safeParse(previous.PreviousTxnID).success || previous.PreviousTxnID !== loan.PreviousTxnID) {
      throw new FinanceError('STALE_STATE', 'Loan changed after the position read.');
    }
  }
  const { asset } = await resolveLoanAsset(reader, readingLedger, loan.LoanBrokerID, signal);
  verifyAsset(asset, input.maxAmount);
  const transaction = { TransactionType: 'LoanPay', Account: input.borrower, LoanID: loanId, Amount: input.maxAmount, Flags: modeFlag[input.mode] };
  const result = await reader.call('simulate', { tx_json: transaction, binary: false }, signal);
  if (result.applied !== false || !index.safeParse(result.ledger_index).success || result.ledger_index < readingLedger.index) {
    throw new FinanceError('SIMULATION_UNAVAILABLE', 'XRPL did not return a usable unsigned simulation context.');
  }
  const success = result.engine_result === 'tesSUCCESS';
  if (success && result.meta?.TransactionResult !== 'tesSUCCESS') {
    throw new FinanceError('SIMULATION_UNAVAILABLE', 'Simulation metadata did not confirm the engine result.');
  }
  const tx = success ? matchTx(result.tx_json, input, true) : null;
  return previewResponse.parse({
    ...core(input), kind: 'xrpl-loan-pay-preview', readingLedger, simulationLedgerIndex: result.ledger_index,
    engineResult: result.engine_result, applied: false, feeDrops: tx?.Fee ?? null,
    deltas: success ? loanDelta(result.meta, loanId) : null, unsignedTransaction: success ? transaction : null,
  });
}

async function verify(reader: XrplReader, input: Verify, signal?: AbortSignal) {
  const txHash = input.txHash.toUpperCase(), loanId = input.loanId.toUpperCase();
  const result = await reader.call('tx', { transaction: txHash, api_version: 2 }, signal);
  if (result.validated !== true || result.meta?.TransactionResult !== 'tesSUCCESS'
    || typeof (result.hash ?? result.tx_json?.hash) !== 'string' || (result.hash ?? result.tx_json?.hash).toUpperCase() !== txHash
    || !index.safeParse(result.ledger_index).success) {
    throw new FinanceError('RECONCILIATION_MISMATCH', 'A successful, validated LoanPay receipt with the requested hash is required.');
  }
  const tx = matchTx(result.tx_json, input, false);
  if (tx.Fee === undefined) throw new FinanceError('RECONCILIATION_MISMATCH', 'Validated receipt omitted its network fee.');
  const ledger = await validatedLedger(reader, signal, result.ledger_index);
  if (result.ledger_hash !== undefined && (typeof result.ledger_hash !== 'string' || result.ledger_hash.toUpperCase() !== ledger.hash)) {
    throw new FinanceError('RECONCILIATION_MISMATCH', 'Receipt ledger hash does not match the validated ledger.');
  }
  const deltas = loanDelta(result.meta, loanId);
  const loan = await loadLoan(reader, ledger, input, signal);
  const { asset } = await resolveLoanAsset(reader, ledger, loan.LoanBrokerID, signal);
  verifyAsset(asset, tx.Amount);
  return receiptResponse.parse({
    ...core(input), kind: 'xrpl-loan-pay-receipt', status: 'verified', ledger, txHash, borrower: input.borrower,
    loanId, mode: input.mode, transactionAmountCap: tx.Amount, feeDrops: tx.Fee, deltas,
  });
}

export async function runXrplLoanPay(reader: XrplReader, operation: XrplLoanPayOperation, raw: unknown, signal?: AbortSignal) {
  const parsed = xrplLoanPayRequests[operation].safeParse(raw);
  if (!parsed.success) throw new FinanceError('INVALID_INPUT', 'Invalid XRPL LoanPay request.');
  const input = parsed.data;
  quantity(input.maxAmount);
  const readiness = await xrplLoanPayReadiness(reader, signal);
  if (readiness.environment !== input.environment) throw new FinanceError('WRONG_CHAIN', 'Configured XRPL provider does not match the requested environment.');
  if (readiness.state !== 'enabled') {
    throw new FinanceError(readiness.state === 'disabled' ? 'FEATURE_DISABLED' : 'FEATURE_STATE_UNKNOWN', 'Required XRPL lending amendments are not verified as enabled.');
  }
  return 'position' in input ? preview(reader, input, signal) : verify(reader, input, signal);
}
