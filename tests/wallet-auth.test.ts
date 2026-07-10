import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyWalletSignature } from '@/lib/mcp/auth';

const PK = '0x6db3a136fd30689df6f0e15c3f96e0bff1f9ea5a5f3527e26403ffbf1582d2f3';

describe('verifyWalletSignature', () => {
  it('accepts a valid, fresh signature', async () => {
    const account = privateKeyToAccount(PK);
    const address = account.address;
    const message = `Sign in to HyperMove MCP Gateway\naddress: ${address}\ntimestamp: ${Date.now()}`;
    const signature = await account.signMessage({ message });

    const out = await verifyWalletSignature(address, message, signature);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.userId).toBe(`wallet:${address.toLowerCase()}`);
  });

  it('rejects a tampered signature', async () => {
    const account = privateKeyToAccount(PK);
    const address = account.address;
    const message = `Sign in to HyperMove MCP Gateway\naddress: ${address}\ntimestamp: ${Date.now()}`;
    const signature = await account.signMessage({ message });
    // Flip a byte inside the `r` component (well before the recovery-id byte
    // at the end) so the signature is unambiguously invalid, not just a
    // different-but-still-recoverable v value.
    const flipped = signature[10] === '0' ? '1' : '0';
    const tampered = (signature.slice(0, 10) + flipped + signature.slice(11)) as `0x${string}`;

    const out = await verifyWalletSignature(address, message, tampered);
    expect(out.ok).toBe(false);
  });

  it('rejects an expired timestamp', async () => {
    const account = privateKeyToAccount(PK);
    const address = account.address;
    const staleTs = Date.now() - 10 * 60_000; // 10 minutes old
    const message = `Sign in to HyperMove MCP Gateway\naddress: ${address}\ntimestamp: ${staleTs}`;
    const signature = await account.signMessage({ message });

    const out = await verifyWalletSignature(address, message, signature);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/expired/);
  });

  it('rejects a message that does not reference the signing address', async () => {
    const account = privateKeyToAccount(PK);
    const otherAddress = '0x000000000000000000000000000000000000ff';
    const message = `Sign in to HyperMove MCP Gateway\naddress: ${otherAddress}\ntimestamp: ${Date.now()}`;
    const signature = await account.signMessage({ message });

    const out = await verifyWalletSignature(account.address, message, signature);
    expect(out.ok).toBe(false);
  });
});
