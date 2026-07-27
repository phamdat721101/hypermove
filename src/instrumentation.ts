/**
 * src/instrumentation.ts
 * ------------------------
 * Next.js server-startup hook (see next.config.mjs's experimental.
 * instrumentationHook comment for why this flag is required on Next 14).
 * register() runs exactly once when the Node.js server process boots.
 *
 * Location: must live directly inside src/ (alongside src/app), NOT at the
 * repo root — this project uses the `src` directory convention, and
 * Next.js 14's instrumentation file-resolution only looks in the repo root
 * OR inside src/, never both.
 *
 * Split pattern (matches Next.js's own documented instrumentation-node/
 * instrumentation-edge example): keep this top-level file free of any
 * Node-only imports (pg, node:fs, etc. via pipeline.ts -> db.ts -> pg) so
 * webpack's build-time static analysis of the dynamic import() below never
 * needs to resolve those deps for whichever bundle(s) this file compiles
 * into. The actual scheduler-starting logic lives in
 * instrumentation-node.ts, imported ONLY behind the NEXT_RUNTIME check.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
