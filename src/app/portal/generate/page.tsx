'use client';

import { useState } from 'react';

interface ScanResponse {
  scan: { url: string; durationMs: number; toolCount: number } | null;
  manifest: { name: string; version: string; description: string; tools: Array<{ name: string; description: string; inputSchema: unknown }>; sourceUrl: string };
  serverCode: string;
  mcpConfig: Record<string, unknown>;
  saved?: { id?: number; slug?: string; cached?: boolean };
}

type Step = 'input' | 'scanning' | 'result';

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
      const llmApi = process.env.NEXT_PUBLIC_LLM_API_URL || 'http://localhost:3001';
      const res = await fetch(`${llmApi}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), host: host.trim() || undefined, wallet: undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Scan failed'); setStep('input'); return; }
      setResult(data);
      setStep('result');
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

  async function handleDownloadZip() {
    if (!result) return;
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: result.manifest.sourceUrl, manifest: result.manifest, serverCode: result.serverCode, host: host.trim() || undefined }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${result.manifest.name}.zip`;
    a.click();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 md:px-8 md:py-20">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          Generate MCP Server <span className="gradient-text-purple-cyan">from any URL</span>
        </h1>
        <p className="mt-2 text-on-surface-variant">
          Paste URL → we crawl everything → AI analyzes → you get an MCP server.
        </p>
      </header>

      {/* Input */}
      {step === 'input' && (
        <div className="space-y-4">
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleScan()}
            placeholder="https://yield.goat.network" className="w-full rounded-lg border border-outline-variant/40 bg-surface-container px-4 py-3 text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:outline-none" />
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)}
            placeholder="Server IP/domain for MCP config (leave empty for hosted)"
            className="w-full rounded-lg border border-outline-variant/40 bg-surface-container px-4 py-3 text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:outline-none" />
          <button onClick={handleScan} disabled={!url.trim()} className="w-full rounded-lg bg-primary px-6 py-3 font-medium text-on-primary disabled:opacity-50">
            Scan & Generate
          </button>
          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      )}

      {/* Scanning */}
      {step === 'scanning' && (
        <div className="flex items-center gap-3 py-12">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-on-surface-variant">Crawling & analyzing {url}...</span>
        </div>
      )}

      {/* Result */}
      {step === 'result' && result && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="glass-panel rounded-lg p-4 flex items-center justify-between">
            <span className="text-sm text-on-surface-variant">
              {result.scan?.durationMs || 0}ms · {result.manifest.tools.length} tools
              {result.saved?.cached && ' · (cached)'}
            </span>
            <button onClick={() => { setStep('input'); setResult(null); }} className="text-xs text-secondary hover:underline">Reset</button>
          </div>

          {/* Tools */}
          <div>
            <h2 className="text-lg font-semibold text-on-surface mb-2">Detected Tools ({result.manifest.tools.length})</h2>
            {result.manifest.tools.length === 0 ? (
              <p className="text-on-surface-variant">No tools detected.</p>
            ) : (
              <ul className="space-y-1">
                {result.manifest.tools.map((t) => (
                  <li key={t.name} className="glass-panel rounded px-3 py-2">
                    <span className="font-mono text-sm text-primary">{t.name}</span>
                    <p className="mt-0.5 text-xs text-on-surface-variant">{t.description}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* MCP Config */}
          <div>
            <h2 className="text-lg font-semibold text-on-surface mb-2">📋 MCP Config</h2>
            <pre className="rounded-lg bg-surface-container p-4 text-xs text-on-surface overflow-auto max-h-48">
              {JSON.stringify(result.mcpConfig, null, 2)}
            </pre>
            <button onClick={() => copyText(JSON.stringify(result.mcpConfig, null, 2), 'config')}
              className="mt-2 rounded border border-primary px-4 py-1.5 text-sm text-primary hover:bg-primary/10">
              {copied === 'config' ? '✓ Copied!' : 'Copy Config'}
            </button>
          </div>

          {/* Deploy options */}
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-on-surface">🚀 Deploy</h2>
            <div className="flex gap-3 flex-wrap">
              <button onClick={handleDownloadZip} className="rounded-lg bg-secondary px-5 py-2.5 text-sm font-medium text-on-primary hover:opacity-90">
                Download ZIP (self-host)
              </button>
              <button onClick={() => copyText(JSON.stringify(result.mcpConfig, null, 2), 'hosted')}
                className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary hover:opacity-90">
                {copied === 'hosted' ? '✓ Copied!' : 'Host for me → Copy Config'}
              </button>
            </div>
            <p className="text-xs text-on-surface-variant">
              <strong>Self-host:</strong> Download ZIP, run on your server. <strong>Host for me:</strong> Already hosted — copy MCP config into your IDE.
            </p>
          </div>

          {/* Raw manifest */}
          <details className="text-sm">
            <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">Raw manifest JSON</summary>
            <pre className="mt-2 rounded-lg bg-surface-container p-4 text-xs overflow-auto max-h-64">
              {JSON.stringify(result.manifest, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
