import type { NextRequest } from 'next/server';
import { scanUrl, generateMCPManifest, emitMCPServer } from '@/lib/scanner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/download — Generate and stream a ZIP bundle (4 files).
 * Input: { url: string, host?: string }
 * Output: application/zip stream
 */
export async function POST(req: NextRequest) {
  let body: { url?: string; host?: string; manifest?: unknown; serverCode?: string };
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { url } = body;
  if (!url) return Response.json({ error: 'Missing url' }, { status: 400 });

  let manifest = body.manifest as ReturnType<typeof generateMCPManifest> | undefined;
  let serverCode = body.serverCode;

  // If manifest not provided, scan fresh
  if (!manifest) {
    const scan = await scanUrl(url);
    manifest = generateMCPManifest(scan);
    serverCode = emitMCPServer(manifest);
  }

  const host = body.host || process.env.MCP_HOST || 'localhost';
  const base = host.startsWith('http') ? host : `http://${host}:3003`;

  // Build 4 files
  const wellKnown = JSON.stringify(manifest, null, 2);
  const server = serverCode || emitMCPServer(manifest);
  const readme = `# ${manifest.name}

Auto-generated MCP server for: ${manifest.sourceUrl}

## Quick start

\`\`\`bash
npm init -y
npm install tsx
PORT=3002 npx tsx webmcp-server.ts
\`\`\`

## MCP Config (paste into Claude/Cursor/Kiro)

\`\`\`json
${JSON.stringify({ mcpServers: { [manifest.name]: { url: `${base}/api/mcp/${manifest.name}`, transport: 'http' } } }, null, 2)}
\`\`\`

## Files

- \`webmcp-server.ts\` — MCP JSON-RPC server (run with tsx)
- \`webmcp.json\` — Machine-readable manifest
- \`package.json\` — Dependencies
- \`README.md\` — This file
`;
  const pkgJson = JSON.stringify({
    name: manifest.name,
    version: '1.0.0',
    type: 'module',
    scripts: { start: 'tsx webmcp-server.ts' },
    dependencies: { tsx: '^4.7.0' },
  }, null, 2);

  // Build ZIP using raw deflate-store (no compression lib needed)
  const zip = buildZip([
    { name: 'webmcp-server.ts', content: server },
    { name: 'webmcp.json', content: wellKnown },
    { name: 'package.json', content: pkgJson },
    { name: 'README.md', content: readme },
  ]);

  return new Response(zip, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${manifest.name}.zip"`,
    },
  });
}

// Minimal ZIP builder (store-only, no compression dep needed)
function buildZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const entries: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const contentBytes = new TextEncoder().encode(file.content);
    const crc = crc32(contentBytes);

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length + contentBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true); // crc32
    lv.setUint32(18, contentBytes.length, true); // compressed size
    lv.setUint32(22, contentBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // filename length
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);
    local.set(contentBytes, 30 + nameBytes.length);
    entries.push(local);

    // Central directory entry
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true); // crc32
    cv.setUint32(20, contentBytes.length, true); // compressed
    cv.setUint32(24, contentBytes.length, true); // uncompressed
    cv.setUint16(28, nameBytes.length, true); // filename length
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((s, c) => s + c.length, 0);

  // End of central directory
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk
  ev.setUint16(6, 0, true); // disk with CD
  ev.setUint16(8, files.length, true); // entries on disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, centralSize, true); // CD size
  ev.setUint32(16, centralOffset, true); // CD offset
  ev.setUint16(20, 0, true); // comment length

  const total = offset + centralSize + 22;
  const result = new Uint8Array(total);
  let pos = 0;
  for (const e of entries) { result.set(e, pos); pos += e.length; }
  for (const c of central) { result.set(c, pos); pos += c.length; }
  result.set(end, pos);
  return result;
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
