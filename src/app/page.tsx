'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Zap, ArrowRight, Shield, Cpu, RefreshCcw, Terminal, Layers, CheckCircle } from 'lucide-react';

const tabs = [
  { id: 'declarative', label: 'Declarative · 3 lines', desc: 'Zero JS framework lock-in.', code: `<form data-tool-name="payment.send"
      data-tool-description="Send USDC to an Ethereum address">
  <input name="to" data-tool-format="address" required />
  <input name="amount" type="number" required />
  <button>Send</button>
</form>

<script type="module">
  import { initWeb3WebMCP } from 'https://esm.sh/@phamnim/web3-webmcp';
  await initWeb3WebMCP({ adapter: 'wagmi' });
</script>` },
  { id: 'imperative', label: 'Imperative · 5 lines', desc: 'Full type checking.', code: `import { initWeb3WebMCP, registerWeb3Tool, primitives } from '@phamnim/web3-webmcp';
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({ chains: ['goat-mainnet'], ows: { wallet: 'my-agent' } });
await initWeb3WebMCP({ adapter: 'wagmi', paymentClient: client });
registerWeb3Tool({
  ...primitives.payment.x402,
  monetize: { priceMicroUsdc: 1000n, payTo: '0xYourAddress', chainId: 2345 },
});` },
  { id: 'modeB', label: 'Mode B · 1 line', desc: 'We host the MCP proxy.', code: `<!-- Add to your <head>. That's literally the entire integration. -->
<script src="https://hypermove.dev/h/your-domain.com/webmcp.js" defer></script>` },
];

