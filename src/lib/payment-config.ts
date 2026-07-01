// Payment config for Pro tier upgrade
// Switch between native BTC and ERC-20 token by changing `useNative`
export const PAYMENT_CONFIG = {
  chainId: 48816, // GOAT Testnet3

  // --- Current: native BTC (faucet available) ---
  useNative: true,
  amount: '0.000001', // 0.000001 BTC
  amountWei: '1000000000000', // 10^12 wei
  amountDisplay: '0.000001 BTC',

  // --- Future: ERC-20 token (uncomment when USDC/GOAT available) ---
  // useNative: false,
  // token: '0xbC10000000000000000000000000000000000001' as `0x${string}`, // GoatToken
  // tokenSymbol: 'GOAT',
  // tokenDecimals: 18,
  // amount: '5', // 5 GOAT
  // amountDisplay: '5 GOAT',

  token: '0xbC10000000000000000000000000000000000001' as `0x${string}`, // kept for future use
  tokenSymbol: 'GOAT',
  tokenDecimals: 18,

  treasury: '0x792cA42F2C2f9D9fB56dDBbfE9a0916AE6e98DD8' as `0x${string}`,
};
