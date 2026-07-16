'use client';

import { useEffect, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useWalletModal } from '@/lib/wallet-modal-context';
import { Plug, Shield, Zap, Copy, Check } from 'lucide-react';

type GatewayState = { gatewayEnabled: boolean; authRequired: boolean } | null;

const MCP_CLIENTS = ['Kiro / Cursor / Claude CLI', 'Claude Desktop / Windsurf', 'curl (raw)'] as const;
type McpClient = (typeof MCP_CLIENTS)[number];

function McpConfigBlock({ origin, token }: { origin: string; token?: string }) {
  const [client, setClient] = useState<McpClient>(MCP_CLIENTS[0]);
  const [copied, setCopied] = useState(false);
  const url = `${origin}/api/mcp`;
  const authHeader = token ? { Authorization: `Bearer ${token}` } : undefined;
  const remoteArgs = ['-y', 'mcp-remote', url, ...(token ? ['--header', `Authorization: Bearer ${token}`] : [])];

  const snippets: Record<McpClient, string> = {
    'Kiro / Cursor / Claude CLI': JSON.stringify(
      { mcpServers: { hypermove: { url, ...(authHeader ? { headers: authHeader } : {}) } } },
      null,
      2,
    ),
    'Claude Desktop / Windsurf': JSON.stringify(
      { mcpServers: { hypermove: { command: 'npx', args: remoteArgs } } },
      null,
      2,
    ),
    'curl (raw)': [
      `curl ${url} \\`,
      token ? `  -H "authorization: Bearer ${token}" \\` : null,
      '  -H "content-type: application/json" \\',
      '  -H "accept: application/json, text/event-stream" \\',
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
  const snippet = snippets[client];

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-hm-accent bg-[#0a0a1a]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {MCP_CLIENTS.map((c) => (
            <button
              key={c}
              onClick={() => setClient(c)}
              className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${client === c ? 'bg-hm-purple text-white' : 'text-gray-400 hover:text-white'}`}
            >
              {c}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="shrink-0 flex items-center gap-1 rounded border border-white/20 px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-xs text-gray-300 leading-relaxed">{snippet}</pre>
    </div>
  );
}

export default function McpConnectPage() {
  const token = useTokenFromQuery();
  const state = useGatewayState();
  const origin = useOrigin();

  return (
    <div className="section-container pt-28 pb-20 flex-1">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <span className="inline-block rounded-full border border-hm-accent bg-hm-muted px-3 py-1 text-xs font-mono text-hm-grey uppercase tracking-wider">
            MCP Gateway
          </span>
          <h1 className="mt-4 font-heading text-4xl font-bold text-hm-primary sm:text-5xl">
            Connect your agent
          </h1>
          <p className="mt-4 max-w-2xl text-hm-grey">
            Call <code className="rounded bg-hm-muted px-1.5 py-0.5 font-mono text-xs text-hm-purple">{origin}/api/mcp</code> from
            any MCP-compatible agent. 10 free queries / 24h, then metered x402/MPP.
          </p>
        </div>

        {/* Features row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="flex items-center gap-3 rounded-xl border border-hm-accent bg-white p-4">
            <Plug className="h-5 w-5 text-hm-purple shrink-0" />
            <div>
              <p className="text-sm font-medium text-hm-primary">Streamable HTTP</p>
              <p className="text-xs text-hm-grey">Real MCP protocol</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-hm-accent bg-white p-4">
            <Zap className="h-5 w-5 text-hm-purple shrink-0" />
            <div>
              <p className="text-sm font-medium text-hm-primary">10 free / day</p>
              <p className="text-xs text-hm-grey">No card required</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-hm-accent bg-white p-4">
            <Shield className="h-5 w-5 text-hm-purple shrink-0" />
            <div>
              <p className="text-sm font-medium text-hm-primary">Wallet auth</p>
              <p className="text-xs text-hm-grey">Sign once, no gas</p>
            </div>
          </div>
        </div>

        {/* Auth / Token section */}
        {token ? (
          <TokenPanel token={token} origin={origin} />
        ) : state === null ? (
          <div className="mt-8 text-center py-8">
            <div className="h-6 w-6 border-2 border-hm-purple border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="mt-3 text-sm text-hm-grey">Checking gateway status…</p>
          </div>
        ) : state.authRequired ? (
          <WalletAuthPanel origin={origin} />
        ) : (
          <NoAuthPanel gatewayEnabled={state.gatewayEnabled} origin={origin} />
        )}
      </div>
    </div>
  );
}

function useTokenFromQuery(): string | null {
  const [token] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('token');
  });
  return token;
}

function useOrigin(): string {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

function useGatewayState(): GatewayState {
  const [state, setState] = useState<GatewayState>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/mcp/health')
      .then((res) => res.json())
      .then((body: { gateway_enabled?: boolean; auth_required?: boolean }) => {
        if (!cancelled) setState({ gatewayEnabled: !!body.gateway_enabled, authRequired: !!body.auth_required });
      })
      .catch(() => {
        if (!cancelled) setState({ gatewayEnabled: false, authRequired: false });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

function NoAuthPanel({ gatewayEnabled, origin }: { gatewayEnabled: boolean; origin: string }) {
  return (
    <div className="rounded-xl border border-hm-accent bg-white p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-hm-purple/10 p-2">
          <Plug className="h-5 w-5 text-hm-purple" />
        </div>
        <div>
          <p className="text-sm font-medium text-hm-primary">No sign-in required</p>
          <p className="mt-1 text-xs text-hm-grey">
            {gatewayEnabled
              ? 'Auth is disabled. Set FEATURE_MCP_AUTH_WORKOS=true to require wallet-signed keys.'
              : 'Gateway is in legacy mode. Add this to your MCP client config — it works without authentication.'}
          </p>
        </div>
      </div>
      <McpConfigBlock origin={origin} />
    </div>
  );
}

function WalletAuthPanel({ origin }: { origin: string }) {
  const { address, isConnected } = useAccount();
  const { open } = useWalletModal();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);

  async function getKey() {
    if (!address) return;
    setError(null);
    setIssuing(true);
    try {
      const message = `Sign in to HyperMove MCP Gateway\naddress: ${address}\ntimestamp: ${Date.now()}`;
      const signature = await signMessageAsync({ message });
      const res = await fetch('/api/mcp/wallet-auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, message, signature }),
      });
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? 'sign-in failed');
      const url = new URL(window.location.href);
      url.searchParams.set('token', body.token);
      window.location.href = url.toString();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sign-in failed');
    } finally {
      setIssuing(false);
    }
  }

  return (
    <div className="rounded-xl border border-hm-purple/20 bg-hm-purple/5 p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-hm-purple/10 p-2">
          <Shield className="h-5 w-5 text-hm-purple" />
        </div>
        <div>
          <p className="font-medium text-hm-primary">Connect your wallet to get a key</p>
          <p className="mt-1 text-sm text-hm-grey">
            One signature (free, no gas) proves you own the address. No account, no password.
          </p>
        </div>
      </div>

      <div className="mt-6">
        {!isConnected ? (
          <button onClick={open} className="rounded-lg bg-hm-purple px-6 py-3 text-sm font-semibold text-white hover:bg-hm-purple/90 transition-colors">
            Connect Wallet →
          </button>
        ) : (
          <button
            onClick={getKey}
            disabled={signing || issuing}
            className="rounded-lg bg-hm-purple px-6 py-3 text-sm font-semibold text-white hover:bg-hm-purple/90 disabled:opacity-50 transition-colors"
          >
            {signing || issuing ? 'Signing…' : `Sign in as ${address?.slice(0, 6)}...${address?.slice(-4)}`}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <p className="mt-4 text-xs text-hm-grey">
        Prefer WorkOS? <a href={`${origin}/api/mcp/authorize`} className="text-hm-purple underline hover:text-hm-purple/80">Sign in with email →</a>
      </p>
    </div>
  );
}

function TokenPanel({ token, origin }: { token: string; origin: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-green-200 bg-green-50 p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-green-100 p-2">
            <Check className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <p className="font-medium text-green-800">Connected — here is your key</p>
            <p className="mt-1 text-sm text-green-700/70">
              Shown once. Store it now; it is not recoverable if lost (revoke + reconnect instead).
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg bg-white border border-green-200 px-3 py-2.5 text-xs font-mono text-hm-dark">{token}</code>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(token);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="shrink-0 rounded-lg bg-hm-purple px-4 py-2.5 text-xs font-medium text-white hover:bg-hm-purple/90"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-hm-accent bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-hm-primary mb-1">Add to your MCP client config</p>
        <p className="text-xs text-hm-grey">The key is embedded as a Bearer header automatically.</p>
        <McpConfigBlock origin={origin} token={token} />
      </div>
    </div>
  );
}
