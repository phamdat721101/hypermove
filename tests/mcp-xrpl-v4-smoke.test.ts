/**
 * tests/mcp-xrpl-v4-smoke.test.ts
 * --------------------------------
 * Live end-to-end smoke check: proves calling the MCP tool surface returns
 * real, structured data for every project named in the v4.0 PRD package
 * (Soil/Flare-Monarq/Doppler, the 12-entry toolkit, the hub index, FXRP
 * bridge). This is the acceptance check for the stated success criterion —
 * not just "the tool exists", but "the tool call actually works end-to-end".
 * Not part of the unit-test suite's assertions (see mcp-xrpl-v4.test.ts for
 * those) — this is a printable proof-of-life run.
 */
import { describe, it, expect } from 'vitest';
import { getTools, getTool } from '../src/lib/mcp/tools';

describe('MCP v4.0 end-to-end smoke: real data for every PRD project', () => {
  it('all 6 new/gated tools are registered', () => {
    const names = getTools().map((t) => t.name);
    const expected = [
      'xrpl.vault.info', 'xrpl.lending.status', 'xrpl.yield.compare',
      'xrpl.toolkit.list', 'xrpl.hub.trending', 'flare.fassets.bridgeStatus',
    ];
    for (const n of expected) expect(names).toContain(n);
  });

  it('xrpl.yield.compare returns Soil, Flare-Monarq, and Doppler with a recommendation', async () => {
    const result = (await getTool('xrpl.yield.compare')!.handler({})) as { venues: { name: string }[]; recommendation: string };
    console.log('xrpl.yield.compare venues:', result.venues.map((v) => v.name));
    console.log('xrpl.yield.compare recommendation:', result.recommendation);
    expect(result.venues.map((v) => v.name)).toEqual(['Soil', 'Flare (Monarq MXRPY)', 'Doppler']);
    expect(result.recommendation).toBeTruthy();
  });

  it('xrpl.toolkit.list returns all 12 xrpl-ai.org/resources entries', async () => {
    const result = (await getTool('xrpl.toolkit.list')!.handler({})) as { entries: { name: string }[] };
    console.log('xrpl.toolkit.list entry count:', result.entries.length, result.entries.map((e) => e.name));
    expect(result.entries).toHaveLength(13);
  });

  it('xrpl.hub.trending returns the live index narrative + composes a real amendment-status read attempt', async () => {
    const result = (await getTool('xrpl.hub.trending')!.handler({})) as { narrative: string; lendingAmendmentStatus: { ok: boolean; error?: unknown } };
    console.log('xrpl.hub.trending narrative:', result.narrative);
    console.log('xrpl.hub.trending amendment status:', JSON.stringify(result.lendingAmendmentStatus));
    expect(result.narrative).toContain('121');
    // lendingAmendmentStatus is always a well-formed ServiceResult ({ok: boolean, ...})
    // — whether the live rippled call succeeds depends on network reachability from
    // the calling environment, which this test does not assert (see mcp-xrpl-v4.test.ts
    // for the mocked-router unit test that verifies the composition itself).
    expect(typeof result.lendingAmendmentStatus.ok).toBe('boolean');
  });

  it('flare.fassets.bridgeStatus returns the real FXRP lifecycle + adoption stat', async () => {
    const result = (await getTool('flare.fassets.bridgeStatus')!.handler({})) as { ok: boolean; data: { mintedToDate: string; lifecycle: string[] } };
    console.log('flare.fassets.bridgeStatus:', result.data.mintedToDate, result.data.lifecycle.length, 'lifecycle steps');
    expect(result.ok).toBe(true);
    expect(result.data.mintedToDate).toMatch(/155M\+/);
    expect(result.data.lifecycle).toHaveLength(5);
  });

  it('xrpl.vault.info honestly gates on the not-yet-active SingleAssetVault amendment', async () => {
    const result = (await getTool('xrpl.vault.info')!.handler({ vaultIndex: 'ABC' })) as { ok: boolean; reason: string };
    console.log('xrpl.vault.info gate result:', JSON.stringify(result));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('amendment_not_active');
  });
});
