import createMDX from '@next/mdx';

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['ts', 'tsx', 'mdx'],
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    mdxRs: false,
  },
  async headers() {
    return [
      {
        source: '/.well-known/:path*',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Cache-Control', value: 'public, max-age=60' },
        ],
      },
    ];
  },
};

const withMDX = createMDX({});
export default withMDX(nextConfig);
