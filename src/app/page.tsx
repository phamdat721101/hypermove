'use client';

import Link from 'next/link';
import { ArrowRight, Cloud, Zap, Shield, Layers } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SCRIPT } from '@/lib/agent';

const integrationTabs = [
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
<script src="https://hypermove.xyz/h/your-domain.com/webmcp.js" defer></script>` },
];

function CodeTabs() {
  const [active, setActive] = useState('declarative');
  const tab = integrationTabs.find((t) => t.id === active)!;
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a0a1a] overflow-hidden">
      <div className="flex border-b border-white/10">
        {integrationTabs.map((t) => (
          <button key={t.id} onClick={() => setActive(t.id)}
            className={`flex-1 px-4 py-3 text-xs font-medium transition-colors ${active === t.id ? 'text-hm-purple bg-white/5 border-b-2 border-hm-purple' : 'text-gray-500 hover:text-gray-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-5">
        <p className="text-xs text-gray-500 mb-3">{tab.desc}</p>
        <pre className="text-xs text-gray-400 font-mono overflow-auto max-h-48 whitespace-pre-wrap break-all">{tab.code}</pre>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [terminalLines, setTerminalLines] = useState<Array<{ label: string; detail?: string; kind: string }>>([]);
  const [terminalState, setTerminalState] = useState<'idle' | 'running' | 'done'>('idle');
  const terminalRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal to bottom when new lines appear
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalLines]);

  // Auto-run the demo dynamically on load and loop it — rendered entirely
  // client-side from the shared SCRIPT (no API calls, no agent budget spend),
  // so it stays a living demo of how an agent uses HyperMove's MCP config to
  // access web3, on every deploy at zero cost.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) => new Promise<void>((r) => { timer = setTimeout(r, ms); });

    const play = async () => {
      while (!cancelled) {
        setTerminalLines([]);
        setTerminalState('running');
        for (const frame of SCRIPT) {
          if (cancelled) return;
          setTerminalLines((prev) => [...prev, frame]);
          if (frame.delayMs > 0) await wait(frame.delayMs);
        }
        if (cancelled) return;
        setTerminalState('done');
        await wait(4000);
      }
    };

    void play();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // Load the animated gradient shader that backs the hero. Re-inits on the
  // #gradient-canvas if the script is already present (client-side nav).
  useEffect(() => {
    const instance = (window as unknown as { __gradientInstance?: { initGradient(sel: string): void } }).__gradientInstance;
    if (instance) {
      try { instance.initGradient('#gradient-canvas'); } catch {}
    } else if (!document.getElementById('gradient-script')) {
      const script = document.createElement('script');
      script.src = '/gradient.js';
      script.id = 'gradient-script';
      document.body.appendChild(script);
    }
  }, []);

  return (
    <div className="relative w-full overflow-hidden">
      {/* <section className="relative z-10 section-container py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 items-center justify-items-center">
          {['GOAT Network', 'Claude', 'Cursor', 'Kiro', 'Bedrock', 'Uniswap', 'Aave', 'OpenAI'].map((name) => (
            <span key={name} className="text-sm font-bold text-hm-grey-light tracking-wide uppercase">{name}</span>
          ))}
        </div>
      </section> */}

      {/* MCP-tools hero — animated gradient backdrop restores the color effect */}
      <section className="relative overflow-hidden pt-32 pb-20 min-h-[500px]">
        <canvas
          id="gradient-canvas"
          className="absolute inset-0 -z-10 h-full w-full"
          style={{
            '--gradient-color-1': '#ef008f',
            '--gradient-color-2': '#6ec3f4',
            '--gradient-color-3': '#7038ff',
            '--gradient-color-4': '#ffba27',
          } as React.CSSProperties}
        />
        <div className="section-container relative z-10">
          <p className="subtitle2">Unified platform</p>
          <h2 className="font-heading text-3xl md:text-4xl font-bold mt-2 mb-6 max-w-2xl text-white">
            All the MCP tools you&apos;ll ever need
          </h2>
          <div className="flex flex-col md:flex-row gap-8 mb-8">
            <p className="flex-1 text-white/85 text-lg leading-relaxed">
              We&apos;ve got everything you need to turn any website or dApp into an AI-agent-callable MCP server. Scan URLs, extract tools, generate configs — all from one platform across{' '}
              <a href="#" className="font-medium text-white underline decoration-white/40 hover:decoration-white">every major chain</a> and{' '}
              <a href="#" className="font-medium text-white underline decoration-white/40 hover:decoration-white">protocol</a>.
            </p>
            <p className="flex-1 text-white/85 text-lg leading-relaxed">
              We also help you <a href="#" className="font-medium text-white underline decoration-white/40 hover:decoration-white">monetize agent calls</a>,{' '}
              <a href="#" className="font-medium text-white underline decoration-white/40 hover:decoration-white">manage quotas</a>, and{' '}
              <a href="#" className="font-medium text-white underline decoration-white/40 hover:decoration-white">host MCP servers</a> — so AI agents can discover and pay for your tools on-chain.
            </p>
          </div>
          <Link href="/mcp-connect" className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-bold text-hm-primary tracking-wide transition-all hover:bg-white/90">
            Start now
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Graphic Grid */}
      <section className="bg-hm-bg py-12">
        <div className="section-container space-y-6">
          {/* Terminal Demo — full width */}
          <div className="rounded-2xl overflow-hidden bg-[#0a0a1a] shadow-xl flex flex-col">
            {/* Terminal header */}
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center space-x-3">
                <div className="flex space-x-2">
                  <div className="h-3 w-3 rounded-full bg-red-400" />
                  <div className="h-3 w-3 rounded-full bg-yellow-400" />
                  <div className="h-3 w-3 rounded-full bg-green-400" />
                </div>
                <span className="text-xs text-gray-400 font-mono uppercase tracking-wider">agent.sh · live demo</span>
              </div>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                terminalState === 'done' ? 'border-green-400 text-green-400' : 
                terminalState === 'running' ? 'border-hm-purple/40 text-hm-purple' : 
                'border-gray-600 text-gray-400'
              }`}>
                {terminalState === 'done' ? '✓ PAID' : terminalState === 'running' ? 'STREAMING' : 'READY'}
              </span>
            </div>
            {/* Terminal body */}
            <div ref={terminalRef} className="p-5 font-mono text-sm h-[320px] overflow-y-auto">
              <p className="text-gray-400">
                <span className="text-green-400">~</span> <span className="text-blue-400">$</span> agent run --target hypermove.xyz
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
                        <span className="text-blue-400">›</span> {frame.label}
                      </p>
                      {frame.detail && <p className="ml-4 text-gray-500 text-xs">{frame.detail}</p>}
                    </div>
                  ))}
                </div>
              )}
              {terminalState === 'running' && <span className="inline-block w-2 h-4 bg-hm-purple animate-pulse mt-2" />}
            </div>
            {/* Terminal footer */}
            <div className="flex items-center justify-between border-t border-white/10 px-4 py-2 mt-auto">
              <div className="text-xs text-gray-400 font-mono uppercase tracking-wider">
                Revenue ticker <span className="text-green-400 text-lg font-bold ml-2">${terminalState === 'done' ? '0.01' : '0.00'}</span>
                <span className="ml-2">· {terminalState === 'done' ? '1' : '0'} calls</span>
              </div>
              <span className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-gray-400">
                <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                Live demo
              </span>
            </div>
          </div>

        </div>
      </section>

      {/* Integrations Section (Dark) */}
      <section className="relative py-32 overflow-hidden">
        <div className="absolute inset-0 bg-hm-primary -skew-y-6 origin-top-left scale-110" />
        <div className="relative z-10 section-container">
          <div className="flex flex-col md:flex-row gap-16">
            <div className="flex-1 min-w-0">
              <p className="subtitle2">Designed for AI Agents</p>
              <h2 className="font-heading text-3xl md:text-4xl font-bold text-white mt-2 mb-4">
                The world&apos;s simplest MCP generation
              </h2>
              <p className="text-white/50 text-lg leading-relaxed mb-6">
                We abstract the hard stuff away so you can focus on building products, not writing MCP boilerplate. Paste a URL — get a working server.
              </p>
              <Link href="/mcp-connect" className="inline-flex items-center gap-2 rounded-full bg-hm-blue px-6 py-3 text-sm font-bold text-hm-dark tracking-wide transition-all hover:bg-white">
                Start now
                <ArrowRight className="h-4 w-4" />
              </Link>

              <div className="flex gap-6 mt-12">
                <div>
                  <img src="/assets/tools-icon.png" alt="" className="h-12 mb-3" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  <h3 className="text-white font-heading text-lg font-medium">Works with any IDE</h3>
                  <p className="text-white/50 text-sm mt-1">Claude Desktop, Cursor, Kiro, VS Code — any MCP client.</p>
                  <a href="/docs/quickstart" className="text-hm-blue text-sm font-bold mt-2 inline-flex items-center gap-1 hover:opacity-75">
                    See docs <ArrowRight className="h-3 w-3" />
                  </a>
                </div>
                <div>
                  <img src="/assets/cube-icon.png" alt="" className="h-12 mb-3" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  <h3 className="text-white font-heading text-lg font-medium">Auto-detect tools</h3>
                  <p className="text-white/50 text-sm mt-1">AI finds forms, buttons, APIs, DeFi actions automatically.</p>
                  <a href="/tools" className="text-hm-blue text-sm font-bold mt-2 inline-flex items-center gap-1 hover:opacity-75">
                    Explore catalog <ArrowRight className="h-3 w-3" />
                  </a>
                </div>
              </div>
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-4">
              <h3 className="font-heading text-xl font-bold text-white mb-2">Three integrations. Pick one — start in five minutes.</h3>
              <CodeTabs />
            </div>
          </div>
        </div>
      </section>

      {/* Why HyperMove */}
      <section className="py-24">
        <div className="section-container">
          <p className="subtitle">Why HyperMove</p>
          <h2 className="font-heading text-3xl md:text-4xl font-bold mt-2 mb-12 text-hm-primary">
            A tech-first approach to MCP
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {[
              { icon: Cloud, title: 'AI-Powered', desc: 'Advanced LLM analyzes pages to extract every action, form, and API endpoint automatically.' },
              { icon: Zap, title: 'Instant Setup', desc: 'From URL to working MCP server in under 15 seconds. No manual configuration needed.' },
              { icon: Shield, title: 'On-Chain Payment', desc: 'Pay with BTC on GOAT Network. No credit cards, no KYC, verified on-chain.' },
              { icon: Layers, title: 'Multi-Chain', desc: '27+ chains supported. EVM, XRPL, Stellar, Cosmos — all from one scan.' },
            ].map((card) => (
              <div key={card.title} className="swipe-card">
                <card.icon className="h-10 w-10 text-hm-purple mb-4" />
                <h3 className="font-heading text-xl font-medium text-hm-primary">{card.title}</h3>
                <p className="text-sm text-hm-grey mt-2">{card.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Global Section (Dark) */}
      <section className="relative py-32 overflow-hidden">
        <div className="absolute inset-0 bg-hm-primary -skew-y-6 origin-top-right scale-110" />
        <div className="relative z-10 section-container">
          <div className="flex flex-col md:flex-row gap-12 items-center">
            <div className="flex-1">
              <p className="subtitle2">Global scale</p>
              <h2 className="font-heading text-3xl md:text-4xl font-bold text-white mt-2 mb-4">
                Built for the agentic economy
              </h2>
              <p className="text-white/50 text-lg leading-relaxed">
                HyperMove makes AI-agent integration simple, borderless, and programmable — just like the rest of the internet. We support{' '}
                <a href="#" className="text-hm-blue hover:text-white">teams of all sizes</a>, from solo builders to enterprise.
              </p>
            </div>
            <div className="flex-1">
              <img src="/assets/global-graphic.png" alt="Global" className="w-full max-w-md opacity-25" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mt-16">
            {[
              { stat: '27+', desc: 'Chains supported across all major ecosystems' },
              { stat: '14', desc: 'Protocols integrated with full tool coverage' },
              { stat: '5s', desc: 'Average scan time from URL to MCP config' },
              { stat: '$5', desc: 'BTC/month for unlimited Pro scans' },
            ].map((item) => (
              <div key={item.stat}>
                <h3 className="font-heading text-3xl font-bold text-white border-l-2 border-hm-blue pl-3">{item.stat}</h3>
                <p className="text-white/50 text-sm mt-2">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Getting Started Section */}
      <section className="py-24">
        <div className="section-container">
          <div className="flex flex-col md:flex-row gap-12">
            <div className="flex-1">
              <h2 className="font-heading text-3xl md:text-4xl font-bold text-hm-primary">What are you waiting for?</h2>
              <p className="text-hm-grey text-lg mt-4 leading-relaxed">
                Explore <a href="/tools" className="text-hm-purple font-medium">HyperMove</a> now, or connect your wallet and start generating MCP servers today! Free tier includes 5 scans.
              </p>
              <Link href="/mcp-connect" className="btn-primary-purple mt-6">
                Start now
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="flex-1 flex gap-6">
              <div className="flex-1 bg-hm-bg rounded-xl p-6">
                <Shield className="h-8 w-8 text-hm-purple mb-3" />
                <h3 className="font-heading text-lg font-medium mb-2 text-hm-primary">Pay only per call</h3>
                <p className="text-sm text-hm-grey mb-4">5 free calls, then per-call USDC/RLUSD via x402 — no subscription, no card.</p>
                <Link href="/mcp-connect" className="btn-secondary">
                  Connect via MCP <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <div className="flex-1 bg-hm-bg rounded-xl p-6">
                <Zap className="h-8 w-8 text-hm-purple mb-3" />
                <h3 className="font-heading text-lg font-medium mb-2 text-hm-primary">Start your first scan</h3>
                <p className="text-sm text-hm-grey mb-4">Get up and running with HyperMove in under 60 seconds.</p>
                <Link href="/docs/quickstart" className="btn-secondary">
                  Quickstart guide <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
