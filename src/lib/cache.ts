/**
 * src/lib/cache.ts
 * ----------------
 * Tiny rolling-TTL LRU used by /api/agent and /api/revenue.
 * Zero deps. Process-local. Suitable for serverless cold-start budgets.
 *
 * Replace with Redis/Postgres in Sprint 3 (mcp-host VPS).
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlLruCache<V> {
  private store = new Map<string, Entry<V>>();

  constructor(private maxEntries = 256, private ttlMs = 24 * 60 * 60 * 1000) {}

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // bump recency
    this.store.delete(key);
    this.store.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  size(): number {
    return this.store.size;
  }
}

/** Daily budget counter — resets on UTC day rollover. */
export class DailyBudget {
  private day = todayUtc();
  private spent = 0;

  constructor(private limitUsd: number) {}

  /** Returns true if `costUsd` fits; consumes the budget. */
  consume(costUsd: number): boolean {
    const today = todayUtc();
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
    if (this.spent + costUsd > this.limitUsd) return false;
    this.spent += costUsd;
    return true;
  }

  remaining(): number {
    return Math.max(0, this.limitUsd - this.spent);
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
