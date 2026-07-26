/**
 * src/lib/mcp/dream/cost.ts
 * ---------------------------
 * Local, self-contained cost tracker for the Dream Cycle pipeline. Tracks
 * token counts x a small configurable price table, entirely INDEPENDENT of
 * services/llm — that service is a standalone process with no exported
 * cost/usage/budget accounting (confirmed by reading services/llm/server.ts:
 * it calls Bedrock/Anthropic/OpenAI directly per-request and returns no
 * usage data back to callers). Requirement 9 of docs/prd/dream-cycle-v1.md.
 */

export interface StagePricePerMillionTokens {
  input: number;
  output: number;
}

/** Small, configurable price table. Defaults model a "small/fast" extraction
 *  model (OI-2 in the PRD is still open — this default is a placeholder). */
const DEFAULT_PRICE: StagePricePerMillionTokens = { input: 0.25, output: 1.25 };

export class CostTracker {
  private usedUsd = 0;
  private perStageTokens: Record<string, number> = {};

  constructor(
    private readonly budgetUsd: number,
    private readonly price: StagePricePerMillionTokens = DEFAULT_PRICE,
  ) {}

  /** Estimated cost of a call BEFORE making it — used to gate early (FR-COST-2). */
  estimateCostUsd(inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1_000_000) * this.price.input + (outputTokens / 1_000_000) * this.price.output;
  }

  /** True if spending `estimatedUsd` more would exceed the remaining budget. */
  canAfford(estimatedUsd: number): boolean {
    return this.usedUsd + estimatedUsd <= this.budgetUsd;
  }

  /** Record actual spend for a stage (called AFTER a call completes). */
  record(stage: string, inputTokens: number, outputTokens: number): void {
    const cost = this.estimateCostUsd(inputTokens, outputTokens);
    this.usedUsd += cost;
    this.perStageTokens[stage] = (this.perStageTokens[stage] ?? 0) + inputTokens + outputTokens;
  }

  get budgetUsedUsd(): number {
    return Math.round(this.usedUsd * 1_000_000) / 1_000_000;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.usedUsd);
  }

  get perStageTokenCounts(): Record<string, number> {
    return { ...this.perStageTokens };
  }
}

/** Cheap, deterministic token estimate (chars/4) — no LLM/embedding call. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
