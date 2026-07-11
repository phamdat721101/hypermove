'use client';

import dynamic from 'next/dynamic';

const GenerateContent = dynamic(() => import('./GenerateContent'), { ssr: false });

export default function GeneratePage() {
  return <GenerateContent />;
}
