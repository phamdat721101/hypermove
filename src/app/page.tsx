'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Zap, ArrowRight, Shield, Cpu, RefreshCcw, Terminal, Layers, CheckCircle } from 'lucide-react';

export default function HomePage() {
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [terminalState, setTerminalState] = useState<'idle' | 'running' | 'done'>('idle');

  const runDemo = () => {
    if (terminalState !== 'idle') return;
    setTerminalState('running');
    setTerminalLines([]);
    const lines = [
      '$ hypermove scan https://yield.goat.network',
      '📡 Crawling HTML + JS bundles...',
      '⚙ Parsing page structure & content...',
      '🤖 AI analyzing actions & tools...',
      '✔ 9 tools detected (deposit, stake, lend, borrow...)',
      '✔ MCP Server generated!',
      '🚀 Hosted at https://hypermove.duckdns.org/0x.../yield-goat-network-mcp',
    ];
    let i = 0;
    const interval = setInterval(() => {
      if (i < lines.length) { setTerminalLines((p) => [...p, lines[i]]); i++; }
      else { clearInterval(interval); setTerminalState('done'); }
    }, 600);
  };

  return (
    <div className="relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-[600px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-transparent to-transparent pointer-events-none" />

      {/* Hero */}
      <div className="mx-auto max-w-7xl px-4 pt-16 pb-20 sm:px-6 lg:px-8 text-center">
        <span className="inline-flex items-center space-x-1.5 rounded-full bg-indigo-500/10 px-3.5 py-1 text-xs font-semibold text-indigo-400 border border-indigo-500/20">
          <Zap className="h-3.5 w-3.5" />
          <span>Powered by AI · Works with Claude, Cursor, Kiro</span>
        </span>
        <h1 className="mt-4 font-display text-5xl font-extrabold tracking-tight text-white sm:text-6xl md:text-7xl">
          Turn Any Website Into An <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">
            AI-Agent Tool
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-3xl text-lg text-gray-400 leading-relaxed">
          Paste a URL. Our AI crawls the page, detects every action, and generates an MCP server — in seconds. Your AI agent connects immediately.
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

      {/* Terminal Demo */}
      <div className="mx-auto max-w-4xl px-4 pb-20">
        <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden shadow-2xl shadow-indigo-500/5">
          <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
            <div className="flex space-x-2">
              <div className="h-3 w-3 rounded-full bg-red-500/70" />
              <div className="h-3 w-3 rounded-full bg-yellow-500/70" />
              <div className="h-3 w-3 rounded-full bg-green-500/70" />
            </div>
            <span className="text-xs text-gray-500 font-mono">terminal</span>
            <button
              onClick={terminalState === 'idle' ? runDemo : () => { setTerminalLines([]); setTerminalState('idle'); }}
              className="flex items-center space-x-1 text-xs text-gray-400 hover:text-white transition-colors"
            >
              <Terminal className="h-3.5 w-3.5" />
              <span>{terminalState === 'idle' ? 'Run demo' : terminalState === 'running' ? 'Running...' : 'Reset'}</span>
            </button>
          </div>
          <div className="p-5 font-mono text-sm min-h-[240px]">
            {terminalLines.length === 0 && (
              <p className="text-gray-600">Click &quot;Run demo&quot; to see HyperMove in action...</p>
            )}
            {terminalLines.map((line, i) => (
              <p key={i} className={`${line.startsWith('$') ? 'text-indigo-400' : line.startsWith('✔') || line.startsWith('🚀') ? 'text-green-400' : 'text-gray-400'} leading-7`}>
                {line}
              </p>
            ))}
            {terminalState === 'running' && <span className="inline-block w-2 h-4 bg-indigo-400 animate-pulse" />}
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

      {/* Final CTA */}
      <div className="mx-auto max-w-3xl px-4 pb-24 text-center">
        <h2 className="font-display text-3xl font-bold text-white mb-4">Ready to make your site agent-callable?</h2>
        <Link href="/portal/generate" className="inline-flex items-center space-x-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-8 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/10 transition-all">
          <span>Try it free — paste any URL</span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
