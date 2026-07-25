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
  // services/** holds independent standalone sub-projects (hypermove-fce-extension,
  // tee-extension/scripts, llm) — each with its own package.json/tsconfig/build
  // step, never installed at the repo root. output:'standalone`'s file tracer
  // (@vercel/nft) statically walks imports/requires and can pick these up even
  // though tsconfig.json already excludes them from the app's own TS program —
  // without this, a sibling service's own missing/uninstalled dependency (e.g.
  // hypermove-fce-extension's @hono/node-server) can surface as a type error
  // during Vercel's build despite never being imported by the Next.js app itself.
  outputFileTracingExcludes: {
    '*': ['./services/**'],
  },
};

const withMDX = createMDX({});
export default withMDX(nextConfig);
