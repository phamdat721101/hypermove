import { z } from 'zod';
import type { ToolDef } from '../../tools';
import { financeRequest } from '../client';
import { strictJson } from '../transport';
import { isFinanceRatesEnabled } from '../../../platform-flag';
import wireSchema from './finance-v1.schema.json';
import ratesSchema from './finance-rates-v1.schema.json';
import { validateFinance, validateRates } from './contracts';
import { ratesSummary } from './rates';
import { xrplLoanPayRequests, type XrplLoanPayOperation } from './xrpl-loan-pay';
import type { FinanceOperation } from './engine';

/**
 * Finance tool catalog (stage r1, read-only). Tool metadata is generated from the
 * canonical schema: nativeInputSchema is a strict ZodObject converted from the same
 * JSON branch (SDK registration + tools/list), and inputValidator is the Ajv2020
 * validator that remains the source of truth. Both run before metering.
 */
const MAX_INPUT_BYTES = 262_144;
const BOOTSTRAP = 'Read-only; never signs or sends. Call finance_get_capabilities_v1 first and pass its contractDigest.';

type Spec = { name: string; operation: FinanceOperation; description: string };
const SPECS: Spec[] = [
  { name: 'finance_get_capabilities_v1', operation: 'capabilities', description: 'Per-network, per-operation Finance capability matrix (arbitrum, base, robinhood, xrpl) with reasons and evidence. Returns the current contractDigest and ratesContractDigest (in warnings).' },
  { name: 'finance_get_positions_v1', operation: 'positions', description: `Loan/position report for one account on one network, pinned to one block or validated ledger: balances, supplied, collateral, debt, health factor, explicit coverage gaps. Returns the report inline when ready, else a job to poll with finance_get_job_v1. ${BOOTSTRAP}` },
  { name: 'finance_get_job_v1', operation: 'job', description: `Get or cancel an owned Finance job. SUCCEEDED means a research artifact is ready, not that money moved. ${BOOTSTRAP}` },
  { name: 'finance_get_action_status_v1', operation: 'status', description: `Fetch an owned Finance artifact (e.g. a positions report) by its resultRef. ${BOOTSTRAP}` },
];
const LOAN_PAY_SPECS = [
  { name: 'finance_preview_xrpl_loan_pay_v1', operation: 'xrpl-loan-pay-preview', description: 'Dry-run one unsigned native XRPL LoanPay using the latest positionId and ledger index/hash from finance_get_positions_v1. Input includes environment, borrower, loan ID, payment mode, and a native XRPL Amount cap. Never signs or submits.' },
  { name: 'finance_verify_xrpl_loan_pay_v1', operation: 'xrpl-loan-pay-verify', description: 'Verify a validated native XRPL LoanPay by hash against the expected environment, borrower, loan ID, payment mode, and maximum amount. Reports evidenced changes to the Loan and the network fee.' },
] as const satisfies ReadonlyArray<{ name: string; operation: XrplLoanPayOperation; description: string }>;

function branchFor(operation: string): Record<string, unknown> {
  const branch = (wireSchema.$defs.Request.oneOf as unknown as Array<{ properties: Record<string, { const?: string }> }>).find((b) => b.properties.operation?.const === operation);
  if (!branch) throw new Error('missing finance request branch: ' + operation);
  return branch as unknown as Record<string, unknown>;
}
/** draft-7-facing metadata: mechanical $defs → definitions with rewritten refs. */
export function draft7(schema: Record<string, unknown>, defs: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify({ ...schema, definitions: defs }).replaceAll('#/$defs/', '#/definitions/');
  return JSON.parse(text);
}
/** Strict ZodObject generated from the same JSON branch (parity is test-asserted against Ajv). */
function toZod(branch: Record<string, unknown>, defs: unknown): z.ZodObject {
  return z.fromJSONSchema({ ...branch, $defs: defs } as unknown as Parameters<typeof z.fromJSONSchema>[0]) as unknown as z.ZodObject;
}
function sizeOk(raw: unknown) { return Buffer.byteLength(JSON.stringify(raw ?? {}), 'utf8') <= MAX_INPUT_BYTES; }

export function financeValidator(operation: FinanceOperation): NonNullable<ToolDef['inputValidator']> {
  return (raw) => {
    if (!sizeOk(raw)) return { ok: false, issues: [{ path: '/', keyword: 'maxBytes' }] };
    if (operation === 'lending-rates') {
      const r = validateRates('RatesRequest', raw);
      return r.ok ? r : { ok: false, issues: r.issues };
    }
    const r = validateFinance('Request', raw);
    if (!r.ok) return { ok: false, issues: r.issues };
    if (r.value.operation !== operation) return { ok: false, issues: [{ path: '/operation', keyword: 'const' }] };
    return r;
  };
}

