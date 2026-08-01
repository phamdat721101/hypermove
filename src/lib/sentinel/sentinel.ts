/**
 * src/lib/sentinel/sentinel.ts
 * -----------------------------
 * Consolidated safety layer: cost caps + policy allow-list + circuit breaker
 * + heuristic prompt-injection scan.
 *
 * Design decisions:
 *  - Four concerns, four private classes, one public `createSentinel()`
 *    factory. Each private class has a single responsibility (SRP). Merging
 *    them into one file avoids the 6-file sprawl the research doc originally
 *    proposed while preserving SOLID at the class level.
 *  - In-memory state is bounded (LRU-style Maps with size caps). Persistence
 *    to Postgres is best-effort via db.ts (async, never blocks the check).
 *  - Telemetry-resilience contract: if the DB is down, sentinel STILL denies
 *    when a cost cap or circuit is breached — enforcement is memory-first.
 *  - Prompt-injection is heuristic-only (regex + token deny-list). Zero deps,
 *    <1ms overhead. LLM-based scanning is intentionally out of scope.
 */

import { insertHMPolicyHit } from '../db';
import { isPlatformEnabled } from '../platform-flag';

// ─── Public API surface ────────────────────────────────────────────────────

export interface SentinelConfig {
  costCaps?: {
    /** USD dollars per agent per day. */
    perAgentDailyUsd?: number;
    /** USD dollars per agent per hour. */
    perAgentHourlyUsd?: number;
    /** Per-invocation cost estimate — used when a call has no explicit cost. */
    defaultCostMicroUsd?: number;
  };
  policies?: {
    /** If set, only these endpoint names may be invoked. */
    endpointAllowlist?: readonly string[];
    /** Prompt-injection defense on payload strings. */
    promptInjection?: 'off' | 'strict';
  };
  circuitBreaker?: {
    /** Fraction 0-1 above which the breaker opens. */
    errorThreshold?: number;
    /** Cool-down in ms before the breaker re-attempts. */
    cooldownMs?: number;
    /** Sliding window size — number of recent outcomes to consider. */
    windowSize?: number;
  };
  /**
   * Bypass the isPlatformEnabled() (FEATURE_HM_PLATFORM) gate entirely for
   * this instance's check()/record() calls. Default false — every existing
   * caller that constructs a sentinel without this field behaves
   * byte-identically to before this field existed. Set true only by callers
   * that have their OWN independent feature flag gating whether they call
   * check()/record() at all (e.g. the MCP gateway's isMcpGuardiansEnabled()) —
   * this lets that caller's flag be the sole enable/disable switch instead of
   * silently also depending on FEATURE_HM_PLATFORM being on.
   */
  forceEnabled?: boolean;
}

export interface SentinelDecision {
  allow: boolean;
  reason?: string;
  policy?: string;
}

export interface SentinelInput {
  endpoint: string;
  agent_id: string;
  payload?: unknown;
  cost_micro_usd?: number;
}

export interface SentinelOutcome {
  endpoint: string;
  agent_id: string;
  success: boolean;
  cost_micro_usd?: number;
}

export interface Sentinel {
  check(input: SentinelInput): Promise<SentinelDecision>;
  record(outcome: SentinelOutcome): void;
}

// ─── Internal: cost tracker ────────────────────────────────────────────────

const MICRO_PER_USD = 1_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TRACKED_AGENTS = 10_000; // hard cap to prevent memory growth

interface Bucket {
  windowStart: number;
  microUsd: number;
}

class CostTracker {
  private daily = new Map<string, Bucket>();
  private hourly = new Map<string, Bucket>();

