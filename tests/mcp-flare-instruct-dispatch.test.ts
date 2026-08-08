/**
 * tests/mcp-flare-instruct-dispatch.test.ts
 * -------------------------------------------
 * Covers the 2026-08-08 real-instructionId fix in flare-instruct.ts's
 * submitAndPoll(): the previous code substituted receipt.transactionHash as
 * a stand-in polling key. HyperMoveInstructionSender.sol's send* functions
 * now `return` the real registry-assigned instructionId, decoded here via
 * viem's simulateContract()+writeContract(request) pattern.
 *
 * Mocks viem's createPublicClient/createWalletClient directly (deeper than
 * mcp-tee-instruct-token-profile.test.ts's flag/config-gate tests, which
 * never reach submitAndPoll() at all) so this is a genuinely new test
 * surface, not a duplicate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origEnv = process.env;

beforeEach(() => {
  process.env = {
    ...origEnv,
    FEATURE_HYPERMOVE_MCP_GATEWAY_V1: 'true',
    FEATURE_MCP_INSTRUCT_V1: 'true',
    TEE_EXTENSION_PROXY_URL: 'https://proxy.example.com',
    FLARE_INSTRUCTION_SENDER_ADDRESS: '0x1111111111111111111111111111111111111111',
    FLARE_INSTRUCT_SIGNER_KEY: '0x' + '11'.repeat(32),
  };
  delete process.env.DATABASE_URL;
  vi.resetModules();
});

afterEach(() => {
  process.env = origEnv;
  vi.doUnmock('viem');
  vi.doUnmock('viem/accounts');
  vi.restoreAllMocks();
});

const FAKE_TX_HASH = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const FAKE_INSTRUCTION_ID = ('0x' + 'bb'.repeat(32)) as `0x${string}`; // deliberately != FAKE_TX_HASH

function mockViemClients() {
  vi.doMock('viem', async () => {
    const actual = await vi.importActual<typeof import('viem')>('viem');
    return {
      ...actual,
      createPublicClient: vi.fn(() => ({
        simulateContract: vi.fn(async () => ({
          request: { fake: 'request' },
          result: FAKE_INSTRUCTION_ID,
        })),
        waitForTransactionReceipt: vi.fn(async () => ({ transactionHash: FAKE_TX_HASH })),
      })),
      createWalletClient: vi.fn(() => ({
        writeContract: vi.fn(async () => FAKE_TX_HASH),
      })),
    };
  });
  vi.doMock('viem/accounts', () => ({
    privateKeyToAccount: vi.fn(() => ({ address: '0x2222222222222222222222222222222222222222' })),
  }));
}

describe('flare-instruct.ts submitAndPoll(): real instructionId decoding', () => {
  it('uses the decoded simulateContract() return value as instructionId, NOT the tx hash', async () => {
    mockViemClients();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: { status: 1, data: { ok: true } } }),
      })),
    );

    const { dispatchInstruction } = await import('../src/lib/mcp/flare-instruct');
    const res = await dispatchInstruction({ opType: 'GENERIC_AGENT_TASK', message: { taskType: 'dream.extract', payload: 'summary' } });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.instructionId).toBe(FAKE_INSTRUCTION_ID);
      expect(res.data.instructionId).not.toBe(FAKE_TX_HASH);
      expect(res.data.txHash).toBe(FAKE_TX_HASH);
    }
    vi.unstubAllGlobals();
  });

  it('polls ext-proxy using GET /action/result/{instructionId}, not the old /action-result/{id} path', async () => {
    mockViemClients();
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ result: { status: 1, data: null } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { dispatchInstruction } = await import('../src/lib/mcp/flare-instruct');
    await dispatchInstruction({ opType: 'FINANCIAL_ACTION', opCommand: 'SWAP', message: { action: 'swap', amount: '1', chain: 'coston2' } });

    const calledUrls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes(`/action/result/${FAKE_INSTRUCTION_ID}`))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/action-result/'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('hex-decodes ActionResult.Data (hexutil.Bytes) into the parsed JSON payload, matching the real tee-proxy response shape', async () => {
    mockViemClients();
    const payload = { attestationQuote: 'magic_pass', insights: { rules: ['r1'], preferences: [], error_patterns: [], facts: [] } };
    const hexData = '0x' + Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ result: { status: 1, data: hexData } }),
      })),
    );

    const { dispatchInstruction } = await import('../src/lib/mcp/flare-instruct');
    const res = await dispatchInstruction({ opType: 'GENERIC_AGENT_TASK', message: { taskType: 'dream.extract', payload: 'summary' } });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.data).toEqual(payload);
    }
    vi.unstubAllGlobals();
  });
});
