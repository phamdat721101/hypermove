import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signWithTee, signWithWallet } from '../src/tee.client.js';

const TEE_URL = 'http://localhost:8888';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signWithTee', () => {
  it('POSTs the raw digest to /sign and returns the signature', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: '0xdead', signature: '0xsig' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await signWithTee(TEE_URL, '0xdead');
    expect(out).toEqual({ ok: true, result: { message: '0xdead', signature: '0xsig' } });

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8888/sign');
    expect(JSON.parse(opts.body as string)).toEqual({ message: '0xdead' });
  });

  it('adds a 0x prefix if the digest is missing one', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: '0xdead', signature: '0xsig' }) });
    vi.stubGlobal('fetch', fetchMock);
    await signWithTee(TEE_URL, 'dead');
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ message: '0xdead' });
  });

  it('never throws on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const out = await signWithTee(TEE_URL, '0xdead');
    expect(out).toEqual({ ok: false, code: 'network_error', message: 'ECONNREFUSED' });
  });

  it('surfaces a non-200 TEE response as tee_error, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => 'can not sign' }));
    const out = await signWithTee(TEE_URL, '0xdead');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('tee_error');
  });
});

describe('signWithWallet — client-side walletID validation', () => {
  it('rejects a non-32-byte walletId before making any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await signWithWallet(TEE_URL, 'not-a-hash', 1, '0xdeadbeef');
    expect(out).toEqual({
      ok: false,
      code: 'invalid_wallet_id',
      message: 'walletId must be a 32-byte hex hash (64 hex chars, optional 0x prefix); got "not-a-hash"',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a valid 64-hex-char walletId (with 0x prefix) and calls the right path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: '0xtx', signature: '0xsig' }) });
    vi.stubGlobal('fetch', fetchMock);
    const walletId = `0x${'a'.repeat(64)}`;
    await signWithWallet(TEE_URL, walletId, 7, '0xdeadbeef');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`http://localhost:8888/sign/${'a'.repeat(64)}/7`);
  });

  it('accepts a valid 64-hex-char walletId without a 0x prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: '0xtx', signature: '0xsig' }) });
    vi.stubGlobal('fetch', fetchMock);
    await signWithWallet(TEE_URL, 'b'.repeat(64), 'key-1', '0xdeadbeef');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`http://localhost:8888/sign/${'b'.repeat(64)}/key-1`);
  });

  it('rejects a walletId that is the right length but has invalid hex chars', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await signWithWallet(TEE_URL, `zz${'a'.repeat(62)}`, 1, '0xdeadbeef');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('invalid_wallet_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