  /** Returns micro-USD consumed within the given window. */
  private consume(map: Map<string, Bucket>, agentId: string, delta: number, windowMs: number): number {
    const now = Date.now();
    let bucket = map.get(agentId);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, microUsd: 0 };
      map.set(agentId, bucket);
    }
    bucket.microUsd += delta;
    if (map.size > MAX_TRACKED_AGENTS) evictOldest(map);
    return bucket.microUsd;
  }

  add(agentId: string, microUsd: number): void {
    this.consume(this.daily, agentId, microUsd, DAY_MS);
    this.consume(this.hourly, agentId, microUsd, HOUR_MS);
  }

  peekDaily(agentId: string): number {
    const b = this.daily.get(agentId);
    if (!b || Date.now() - b.windowStart > DAY_MS) return 0;
    return b.microUsd;
  }

  peekHourly(agentId: string): number {
    const b = this.hourly.get(agentId);
    if (!b || Date.now() - b.windowStart > HOUR_MS) return 0;
    return b.microUsd;
  }
}

function evictOldest<K, V extends { windowStart: number }>(map: Map<K, V>): void {
  let oldestKey: K | undefined;
  let oldestStart = Infinity;
  for (const [k, v] of map) {
    if (v.windowStart < oldestStart) { oldestStart = v.windowStart; oldestKey = k; }
  }
  if (oldestKey !== undefined) map.delete(oldestKey);
}

// ─── Internal: circuit breaker (sliding window) ────────────────────────────

interface BreakerState {
  outcomes: boolean[]; // true = success
  cursor: number;
  openedAt: number | null;
}

class CircuitBreaker {
  private state = new Map<string, BreakerState>();
  constructor(
    private threshold: number,
    private cooldownMs: number,
    private windowSize: number,
  ) {}

  /** True when the breaker is currently open (deny). */
  isOpen(endpoint: string): boolean {
    const s = this.state.get(endpoint);
    if (!s || s.openedAt === null) return false;
    if (Date.now() - s.openedAt < this.cooldownMs) return true;
    // Cool-down elapsed → half-open (reset and allow next attempt).
    s.openedAt = null;
    s.outcomes = [];
    s.cursor = 0;
    return false;
  }

  record(endpoint: string, success: boolean): void {
    let s = this.state.get(endpoint);
    if (!s) {
      s = { outcomes: [], cursor: 0, openedAt: null };
      this.state.set(endpoint, s);
    }
    if (s.outcomes.length < this.windowSize) s.outcomes.push(success);
    else { s.outcomes[s.cursor] = success; s.cursor = (s.cursor + 1) % this.windowSize; }

    if (s.outcomes.length >= Math.min(this.windowSize, 5)) {
      const errors = s.outcomes.filter((o) => !o).length;
      const rate = errors / s.outcomes.length;
      if (rate >= this.threshold) s.openedAt = Date.now();
    }
  }
}

// ─── Internal: prompt-injection heuristics ─────────────────────────────────

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(prior|previous)\s+instructions/i,
  /system\s*prompt\s*[:=]/i,
  /you\s+are\s+now\s+a\s+different/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /jailbreak/i,
  /developer\s+mode\s+enabled/i,
  /<\/?script[\s>]/i,
];

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function looksLikePromptInjection(text: string): boolean {
  if (!text) return false;
  const normalized = text.replace(CONTROL_CHAR_RE, ' ');
  for (const re of INJECTION_PATTERNS) if (re.test(normalized)) return true;
  return false;
}

/** Recursively scan a payload for injection strings, capped by depth to avoid pathological inputs. */
function scanPayload(v: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof v === 'string') return looksLikePromptInjection(v);
  if (Array.isArray(v)) {
    for (const item of v) if (scanPayload(item, depth + 1)) return true;
    return false;
  }
  if (v && typeof v === 'object') {
    for (const val of Object.values(v)) if (scanPayload(val, depth + 1)) return true;
  }
  return false;
}

// ─── The Sentinel itself ───────────────────────────────────────────────────

class SentinelImpl implements Sentinel {
  private costs = new CostTracker();
  private breaker: CircuitBreaker;
  private allowlist?: ReadonlySet<string>;
  private injection: 'off' | 'strict';
  private dailyCapMicro: number;
  private hourlyCapMicro: number;
  private defaultCostMicro: number;
  private forceEnabled: boolean;

