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
    // PRD-D (2026-07-27, Dream Cycle server-side scheduler): instrumentation.ts's
    // register() is how the in-process hourly scheduler starts once at process
    // boot. On Next.js 14 (this project — next@14.2.18) instrumentationHook is
    // NOT on by default; it only became default-on in Next.js 15+. Without this
    // flag, instrumentation.ts would silently never run, and the scheduler
    // would never start even with FEATURE_MCP_DREAM_SCHEDULER=true set.
    instrumentationHook: true,
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
