import { NextRequest } from 'next/server';
import { buildAgentSource } from '@/lib/agent';
import { DailyBudget } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAILY = new DailyBudget(Number(process.env.AGENT_DAILY_BUDGET_USD ?? 5));
const COST_PER_RUN_USD = 0.005; // mock-mode cost is 0; real Anthropic Haiku averages ~$0.005/run

export async function GET(_req: NextRequest) {
  if (!DAILY.consume(COST_PER_RUN_USD)) {
    return new Response(JSON.stringify({ error: 'agent.budget.exhausted' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }

  const source = buildAgentSource();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      try {
        for await (const frame of source.run()) {
          controller.enqueue(enc.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(enc.encode(`event: end\ndata: {}\n\n`));
      } catch (err) {
        controller.enqueue(
          enc.encode(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-agent-mode': source.mode,
    },
  });
}