  constructor(cfg: SentinelConfig) {
    const cb = cfg.circuitBreaker ?? {};
    this.breaker = new CircuitBreaker(
      cb.errorThreshold ?? Number(process.env.HM_CIRCUIT_ERROR_THRESHOLD ?? 0.5),
      cb.cooldownMs ?? Number(process.env.HM_CIRCUIT_COOLDOWN_MS ?? 60_000),
      cb.windowSize ?? 20,
    );
    if (cfg.policies?.endpointAllowlist) this.allowlist = new Set(cfg.policies.endpointAllowlist);
    this.injection = cfg.policies?.promptInjection ?? 'strict';
    this.dailyCapMicro = usdToMicro(cfg.costCaps?.perAgentDailyUsd ?? Number(process.env.HM_COST_CAP_PER_AGENT_DAILY_USD ?? 100));
    this.hourlyCapMicro = usdToMicro(cfg.costCaps?.perAgentHourlyUsd ?? Number(process.env.HM_COST_CAP_PER_AGENT_HOURLY_USD ?? 20));
    this.defaultCostMicro = cfg.costCaps?.defaultCostMicroUsd ?? 10_000; // $0.01 per call default
    this.forceEnabled = cfg.forceEnabled ?? false;
  }

  async check(input: SentinelInput): Promise<SentinelDecision> {
    if (!this.forceEnabled && !isPlatformEnabled()) return { allow: true };

    // 1. Allowlist
    if (this.allowlist && !this.allowlist.has(input.endpoint)) {
      this.hit('tool_allowlist', input, `endpoint '${input.endpoint}' not in allowlist`);
      return { allow: false, policy: 'tool_allowlist', reason: 'endpoint_not_allowed' };
    }

    // 2. Circuit breaker
    if (this.breaker.isOpen(input.endpoint)) {
      this.hit('circuit_breaker', input, 'breaker_open');
      return { allow: false, policy: 'circuit_breaker', reason: 'breaker_open' };
    }

    // 3. Cost caps
    const projected = this.costs.peekDaily(input.agent_id) + (input.cost_micro_usd ?? this.defaultCostMicro);
    if (projected > this.dailyCapMicro) {
      this.hit('cost_cap', input, `daily_cap_exceeded (${microToUsd(projected)} > ${microToUsd(this.dailyCapMicro)})`, projected);
      return { allow: false, policy: 'cost_cap', reason: 'daily_cap_exceeded' };
    }
    const projectedHour = this.costs.peekHourly(input.agent_id) + (input.cost_micro_usd ?? this.defaultCostMicro);
    if (projectedHour > this.hourlyCapMicro) {
      this.hit('cost_cap', input, 'hourly_cap_exceeded', projectedHour);
      return { allow: false, policy: 'cost_cap', reason: 'hourly_cap_exceeded' };
    }

    // 4. Prompt-injection heuristic
    if (this.injection === 'strict' && scanPayload(input.payload)) {
      this.hit('prompt_injection', input, 'heuristic_match');
      return { allow: false, policy: 'prompt_injection', reason: 'suspicious_payload' };
    }

    return { allow: true };
  }

  record(outcome: SentinelOutcome): void {
    if (!this.forceEnabled && !isPlatformEnabled()) return;
    this.costs.add(outcome.agent_id, outcome.cost_micro_usd ?? this.defaultCostMicro);
    this.breaker.record(outcome.endpoint, outcome.success);
  }

  private hit(policy: string, input: SentinelInput, reason: string, cost_micro_usd?: number): void {
    // Async, non-blocking. Persistence failures do not affect the enforcement path.
    queueMicrotask(() => {
      insertHMPolicyHit({
        policy,
        endpoint: input.endpoint,
        agent_id: input.agent_id,
        reason,
        cost_micro_usd,
      }).catch(() => { /* swallow */ });
    });
  }
}

function usdToMicro(usd: number): number { return Math.round(usd * MICRO_PER_USD); }
function microToUsd(micro: number): string { return (micro / MICRO_PER_USD).toFixed(2); }

/** Factory — the only public constructor. */
export function createSentinel(cfg: SentinelConfig = {}): Sentinel {
  return new SentinelImpl(cfg);
}

// Expose the heuristic for reuse by the security guard.
export { looksLikePromptInjection };