const pct = (s: unknown) => (typeof s === 'string' ? `${(Number(s) * 100).toFixed(2)}%` : 'n/a');
/** Deterministic, non-authoritative summary of a finance.response/1 (no LLM). */
export function financeSummary(response: Record<string, any>): string {
  const lines = ['Summary (non-authoritative):'];
  if (response.kind === 'error') lines.push(`${response.status}: ${response.errors?.[0]?.code} — ${response.errors?.[0]?.recovery}`);
  else if (response.kind === 'job') lines.push(`Job ${response.data.jobId} is ${response.data.state}; poll finance_get_job_v1${response.data.resultRef ? `, result ${response.data.resultRef}` : ''}.`);
  else if (response.kind === 'capabilities') {
    const admitted = response.data.filter((c: any) => c.stage === 'READ_VERIFIED').map((c: any) => c.operation);
    lines.push(`${response.network}: read-verified [${admitted.join(', ') || 'none'}]; all write operations unsupported at this stage.`);
  } else if (response.kind === 'positions') {
    const r = response.data; const p = r.observation.point;
    lines.push(`${response.network} · ${r.account.address} · at ${p.kind === 'evm-block' ? 'block ' + p.number : 'ledger ' + p.index}`);
    for (const pos of r.positions) {
      if (pos.kind === 'xrpl-loan') lines.push(`- XRPL loan ${pos.loanId.slice(0, 8)}…: rate ${pct(String(pos.interestRateTenthsBps / 100000))} APR, ${pos.paymentRemaining} payments left, next due ${pos.nextDueAt ?? 'unknown'}`);
      else lines.push(`- ${pos.protocol}: ${pos.collateral.length} collateral, ${pos.debt.length} debt asset(s), HF ${pos.noDebt ? 'no debt' : pos.healthFactor ?? 'unknown'}${pos.ltv ? `, LTV ${pct(pos.ltv)}` : ''}`);
    }
    if (!r.positions.length) lines.push('- no lending positions found in admitted markets');
    if (!r.coverage.complete) lines.push(`Coverage partial: ${r.coverage.missing.map((m: any) => `${m.capability}=${m.reasonCode}`).join(', ')}`);
  }
  lines.push('execution=false: nothing was prepared, signed or sent.');
  return lines.join('\n');
}

export function getFinanceTools(): ToolDef[] {
  const tools: ToolDef[] = SPECS.map(({ name, operation, description }) => {
    const branch = branchFor(operation);
    return {
      name, description, tier: 't1_read', requiresAuthentication: true,
      inputSchema: draft7(branch, wireSchema.$defs),
      nativeInputSchema: toZod(branch, wireSchema.$defs),
      inputValidator: financeValidator(operation),
      summarize: (result) => financeSummary(result as Record<string, any>),
      handler: (args, ctx) => financeRequest(ctx?.session.userId ?? 'anonymous', operation, args),
    };
  });
  if (isFinanceRatesEnabled()) {
    const branch = ratesSchema.$defs.RatesRequest as Record<string, unknown>;
    tools.push({
      name: 'finance_get_lending_rates_v1', tier: 't1_read', requiresAuthentication: true,
      description: 'Live lending rates for XRP/FXRP/stablecoins across XRPL native (XLS-65 vault realised yield, XLS-66 observed loan-rate range), Flare (Kinetic money market, ERC-4626 vaults), Aave V3 (Arbitrum/Base) and Morpho Blue (Base). Each row is labelled posted-variable | realized-trailing | observed-loan-range | documented-headline; compare only within one kind. Read-only. Pass ratesContractDigest from finance_get_capabilities_v1 warnings.',
      inputSchema: draft7(branch, ratesSchema.$defs),
      nativeInputSchema: toZod(branch, ratesSchema.$defs),
      inputValidator: financeValidator('lending-rates'),
      summarize: (result) => ratesSummary(result as Record<string, unknown>),
      handler: (args, ctx) => financeRequest(ctx?.session.userId ?? 'anonymous', 'lending-rates', args),
    });
  }
  if (process.env.FINANCE_XRPL_LOAN_PAY_V1 === 'true') {
    for (const { name, operation, description } of LOAN_PAY_SPECS) {
      const schema = xrplLoanPayRequests[operation];
      tools.push({
        name, description, tier: 't1_read', requiresAuthentication: true,
        inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
        nativeInputSchema: schema,
        inputValidator: (raw) => {
          if (!sizeOk(raw)) return { ok: false, issues: [{ path: '/', keyword: 'maxBytes' }] };
          const parsed = schema.safeParse(raw);
          return parsed.success ? { ok: true, value: parsed.data } : {
            ok: false, issues: parsed.error.issues.map(issue => ({ path: '/' + issue.path.join('/'), keyword: issue.code })),
          };
        },
        handler: (args, ctx) => financeRequest(ctx?.session.userId ?? 'anonymous', operation, args),
      });
    }
  }
  return tools;
}

/**
 * Raw-body guard for the MCP HTTP route (flag on only). JSON.parse silently keeps
 * the last duplicate key and lossy UTF-8 decoding rewrites bytes, so Finance
 * tools/call bodies are checked on the raw bytes before the SDK parses them.
 * Non-Finance requests pass through unchanged. Returns a replayable Request or a
 * JSON-RPC error Response.
 */
export async function guardFinanceBody(req: Request): Promise<Request | Response> {
  if (req.method !== 'POST') return req;
  const bytes = new Uint8Array(await req.arrayBuffer());
  const replay = () => new Request(req.url, { method: req.method, headers: req.headers, body: bytes });
  const lossy = new TextDecoder().decode(bytes);
  if (!lossy.includes('finance_')) return replay();
  const error = (code: number, message: string, id: unknown = null) => Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: 400 });
  let parsed: unknown;
  try { parsed = JSON.parse(lossy); } catch { return replay(); } // SDK reports its own parse error
  const calls = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ id?: unknown; method?: string; params?: { name?: unknown } }>;
  const finance = calls.find((c) => c?.method === 'tools/call' && typeof c.params?.name === 'string' && c.params.name.startsWith('finance_'));
  if (!finance) return replay();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return error(-32700, 'Finance requests must be valid UTF-8', finance.id ?? null); }
  try { strictJson(text); } catch { return error(-32602, 'invalid tool arguments: ambiguous JSON (duplicate key or unpaired surrogate)', finance.id ?? null); }
  return replay();
}
