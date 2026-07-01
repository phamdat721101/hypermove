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
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-white">MCP Config</h2>
        <button onClick={() => onCopy(config, 'config')} className="flex items-center space-x-1 text-xs text-gray-400 hover:text-indigo-400 transition-colors">
          {copied === 'config' ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied === 'config' ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>
      <div className="flex gap-1 px-5 pt-3">
        {clients.map((c) => (
          <button key={c} onClick={() => setClient(c)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${client === c ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300 bg-gray-800/50'}`}>
            {c}
          </button>
        ))}
      </div>
      <pre className="p-5 text-xs text-gray-300 font-mono overflow-auto max-h-48">{config}</pre>
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
      <div className="absolute top-0 left-0 w-full h-[400px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/15 via-transparent to-transparent pointer-events-none" />

      <div className="mx-auto max-w-3xl px-4 pt-12 pb-20 sm:px-6">
        {/* Header */}
        <div className="mb-10">
          <span className="inline-block rounded-full border border-gray-700 bg-gray-800/50 px-3 py-1 text-xs font-mono text-gray-400 uppercase tracking-wider">
            Portal · MCP Generator
          </span>
          <h1 className="mt-4 font-display text-4xl font-bold text-white sm:text-5xl">
            Generate MCP Server
          </h1>
          <p className="mt-4 max-w-2xl text-gray-400">
            Paste a URL → AI crawls & analyzes → you get a deployable MCP server + config for your AI agent.
          </p>
        </div>

        {/* Input State */}
        {step === 'input' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 space-y-4">
              <div className="relative">
                <Globe className="absolute left-3.5 top-3 h-5 w-5 text-gray-500" />
                <input
                  type="url" value={url} onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleScan()}
                  placeholder="https://yield.goat.network"
                  className="w-full rounded-lg border border-gray-700 bg-gray-950 pl-11 pr-4 py-3 text-white placeholder:text-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none transition"
                />
              </div>
              <input
                type="text" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional) — e.g. BTC yield aggregator"
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-4 py-3 text-white placeholder:text-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none transition"
              />
              <button
                onClick={isConnected ? handleScan : openWalletModal} disabled={isConnected && !url.trim()}
                className="w-full flex items-center justify-center space-x-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 px-6 py-3.5 text-sm font-semibold text-white transition-all shadow-lg shadow-indigo-500/10"
              >
                {isConnected ? (
                  <><Sparkles className="h-4 w-4" /><span>Scan & Generate</span></>
                ) : (
                  <><Wallet className="h-4 w-4" /><span>Connect Wallet</span></>
                )}
              </button>
              {isConnected && quota && (
                <p className="text-center text-xs text-gray-500">
                  {quota.tier === 'pro' ? '✓ Pro — unlimited scans' : `${quota.free_remaining}/5 free scans remaining`}
                </p>
              )}
            </div>
            {error && <p className="text-sm text-red-400 text-center">{error}</p>}
            <p className="text-center text-xs text-gray-600">
              Try: yield.goat.network · app.uniswap.org · aave.com
            </p>
          </div>
        )}

        {/* Scanning State */}
        {step === 'scanning' && (
          <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-8 space-y-6">
            <div className="text-center">
              <Sparkles className="mx-auto h-8 w-8 text-indigo-400 animate-pulse" />
              <p className="mt-3 text-sm text-gray-400">{scanStep}</p>
            </div>
            <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-300" style={{ width: `${scanProgress}%` }} />
            </div>
            <p className="text-center text-xs text-gray-600 font-mono">{Math.round(scanProgress)}%</p>
          </div>
        )}

        {/* Result State */}
        {step === 'result' && result && (
          <div className="space-y-6">
            {/* Success banner */}
            <div className="flex items-center justify-between rounded-xl border border-green-800/40 bg-green-900/10 px-5 py-3">
              <div className="flex items-center space-x-2">
                <CheckCircle2 className="h-5 w-5 text-green-400" />
                <span className="text-sm text-green-300 font-medium">
                  {result.manifest.tools.length} tools detected
                </span>
              </div>
              <button onClick={() => { setStep('input'); setResult(null); refreshQuota(); }} className="flex items-center space-x-1 text-xs text-gray-400 hover:text-white">
                <RefreshCw className="h-3.5 w-3.5" />
                <span>New scan</span>
              </button>
            </div>

            {/* Tools list */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-800">
                <h2 className="text-sm font-semibold text-white">Detected Tools</h2>
              </div>
              <div className="divide-y divide-gray-800/60">
                {result.manifest.tools.map((t) => (
                  <div key={t.name} className="px-5 py-3 hover:bg-gray-800/20 transition-colors">
                    <span className="font-mono text-sm text-indigo-400">{t.name}</span>
                    <p className="mt-0.5 text-xs text-gray-500">{t.description}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* MCP Config — per client */}
            <McpConfigBlock mcpUrl={Object.values(result.mcpConfig.mcpServers as Record<string, {url:string}>)[0]?.url || ''} copied={copied} onCopy={copyText} />

            {/* Deploy buttons */}
            <div className="grid sm:grid-cols-2 gap-3">
              <button onClick={handleDownloadZip} className="flex items-center justify-center space-x-2 rounded-lg border border-gray-700 bg-gray-900/60 hover:bg-gray-800 px-5 py-3 text-sm font-medium text-white transition-colors">
                <Download className="h-4 w-4" />
                <span>Download ZIP</span>
              </button>
              <button onClick={() => copyText(JSON.stringify(result.mcpConfig, null, 2), 'hosted')} className="flex items-center justify-center space-x-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-5 py-3 text-sm font-medium text-white transition-all shadow-md shadow-indigo-500/10">
                <Terminal className="h-4 w-4" />
                <span>{copied === 'hosted' ? '✓ Copied!' : 'Host for me → Copy'}</span>
              </button>
            </div>
            <p className="text-xs text-gray-500">
              <strong className="text-gray-300">Self-host:</strong> Download ZIP, run on your server.{' '}
              <strong className="text-gray-300">Host for me:</strong> Already hosted — copy MCP config into your IDE.
            </p>

            {/* Raw manifest */}
            <details className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden">
              <summary className="px-5 py-3 text-sm font-medium text-gray-400 cursor-pointer hover:text-white transition-colors">
                Raw manifest JSON
              </summary>
              <pre className="px-5 pb-4 text-xs text-gray-400 font-mono overflow-auto max-h-64">
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
