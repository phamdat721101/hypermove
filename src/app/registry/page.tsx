import type { Metadata } from 'next';
import { ComingSoon } from '@/app/dashboard/page';

export const metadata: Metadata = { title: 'Registry (S3)' };

export default function RegistryPage() {
  return (
    <ComingSoon
      title="Registry"
      sprint="Sprint 3"
      blurb="Public catalog of Mode B hosted dApps with one-click `claude mcp add` install."
    />
  );
}
