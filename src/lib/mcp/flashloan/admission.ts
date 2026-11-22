import { ResearchError, boundaryEvent } from './contracts';
import { PUBLIC_LIMITS } from './public-contracts';

type Bucket = { count: number; expires: number };
/** Bounded ephemeral counters, not client identity or research persistence. */
export class RateWindow {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly limit: number, private readonly clock = Date.now) {}
  take(key: string) {
    const now = this.clock();
    for (const [id, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10000) throw new ResearchError('CAPACITY_EXCEEDED', 'Admission table is full; retry after 60 seconds.', true);
      bucket = { count: 0, expires: now + 60000 }; this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) { boundaryEvent('EDGE-03', 'PUBLIC_RATE_LIMIT'); throw new ResearchError('RATE_LIMITED', 'Request quota exhausted; retry after 60 seconds.', true); }
    bucket.count++;
  }
}
export class ResearchAdmission {
  private active = 0;
  private publicActive = 0;
  readonly publicRate: RateWindow;
  constructor(private readonly total = 2, clock = Date.now) { this.publicRate = new RateWindow(PUBLIC_LIMITS.computations_per_minute, clock); }
  privateLease(): (() => void) | null {
    if (this.active >= this.total) return null;
    this.active++;
    return this.release(false);
  }
  publicLease(key: string) {
    if (this.publicActive >= 1 || this.active >= this.total) { boundaryEvent('EDGE-03', 'PUBLIC_CAPACITY'); throw new ResearchError('CAPACITY_EXCEEDED', 'Research capacity is busy; retry after 5 seconds.', true); }
    this.publicRate.take(key); this.active++; this.publicActive++;
    return this.release(true);
  }
  private release(publicLease: boolean) {
    let released = false;
    return () => { if (released) return; released = true; this.active--; if (publicLease) this.publicActive--; };
  }
}
