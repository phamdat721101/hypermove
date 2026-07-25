/**
 * report.ts
 * ---------
 * Aggregates all SegmentResults into one FinalReport (JSON + human-readable table).
 * Wrapped in nim-skill's runHarnessed() with an enforcer requiring FinalReport schema
 * conformance — per the PRD, this is the cheapest, highest-value enforcement point:
 * a malformed report must never silently ship (03-architecture-and-design.md, T1-4).
 */
import { runHarnessed, type SkillDef } from 'nim-skill';
import {
  isWellFormedFinalReport,
  type FinalReport,
  type SegmentResult,
} from './types.js';

export function aggregateReport(results: SegmentResult[]): FinalReport {
  // A run "completes" if every segment reached ITS expected terminal state — an
  // expected `blocked` (T1) counts as completion, not failure, per the PRD's explicit
  // framing ("a named blocker stopping cleanly is a successful run").
  const ranToCompletion = results.every(
    (r) => r.status === 'real' || r.status === 'simulated' || r.status === 'blocked',
  );

  return {
    generatedAt: new Date().toISOString(),
    results,
    ranToCompletion,
  };
}

const STATUS_LABEL: Record<SegmentResult['status'], string> = {
  real: 'REAL',
  simulated: 'SIMULATED',
  blocked: 'BLOCKED',
  error: 'ERROR',
};

function contextLabel(segment: SegmentResult['segment']): string {
  switch (segment) {
    case 'A':
      return 'coston2';
    case 'B':
      return 'local sim';
    case 'C':
      return 'xrpl testnet';
  }
}

export function formatReportHuman(report: FinalReport): string {
  const lines: string[] = [];
  lines.push(`HyperMove Flare TEE-Proxy E2E Report — generated ${report.generatedAt}`);
  lines.push(`Ran to completion: ${report.ranToCompletion ? 'yes' : 'no'}`);
  lines.push('');
  for (const r of report.results) {
    const label = `${STATUS_LABEL[r.status]} (${contextLabel(r.segment)})`;
    const blocker = r.blockerId ? ` [${r.blockerId}]` : '';
    lines.push(`[Segment ${r.segment}] ${r.step}: ${label}${blocker} — ${r.message}`);
    if (r.evidence?.txHash) lines.push(`    tx: ${r.evidence.txHash}`);
    if (r.evidence?.address) lines.push(`    address: ${r.evidence.address}`);
    if (r.evidence?.url) lines.push(`    url: ${r.evidence.url}`);
  }
  return lines.join('\n');
}

interface AggregateInput {
  results: SegmentResult[];
}

// runHarnessed's real signature fixes the skill's input type to Dict
// (Record<string, unknown>) — only the output type O is generic (verified against
// node_modules/nim-skill/dist/harness/runtime.d.ts). SkillDef is declared against
// Record<string, unknown> here and narrowed with a cast inside execute, since this
// module fully controls what it actually passes as runtime input.
const aggregateReportSkill: SkillDef<Record<string, unknown>, FinalReport & Record<string, unknown>> = {
  name: 'e2e.report.aggregate',
  version: '1.0.0',
  harness: {
    enforcer: {
      strategies: [
        {
          kind: 'schema',
          required: ['generatedAt', 'results', 'ranToCompletion'],
        },
      ],
      maxHeals: 0,
      mode: 'strict',
    },
    monitor: { exporters: ['file'] },
  },
  execute: async (input) => {
    const { results } = input as unknown as AggregateInput;
    return aggregateReport(results) as FinalReport & Record<string, unknown>;
  },
};

export async function runAggregateReport(
  results: SegmentResult[],
  agentId = 'e2e-coston2-flare-xrpl',
): Promise<FinalReport> {
  const { output, verified, checks } = await runHarnessed(
    aggregateReportSkill,
    { results },
    { agentId },
  );

  if (!verified || !isWellFormedFinalReport(output)) {
    // A malformed report must never silently ship — this is the one place in the
    // whole script where a thrown error (not a SegmentResult) is the correct output,
    // since the report itself is the thing that failed schema validation.
    throw new Error(
      `Final report failed schema verification: ${JSON.stringify(checks)}`,
    );
  }

  return output;
}
