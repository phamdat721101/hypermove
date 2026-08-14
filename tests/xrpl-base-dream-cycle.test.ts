import { describe, it, expect } from 'vitest';
import { CHAINS, PROTOCOLS, chainById } from '../src/lib/registry';
import { supportedNetworks } from '../src/lib/mcp/payment-router';
import { librarianScan } from '../src/lib/mcp/dream/consolidate';
import { formatMattPocockSOP } from '../src/lib/mcp/dream/skillify-insights';
import { formatMorningBriefMarkdown } from '../src/lib/mcp/dream/morning-brief';

describe('XRPL & Base Dream Cycle Integration (RLUSD & USDC Focus)', () => {
  it('registers XRPL (mainnet/testnet) and Base (mainnet/sepolia) in CHAINS and x402 PROTOCOL', () => {
    const xrplMainnet = chainById('xrpl-mainnet');
    const xrplTestnet = chainById('xrpl-testnet');
    const baseMainnet = chainById('base-mainnet');
    const baseSepolia = chainById('base-sepolia');

    expect(xrplMainnet).toBeDefined();
    expect(xrplTestnet).toBeDefined();
    expect(baseMainnet).toBeDefined();
    expect(baseSepolia).toBeDefined();

    const x402Protocol = PROTOCOLS.find((p) => p.id === 'x402');
    expect(x402Protocol?.chains).toContain('xrpl-mainnet');
    expect(x402Protocol?.chains).toContain('xrpl-testnet');
    expect(x402Protocol?.chains).toContain('base-mainnet');
    expect(x402Protocol?.chains).toContain('base-sepolia');
  });

  it('includes RLUSD and USDC assets for XRPL & Base networks in supportedNetworks', () => {
    const nets = supportedNetworks();
    const xrplNet = nets.find((n) => n.chain === 'xrpl-mainnet');
    const xrplTestNet = nets.find((n) => n.chain === 'xrpl-testnet');
    const baseNet = nets.find((n) => n.chain === 'base-mainnet');

    expect(xrplNet?.assets).toContain('RLUSD');
    expect(xrplTestNet?.assets).toContain('RLUSD');
    expect(baseNet?.assets).toContain('USDC');
  });

  it('Phase 3 Librarian Hygiene: detects logical contradictions in SOP rules', async () => {
    const existing = [
      { memory_id: 'm1', type: 'rule' as const, content: 'Always set user session max timeout to 30 minutes', confidence: 0.9, source_count: 5, embedding: [] },
    ];
    const newInsights = [
      { type: 'rule' as const, content: 'Do not set user session max timeout to 30 minutes instead of 60 minutes' },
    ];

    const contradictions = await librarianScan('agent-test-1', newInsights, existing);
    expect(contradictions.length).toBeGreaterThan(0);
    expect(contradictions[0].reason).toContain('Logical contradiction detected');
  });

  it('Phase 4 Skillification: produces Matt-Pocock Standard type-safe SOPs', () => {
    const memories = [
      { type: 'rule', content: 'Settle Dream Cycle extraction via RLUSD on XRPL testnet', confidence: 0.95 },
      { type: 'rule', content: 'Verify on-ledger transaction proof via T54 facilitator', confidence: 0.92 },
    ];
    const sop = formatMattPocockSOP('sop_xrpl_rlusd_execution', 'XRPL RLUSD Execution SOP', memories);
    expect(sop).toContain('@standard Matt-Pocock TypeScript Type-Safe SOP');
    expect(sop).toContain('export interface SopXrplRlusdExecutionInput');
    expect(sop).toContain('export interface SopXrplRlusdExecutionOutput');
    expect(sop).toContain('RLUSD');
  });

  it('Phase 5 Morning Brief: formats 3-bullet Sovereign Morning Brief markdown', () => {
    const brief = formatMorningBriefMarkdown({
      agentId: 'agent-007',
      runId: 'run-uuid-1234',
      executed: ['Skillified sop_rule_pattern into type-safe SOP SKILL.md'],
      neutralized: ['Pruned contradictory SOP rule: "Always timeout 30m" vs "Do not timeout 30m"'],
      proposed: ['Requesting $0.50 budget expansion for deep-scan research orbs.'],
      tokensReducedPercent: 95,
    });

    expect(brief).toContain('Sovereign Morning Brief');
    expect(brief).toContain('* **Executed**:');
    expect(brief).toContain('* **Neutralized**:');
    expect(brief).toContain('* **Proposed**:');
    expect(brief).toContain('95%');
  });
});
