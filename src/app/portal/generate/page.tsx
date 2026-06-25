'use client';

import { useState } from 'react';

interface DetectedPrimitive {
  name: string;
  detected: boolean;
  confidence: number;
  evidence: string[];
}

interface ScanResponse {
  scan: {
    url: string;
    durationMs: number;
    primitives: DetectedPrimitive[];
    walletAdapter: string;
    chains: number[];
    genericTools: Array<{ name: string; description: string }>;
  };
  manifest: {
    name: string;
    version: string;
    description: string;
    tools: Array<{ name: string; description: string; serverCompatible: boolean }>;
    chains: number[];
    walletAdapter: string;
    sourceUrl: string;
  };
  serverCode: string;
  mcpConfig: Record<string, unknown>;
}

type Step = 'input' | 'scanning' | 'preview' | 'done';

export default function GeneratePage() {
  const [url, setUrl] = useState('');
  const [host, setHost] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  async function handleScan() {
    if (!url.trim()) return;
    setError('');
    setStep('scanning');
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), host: host.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Scan failed'); setStep('input'); return; }
      setResult(data);
      setStep('preview');
    } catch (e) {
      setError((e as Error).message);
      setStep('input');
    }
  }

  function copyText(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  function downloadFile(content: string, filename: string) {
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 md:px-8 md:py-20">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          Generate MCP Server <span className="gradient-text-purple-cyan">from any URL</span>
        </h1>
        <p className="mt-2 text-on-surface-variant">
          Paste URL → scan → get a deployable MCP server + config for your AI agent.
        </p>
      </header>

      {/* ─── Step 1: Input ─── */}
      {step === 'input' && (
        <div className="space-y-4">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleScan()}
            placeholder="https://app.uniswap.org"
            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container px-4 py-3 text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:outline-none"
          />
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="Server IP/domain (e.g. 54.123.45.67 or mcp.yourdomain.com)"
            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container px-4 py-3 text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:outline-none"
          />
          <button
            onClick={handleScan}
            disabled={!url.trim()}
            className="w-full rounded-lg bg-primary px-6 py-3 font-medium text-on-primary disabled:opacity-50"
          >
            Scan & Generate
          </button>
          {error && <p className="text-sm text-error">{error}</p>}
          <p className="text-xs text-on-surface-variant">
            Enter the IP/domain of your Lightsail server for the MCP config. Leave empty for localhost.
          </p>
        </div>
      )}

      {/* ─── Scanning ─── */}
      {step === 'scanning' && (
        <div className="flex items-center gap-3 py-12">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-on-surface-variant">Scanning {url}...</span>
        </div>
      )}

      {/* ─── Preview & Results ─── */}
      {(step === 'preview' || step === 'done') && result && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="glass-panel rounded-lg p-4 flex items-center justify-between">
            <span className="text-sm text-on-surface-variant">
              {result.scan.durationMs}ms · {result.manifest.tools.length} tools · {result.scan.walletAdapter} · chains: {result.scan.chains.join(', ') || '—'}
            </span>
            <button onClick={() => { setStep('input'); setResult(null); }} className="text-xs text-secondary hover:underline">Reset</button>
          </div>

          {/* Detected tools */}
          <div>
            <h2 className="text-lg font-semibold text-on-surface mb-2">Detected Tools</h2>
            {result.manifest.tools.length === 0 ? (
              <p className="text-on-surface-variant">No tools detected. Try a different dApp URL.</p>
            ) : (
              <ul className="space-y-1">
                {result.manifest.tools.map((t) => (
                  <li key={t.name} className="glass-panel rounded px-3 py-2">
                    <div className="flex justify-between items-center">
                      <span className="font-mono text-sm text-primary">{t.name}</span>
                      <span className="text-xs text-on-surface-variant">{t.serverCompatible ? '✓ server' : 'browser'}</span>
                    </div>
                    {t.description && <p className="mt-1 text-xs text-on-surface-variant">{t.description}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ─── MCP Config (the key output NIM wants) ─── */}
          <div>
            <h2 className="text-lg font-semibold text-on-surface mb-2">📋 MCP Config (paste into Claude/Cursor/Kiro)</h2>
            <pre className="rounded-lg bg-surface-container p-4 text-xs text-on-surface overflow-auto max-h-48">
              {JSON.stringify(result.mcpConfig, null, 2)}
            </pre>
            <button
              onClick={() => copyText(JSON.stringify(result.mcpConfig, null, 2), 'config')}
              className="mt-2 rounded border border-primary px-4 py-1.5 text-sm text-primary hover:bg-primary/10"
            >
              {copied === 'config' ? '✓ Copied!' : 'Copy Config'}
            </button>
          </div>

          {/* ─── Server file download ─── */}
          <div>
            <h2 className="text-lg font-semibold text-on-surface mb-2">🖥️ MCP Server (deploy to Lightsail)</h2>
            <p className="text-sm text-on-surface-variant mb-2">
              Download this file → upload to your server → run <code className="font-mono text-secondary">npx tsx webmcp-server.ts</code>
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => downloadFile(result.serverCode, 'webmcp-server.ts')}
                className="rounded border border-secondary px-4 py-1.5 text-sm text-secondary hover:bg-secondary/10"
              >
                Download webmcp-server.ts
              </button>
              <button
                onClick={() => copyText(result.serverCode, 'server')}
                className="rounded border border-outline-variant/40 px-4 py-1.5 text-sm text-on-surface-variant hover:bg-surface-container"
              >
                {copied === 'server' ? '✓ Copied!' : 'Copy Code'}
              </button>
            </div>
          </div>

          {/* ─── Manifest JSON ─── */}
          <details className="text-sm">
            <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
              Raw webmcp.json manifest
            </summary>
            <pre className="mt-2 rounded-lg bg-surface-container p-4 text-xs overflow-auto max-h-64">
              {JSON.stringify(result.manifest, null, 2)}
            </pre>
          </details>

          {/* ─── Deploy instructions ─── */}
          <div className="glass-panel rounded-lg p-4 text-sm text-on-surface-variant">
            <strong>Deploy steps:</strong>
            <ol className="mt-2 list-decimal pl-5 space-y-1">
              <li>Upload <code>webmcp-server.ts</code> to your Lightsail instance</li>
              <li>Install: <code>npm init -y && npm i tsx</code></li>
              <li>Run: <code>PORT=3002 npx tsx webmcp-server.ts</code></li>
              <li>Copy the MCP config above into your IDE settings (Claude/Cursor/Kiro)</li>
              <li>Your agent will auto-discover tools via JSON-RPC</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
