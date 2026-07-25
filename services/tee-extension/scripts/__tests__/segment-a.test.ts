/**
 * segment-a.test.ts — T2-5: asserts the script never invokes
 * `start-services.sh --chain coston2` after a successful deploy, and that a missing
 * DEPLOYMENT_PRIVATE_KEY produces an `error` result without attempting any child process.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSegmentA } from '../segment-a.js';
import type { OrchestratorConfig } from '../config.js';

const spawnCalls: string[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    spawnCalls.push(args.join(' '));
    const handlers: Record<string, ((...a: any[]) => void)[]> = {};
    const fakeStream = { on: (_e: string, _cb: any) => fakeStream };
    return {
      stdout: fakeStream,
      stderr: fakeStream,
      on: (event: string, cb: (...a: any[]) => void) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(cb);
        if (event === 'close') {
          // Simulate pre-build.sh succeeding immediately (exit code 0), synchronously
          // enough for the test but still via the real Promise-based interface.
          setTimeout(() => cb(0), 0);
        }
        return this;
      },
    };
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: () => true,
    readFileSync: () => 'EXTENSION_ID="65536"\nINSTRUCTION_SENDER="0xInstructionSenderAddr"\n',
  };
});

const baseConfig: OrchestratorConfig = {
  deploymentPrivateKey: '0xTEST_KEY_NEVER_REAL',
  chainUrl: 'https://coston2-api.flare.network/ext/C/rpc',
  addressesFile: './config/coston2/deployed-addresses.json',
  extProxyPortLocal: 6674,
  xrplRlusdMaxPerTransfer: '50',
};

describe('runSegmentA', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('never invokes start-services.sh --chain coston2 after a successful deploy', async () => {
    const results = await runSegmentA(baseConfig);
    const startedCostonEctProxy = spawnCalls.some(
      (call) => call.includes('start-services.sh') && call.includes('coston2'),
    );
    expect(startedCostonEctProxy).toBe(false);
  });

  it('produces a real deploy result followed by a blocked T1 result', async () => {
    const results = await runSegmentA(baseConfig);
    const deployResult = results.find((r) => r.step === 'deploy-and-register');
    const blockedResult = results.find((r) => r.step === 'start-ext-proxy');

    expect(deployResult?.status).toBe('real');
    expect(deployResult?.evidence?.address).toBe('0xInstructionSenderAddr');
    expect(blockedResult?.status).toBe('blocked');
    expect(blockedResult?.blockerId).toBe('T1');
  });

  it('returns an error result and spawns nothing when DEPLOYMENT_PRIVATE_KEY is missing', async () => {
    const results = await runSegmentA({ ...baseConfig, deploymentPrivateKey: undefined });
    expect(results[0].status).toBe('error');
    expect(spawnCalls.length).toBe(0);
  });
});
