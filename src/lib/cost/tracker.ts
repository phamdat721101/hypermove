/**
 * src/lib/cost/tracker.ts
 * ------------------------
 * Generic, self-contained cost tracker: tracks token counts x a small
 * configurable price table. Originally built for the Dream Cycle pipeline
 * (docs/prd/dream-cycle-v1.md, Requirement 9) as `dream/cost.ts`, relocated
 * here (2026-08-01) so any feature with a genuine per-call LLM cost can
 * import it without pulling in Dream-Cycle-specific modules — pure move, no
 * behavior change. `src/lib/mcp/dream/cost.ts` re-exports from this file so
 * no existing Dream Cycle import site needed to change.
 *
 * Deliberately independent of any specific LLM provider/service — it has no
 * knowledge of services/llm or any other call site; callers estimate/record
 * tokens themselves and this class just does the USD math + budget gating.
 */

export interface StagePricePerMillionTokens {
  input: number;
  output: number;
}

/** Small, configurable price table. Defaults model a "small/fast" extraction
 *  model (OI-2 in the Dream Cycle PRD is still open — this default is a placeholder). */
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
