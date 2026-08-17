import { describe, it, expect } from 'vitest';

/**
 * Regression for docs/feedback/2026-08-17-start-dream-4th-esm-cjs-crash-scure-bip39.md
 *
 * A 4th instance of this repo's documented systemic ESM/CJS dependency
 * pattern (see package.json's _pnpm_overrides_justifications and
 * .kiro/steering/lessons-learned.md's 2026-08-12 entries for the first 3).
 * xrpl@5.0.0's own compiled Wallet/index.js does
 * `require("@scure/bip39/wordlists/english.js")` -- a `.js`-suffixed
 * subpath that only @scure/bip39@2.x's exports map defines. Every 2.x
 * release is published ESM-only (type:module, no CJS build), so a plain
 * `require()` of it crashes with "require() of ES Module ... not
 * supported" the first time any code path reaches XRPL seed/mnemonic
 * wallet derivation (e.g. during settlement proof verification).
 *
 * Fixed via a pnpm patch (patches/@scure__bip39@2.3.0.patch) that adds a
 * real CJS build under cjs/ plus dual require/import/default exports
 * conditions, and a companion `@scure/bip39>@noble/hashes` override
 * (package.json's pnpm.overrides) since the CJS build's own require()
 * calls need a CJS-compatible @noble/hashes sibling.
 *
 * This test exercises the REAL xrpl package end-to-end (not a mock) --
 * a version-override or patch regression here would only surface as this
 * exact require()/module-resolution crash, which no unit-level mock of
 * `xrpl` could ever catch. Uses a well-known BIP-39 test vector so the
 * assertion is deterministic without needing a live network call.
 *
 * Note: xrpl.Wallet.generate()'s default ed25519 seed-based path is a
 * SEPARATE code path (never touches @scure/bip39) and has its own
 * pre-existing, unrelated failure under vitest's jsdom environment
 * (@noble/curves' getExtendedPublicKey throws "private key must be hex
 * string or Uint8Array" -- a vitest/jsdom crypto-shim quirk, not an
 * ESM/CJS issue) -- intentionally not tested here; out of scope for this
 * regression, which is specifically about the mnemonic/bip39 require()
 * crash.
 */
describe('xrpl.Wallet mnemonic derivation (real @scure/bip39 CJS patch regression)', () => {
  it('xrpl.Wallet.fromMnemonic() succeeds against a real BIP-39 test vector without an ESM/CJS require() crash', async () => {
    const xrpl = await import('xrpl');
    const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const wallet = xrpl.Wallet.fromMnemonic(testMnemonic);
    expect(wallet.address).toBe('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3');
    expect(wallet.publicKey).toBe('031D68BC1A142E6766B2BDFB006CCFE135EF2E0E2E94ABB5CF5C9AB6104776FBAE');
  });
});
