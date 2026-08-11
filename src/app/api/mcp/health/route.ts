import { isMcpGatewayEnabled, isMcpAuthEnabled, isMcpResourcesEnabled } from '@/lib/platform-flag';
import { getTools } from '@/lib/mcp/tools';
import { getPrompts } from '@/lib/mcp/prompts';
import { isRealPaymentsConfigured } from '@/lib/mcp/npayment-rails';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/mcp/health — public liveness + gateway status. */
export async function GET() {
  return Response.json({
    ok: true,
    gateway_enabled: isMcpGatewayEnabled(),
    auth_required: isMcpAuthEnabled(),
    transport: 'streamable-http',
    tools: isMcpGatewayEnabled() ? getTools().map((t) => t.name) : ['payment.x402', 'reputation.read'],
    // Dream Cycle Confidential Extraction on Flare FCC, Task 10. Additive —
    // mirrors the `tools` field's exact shape/gating (empty when the
    // gateway or isMcpResourcesEnabled() is off) so a client-side page (see
    // /mcp-connect) can detect whether dream/run_confidential is currently
    // registered without needing a live MCP prompts/list round-trip of its
    // own. First real consumer of getPrompts() outside the MCP transport
    // itself (server.ts) and its own tests.
    prompts: isMcpGatewayEnabled() && isMcpResourcesEnabled() ? getPrompts().map((p) => p.name) : [],
    version: '2.0.0',
    // PRD-A (2026-07-27 dream-cycle-practical-readiness-feedback): commit +
    // deployed_at — build-time constants only (see scripts/deploy-vps.sh),
    // never a runtime `git` call — let an external integrator confirm which
    // commit this specific process (hypermove-app, separate from llm-service)
    // is actually running, instead of trusting an unverifiable "should be
    // fixed" claim. Additive-only: every existing field above is unchanged.
    commit: process.env.GIT_SHA || null,
    deployed_at: process.env.DEPLOYED_AT || null,
    // PRD 05 (2026-08-11 dream-cycle-fcc-rlusd-status-review): a read-only
    // boolean reflecting isRealPaymentsConfigured()'s live return value —
    // never the underlying MCP_FACILITATOR_PRIVATE_KEY/PAY_TO_ADDRESS values
    // themselves, so this carries no secret-disclosure risk. Closes the
    // exact gap that review's corpus repeatedly hit: every settlement path
    // (EVM x402, Stellar, XRPL RLUSD) collapses to this single gate, and
    // there was previously no way for a caller (or an operator without
    // shell access to this deployment) to check its state without either
    // live server/env access or attempting a real payment and inferring
    // from whether the response looked mock- or real-shaped.
    real_payments_configured: isRealPaymentsConfigured(),
    time: new Date().toISOString(),
  });
}
