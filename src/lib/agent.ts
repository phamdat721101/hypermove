/**
 * src/lib/agent.ts
 * ----------------
 * The 9-frame live-agent cinematic state machine + two interchangeable sources.
 *
 * SOLID:
 *  - LiveAgentSource is the strategy interface (Dependency Inversion).
 *  - MockSource and AnthropicSource implement it (Open/Closed: add Bedrock by writing one class).
 *  - Frames are a typed enum; consumers never branch on free-form strings.
 *
 * The Anthropic SDK is imported lazily so the mock-mode bundle has zero external deps.
 */

export type FrameKind =
  | 'manifest.fetch'
  | 'manifest.ok'
  | 'paywall.call'
  | 'paywall.402'
  | 'paywall.sign'
  | 'paywall.tx'
  | 'paywall.200'
  | 'revenue.tick'
  | 'done';

export interface AgentFrame {
  kind: FrameKind;
  /** Human label rendered in the terminal panel. */
  label: string;
  /** Optional shell-style detail rendered as muted line. */
  detail?: string;
  /** Milliseconds the UI should pause before the next frame. */
  delayMs: number;
}

export const SCRIPT: readonly AgentFrame[] = [
  { kind: 'manifest.fetch', label: 'load MCP config · hypermove.xyz',           detail: 'GET /.well-known/webmcp.json',                            delayMs: 700 },
  { kind: 'manifest.ok',    label: '✓ 4 web3 tools discovered',                 detail: 'payment.x402 · swap.quote · balance.read · tx.send',      delayMs: 800 },
  { kind: 'paywall.call',   label: 'tools/call payment.x402 → access web3',     detail: '{ "target": "/api/paid-endpoint", "chain": "base" }',     delayMs: 800 },
  { kind: 'paywall.402',    label: '← HTTP 402 · WWW-Authenticate: x402-USDC',  detail: 'realm="hypermove.xyz" price="10000" chain="base-sepolia"', delayMs: 900 },
  { kind: 'paywall.sign',   label: 'OWS vault · policy.check + sign EIP-3009',  detail: 'maxPerTx=100000 ✓ · chain.allow=base-sepolia ✓',          delayMs: 700 },
  { kind: 'paywall.tx',     label: 'settle on-chain · USDC transfer',           detail: '0xfa6c…b21e · confirmed in ~1.2s',                        delayMs: 900 },
  { kind: 'paywall.200',    label: '→ HTTP 200 · web3 action executed',         detail: '{ "ok": true, "amount_usdc": 10000 }',                    delayMs: 700 },
  { kind: 'revenue.tick',   label: 'hypermove.xyz revenue +$0.01',              detail: 'agent paid the dApp per call · settled on-chain',         delayMs: 600 },
  { kind: 'done',           label: 'agent flow complete · 8.0s end-to-end',     delayMs: 0 },
];

export interface LiveAgentSource {
  readonly mode: 'mock' | 'real';
  /** Yields frames in order; consumer awaits each one. */
  run(): AsyncIterable<AgentFrame>;
}

class MockSource implements LiveAgentSource {
  readonly mode = 'mock' as const;
  async *run(): AsyncIterable<AgentFrame> {
    for (const f of SCRIPT) {
      yield f;
      if (f.delayMs > 0) await sleep(f.delayMs);
    }
  }
}

class AnthropicSource implements LiveAgentSource {
  readonly mode = 'real' as const;
  constructor(private apiKey: string) {}
  async *run(): AsyncIterable<AgentFrame> {
    // Attempt a real Anthropic call; on any failure, downgrade to mock so the demo never breaks.
    try {
      // Lazy import: only loaded when LIVE_AGENT_MODE=real.
      // webpackIgnore prevents Next.js from trying to resolve this optional dep at build time.
      // @ts-expect-error — optional peer dep; missing in mock-only deployments.
      const mod = await import(/* webpackIgnore: true */ '@anthropic-ai/sdk').catch(() => null);
      if (!mod) {
        yield* new MockSource().run();
        return;
      }
      // We do not call the SDK in MVP — emitting deterministic frames keeps cost at $0
      // and demo fidelity at 100%. The integration point lives here; flip a feature flag
      // (REAL_ANTHROPIC_INVOKE=1) in S3 once the agent budget Postgres counter lands.
      yield* new MockSource().run();
    } catch {
      yield* new MockSource().run();
    }
  }
}

export function buildAgentSource(): LiveAgentSource {
  const mode = process.env.LIVE_AGENT_MODE === 'real' ? 'real' : 'mock';
  if (mode === 'real' && process.env.ANTHROPIC_API_KEY) {
    return new AnthropicSource(process.env.ANTHROPIC_API_KEY);
  }
  return new MockSource();
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
