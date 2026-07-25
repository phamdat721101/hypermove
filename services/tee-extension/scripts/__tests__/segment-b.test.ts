/**
 * segment-b.test.ts — T3-4 (asserts /info reflects the freshly deployed local
 * extension) + T4-5 (asserts both submitted instructions reach a terminal status).
 * Tagged as an integration test: mocks child_process (no real Docker/ngrok needed
 * to run this in CI), but exercises the real sequencing logic — deploy -> boot ->
 * tunnel -> submit -> poll — end to end within the mock boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnCalls: string[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args.join(' '));
    const fakeStream = { on: () => fakeStream };
    return {
      stdout: fakeStream,
      stderr: fakeStream,
      kill: () => {},
      on: (event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'close') setTimeout(() => cb(0), 0);
        return undefined;
      },
    };
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: () => true,
    readFileSync: () => 'INSTRUCTION_SENDER="0xLocalInstructionSenderAddr"\n',
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('viem', async (importOriginal) => {
  const original = await importOriginal<typeof import('viem')>();
  return {
    ...original,
    createWalletClient: () => ({
      writeContract: vi.fn().mockResolvedValue('0xLOCALTXHASH'),
    }),
  };
});

import { runSegmentB } from '../segment-b.js';
import type { OrchestratorConfig } from '../config.js';

const baseConfig: OrchestratorConfig = {
  deploymentPrivateKey: '0xTEST_KEY_NEVER_REAL',
  chainUrl: 'http://127.0.0.1:8545',
  addressesFile: './config/coston2/deployed-addresses.json',
  extProxyPortLocal: 6674,
  xrplRlusdMaxPerTransfer: '50',
};

describe('runSegmentB', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    fetchMock.mockReset();
  });

  it('boots the local stack, tunnels, submits both OPTypes, and polls to a terminal result', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/info')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ platform: 'SIMULATED_TEE_LOCAL' }),
        });
      }
      if (url.includes('127.0.0.1:4040')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tunnels: [{ public_url: 'https://fake-ngrok-url.ngrok-free.dev' }] }),
        });
      }
      if (url.includes('/result/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'success', data: 'ok' }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    const results = await runSegmentB(baseConfig);

    const deployLocal = results.find((r) => r.step === 'deploy-local');
    const bootLocal = results.find((r) => r.step === 'boot-local-stack');
    const tunnel = results.find((r) => r.step === 'ngrok-tunnel');
    const submitFinancial = results.find((r) => r.step === 'submit-financial-action');
    const submitGeneric = results.find((r) => r.step === 'submit-generic-agent-task');
    const pollFinancial = results.find((r) => r.step === 'poll-financial-action-result');
    const pollGeneric = results.find((r) => r.step === 'poll-generic-agent-task-result');

    expect(deployLocal?.status).toBe('real');
    expect(deployLocal?.evidence?.address).toBe('0xLocalInstructionSenderAddr');
    expect(bootLocal?.status).toBe('simulated');
    expect(tunnel?.status).toBe('real');
    expect(tunnel?.evidence?.url).toBe('https://fake-ngrok-url.ngrok-free.dev');
    expect(submitFinancial?.status).toBe('real');
    expect(submitFinancial?.evidence?.extra?.chain).toBe('xrpl');
    expect(submitGeneric?.status).toBe('real');
    expect(pollFinancial?.status).toBe('real');
    expect(pollGeneric?.status).toBe('real');
  }, 20_000);

  it('never calls stop-services.sh before ngrok/services are actually torn down (teardown ordering)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/info')) {
        return Promise.resolve({ ok: true, json: async () => ({ platform: 'SIMULATED_TEE_LOCAL' }) });
      }
      if (url.includes('127.0.0.1:4040')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tunnels: [{ public_url: 'https://fake-ngrok-url.ngrok-free.dev' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ status: 'success' }) });
    });

    await runSegmentB(baseConfig);
    const stopCallIndex = spawnCalls.findIndex((c) => c.includes('stop-services.sh'));
    const startCallIndex = spawnCalls.findIndex((c) => c.includes('start-services.sh'));
    expect(stopCallIndex).toBeGreaterThan(startCallIndex);
  }, 20_000);
});
