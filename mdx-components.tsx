import type { MDXComponents } from 'mdx/types';
import CodeBlock from '@/components/CodeBlock';
import ChainBadge from '@/components/ChainBadge';
import ProtocolBadge from '@/components/ProtocolBadge';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    CodeBlock,
    ChainBadge,
    ProtocolBadge,
    ...components,
  };
}
