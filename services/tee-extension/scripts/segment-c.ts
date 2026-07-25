/**
 * segment-c.ts
 * ------------
 * Segment C — XRPL testnet (real settlement): decodes the exact
 * {action, amount, chain} fields from the FinancialActionMessage sent on-chain in
 * Segment B and, when chain === 'xrpl', performs a real RLUSD Payment via
 * n-payment's real SDK surface (createXrplClient / ensureTrustLine / sendRLUSD —
 * verified against node_modules/n-payment/dist/index.d.ts, not guessed from the
 * skill doc's tool-name framing, which names MCP-tool wrappers rather than the raw
 * exported classes/functions this script calls directly).
 *
 * This is explicitly NOT a TEE-signed settlement — the signing key lives in this
 * script's own process (an XRPL testnet wallet), not inside extension.go or any
 * confidential machine. See 03-architecture-and-design.md's "Why Segment C lives
 * in the orchestrator, not in extension.go" for the full reasoning. extension.go's
 * honest-stub handlers are never modified by this segment.
 *
 * maxHeals: 0 — a real money movement must never be "healed" by blind retry.
 * harness.guard hard-caps the RLUSD amount per run, reusing n-payment's own
 * RLUSD_MAX_PER_TRANSFER convention rather than inventing a new cap scheme.
 */
import { runHarnessed, type SkillDef } from 'nim-skill';
import { createXrplClient } from 'n-payment';
import type { OrchestratorConfig } from './config.js';
import type { SegmentResult } from './types.js';

/** Well-formed XRPL testnet tx hash: 64 uppercase hex chars. Used by the enforcer
 *  to require a REAL hash shape, not merely a truthy value (T5-5). */
const XRPL_TX_HASH_PATTERN = /^[0-9A-F]{64}$/;

interface DecodedFinancialAction {
  action?: string;
  amount?: string;
  chain?: string;
}

/** Decodes the exact fields Segment B attached as evidence on its
 *  submit-financial-action result — reading the real sent values back out,
 *  not reconstructing them independently, which is what makes the
 *  "message -> intent -> settlement" traceability claim true (T5-2). */
export function decodeFinancialActionEvidence(
  evidence: Record<string, string | number | boolean> | undefined,
): DecodedFinancialAction {
  if (!evidence) return {};
  return {
    action: typeof evidence.action === 'string' ? evidence.action : undefined,
    amount: typeof evidence.amount === 'string' ? evidence.amount : undefined,
    chain: typeof evidence.chain === 'string' ? evidence.chain : undefined,
  };
}

interface SegmentCInput {
  config: OrchestratorConfig;
  financialActionEvidence: Record<string, string | number | boolean> | undefined;
}

