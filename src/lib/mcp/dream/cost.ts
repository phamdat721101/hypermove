/**
 * src/lib/mcp/dream/cost.ts
 * ---------------------------
 * Re-export shim (2026-08-01). CostTracker/estimateTokens relocated to
 * src/lib/cost/tracker.ts — a pure move, identical public API and behavior —
 * so other features with a genuine per-call LLM cost can import the tracker
 * without pulling in Dream-Cycle-specific modules. This file exists so no
 * existing Dream Cycle import site (extract.ts, pipeline.ts) needed to change
 * import paths as part of the relocation.
 */

export { CostTracker, estimateTokens, type StagePricePerMillionTokens } from '../../cost/tracker';
