import { z } from 'zod';

export const evmNetwork = z.enum(['ethereum', 'arbitrum', 'base', 'robinhood']);
export const discoveryNetwork = z.enum(['ethereum', 'arbitrum', 'base', 'robinhood', 'sui']);
export const CHAINS = { ethereum: 1, arbitrum: 42161, base: 8453, robinhood: 4663 } as const;
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
export const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase());
export const suiObjectId = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).transform((s) => '0x' + s.slice(2).toLowerCase().padStart(64, '0'));

/** Parse bounded Move struct tags without lowercasing case-sensitive identifiers. */
export function normalizeCoinType(raw: string): string {
  if (raw.length > 1024) throw new Error('Coin type is too long.');
  let at = 0;
  const parse = (depth: number): string => {
    if (depth > 8) throw new Error('Coin type nesting is too deep.');
    const match = /^(0x[0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)/.exec(raw.slice(at));
    if (!match) throw new Error('Expected a Move struct tag.');
    at += match[0].length;
    let out = suiObjectId.parse(match[1]) + '::' + match[2] + '::' + match[3];
    if (raw[at] === '<') {
      at++;
      const args = [parse(depth + 1)];
      while (raw[at] === ',') { at++; args.push(parse(depth + 1)); if (args.length > 8) throw new Error('Too many type arguments.'); }
      if (raw[at++] !== '>') throw new Error('Unclosed type arguments.');
      out += '<' + args.join(',') + '>';
    }
    return out;
  };
  const out = parse(0);
  if (at !== raw.length) throw new Error('Invalid Move type suffix.');
  return out;
}
export const coinType = z.string().max(1024).transform((s, ctx) => {
  try { return normalizeCoinType(s); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid Move coin type.' }); return z.NEVER; }
});

export const SUI_MAINNET_CHAIN_IDENTIFIER = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';
export const chainCatalog = {
  ethereum: { family: 'evm', chain_id: 1, provider_id: 'ethereum' },
  arbitrum: { family: 'evm', chain_id: 42161, provider_id: 'arbitrum' },
  base: { family: 'evm', chain_id: 8453, provider_id: 'base' },
  robinhood: { family: 'evm', chain_id: 4663, provider_id: 'robinhood' },
  sui: { family: 'move', environment: 'mainnet', provider_id: 'sui' },
} as const;