// See report.ts's comment: runHarnessed fixes the skill input type to Dict; we
// narrow via cast inside execute rather than through the generic.
const segmentCSkill: SkillDef<Record<string, unknown>, { results: SegmentResult[] } & Record<string, unknown>> = {
  name: 'e2e.segmentC.xrplRlusdSettlement',
  version: '1.0.0',
  harness: {
    enforcer: {
      strategies: [{ kind: 'schema', required: ['results'] }],
      maxHeals: 0,
      mode: 'strict',
    },
    // Hard amount cap (T5-4) is enforced in-line (see the guard-cap-check step
    // below) rather than via harness.guard, since GuardConfig's real shape
    // (node_modules/nim-skill/dist/harness/types.d.ts) only exposes
    // {maxCostUsd, ratePerMin, allowTools, injection} — no per-field amount-cap
    // primitive exists yet. Reusing n-payment's own RLUSD_MAX_PER_TRANSFER
    // convention as the cap VALUE (not the enforcement mechanism) is still
    // honored — see config.xrplRlusdMaxPerTransfer below.
    monitor: { exporters: ['file'] },
  },
  execute: async (rawInput): Promise<{ results: SegmentResult[] } & Record<string, unknown>> => {
    const { config, financialActionEvidence } = rawInput as unknown as SegmentCInput;
    const results: SegmentResult[] = [];
    const decoded = decodeFinancialActionEvidence(financialActionEvidence);

    if (decoded.chain !== 'xrpl') {
      results.push({
        segment: 'C',
        step: 'decode-message',
        status: 'error',
        message: `Segment B's FinancialActionMessage did not target chain:"xrpl" (got: ${decoded.chain ?? 'undefined'}). Segment C only handles the xrpl-targeted case.`,
      });
      return { results };
    }

    const amountNum = Number(decoded.amount);
    const maxPerTransfer = Number(config.xrplRlusdMaxPerTransfer);
    if (!decoded.amount || Number.isNaN(amountNum) || amountNum <= 0) {
      results.push({
        segment: 'C',
        step: 'decode-message',
        status: 'error',
        message: `Decoded amount "${decoded.amount}" is not a valid positive number — refusing to attempt a payment.`,
      });
      return { results };
    }
    if (amountNum > maxPerTransfer) {
      results.push({
        segment: 'C',
        step: 'guard-cap-check',
        status: 'error',
        message: `Decoded amount ${amountNum} RLUSD exceeds this run's cap of ${maxPerTransfer} RLUSD (RLUSD_MAX_PER_TRANSFER). Refusing — this is a hard guard, not a warning.`,
      });
      return { results };
    }

    results.push({
      segment: 'C',
      step: 'decode-message',
      status: 'real',
      evidence: { extra: { action: decoded.action ?? '', amount: decoded.amount, chain: decoded.chain } },
      message: `Decoded FinancialActionMessage from Segment B: action=${decoded.action}, amount=${decoded.amount} RLUSD, chain=xrpl.`,
    });

    // n-payment does not export a wallet-generation/faucet-funding utility
    // (verified against node_modules/n-payment/dist/index.d.ts — no such export
    // exists). Its own documented convention (XRPL_SEED_MISSING error, skill's
    // error table) is that the operator supplies a funded testnet seed via
    // XRPL_SEED, sourced from https://faucet.altnet.rippletest.net/accounts
    // themselves. This script follows that convention rather than fabricating a
    // generation helper that doesn't exist in the real SDK surface.
    if (!config.xrplSeed) {
      results.push({
        segment: 'C',
        step: 'xrpl-seed-check',
        status: 'error',
        message:
          'XRPL_SEED not supplied. n-payment has no wallet-generation export — obtain a funded ' +
          'XRPL testnet seed at https://faucet.altnet.rippletest.net/accounts and set XRPL_SEED ' +
          'in .env.coston2 (never in chat), per n-payment\'s own XRPL_SEED_MISSING convention.',
      });
      return { results };
    }

    const client = createXrplClient({ seed: config.xrplSeed, network: 'testnet' });

    try {
      const trustlineTxHash = await client.ensureTrustLine();
      results.push({
        segment: 'C',
        step: 'ensure-trustline',
        status: 'real',
        evidence: trustlineTxHash ? { txHash: trustlineTxHash } : undefined,
        message: trustlineTxHash
          ? `RLUSD trustline created (TrustSet tx: ${trustlineTxHash}).`
          : 'RLUSD trustline already existed — no TrustSet needed.',
      });

      // Demo destination: pay to the same wallet's own address by default (a
      // real, on-ledger XRPL Payment either way) unless a distinct recipient is
      // configured. Kept simple deliberately — the point is a real settlement
      // tx exists and is traceable, not a specific counterparty.
      const destination = process.env.XRPL_SETTLEMENT_DESTINATION ?? (await client.getAddress());

      const payment = await client.sendRLUSD(destination, decoded.amount);

      if (!XRPL_TX_HASH_PATTERN.test(payment.hash)) {
        results.push({
          segment: 'C',
          step: 'xrpl-payment',
          status: 'error',
          message: `sendRLUSD returned a malformed tx hash shape: "${payment.hash}" — refusing to report this as real.`,
        });
        return { results };
      }

      results.push({
        segment: 'C',
        step: 'xrpl-payment',
        status: 'real',
        evidence: { txHash: payment.hash },
        message: `Real RLUSD Payment submitted on XRPL testnet (validated: ${payment.validated}). Amount ${decoded.amount} RLUSD, destination ${destination}. This is a script-held-key settlement, NOT a TEE/PMW-signed one.`,
      });
    } catch (err) {
      results.push({
        segment: 'C',
        step: 'xrpl-payment',
        status: 'error',
        message: `XRPL settlement failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      await client.disconnect().catch(() => {});
    }

    return { results };
  },
};

export async function runSegmentC(
  config: OrchestratorConfig,
  financialActionEvidence: Record<string, string | number | boolean> | undefined,
  agentId = 'e2e-coston2-flare-xrpl',
): Promise<SegmentResult[]> {
  const { output, verified, checks } = await runHarnessed(
    segmentCSkill,
    { config, financialActionEvidence },
    { agentId },
  );

  if (!verified || !Array.isArray(output.results)) {
    return [
      {
        segment: 'C',
        step: 'harness-verify',
        status: 'error',
        message: `Segment C output failed harness verification: ${JSON.stringify(checks)}`,
      },
    ];
  }

  return output.results;
}
