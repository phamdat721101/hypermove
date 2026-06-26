import type { NextRequest } from 'next/server';
import { scanUrl, generateMCPManifest, emitMCPServer, generateMCPConfig } from '@/lib/scanner';
import { findMCPByUrl, insertGeneratedMCP } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_HOST = process.env.MCP_HOST || 'localhost';

export async function POST(req: NextRequest) {
  let body: { url?: string; name?: string; host?: string };
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { url, name, host } = body;
  if (!url || typeof url !== 'string') return Response.json({ error: 'Missing "url"' }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch { return Response.json({ error: 'Invalid URL' }, { status: 400 }); }

  const resolvedHost = host || DEFAULT_HOST;

  // Dedup: check if already scanned
  const existing = await findMCPByUrl(parsed.toString());
  if (existing) {
    return Response.json({
      scan: null,
      manifest: existing.manifest,
      serverCode: existing.serverCode,
      mcpConfig: generateMCPConfig(existing.manifest as any, resolvedHost),
      saved: { id: existing.id, slug: existing.slug, cached: true },
    });
  }

  try {
    const scanResult = await scanUrl(parsed.toString());
    const manifest = generateMCPManifest(scanResult, { name });
    const serverCode = emitMCPServer(manifest);
    const mcpConfig = generateMCPConfig(manifest, resolvedHost);

    // Save to DB
    const dbResult = await insertGeneratedMCP({
      sourceUrl: parsed.toString(),
      mcpName: manifest.name,
      manifest,
      serverCode,
      host: resolvedHost,
    });

    return Response.json({
      scan: { url: scanResult.url, durationMs: scanResult.durationMs, toolCount: scanResult.tools.length, crawlData: scanResult.crawlData },
      manifest,
      serverCode,
      mcpConfig,
      saved: dbResult.ok ? { id: dbResult.id, slug: dbResult.slug } : { error: dbResult.noopReason || 'db_error' },
    });
  } catch (err) {
    return Response.json({ error: 'Scan failed', detail: (err as Error).message }, { status: 500 });
  }
}
