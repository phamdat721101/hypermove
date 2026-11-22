// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PublicResearch } from '../src/lib/mcp/flashloan/public-worker';
import { ResearchAdmission } from '../src/lib/mcp/flashloan/admission';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';

const tool = 'flashloan_rlusd_devtools_v1';
const issuer = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const currency = '524C555344000000000000000000000000000000';
const payer = 'r4PboXNDNese3YLhc8tgzzKNhjGeEaxqfc';
const recipient = 'rUUmpjtQXAMnX4xWvC9cq1FyWwVyubC2ad';
const rlusd = '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258';
const otherRlusd = '0xbc05b5c43e0462c41a1ffee50a215a2bb3ee4bc6';
const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const block = { number: '0x12', hash: `0x${'01'.repeat(32)}` };
const evmHash = `0x${'89'.repeat(32)}`, xrplHash = 'AC'.repeat(32);
const sender = `0x${'12'.repeat(20)}`, receiver = `0x${'34'.repeat(20)}`;
const word = (value: bigint) => value.toString(16).padStart(64, '0');

function service(fetcher: typeof fetch) {
  const engine = new ResearchEngine({ endpoints: { base: 'https://base.test', ethereum: 'https://ethereum.test', xrpl: 'https://xrpl.test' }, deployments: [], fetcher });
  return new PublicResearch(engine, new ResearchAdmission(2), 'x'.repeat(48));
}

