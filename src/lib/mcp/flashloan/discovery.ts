import { z } from 'zod';
import { address, ResearchError, type Input } from './contracts';
import { boundedJson, delay } from './transport';

const pairSchema = z.object({ chainId: z.string(), dexId: z.string(), pairAddress: address, labels: z.array(z.string()).nullish(), baseToken: z.object({ address, symbol: z.string().optional() }), quoteToken: z.object({ address, symbol: z.string().optional() }), priceUsd: z.string().nullish(), priceNative: z.string().optional(), liquidity: z.object({ usd: z.number().finite().nonnegative().optional() }).nullish() });
export type DiscoveryPair = z.infer<typeof pairSchema>;

/** Serialized smooth token reservation: concurrent callers cannot overspend a bucket. */
export class RequestBudget {
  private tail = Promise.resolve();
  private next = 0;
  constructor(private readonly spacingMs = 210, private readonly clock = Date.now) {}
  acquire(signal?: AbortSignal): Promise<void> {
    const pending = this.tail.then(async () => { signal?.throwIfAborted(); const wait = Math.max(0, this.next - this.clock()); if (wait) await delay(wait, signal); this.next = this.clock() + this.spacingMs; });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
export class DexScreener {
  private readonly buckets = { pairs: new RequestBudget(), profiles: new RequestBudget(1050) };
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    // Requests with different cancellation lifetimes never share a promise.
    const key = signal ? undefined : path;
    if (key && this.inflight.has(key)) return this.inflight.get(key)!;
    const request = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.buckets.pairs.acquire(signal);
        const controller = new AbortController(); const abort = () => controller.abort();
        const timer = setTimeout(abort, 15000); signal?.addEventListener('abort', abort, { once: true });
        try {
          const response = await this.fetcher(`https://api.dexscreener.com${path}`, { redirect: 'error', signal: controller.signal });
          if (response.status === 429 || response.status >= 500) { if (attempt === 2) throw new ResearchError('DISCOVERY_UNAVAILABLE', 'DexScreener retry budget exhausted.', true); await delay(Math.min(5000, Number(response.headers.get('retry-after')) * 1000 || 250 * 2 ** attempt), signal); continue; }
          if (!response.ok) throw new ResearchError('DISCOVERY_REJECTED', `DexScreener returned HTTP ${response.status}.`);
          return await boundedJson(response, 4_000_000);
        } catch (e) { if (e instanceof ResearchError) throw e; throw new ResearchError(signal?.aborted ? 'CANCELLED' : 'DISCOVERY_UNAVAILABLE', 'Discovery request interrupted.', !signal?.aborted); }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      }
      throw new ResearchError('DISCOVERY_UNAVAILABLE', 'Discovery unavailable.');
    })();
    if (key) this.inflight.set(key, request);
    try { return await request; } finally { if (key) this.inflight.delete(key); }
  }
  async discover(input: Input<'flashloan_discover_arbitrage_pools'>, signal?: AbortSignal) {
    const tokens = [...new Set(input.tokens)].filter((t) => !input.exclude_tokens.includes(t));
    const pairs = new Map<string, DiscoveryPair>(); const rejected: Array<{ token: string; reason: string }> = []; const warnings: string[] = [];
    for (let i = 0; i < tokens.length; i += 30) {
      const raw = await this.get(`/tokens/v1/${input.network}/${tokens.slice(i, i + 30).join(',')}`, signal);
      if (!Array.isArray(raw)) throw new ResearchError('INVALID_RESPONSE', 'Expected a DexScreener pair array.');
      for (const value of raw) {
        const p = pairSchema.safeParse(value);
        if (!p.success) {
          const warning = 'Malformed pair omitted: ' + p.error.issues.map((issue) => issue.path.join('.')).join(',');
          if (warnings.length < 32 && !warnings.includes(warning)) warnings.push(warning);
          continue;
        }
        if (p.data.chainId === input.network && (p.data.liquidity?.usd ?? -1) >= input.min_liquidity_usd) pairs.set(p.data.pairAddress, p.data);
      }
    }
    const candidates = tokens.flatMap((token) => {
      const pools = [...pairs.values()].filter((p) => p.baseToken.address === token || p.quoteToken.address === token);
      if (pools.length < 2) { rejected.push({ token, reason: 'FEWER_THAN_TWO_LIQUID_POOLS' }); return []; }
      return [{ token, pools, status: 'DISCOVERY_ONLY' as const, requires_onchain_route_validation: true }];
    });
    return { network: input.network, observed_at: new Date().toISOString(), candidates, rejected, warnings, provenance: ['https://docs.dexscreener.com/api/reference'], complete: warnings.length === 0 };
  }
}
