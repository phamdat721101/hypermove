'use client';

import { useEffect, useState } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { useWalletModal } from '@/lib/wallet-modal-context';

/**
 * /mcp-connect — the human-facing surface for the MCP Gateway.
 *
 * Two independent gaps fixed here:
 *
 * 1. Origin: every curl example used to hardcode `https://hypermove.xyz`,
 *    which is wrong on any other deploy (localhost, a VPS behind duckdns,
 *    a staging domain). Fixed by deriving the base URL from the browser's
 *    own `window.location.origin` — this page never needs to know its host.
 *
 * 2. Auth key issuance: the only path to a bearer token was WorkOS OAuth.
 *    On a web3 product where every other paid flow already asks the user to
 *    connect a wallet (WalletConnect.tsx + wagmi, wired app-wide via
 *    Web3Provider in layout.tsx), forcing a *separate* identity system for
 *    MCP is inconsistent and adds a second login the user never asked for.
 *    Fixed by adding a wallet-signature login: connect wallet → sign one
 *    message → POST to /api/mcp/wallet-auth → same storeToken() the WorkOS
 *    path already uses, just keyed by wallet address instead of a WorkOS id.
 */
type GatewayState = { gatewayEnabled: boolean; authRequired: boolean; confidentialDreamCycleAvailable: boolean } | null;

const MCP_CLIENTS = ['Kiro / Cursor / Claude CLI', 'Claude Desktop / Windsurf', 'curl (raw)'] as const;
type McpClient = (typeof MCP_CLIENTS)[number];

/**
 * Renders how to CONNECT an MCP client — not how to call a REST API. /api/mcp
 * is a real MCP server (Streamable HTTP), so agents add it to their MCP config
 * (`mcpServers`), or bridge stdio clients via `mcp-remote`. The raw-curl tab
 * includes the mandatory `Accept: application/json, text/event-stream` header
 * that the Streamable-HTTP transport requires (a plain JSON POST gets 406).
 */
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
    <div className="mt-4 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {MCP_CLIENTS.map((c) => (
            <button
              key={c}
              onClick={() => setClient(c)}
              className={`rounded px-2 py-1 text-[11px] ${client === c ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'}`}
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
          className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs text-neutral-300">{snippet}</pre>
    </div>
  );
}

export default function McpConnectPage() {
  const token = useTokenFromQuery();
  const state = useGatewayState();
  const origin = useOrigin();

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-neutral-500">MCP Gateway</p>
      <h1 className="text-3xl font-semibold tracking-tight text-neutral-100">Connect your agent</h1>
      <p className="mt-3 text-sm text-neutral-400">
        Call <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs">{origin}/api/mcp</code> from
        any MCP-compatible agent. 10 free queries / 24h, then metered x402/MPP.
      </p>

      {token ? (
        <TokenPanel token={token} origin={origin} />
      ) : state === null ? (
        <p className="mt-8 text-sm text-neutral-500">Checking gateway status…</p>
      ) : state.authRequired ? (
        <WalletAuthPanel origin={origin} />
      ) : (
        <NoAuthPanel gatewayEnabled={state.gatewayEnabled} origin={origin} />
      )}
    </main>
  );
}

// (ConfidentialDreamCycleCallout removed 2026-08-14, FCC removal. See
// docs/fcc-removal-proposal-2026-08-14.md.)


function useTokenFromQuery(): string | null {
  const [token] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('token');
  });
  return token;
}