function CodeTabs() {
  const [active, setActive] = useState('declarative');
  const tab = tabs.find((t) => t.id === active)!;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 overflow-hidden">
      <div className="flex border-b border-gray-800">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setActive(t.id)}
            className={`flex-1 px-4 py-3 text-xs font-medium transition-colors ${active === t.id ? 'text-indigo-400 bg-gray-800/50 border-b-2 border-indigo-500' : 'text-gray-500 hover:text-gray-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-5">
        <p className="text-xs text-gray-500 mb-3">{tab.desc}</p>
        <pre className="text-xs text-gray-400 font-mono overflow-auto max-h-48">{tab.code}</pre>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [terminalLines, setTerminalLines] = useState<Array<{ label: string; detail?: string; kind: string }>>([]);
  const [terminalState, setTerminalState] = useState<'idle' | 'running' | 'done'>('idle');

  const runDemo = () => {
    if (terminalState !== 'idle') return;
    setTerminalState('running');
    setTerminalLines([]);
    const src = new EventSource('/api/agent');
    src.addEventListener('frame', (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(ev.data);
        setTerminalLines((prev) => [...prev, frame]);
      } catch {}
    });
    src.addEventListener('end', () => { setTerminalState('done'); src.close(); });
    src.addEventListener('error', () => { setTerminalState('done'); src.close(); });
  };

  return (
    <div className="relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[600px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-transparent to-transparent pointer-events-none" />

      {/* Hero */}
      <div className="mx-auto max-w-7xl px-4 pt-16 pb-20 sm:px-6 lg:px-8 text-center">
        <h1 className="mt-4 font-display text-5xl font-extrabold tracking-tight text-white sm:text-6xl md:text-7xl">
          Make any web3 dApp <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">
            agent-callable in 3 lines of HTML.
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-3xl text-lg text-gray-400 leading-relaxed">
          <code className="font-mono text-indigo-400">hypermove.dev</code> is the single destination where any web3 dApp becomes agent-callable and starts earning USDC per agent call in five minutes. The homepage IS the demo — watch an AI agent pay the page $0.01 in real time.
        </p>

        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link href="/portal/generate" className="group flex items-center space-x-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-6 py-3 text-sm font-semibold text-white transition-all shadow-lg shadow-indigo-500/10">
            <span>Scan Your URL Now</span>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link href="/portal" className="flex items-center space-x-1.5 rounded-lg border border-gray-800 bg-gray-900/40 hover:bg-gray-900 px-6 py-3 text-sm font-semibold text-gray-300 hover:text-white transition-colors">
            <Layers className="h-4 w-4" />
            <span>Browse Catalog</span>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-3 gap-8 max-w-2xl mx-auto text-center">
          <div>
            <p className="font-mono text-3xl font-bold text-indigo-400">27</p>
            <p className="text-xs text-gray-500 uppercase tracking-wider mt-1">Chains</p>
          </div>
          <div>
            <p className="font-mono text-3xl font-bold text-indigo-400">14</p>
            <p className="text-xs text-gray-500 uppercase tracking-wider mt-1">Protocols</p>
          </div>
          <div>
            <p className="font-mono text-3xl font-bold text-indigo-400">5 min</p>
            <p className="text-xs text-gray-500 uppercase tracking-wider mt-1">To first paid call</p>
          </div>
        </div>
      </div>

      {/* Terminal Demo */}
      <div className="mx-auto max-w-4xl px-4 pb-20">
        <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden shadow-2xl shadow-indigo-500/5">
          {/* Terminal header */}
          <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
            <div className="flex items-center space-x-3">
              <div className="flex space-x-2">
                <div className="h-3 w-3 rounded-full bg-red-500/70" />
                <div className="h-3 w-3 rounded-full bg-yellow-500/70" />
                <div className="h-3 w-3 rounded-full bg-green-500/70" />
              </div>
              <span className="text-xs text-gray-400 font-mono uppercase tracking-wider">agent.sh · live demo</span>
            </div>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              terminalState === 'done' ? 'border-green-500/40 text-green-400' : 
              terminalState === 'running' ? 'border-indigo-500/40 text-indigo-400' : 
              'border-gray-600 text-gray-400'
            }`}>
              {terminalState === 'done' ? '✓ PAID' : terminalState === 'running' ? 'STREAMING' : 'READY'}
            </span>
          </div>

          {/* Terminal body */}
          <div className="p-5 font-mono text-sm min-h-[280px] max-h-[320px] overflow-y-auto">
            <p className="text-gray-500">
              <span className="text-green-400">~</span> <span className="text-indigo-400">$</span> agent run --target hypermove.dev
            </p>
            {terminalLines.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5">
                {terminalLines.map((frame, i) => (
                  <div key={i}>
                    <p className={`${
                      frame.kind === 'paywall.200' || frame.kind === 'done' ? 'text-green-400' :
                      frame.kind === 'paywall.402' ? 'text-yellow-400' :
                      frame.kind === 'revenue.tick' ? 'text-emerald-400' :
                      'text-gray-300'
                    }`}>
                      <span className="text-indigo-400">›</span> {frame.label}
                    </p>
                    {frame.detail && <p className="ml-4 text-gray-600 text-xs">{frame.detail}</p>}
                  </div>
                ))}
              </div>
            )}
            {terminalState === 'running' && <span className="inline-block w-2 h-4 bg-indigo-400 animate-pulse mt-2" />}
          </div>

          {/* Terminal footer */}
          <div className="flex items-center justify-between border-t border-gray-800 px-4 py-3">
            <div className="text-xs text-gray-500 font-mono uppercase tracking-wider">
              Revenue ticker <span className="text-green-400 text-lg font-bold ml-2">${terminalState === 'done' ? '0.01' : '0.00'}</span>
              <span className="ml-2">· {terminalState === 'done' ? '1' : '0'} calls</span>
            </div>
            <button
              onClick={terminalState === 'idle' ? runDemo : () => { setTerminalLines([]); setTerminalState('idle'); }}
              disabled={terminalState === 'running'}
              className="rounded-lg border border-gray-700 px-4 py-1.5 text-xs font-medium text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-50 transition-colors"
            >
              {terminalState === 'done' ? '↻ Replay' : terminalState === 'running' ? 'Running…' : '▶ Run agent'}
            </button>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
        <h2 className="text-center font-display text-3xl font-bold text-white mb-12">How it works</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            { icon: Cpu, title: '1. Paste any URL', desc: 'Drop a link to any website, dApp, or API documentation page.' },
            { icon: Zap, title: '2. AI Analyzes', desc: 'Our LLM crawls the page, extracts every action, form, and tool.' },
            { icon: CheckCircle, title: '3. Agent Connects', desc: 'Get MCP config — paste into Claude, Cursor, or Kiro. Done.' },
          ].map((step) => (
            <div key={step.title} className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 text-center">
              <step.icon className="mx-auto h-8 w-8 text-indigo-400 mb-4" />
              <h3 className="font-display text-lg font-semibold text-white mb-2">{step.title}</h3>
              <p className="text-sm text-gray-400">{step.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Features grid */}
      <div className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            { icon: Shield, title: '27 Chains Supported', desc: 'EVM, XRPL, Stellar, Cosmos, Solana — all from one scan.' },
            { icon: Terminal, title: 'MCP Spec Compliant', desc: 'Works with Claude Desktop, Cursor, Kiro, AWS Bedrock.' },
            { icon: RefreshCcw, title: 'Instant Deploy', desc: 'Download ZIP to self-host, or we host it for you — one click.' },
            { icon: Layers, title: 'Auto-detect Tools', desc: 'AI finds forms, buttons, APIs, DeFi actions automatically.' },
            { icon: Zap, title: 'Fast Scan', desc: 'Crawl + AI analysis in 5-15 seconds. No manual configuration.' },
            { icon: CheckCircle, title: 'Free to Start', desc: 'Scan unlimited URLs. Pay only for hosted MCP (optional).' },
          ].map((f) => (
            <div key={f.title} className="rounded-lg border border-gray-800/60 bg-gray-900/30 p-5">
              <f.icon className="h-5 w-5 text-indigo-400 mb-3" />
              <h4 className="text-sm font-semibold text-white mb-1">{f.title}</h4>
              <p className="text-xs text-gray-500">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Code Examples — tabbed */}
      <div className="mx-auto max-w-4xl px-4 pb-20 sm:px-6 lg:px-8">
        <h2 className="text-center font-display text-3xl font-bold text-white mb-8">Three integrations. Pick one — start in five minutes.</h2>
        <CodeTabs />
      </div>

    </div>
  );
}
