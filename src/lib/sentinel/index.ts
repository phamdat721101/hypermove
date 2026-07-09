/**
 * src/lib/sentinel/index.ts
 * -------------------------
 * Public barrel + a memoized default sentinel using env-var config.
 * Consumers who need custom policy can still call createSentinel() directly.
 */

import { createSentinel, type Sentinel } from './sentinel';

export { createSentinel, looksLikePromptInjection } from './sentinel';
export type { Sentinel, SentinelConfig, SentinelDecision, SentinelInput, SentinelOutcome } from './sentinel';

let cached: Sentinel | null = null;

/** Process-wide default sentinel — env-var-configured, safe to import anywhere. */
export function defaultSentinel(): Sentinel {
  if (!cached) cached = createSentinel({});
  return cached;
}

/** Test hook. */
export function _resetDefaultSentinel(): void {
  cached = null;
}
