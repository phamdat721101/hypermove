import { http, createConfig, createStorage, noopStorage } from 'wagmi';
import { defineChain } from 'viem';

// GOAT Network Alpha Mainnet
export const goatMainnet = defineChain({
  id: 2345,
  name: 'GOAT Network',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.goat.network'] } },
  blockExplorers: { default: { name: 'GOAT Explorer', url: 'https://explorer.goat.network' } },
});

// GOAT Testnet3
export const goatTestnet3 = defineChain({
  id: 48816,
  name: 'GOAT Testnet3',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet3.goat.network'] } },
  blockExplorers: { default: { name: 'GOAT Testnet3 Explorer', url: 'https://explorer.testnet3.goat.network' } },
  testnet: true,
});

export const config = createConfig({
  chains: [goatTestnet3, goatMainnet],
  storage: createStorage({ storage: typeof window !== 'undefined' ? window.localStorage : noopStorage }),
  transports: {
    [goatTestnet3.id]: http(),
    [goatMainnet.id]: http(),
  },
});
