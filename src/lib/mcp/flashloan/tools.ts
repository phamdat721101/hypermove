import { z } from 'zod';
import type { ToolDef } from '../tools';
import { operationSchemas, type Operation } from './contracts';
import { researchRequest } from './client';

const descriptions: Record<Operation, string> = {
  flashloan_discover_arbitrage_pools: 'Discover EVM multi-pool candidates using the official DexScreener API. Returns an owned asynchronous research job.',
  flashloan_ingest_l2_tickmap_and_reserves: 'Read block-pinned pool reserves, initialized ticks and lender state. Unsupported or incomplete state is explicit.',
  flashloan_solve_dynamic_route_split: 'Evaluate closed routes and risk-bounded integer allocations against an owned immutable snapshot.',
  flashloan_simulate_atomic_revm: 'Dry-run a compiled flashloan plan. Returns fidelity, repayment evidence and injected assumptions; never signs or broadcasts.',
  xrpl_discover_arbitrage_routes: 'Read native XRPL AMMs and funded order books at one validated ledger; distinguish account-backed and hypothetical funding.',
  xrpl_simulate_arbitrage_route: 'Estimate native XRPL routes or dry-run one supported unsigned native transaction. Does not assert cross-transaction atomicity.',
  nim_memory_sync_flashloan_lesson: 'Retrieve cited research context or propose, validate and commit report evidence. Never approves generated procedures.',
  flashloan_research_job: 'Get/cancel an owned job, read an owned artifact, or inspect research capabilities.',
};
export function getFlashloanTools(): ToolDef[] {
  return (Object.keys(operationSchemas) as Operation[]).map((name) => {
    const schema = operationSchemas[name];
    return { name, description: descriptions[name], tier: 't1_read', nativeInputSchema: schema, requiresAuthentication: true,
      inputSchema: z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }),
      handler: (args, ctx) => researchRequest(ctx?.session.userId ?? 'anonymous', name, args),
    };
  });
}
