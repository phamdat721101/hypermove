import type { Protocol } from '@/lib/registry';
import { protocolById } from '@/lib/registry';

interface ProtocolBadgeProps {
  protocolId: string;
  size?: 'sm' | 'md';
}

const ACCENT_CLASSES: Record<Protocol['accent'], string> = {
  primary:   'bg-primary-container/15 text-primary border-primary-container/40',
  secondary: 'bg-secondary-container/15 text-secondary border-secondary-container/40',
  tertiary:  'bg-tertiary-container/15 text-tertiary border-tertiary-container/40',
  error:     'bg-error-container/15 text-error border-error/40',
};

export default function ProtocolBadge({ protocolId, size = 'md' }: ProtocolBadgeProps) {
  const protocol = protocolById(protocolId);
  if (!protocol) {
    return <span className="chip bg-surface-container-high text-on-surface-variant">{protocolId}</span>;
  }
  const sizeClass = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-label-mono px-2 py-1';
  return (
    <span
      title={protocol.summary}
      className={`chip border font-mono ${ACCENT_CLASSES[protocol.accent]} ${sizeClass}`}
    >
      {protocol.name}
    </span>
  );
}
