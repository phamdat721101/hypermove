'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { Globe, Sparkles, CheckCircle2, Copy, Check, Download, RefreshCw, Terminal, Wallet } from 'lucide-react';
import { useWalletModal } from '@/lib/wallet-modal-context';
import UpgradeModal from '@/components/UpgradeModal';

interface ScanResponse {
  manifest: { name: string; description: string; tools: Array<{ name: string; description: string; inputSchema: unknown }>; sourceUrl: string };
  mcpConfig: Record<string, unknown>;
  crawlData?: { url: string; title: string; toolCount: number };
}

type Step = 'input' | 'scanning' | 'result';

const clients = ['Kiro / Cursor / Claude CLI', 'Claude Desktop / Windsurf'] as const;
type Client = typeof clients[number];

function McpConfigBlock({ mcpUrl, copied, onCopy }: { mcpUrl: string; copied: string; onCopy: (t: string, id: string) => void }) {
  const [client, setClient] = useState<Client>(clients[0]);

  const name = mcpUrl.split('/').pop() || 'mcp-server';

  const configs: Record<Client, string> = {
    'Kiro / Cursor / Claude CLI': JSON.stringify({ mcpServers: { [name]: { url: mcpUrl } } }, null, 2),
    'Claude Desktop / Windsurf': JSON.stringify({ mcpServers: { [name]: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl] } } }, null, 2),
  };

  const config = configs[client];

  return (
    <div className="rounded-xl border border-hm-accent bg-white overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-hm-accent">
        <h2 className="text-sm font-semibold text-hm-primary">MCP Config</h2>
        <button onClick={() => onCopy(config, 'config')} className="flex items-center space-x-1 text-xs text-hm-grey hover:text-hm-purple transition-colors">
          {copied === 'config' ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied === 'config' ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>
      <div className="flex gap-1 px-5 pt-3">
        {clients.map((c) => (
          <button key={c} onClick={() => setClient(c)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${client === c ? 'bg-hm-purple text-white' : 'text-hm-grey hover:text-hm-dark bg-hm-muted'}`}>
            {c}
          </button>
        ))}
      </div>
      <pre className="p-5 text-xs text-hm-dark font-mono overflow-auto max-h-48 bg-hm-bg">{config}</pre>
    </div>
  );
}

export default function GenerateContent() {
  const { isConnected, address } = useAccount();
  const { open: openWalletModal } = useWalletModal();

  function getLlmApi() {
    const rawLlmApi = (process.env.NEXT_PUBLIC_LLM_API_URL || '').replace(/\/+$/, '');
    const isLocalHostname = (h: string) => /^(localhost|127\.|0\.0\.0\.0|\[?::1?\]?)$/i.test(h);
    const browserOnLocalhost = typeof window !== 'undefined' && isLocalHostname(window.location.hostname);
    const rawApiIsLocal = !rawLlmApi || /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1?\]?)(?::|\/|$)/i.test(rawLlmApi);
    return browserOnLocalhost && !rawApiIsLocal
      ? `${window.location.protocol}//${window.location.hostname}:3001`
      : rawLlmApi;
  }
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [scanProgress, setScanProgress] = useState(0);
  const [scanStep, setScanStep] = useState('');
  const [quota, setQuota] = useState<{ free_remaining: number; tier: string } | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);

  // Fetch quota when wallet connects
  useEffect(() => {
    if (isConnected && address) { refreshQuota(); }
  }, [isConnected, address]);

  function refreshQuota() {
    if (!address) return;
    const api = getLlmApi();
    fetch(`${api}/quota?wallet=${address}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data && 'free_remaining' in data) setQuota(data); })
      .catch(() => {});
  }

  const scanSteps = [
    'Crawling target page...',
    'Fetching JS bundles...',
    'Parsing page structure...',
    'AI analyzing content...',
    'Generating MCP tools...',
    'Building server bundle...',
  ];

  async function handleScan() {
    if (!url.trim()) return;
    if (!isConnected || !address) { openWalletModal(); return; }

    // Check quota via BE
    const llmApi = getLlmApi();
    const quotaCheck = await fetch(`${llmApi}/quota?wallet=${address}`);
    if (quotaCheck.ok) {
      const q = await quotaCheck.json();
      if (q.tier !== 'pro' && q.free_remaining <= 0) { setShowUpgrade(true); return; }
    }

    setError('');
    setStep('scanning');
    setScanProgress(0);

    // Animate progress
    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 12 + 3;
      if (progress > 95) progress = 95;
      setScanProgress(progress);
      setScanStep(scanSteps[Math.min(Math.floor((progress / 100) * scanSteps.length), scanSteps.length - 1)]);
    }, 500);

    try {
      const scanEndpoint = llmApi ? `${llmApi}/scan` : '/api/scan';
      const hostOverride = (process.env.NEXT_PUBLIC_MCP_HOST_URL || '').replace(/\/+$/, '');
      const res = await fetch(scanEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), wallet: address, ...(hostOverride ? { host: hostOverride } : {}) }),
      });
      const data = await res.json();
      clearInterval(interval);
      setScanProgress(100);
      if (!res.ok) { setError(data.error || 'Scan failed'); setStep('input'); return; }
      setTimeout(() => { setResult(data); setStep('result'); }, 400);
      // Consume quota via BE after successful scan
      fetch(`${llmApi}/quota/consume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: address }) }).catch(() => {});
      // Refresh quota display
      setTimeout(refreshQuota, 500);
    } catch (e) {
      clearInterval(interval);
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
      body: JSON.stringify({ url: result.manifest.sourceUrl, manifest: result.manifest }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${result.manifest.name}.zip`;
    a.click();
  }

  return (
    <div className="relative min-h-[calc(100vh-64px)]">
      <div className="section-container pt-24 pb-20">
        {/* Header */}
        <div className="mb-10">
          <span className="inline-block rounded-full border border-hm-accent bg-hm-muted px-3 py-1 text-xs font-mono text-hm-grey uppercase tracking-wider">
            Portal · MCP Generator
          </span>
          <h1 className="mt-4 font-heading text-4xl font-bold text-hm-primary sm:text-5xl">
            Generate MCP Server
          </h1>
          <p className="mt-4 max-w-2xl text-hm-grey">
            Paste a URL → AI crawls & analyzes → you get a deployable MCP server + config for your AI agent.
          </p>
        </div>

        {/* Input State */}
        {step === 'input' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-hm-accent bg-white p-6 space-y-4 shadow-sm">
              <div className="relative">
                <Globe className="absolute left-3.5 top-3 h-5 w-5 text-hm-grey" />
                <input
                  type="url" value={url} onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleScan()}
                  placeholder="https://yield.goat.network"
                  className="w-full rounded-lg border border-hm-accent bg-hm-bg pl-11 pr-4 py-3 text-hm-dark placeholder:text-hm-grey-light focus:border-hm-purple focus:ring-1 focus:ring-hm-purple focus:outline-none transition"
                />
              </div>
              <input
                type="text" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional) — e.g. BTC yield aggregator"
                className="w-full rounded-lg border border-hm-accent bg-hm-bg px-4 py-3 text-hm-dark placeholder:text-hm-grey-light focus:border-hm-purple focus:ring-1 focus:ring-hm-purple focus:outline-none transition"
              />
              <button
                onClick={isConnected ? handleScan : openWalletModal} disabled={isConnected && !url.trim()}
                className="w-full flex items-center justify-center space-x-2 rounded-lg bg-hm-purple hover:bg-hm-purple/90 disabled:opacity-40 disabled:hover:bg-hm-purple px-6 py-3.5 text-sm font-semibold text-white transition-all shadow-lg shadow-hm-purple/10"
              >
                {isConnected ? (
                  <><Sparkles className="h-4 w-4" /><span>Scan & Generate</span></>
                ) : (
                  <><Wallet className="h-4 w-4" /><span>Connect Wallet</span></>
                )}
              </button>
              {isConnected && quota && (
                <p className="text-center text-xs text-hm-grey">
                  {quota.tier === 'pro' ? '✓ Pro — unlimited scans' : `${quota.free_remaining}/5 free scans remaining`}
                </p>
              )}
            </div>
            {error && <p className="text-sm text-red-600 text-center">{error}</p>}
            <p className="text-center text-xs text-hm-grey">
              Try: yield.goat.network · app.uniswap.org · aave.com
            </p>
          </div>
        )}

        {/* Scanning State */}
        {step === 'scanning' && (
          <div className="rounded-xl border border-hm-accent bg-white p-8 space-y-6 shadow-sm">
            <div className="text-center">
              <Sparkles className="mx-auto h-8 w-8 text-hm-purple animate-pulse" />
              <p className="mt-3 text-sm text-hm-grey">{scanStep}</p>
            </div>
            <div className="w-full h-1.5 bg-hm-muted rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-hm-purple to-hm-blue rounded-full transition-all duration-300" style={{ width: `${scanProgress}%` }} />
            </div>
            <p className="text-center text-xs text-hm-grey font-mono">{Math.round(scanProgress)}%</p>
          </div>
        )}

        {/* Result State */}
        {step === 'result' && result && (
          <div className="space-y-6">
            {/* Success banner */}
            <div className="flex items-center justify-between rounded-xl border border-green-200 bg-green-50 px-5 py-3">
              <div className="flex items-center space-x-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <span className="text-sm text-green-700 font-medium">
                  {result.manifest.tools.length} tools detected
                </span>
              </div>
              <button onClick={() => { setStep('input'); setResult(null); refreshQuota(); }} className="flex items-center space-x-1 text-xs text-hm-grey hover:text-hm-dark">
                <RefreshCw className="h-3.5 w-3.5" />
                <span>New scan</span>
              </button>
            </div>

            {/* Tools list */}
            <div className="rounded-xl border border-hm-accent bg-white overflow-hidden shadow-sm">
              <div className="px-5 py-3 border-b border-hm-accent">
                <h2 className="text-sm font-semibold text-hm-primary">Detected Tools</h2>
              </div>
              <div className="divide-y divide-hm-accent">
                {result.manifest.tools.map((t) => (
                  <div key={t.name} className="px-5 py-3 hover:bg-hm-bg transition-colors">
                    <span className="font-mono text-sm text-hm-purple">{t.name}</span>
                    <p className="mt-0.5 text-xs text-hm-grey">{t.description}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* MCP Config — per client */}
            <McpConfigBlock mcpUrl={Object.values(result.mcpConfig.mcpServers as Record<string, {url:string}>)[0]?.url || ''} copied={copied} onCopy={copyText} />

            {/* Deploy buttons */}
            <div className="grid sm:grid-cols-2 gap-3">
              <button onClick={handleDownloadZip} className="flex items-center justify-center space-x-2 rounded-lg border border-hm-accent bg-white hover:bg-hm-bg px-5 py-3 text-sm font-medium text-hm-dark transition-colors">
                <Download className="h-4 w-4" />
                <span>Download ZIP</span>
              </button>
              <button onClick={() => copyText(JSON.stringify(result.mcpConfig, null, 2), 'hosted')} className="flex items-center justify-center space-x-2 rounded-lg bg-hm-purple hover:bg-hm-purple/90 px-5 py-3 text-sm font-medium text-white transition-all shadow-md shadow-hm-purple/10">
                <Terminal className="h-4 w-4" />
                <span>{copied === 'hosted' ? '✓ Copied!' : 'Host for me → Copy'}</span>
              </button>
            </div>
            <p className="text-xs text-hm-grey">
              <strong className="text-hm-dark">Self-host:</strong> Download ZIP, run on your server.{' '}
              <strong className="text-hm-dark">Host for me:</strong> Already hosted — copy MCP config into your IDE.
            </p>

            {/* Raw manifest */}
            <details className="rounded-xl border border-hm-accent bg-white overflow-hidden shadow-sm">
              <summary className="px-5 py-3 text-sm font-medium text-hm-grey cursor-pointer hover:text-hm-dark transition-colors">
                Raw manifest JSON
              </summary>
              <pre className="px-5 pb-4 text-xs text-hm-dark font-mono overflow-auto max-h-64 bg-hm-bg">
                {JSON.stringify(result.manifest, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
      <UpgradeModal
        isOpen={showUpgrade}
        onClose={() => setShowUpgrade(false)}
        onSuccess={() => {
          setShowUpgrade(false);
          refreshQuota();
        }}
      />
    </div>
  );
}
