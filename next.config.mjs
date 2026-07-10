import createMDX from '@next/mdx';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  pageExtensions: ['ts', 'tsx', 'md', 'mdx'],
  // n-payment lazily requires optional protocol deps (@x402/stellar, mppx, …).
  // Keep it external so webpack doesn't try to bundle those; it's required at
  // runtime in the Node route handler only when real settlement is configured.
  experimental: {
    serverComponentsExternalPackages: ['n-payment'],
  },
};

const withMDX = createMDX({});
export default withMDX(nextConfig);
