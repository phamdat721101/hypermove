import type { NextRequest } from 'next/server';
import { scanUrl, generateMCPManifest, emitMCPServer, generateMCPConfig } from '@/lib/scanner';
import { insertGeneratedMCP } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_HOST = process.env.MCP_HOST || 'localhost';

export async function POST(req: NextRequest) {
  let body: { url?: string; name?: string; host?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { url, name, host } = body;
  if (!url || typeof url !== 'string') {
    return Response.json({ error: 'Missing "url" field' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return Response.json({ error: 'Invalid URL. Must be http:// or https://' }, { status: 400 });
  }

  try {
    const scanResult = await scanUrl(parsed.toString());
    const manifest = generateMCPManifest(scanResult, { name });
    const serverCode = emitMCPServer(manifest);
    const mcpConfig = generateMCPConfig(manifest, host || DEFAULT_HOST);

    // Persist to Supabase (non-blocking — don't fail the response if DB is down)
    const dbResult = await insertGeneratedMCP({
      sourceUrl: parsed.toString(),
      mcpName: manifest.name,
      manifest,
      serverCode,
      host: host || DEFAULT_HOST,
    });

    return Response.json({
      scan: scanResult,
      manifest,
      serverCode,
      mcpConfig,
      saved: dbResult.ok ? { id: dbResult.id } : { error: dbResult.noopReason || 'db_error' },
    });
  } catch (err) {
    return Response.json({ error: 'Scan failed', detail: (err as Error).message }, { status: 500 });
  }
}