/** The page's own origin — never hardcode a domain; works on hypermove.xyz, a VPS, or localhost. */
function useOrigin(): string {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

/** Fetches /api/mcp/health once and exposes the flags the UI branches on. */
function useGatewayState(): GatewayState {
  const [state, setState] = useState<GatewayState>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/mcp/health')
      .then((res) => res.json())
      .then((body: { gateway_enabled?: boolean; auth_required?: boolean; prompts?: string[] }) => {
        if (!cancelled) {
          setState({
            gatewayEnabled: !!body.gateway_enabled,
            authRequired: !!body.auth_required,
            // Dream Cycle Confidential Extraction on Flare FCC, Task 10.
            // Derived from /api/mcp/health's additive `prompts` field
            // (mirrors its existing `tools` field) rather than a new
            // dedicated endpoint — dream/run_confidential is absent from
            // that list entirely whenever isMcpDreamConfidentialEnabled()
            // is off (default), matching the prompt's own "not even
            // discoverable when disabled" design (prompts.ts).
            confidentialDreamCycleAvailable: (body.prompts ?? []).includes('dream/run_confidential'),
          });
        }
      })
      .catch(() => {
        // Health check itself failed — treat as "no auth required" so the
        // page still shows a usable curl example instead of stalling.
        if (!cancelled) setState({ gatewayEnabled: false, authRequired: false, confidentialDreamCycleAvailable: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/** Shown when the gateway doesn't require sign-in — flagged as an insecure/unintended
 *  state rather than a neutral one, since the intended default is auth-required. */
function NoAuthPanel({ gatewayEnabled, origin }: { gatewayEnabled: boolean; origin: string }) {
  return (
    <div className="mt-8 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
      <p className="text-sm font-medium text-amber-300">⚠ No sign-in required — anyone can call this endpoint</p>
      <p className="mt-1 text-xs text-neutral-400">
        {gatewayEnabled
          ? 'FEATURE_MCP_AUTH_WORKOS is off. Set it to "true" (with FEATURE_HYPERMOVE_MCP_GATEWAY_V1=true) to require a wallet-signed key for every request.'
          : 'FEATURE_HYPERMOVE_MCP_GATEWAY_V1 is off, so /api/mcp serves the legacy payment.x402 + reputation.read tools and never checks auth — setting FEATURE_MCP_AUTH_WORKOS alone has no effect until this master flag is also on.'}
      </p>
      <p className="mt-3 text-xs text-neutral-400">Add this to your MCP client config — it&apos;s a real MCP server (Streamable HTTP), not a REST endpoint.</p>
      <McpConfigBlock origin={origin} />
    </div>
  );
}

/** Shown when auth is required — connect wallet, sign one message, get a bearer token. */
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
    <div className="mt-8 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
      <p className="text-sm font-medium text-emerald-300">Connect your wallet to get a key</p>
      <p className="mt-1 text-xs text-neutral-400">
        One signature (free, no gas) proves you own the address. No account, no password.
      </p>
      {!isConnected ? (
        <button onClick={open} className="mt-4 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-neutral-950 hover:bg-emerald-400">
          Connect Wallet →
        </button>
      ) : (
        <button
          onClick={getKey}
          disabled={signing || issuing}
          className="mt-4 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-medium text-neutral-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {signing || issuing ? 'Signing…' : `Sign in as ${address?.slice(0, 6)}...${address?.slice(-4)}`}
        </button>
      )}
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      <p className="mt-4 text-xs text-neutral-500">
        Prefer WorkOS? <a href={`${origin}/api/mcp/authorize`} className="underline hover:text-neutral-300">Sign in with email →</a>
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        No wallet, no browser at all? <a href="/docs/agent-auth" className="underline hover:text-neutral-300">Terminal-only sign-in →</a>
      </p>
    </div>
  );
}

function TokenPanel({ token, origin }: { token: string; origin: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-8 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
      <p className="text-sm font-medium text-emerald-300">Connected — here is your key</p>
      <p className="mt-1 text-xs text-neutral-400">
        Shown once. Store it now; it is not recoverable if lost (revoke + reconnect instead).
      </p>
      <div className="mt-4 flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg bg-neutral-900 px-3 py-2 text-xs text-neutral-200">{token}</code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-4 text-xs text-neutral-400">Add this to your MCP client config (the key is embedded as a Bearer header):</p>
      <McpConfigBlock origin={origin} token={token} />
    </div>
  );
}
