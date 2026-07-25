/**
 * src/lib/mcp/rate-limit-device.ts
 * --------------------------------
 * Per-IP rate limiting for POST /api/mcp/device/start. Reuses rate-limit.ts's
 * exact durable rolling-window pattern (mcp_rate_counters, sha256 bucket key,
 * hour buckets), just keyed by IP instead of userId.
 *
 * Why this exists as a separate limiter rather than reusing checkAndConsume()
 * directly: /device/start is called with NO identity at all (that's the whole
 * point — no wallet, no email, no pre-existing account), so there is no
 * userId to key on. The only signal available pre-auth is the caller's IP.
 *
 * Threshold: 10 starts / hour / IP. This is deliberately generous enough for
 * legitimate retries (a human mistyping the y/n, a flaky connection) while
 * still bounding the free-tier-token-farming risk that coincides with
 * /device/start + /device/approve being reachable from any host (not
 * loopback-restricted — see platform-flag.ts's isMcpDeviceAuthEnabled() doc
 * comment for the full accepted tradeoff).
 */

import { createHash } from 'node:crypto';
import { withClient } from '../db';

export const DEVICE_START_LIMIT_PER_IP = 10;
const WINDOW_HOURS = 1;

export interface DeviceRateResult {
  allowed: boolean;
  used: number;
  limit: number;
}

function hourBucket(now = Date.now()): number {
  return Math.floor(now / 3_600_000);
}

function bucketKey(ip: string, bucket: number): string {
  // Distinct namespace prefix ("device-start:") from rate-limit.ts's userId
  // buckets, so the two limiters can never collide on the same bucket_key
  // even if an IP string and a userId string were ever identical.
  return createHash('sha256').update(`device-start:${ip}:${bucket}`).digest('hex');
}

/** Extract the caller's IP the same way src/app/tools/actions.ts already does. */
export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? headers.get('x-real-ip') ?? 'unknown';
}

/** Sum the rolling window; if under the limit, consume one and return allowed. */
export async function checkAndConsumeDeviceStart(ip: string): Promise<DeviceRateResult> {
  const bucket = hourBucket();
  const oldest = bucket - (WINDOW_HOURS - 1);
  const key = `device-start:${ip}`;

  const used = await withClient(async (client) => {
    const { rows } = await client.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(count),0) AS total FROM mcp_rate_counters
       WHERE user_id = $1 AND hour_bucket BETWEEN $2 AND $3`,
      [key, oldest, bucket],
    );
    return Number(rows[0]?.total ?? 0);
  });

  // No DB → unlimited (dev fallback, matches rate-limit.ts's own behavior).
  if (used === null) return { allowed: true, used: 0, limit: DEVICE_START_LIMIT_PER_IP };

  if (used >= DEVICE_START_LIMIT_PER_IP) {
    return { allowed: false, used, limit: DEVICE_START_LIMIT_PER_IP };
  }

  await withClient(async (client) => {
    const expiresAt = new Date((bucket + WINDOW_HOURS) * 3_600_000).toISOString();
    await client.query(
      `INSERT INTO mcp_rate_counters (bucket_key, user_id, hour_bucket, count, expires_at)
       VALUES ($1,$2,$3,1,$4)
       ON CONFLICT (bucket_key) DO UPDATE SET count = mcp_rate_counters.count + 1`,
      [bucketKey(ip, bucket), key, bucket, expiresAt],
    );
    return true;
  });

  return { allowed: true, used: used + 1, limit: DEVICE_START_LIMIT_PER_IP };
}
