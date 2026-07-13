/**
 * src/lib/mcp/rate-limit.ts
 * -------------------------
 * Free tier: 5 queries per rolling 24h per user. Durable counter in
 * mcp_rate_counters keyed by sha256(userId + hourBucket); the rolling window is
 * the sum of the last 24 hourly buckets. DB-absent → allow (dev / mock-first).
 */

import { createHash } from 'node:crypto';
import { withClient } from '../db';

export const FREE_TIER_LIMIT = 5;
const WINDOW_HOURS = 24;

export interface RateResult {
  allowed: boolean;
  used: number;
  limit: number;
  resetInHours: number;
}

function hourBucket(now = Date.now()): number {
  return Math.floor(now / 3_600_000);
}

function bucketKey(userId: string, bucket: number): string {
  return createHash('sha256').update(`${userId}:${bucket}`).digest('hex');
}

/** Sum the rolling window; if under the limit, consume one and return allowed. */
export async function checkAndConsume(userId: string): Promise<RateResult> {
  const bucket = hourBucket();
  const oldest = bucket - (WINDOW_HOURS - 1);

  const used = await withClient(async (client) => {
    const { rows } = await client.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(count),0) AS total FROM mcp_rate_counters
       WHERE user_id = $1 AND hour_bucket BETWEEN $2 AND $3`,
      [userId, oldest, bucket],
    );
    return Number(rows[0]?.total ?? 0);
  });

  // No DB → unlimited (dev). used === null signals no-DB.
  if (used === null) return { allowed: true, used: 0, limit: FREE_TIER_LIMIT, resetInHours: 0 };

  if (used >= FREE_TIER_LIMIT) {
    return { allowed: false, used, limit: FREE_TIER_LIMIT, resetInHours: hoursUntilReset() };
  }

  await withClient(async (client) => {
    const expiresAt = new Date((bucket + WINDOW_HOURS) * 3_600_000).toISOString();
    await client.query(
      `INSERT INTO mcp_rate_counters (bucket_key, user_id, hour_bucket, count, expires_at)
       VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (bucket_key) DO UPDATE SET count = mcp_rate_counters.count + 1`,
      [bucketKey(userId, bucket), userId, bucket, expiresAt],
    );
    return true;
  });

  return { allowed: true, used: used + 1, limit: FREE_TIER_LIMIT, resetInHours: hoursUntilReset() };
}

function hoursUntilReset(): number {
  const msIntoHour = Date.now() % 3_600_000;
  return Math.max(1, Math.ceil((3_600_000 - msIntoHour) / 3_600_000));
}
