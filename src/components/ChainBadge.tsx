import type { Chain } from '@/lib/registry';
import { chainById } from '@/lib/registry';

interface ChainBadgeProps {
  chainId: string;
  size?: 'sm' | 'md';
}

const ACCENT_CLASSES: Record<Chain['accent'], string> = {
  primary:   'bg-primary-container/15 text-primary border-primary-container/40',
  secondary: 'bg-secondary-container/15 text-secondary border-secondary-container/40',
  tertiary:  'bg-tertiary-container/15 text-tertiary border-tertiary-container/40',
  error:     'bg-error-container/15 text-error border-error/40',
};

export default function ChainBadge({ chainId, size = 'md' }: ChainBadgeProps) {
  const chain = chainById(chainId);
  if (!chain) {
    return <span className="chip bg-surface-container-high text-on-surface-variant">{chainId}</span>;
  }
  const sizeClass = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-label-mono px-2 py-1';
  return (
    <span
      title={`${chain.name} (${chain.kind}${chain.chainId ? ` · #${chain.chainId}` : ''})`}
      className={`chip border ${ACCENT_CLASSES[chain.accent]} ${sizeClass}`}
    >
      {chain.tier === 'testnet' && <span aria-hidden="true">⌁</span>}
      {chain.name}
    </span>
  );
}
