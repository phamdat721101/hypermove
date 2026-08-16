/** Public-address-only XRPL wallet readiness checks. Never handles secrets. */

type RpcResult = Record<string, unknown>;

function rpcUrl(network: string): string | null {
  if (network === 'xrpl-mainnet') return 'https://xrplcluster.com';
  if (network === 'xrpl-testnet') return 'https://s.altnet.rippletest.net:51234';
  return null;
}

async function rpc(url: string, method: string, params: Record<string, unknown>): Promise<RpcResult | null> {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { result?: RpcResult };
    return body.result ?? null;
  } catch {
    return null;
  }
}

export async function getXrplReadiness(address: string, network = 'xrpl-testnet', asset = 'RLUSD') {
  const url = rpcUrl(network);
  const issuer = process.env.XRPL_RLUSD_ISSUER ?? '';
  const faucetUrl = network === 'xrpl-testnet' ? 'https://xrpl.org/xrp-testnet-faucet.html' : null;
  if (!url) return { address, network, asset, funded: false, ready: false, issuer, faucetUrl, nextAction: 'use xrpl-testnet or xrpl-mainnet' };
  const [info, lines, server] = await Promise.all([
    rpc(url, 'account_info', { account: address, ledger_index: 'validated' }),
    rpc(url, 'account_lines', { account: address, ledger_index: 'validated' }),
    rpc(url, 'server_info', {}),
  ]);
  const accountData = info?.account_data as { Balance?: string; OwnerCount?: number } | undefined;
  const xrpDrops = BigInt(accountData?.Balance ?? '0');
  const validatedLedger = (server?.info as { validated_ledger?: { reserve_base_xrp?: number; reserve_inc_xrp?: number } } | undefined)?.validated_ledger;
  const baseReserve = BigInt(Math.round((validatedLedger?.reserve_base_xrp ?? 0) * 1_000_000));
  const ownerReserve = BigInt(Math.round((validatedLedger?.reserve_inc_xrp ?? 0) * 1_000_000)) * BigInt(accountData?.OwnerCount ?? 0);
  const line = ((lines?.lines as Array<{ currency?: string; account?: string; balance?: string }> | undefined) ?? [])
    .find((item) => item.currency === asset && item.account === issuer);
  const rlusdBalance = line?.balance ?? '0';
  const funded = Boolean(accountData);
  const reserveSatisfied = funded && xrpDrops >= baseReserve + ownerReserve;
  const trustline = Boolean(line);
  const ready = funded && reserveSatisfied && trustline && Number(rlusdBalance) > 0;
  const nextAction = !funded ? 'fund this public address with the XRPL testnet faucet'
    : !reserveSatisfied ? 'fund enough XRP to satisfy the ledger reserve'
      : !issuer ? 'configure XRPL_RLUSD_ISSUER before creating an RLUSD trust line'
        : !trustline ? 'sign an RLUSD trust-line transaction in your local wallet'
          : Number(rlusdBalance) <= 0 ? 'receive RLUSD into the established trust line'
            : 'ready';
  return { address, network, asset, funded, xrpReserve: { requiredDrops: (baseReserve + ownerReserve).toString(), balanceDrops: xrpDrops.toString(), satisfied: reserveSatisfied }, trustline, rlusdBalance, issuer, faucetUrl, ready, nextAction };
}

export function buildXrplBootstrap(network = 'xrpl-testnet', asset = 'RLUSD') {
  return {
    network, asset, signer: 'local-client-required', secrets: 'never transmitted to HyperMove',
    steps: ['create or import a wallet in your local client', 'fund the public address', 'sign an RLUSD trust-line transaction locally', 'call wallet.xrpl.readiness with the public address'],
  };
}
