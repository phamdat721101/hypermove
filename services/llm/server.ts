/**
 * services/llm/server.ts
 * ----------------------
 * Standalone LLM backend service. Deploy on Lightsail.
 * Keeps API keys server-side. Hypermove FE (Vercel) calls this.
 *
 * Run: PORT=3001 npx tsx server.ts
 * Env: BEDROCK_API_KEY, BEDROCK_REGION, BEDROCK_MODEL (or ANTHROPIC_API_KEY, OPENAI_API_KEY)
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 3001);

const SYSTEM_PROMPT = `You are analyzing a web page to extract user-callable actions as MCP tools.
Given the website's crawled data below, identify ALL actions a user can perform.
Return ONLY a JSON array of tools. Each tool must have:
- name: snake_case identifier
- description: 1 sentence explaining what the tool does
- inputSchema: JSON Schema object with properties and required fields

Focus on: forms, transactions, staking, swapping, deposits, withdrawals, claims, votes, purchases, bookings, searches, filtering.
Skip: pure navigation links, social media links, footer links, cookie banners.
For DeFi/Web3: extract main actions (stake, swap, lend, borrow, deposit, withdraw, bridge, claim).
For regular sites: extract forms, search, purchase flows, account actions.

Return 1-15 tools. Quality > quantity. Raw JSON array only, no markdown fences.`;

async function callLlm(content: string): Promise<string> {
  const provider = process.env.LLM_PROVIDER || 'bedrock';

  if (provider === 'bedrock') {
    const apiKey = process.env.BEDROCK_API_KEY;
    if (!apiKey) throw new Error('BEDROCK_API_KEY not set');
    const region = process.env.BEDROCK_REGION || 'us-east-1';
    const model = process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const res = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ anthropic_version: '2023-06-01', max_tokens: 2000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
    });
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || '';
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
    });
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text || '';
  }

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o', max_tokens: 2000, messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n---\n${content.slice(0, 15000)}` }] }),
    });
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider: process.env.LLM_PROVIDER || 'bedrock' }));
    return;
  }

  // POST /api/llm
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { content?: string };
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    if (!body.content) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing content' })); return; }

    try {
      const raw = await callLlm(body.content);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tools: [] })); return; }

      const tools = JSON.parse(jsonMatch[0]) as Array<{ name: string; description: string; inputSchema?: unknown }>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tools: tools.slice(0, 15).map(t => ({
          name: String(t.name).replace(/\W+/g, '_').toLowerCase().slice(0, 64),
          description: t.description || t.name,
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
        })),
      }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'LLM call failed', detail: (err as Error).message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`LLM service running on port ${PORT}`);
  console.log(`Provider: ${process.env.LLM_PROVIDER || 'bedrock'}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