describe('public RLUSD developer checks', () => {
  it('keeps provider catalogs distinct from executable routes and official contracts', async () => {
    const app = service(vi.fn(async (url, init) => {
      if (String(url).includes('squidrouter')) return Response.json({ message: 'x-integrator-id header is missing' }, { status: 400 });
      const args = JSON.parse(String(init?.body));
      return Response.json(args.symbol ? [{ chainId: 8453, address: otherRlusd }] : []);
    }));
    expect(app.capabilities().operations).toContain(tool);
    await expect(app.dispatch(tool, { request: { action: 'check_providers' } }, 'catalog')).resolves.toMatchObject({ execution: false, data: {
      scope: 'catalog_only', route_ready: false, providers: { squid: { status: 'integrator_id_required' },
        relay: { status: 'xrpl_rlusd_not_listed', base_official_address_listed: false, base_other_symbol_addresses: [otherRlusd] } },
    } });
    await expect(app.dispatch(tool, { request: { action: 'check_providers', rpc: 'https://injected.test' } }, 'catalog')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('quotes a pinned local conversion including the official asset and scope', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body));
      const base = String(url).includes('base.test');
      if (method === 'eth_chainId') return Response.json({ result: base ? '0x2105' : '0x1' });
      if (method === 'eth_getBlockByNumber') return Response.json({ result: block });
      expect(method).toBe('eth_call'); expect(params[1]).toBe(block.number);
      expect(params[0].data.slice(0, 10)).toBe(base ? '0xc6a5026a' : '0x5e0d443f');
      return Response.json({ result: '0x' + word(999952745n) + (base ? word(0n).repeat(3) : '') });
    });
    const app = service(fetcher);
    const args = { action: 'quote_spot', amount_in_raw: '1000000000000000000000' };
    await expect(app.dispatch(tool, { request: { ...args, network: 'base' } }, 'quote')).resolves.toMatchObject({ data: { scope: 'same_chain_conversion', block, input_token: rlusd, output_token: usdc, output_amount_raw: '999952745', gas_included: false } });
    await expect(app.dispatch(tool, { request: { ...args, network: 'ethereum' } }, 'quote')).resolves.toMatchObject({ data: { chain_id: 1, output_amount_raw: '999952745' } });
  });

  it('matches only validated native XRPL delivered value with the exact issuer and tag', async () => {
    let delivered = true;
    const app = service(vi.fn(async () => Response.json({ result: { hash: xrplHash, validated: true, ledger_index: 108188636,
      tx_json: { TransactionType: 'Payment', Account: payer, Destination: recipient, DestinationTag: 9, DeliverMax: { currency, issuer, value: '2' } },
      meta: { TransactionResult: 'tesSUCCESS', ...(delivered ? { delivered_amount: { issuer, currency, value: '0.03925782646083654' } } : {}) },
    } })));
    const request = { action: 'verify_xrpl_payment', tx_hash: xrplHash, payer, recipient, amount: '0.0392578264608365400', destination_tag: 9 };
    await expect(app.dispatch(tool, { request }, 'xrpl')).resolves.toMatchObject({ data: { status: 'verified', scope: 'xrpl_payment_only' } });
    await expect(app.dispatch(tool, { request: { ...request, amount: '2' } }, 'xrpl')).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
    await expect(app.dispatch(tool, { request: { ...request, destination_tag: 10 } }, 'xrpl')).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
    delivered = false;
    await expect(app.dispatch(tool, { request }, 'xrpl')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('checks exact EVM transfer identity, canonical block and finalized height', async () => {
    let asset = rlusd, finalHeight = '0x11', canonical = block.hash;
    const app = service(vi.fn(async (_url, init) => {
      const { method, params } = JSON.parse(String(init?.body));
      if (method === 'eth_chainId') return Response.json({ result: '0x2105' });
      if (method === 'eth_getBlockByNumber') return Response.json({ result: params[0] === 'finalized' ? { ...block, number: finalHeight } : { ...block, hash: canonical } });
      return Response.json({ result: { transactionHash: evmHash, status: '0x1', blockNumber: block.number, blockHash: block.hash,
        logs: [{ address: asset, logIndex: '0x6a', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${word(BigInt(sender))}`, `0x${word(BigInt(receiver))}`], data: `0x${word(10n ** 18n)}` }],
      } });
    }));
    const request = { action: 'verify_evm_transfer', network: 'base', asset: 'rlusd', tx_hash: evmHash, sender, recipient: receiver, amount_raw: '1000000000000000000', log_index: 106 };
    await expect(app.dispatch(tool, { request }, 'evm')).resolves.toMatchObject({ data: { status: 'pending_finality', scope: 'evm_transfer_only' } });
    finalHeight = block.number;
    await expect(app.dispatch(tool, { request }, 'evm')).resolves.toMatchObject({ data: { status: 'verified', token: rlusd } });
    await expect(app.dispatch(tool, { request: { ...request, log_index: 107 } }, 'evm')).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
    asset = otherRlusd;
    await expect(app.dispatch(tool, { request }, 'evm')).rejects.toMatchObject({ code: 'RECEIPT_MISMATCH' });
    asset = rlusd; canonical = `0x${'ab'.repeat(32)}`;
    await expect(app.dispatch(tool, { request }, 'evm')).rejects.toMatchObject({ code: 'REORG' });
  });
});

// Opt-in replay of public, historical receipts and read-only quotes.
it.runIf(process.env.FLASHLOAN_RLUSD_LIVE === '1')('replays public catalogs, both quotes and three chain receipts', async () => {
  const engine = new ResearchEngine({ endpoints: {
    base: 'https://base-rpc.publicnode.com', ethereum: 'https://ethereum-rpc.publicnode.com', xrpl: 'https://xrplcluster.com/',
  }, deployments: [] });
  const app = new PublicResearch(engine, new ResearchAdmission(2), 'x'.repeat(48));
  const check = (request: Record<string, unknown>) => app.dispatch(tool, { request }, 'live');
  await expect(check({ action: 'check_providers' })).resolves.toMatchObject({ data: { route_ready: false,
    providers: { relay: { base_official_address: rlusd }, squid: { status: 'integrator_id_required' } },
  } });
  for (const network of ['base', 'ethereum']) {
    await expect(check({ action: 'quote_spot', network, amount_in_raw: '1000000000000000000000' })).resolves.toMatchObject({ data: { status: 'quoted', scope: 'same_chain_conversion' } });
  }
  await expect(check({ action: 'verify_xrpl_payment', tx_hash: '73C5DBCF0733979B476D25E06CE0428E03362EB5B5DE3621546ACF74102E9DBF', payer, recipient,
    amount: '0.03925782646083654' })).resolves.toMatchObject({ data: { status: 'verified', ledger_index: 108188636 } });
  await expect(check({ action: 'verify_evm_transfer', network: 'base', asset: 'usdc', tx_hash: '0x5ee1b6a8dcef6256cf77c6f51f8d2020e10c6479f0b088ba9585e3f7cf0260cf',
    sender: '0x091cd0ab1b5a131cf92a76700a77b48c7bee7985', recipient: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38', amount_raw: '103264832', log_index: 106 })).resolves.toMatchObject({ data: { status: 'verified', token: usdc } });
  await expect(check({ action: 'verify_evm_transfer', network: 'ethereum', asset: 'rlusd', tx_hash: '0xd7f2505c2886c86f760c694b161da127b457e05f0223fd7bd42457d78fbdf1f3',
    sender: '0x0000000000000000000000000000000000000000', recipient: '0xfbca8b5f5794456b59ad4177e5b212d0db600bb6', amount_raw: '14000000000000000000000000', log_index: 2218 })).resolves.toMatchObject({ data: { status: 'verified', chain_id: 1 } });
}, 90000);
