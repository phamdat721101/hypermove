'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useSendTransaction, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, parseUnits } from 'viem';
import { X, Zap, CheckCircle2, Loader2 } from 'lucide-react';
import { PAYMENT_CONFIG } from '@/lib/payment-config';

const ERC20_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function UpgradeModal({ isOpen, onClose, onSuccess }: Props) {
  const { address } = useAccount();
  const [step, setStep] = useState<'loading' | 'confirm' | 'paying' | 'verifying' | 'done'>('loading');
  const [priceInfo, setPriceInfo] = useState<{ btcAmount: string; display: string; weiAmount: string } | null>(null);

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) { setStep('loading'); setPriceInfo(null); }
  }, [isOpen]);

  // Fetch dynamic price when modal opens
  if (isOpen && step === 'loading' && !priceInfo) {
    const llmApi = (process.env.NEXT_PUBLIC_LLM_API_URL || '').replace(/\/+$/, '') || 'http://localhost:3001';
    fetch(`${llmApi}/price`).then(r => r.json()).then(data => {
      setPriceInfo(data);
      setStep('confirm');
    }).catch(() => setStep('confirm'));
  }

  // Native BTC transfer
  const { sendTransaction, data: nativeTxHash, error: nativeError } = useSendTransaction();
  // ERC-20 transfer
  const { writeContract, data: tokenTxHash, error: tokenError } = useWriteContract();

  const txHash = PAYMENT_CONFIG.useNative ? nativeTxHash : tokenTxHash;
  const txError = PAYMENT_CONFIG.useNative ? nativeError : tokenError;

  // Reset to confirm if user rejects
  if (txError && step === 'paying') {
    setStep('confirm');
  }

  const { isSuccess: txConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
  });

  // When tx confirmed, call BE upgrade
  if (txConfirmed && step === 'paying') {
    setStep('verifying');
    const llmApi = (process.env.NEXT_PUBLIC_LLM_API_URL || '').replace(/\/+$/, '') || 'http://localhost:3001';
    fetch(`${llmApi}/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: address, txHash }),
    }).then(r => {
      if (r.ok) { setStep('done'); onSuccess(); }
      else setStep('confirm');
    }).catch(() => setStep('confirm'));
  }

  function handlePay() {
    if (!address) return;
    setStep('paying');

    if (PAYMENT_CONFIG.useNative) {
      // Native BTC transfer (dynamic price)
      const wei = priceInfo?.weiAmount ? BigInt(priceInfo.weiAmount) : parseEther(PAYMENT_CONFIG.amount);
      sendTransaction({
        to: PAYMENT_CONFIG.treasury,
        value: wei,
      });
    } else {
      // ERC-20 token transfer
      writeContract({
        address: PAYMENT_CONFIG.token,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [PAYMENT_CONFIG.treasury, parseUnits(PAYMENT_CONFIG.amount, PAYMENT_CONFIG.tokenDecimals)],
      });
    }
  }

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-semibold text-white">Upgrade to Pro</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {step === 'loading' && (
          <div className="text-center py-6">
            <Loader2 className="h-6 w-6 text-indigo-400 animate-spin mx-auto" />
            <p className="mt-2 text-xs text-gray-500">Fetching current price...</p>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-center">
              <p className="text-2xl font-bold text-white">{priceInfo?.display || PAYMENT_CONFIG.amountDisplay}</p>
              <p className="text-xs text-gray-500 mt-1">per month · GOAT Testnet3 · ~$5 USD</p>
            </div>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>✓ Unlimited scans for 30 days</li>
              <li>✓ All tools + hosted MCP</li>
              <li>✓ Cancel anytime</li>
            </ul>
            <button onClick={handlePay} className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-3 text-sm font-semibold text-white transition-colors">
              <Zap className="h-4 w-4" />
              Pay {priceInfo?.btcAmount || PAYMENT_CONFIG.amount} BTC
            </button>
          </div>
        )}

        {step === 'paying' && (
          <div className="text-center py-6 space-y-3">
            <Loader2 className="h-8 w-8 text-indigo-400 animate-spin mx-auto" />
            <p className="text-sm text-gray-400">Confirm transaction in your wallet...</p>
          </div>
        )}

        {step === 'verifying' && (
          <div className="text-center py-6 space-y-3">
            <Loader2 className="h-8 w-8 text-indigo-400 animate-spin mx-auto" />
            <p className="text-sm text-gray-400">Verifying payment...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center py-6 space-y-3">
            <CheckCircle2 className="h-8 w-8 text-green-400 mx-auto" />
            <p className="text-sm text-green-300 font-medium">Upgraded to Pro!</p>
            <p className="text-xs text-gray-500">Unlimited scans for 30 days.</p>
            <button onClick={onClose} className="text-xs text-indigo-400 hover:text-indigo-300">Close</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
