'use client';

import { useState } from 'react';
import CodeBlock from './CodeBlock';

interface Tab {
  id: 'declarative' | 'imperative' | 'modeB';
  label: string;
  description: string;
  language: 'html' | 'ts';
  code: string;
}

const TABS: readonly Tab[] = [
  {
    id: 'declarative',
    label: 'Declarative · 3 lines of HTML',
    description: 'Decorate any form/button/anchor. Zero JS framework lock-in.',
    language: 'html',
    code: `<form data-tool-name="payment.send"
      data-tool-description="Send USDC to an Ethereum address">
  <input name="to" data-tool-format="address" required />
  <input name="amount" type="number" required />
  <button>Send</button>
</form>

<script type="module">
  import { initWeb3WebMCP } from 'https://esm.sh/@phamnim/web3-webmcp';
  await initWeb3WebMCP({ adapter: 'wagmi' });
</script>`,
  },
  {
    id: 'imperative',
    label: 'Imperative · 5 lines of TS',
    description: 'Register custom tools at runtime with full type checking.',
    language: 'ts',
    code: `import { initWeb3WebMCP, registerWeb3Tool, primitives } from '@phamnim/web3-webmcp';
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({ chains: ['goat-mainnet'], ows: { wallet: 'my-agent' } });
await initWeb3WebMCP({ adapter: 'wagmi', paymentClient: client });
registerWeb3Tool({
  ...primitives.payment.x402,
  monetize: { priceMicroUsdc: 1000n, payTo: '0xYourAddress', chainId: 2345 },
});`,
  },
  {
    id: 'modeB',
    label: 'Mode B · 1-line install',
    description: 'Add one <script> to your <head>. We host the MCP proxy.',
    language: 'html',
    code: `<!-- Add to your <head>. That's literally the entire integration. -->
<script src="https://hypermove.dev/h/your-domain.com/webmcp.js" defer></script>`,
  },
];

export default function CodeExamplePicker() {
  const [activeId, setActiveId] = useState<Tab['id']>('declarative');
  const active = TABS.find((t) => t.id === activeId) ?? TABS[0];
  return (
    <div className="glass-panel rounded-lg p-2">
      <div role="tablist" aria-label="Integration mode" className="flex flex-wrap gap-1">
        {TABS.map((tab) => {
          const sel = tab.id === activeId;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={sel}
              onClick={() => setActiveId(tab.id)}
              className={`flex flex-col items-start gap-1 rounded-md px-3 py-2 text-left text-body-sm transition-colors ${
                sel
                  ? 'bg-primary-container/20 text-on-surface'
                  : 'text-on-surface-variant hover:bg-surface-container-high/40'
              }`}
            >
              <span className="font-semibold">{tab.label}</span>
              <span className="text-label-mono uppercase tracking-wider text-on-surface-variant">
                {tab.description}
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel">
        <CodeBlock language={active.language} code={active.code} />
      </div>
    </div>
  );
}
