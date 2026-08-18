import { afterEach, describe, expect, it } from 'vitest';
import { getTool, _resetTools } from '@/lib/mcp/tools';
import { issuePaymentQuote, settleQuote } from '@/lib/mcp/paywall';

afterEach(() => {
  delete process.env.XRPL_TREASURY_ADDRESS;
  delete process.env.XRPL_RLUSD_ISSUER;
  delete process.env.MCP_XRPL_QUOTE_TTL_MS;
  _resetTools();
});

function configureQuote() {
  process.env.XRPL_TREASURY_ADDRESS = 'rMerchantAddress';
  process.env.XRPL_RLUSD_ISSUER = 'rRlusdIssuer';
}

describe('XRPL payment readiness contract', () => {
  it('issues a complete, signer-safe XRPL quote before settlement', async () => {
    configureQuote();
    const result = await issuePaymentQuote('user-1', { tier: 'dream', chain: 'xrpl-testnet', asset: 'RLUSD', agentId: 'agent-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.merchant).toBe('rMerchantAddress');
      expect(result.quote.issuer).toBe('rRlusdIssuer');
      expect(result.quote.nonce).toHaveLength(32);
      expect(Date.parse(result.quote.expiresAt)).toBeGreaterThan(Date.now());
    }
  });

  it('rejects an expired quote before asking the rail to settle', async () => {
    configureQuote();
    process.env.MCP_XRPL_QUOTE_TTL_MS = '1';
    const issued = await issuePaymentQuote('user-2', { tier: 'dream', chain: 'xrpl-testnet', asset: 'RLUSD', agentId: 'agent-2' });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const settled = await settleQuote('user-2', issued.quote.quoteId, 'proof');
    expect(settled.ok).toBe(false);
    expect(settled.error).toMatch(/expired/);
  });

  it('rejects a quote before settlement when the requested Dream agent differs', async () => {
    configureQuote();
    const issued = await issuePaymentQuote('user-bound', { tier: 'dream', chain: 'xrpl-testnet', asset: 'RLUSD', agentId: 'agent-a' });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const settled = await settleQuote('user-bound', issued.quote.quoteId, 'proof', { tier: 'dream', agentId: 'agent-b' });
    expect(settled.ok).toBe(false);
    expect(settled.error).toMatch(/different agent_id/);
  });

  it('publishes secret-free local-signer bootstrap and strict episode schema', async () => {
    const bootstrap = getTool('wallet.xrpl.bootstrap')!;
    const value = await bootstrap.handler({});
    expect(JSON.stringify(value).toLowerCase()).not.toContain('seed');
    expect(JSON.stringify(value).toLowerCase()).not.toContain('private key');
    const ingest = getTool('submit_episode_log')!;
    const schema = ingest.inputSchema as { properties: { episodes: { items: { properties: { steps: { items: { required: string[] } } } } } } };
    expect(schema.properties.episodes.items.properties.steps.items.required).toEqual(['action', 'result']);
  });

  it('keeps observation_summary as an additive compatibility alias', async () => {
    const { ingestEpisodes } = await import('@/lib/mcp/dream/ingest');
    const output = await ingestEpisodes('agent-legacy', 'user-legacy', [{
      episode_id: 'episode-legacy', agent_id: 'agent-legacy', timestamp: new Date().toISOString(), outcome: 'success',
      steps: [{ action: 'checked payment readiness', observation_summary: 'trust line is present' }],
    }]);
    expect(output.ingested_count).toBe(1);
    expect(output.normalized_fields?.[0]?.fields).toContain('steps[0].observation_summary→result');
  });
});
