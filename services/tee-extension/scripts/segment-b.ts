/**
 * segment-b.ts
 * ------------
 * Segment B — local Hardhat devnet (real, SIMULATED_TEE=true): boots the full
 * contract -> ext-proxy -> extension-tee stack locally (Task 3), fronts ext-proxy
 * with an ad-hoc ngrok tunnel, submits both OPTypes on-chain, and polls for results
 * (Task 4).
 *
 * maxHeals: 2 here specifically — Docker-startup races are a legitimate transient
 * retry case, unlike Segment A/C's maxHeals:0 (a fabricated deploy/payment result
 * must never be produced by blind retry). See 03-architecture-and-design.md.
 *
 * Guard/monitor config fields verified against the real nim-skill harness types
 * (node_modules/nim-skill/dist/harness/types.d.ts) — GuardConfig only exposes
 * {maxCostUsd, ratePerMin, allowTools, injection}; MonitorConfig only exposes
 * {exporters, traceFile, tokenAccounting}. `ratePerMin` is the real mechanism for
 * "cap how many calls this segment can make per run" (T4-3), not an invented
 * `maxCalls` field.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { runHarnessed, type SkillDef } from 'nim-skill';
import { createWalletClient, http, encodeAbiParameters, type Address } from 'viem';
import type { OrchestratorConfig } from './config.js';
import type { SegmentResult } from './types.js';

const SCAFFOLD_DIR = '../extension-examples/extension-scaffold';
const NGROK_LOCAL_API = 'http://127.0.0.1:4040/api/tunnels';

interface ChildProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScaffoldScript(
  scriptRelPath: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<ChildProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptRelPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fetchInfo(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${url}/info`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads INSTRUCTION_SENDER back out of config/extension.env — the same file
 *  Segment A's pre-build.sh writes (see segment-a.ts's parseExtensionEnvFile).
 *  Segment B's own local pre-build.sh run (Task 3, below) writes this file for
 *  the LOCAL deployment specifically — this closes the integration gap between
 *  "contract deployed locally" and "on-chain calls target the right address"
 *  without relying on an operator-supplied placeholder env var. */
function readLocalInstructionSenderAddress(cwd: string): Address | undefined {
  const path = `${cwd}/config/extension.env`;
  if (!existsSync(path)) return undefined;
  const contents = readFileSync(path, 'utf8');
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('INSTRUCTION_SENDER=')) {
      const value = trimmed.slice('INSTRUCTION_SENDER='.length).replace(/['"]/g, '');
      return value as Address;
    }
  }
  return undefined;
}

/** Spawns `ngrok http <port>` and reads the public URL from ngrok's local API.
 *  Returns the child process handle so callers can kill it in teardown. */
async function startNgrokTunnel(
  port: number,
): Promise<{ url: string; proc: ReturnType<typeof spawn> }> {
  const proc = spawn('ngrok', ['http', String(port)], { stdio: 'ignore' });

  // ngrok needs a moment to establish the tunnel and expose its local API.
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(NGROK_LOCAL_API);
      if (res.ok) {
        const data = (await res.json()) as { tunnels?: { public_url: string }[] };
        const httpsTunnel = data.tunnels?.find((t) => t.public_url.startsWith('https://'));
        if (httpsTunnel) return { url: httpsTunnel.public_url, proc };
      }
    } catch {
      // ngrok API not ready yet — retry.
    }
  }
  proc.kill();
  throw new Error('ngrok tunnel did not become ready within 15s.');
}

const INSTRUCTION_SENDER_ABI = [
  {
    type: 'function',
    name: 'sendFinancialAction',
    stateMutability: 'payable',
    inputs: [
      { name: '_opCommand', type: 'bytes32' },
      { name: '_message', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sendGenericAgentTask',
    stateMutability: 'payable',
    inputs: [{ name: '_message', type: 'bytes' }],
    outputs: [],
  },
] as const;

/** Matches flare-instruct.ts's opCommandToBytes32() convention exactly — read, not
 *  reinvented (WR-02 self-check: same encoding scheme across both modules). */
function opCommandToBytes32(command: string): `0x${string}` {
  const bytes = new TextEncoder().encode(command);
  const padded = new Uint8Array(32);
  padded.set(bytes.slice(0, 32));
  return `0x${Buffer.from(padded).toString('hex')}` as `0x${string}`;
}

function encodeFinancialActionMessage(action: string, amount: string, chain: string): `0x${string}` {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'action', type: 'string' },
          { name: 'amount', type: 'string' },
          { name: 'chain', type: 'string' },
        ],
      },
    ],
    [{ action, amount, chain }],
  );
}

function encodeGenericAgentTaskMessage(taskType: string, payload: object): `0x${string}` {
  const payloadBytes = `0x${Buffer.from(JSON.stringify(payload), 'utf8').toString('hex')}` as `0x${string}`;
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'taskType', type: 'string' },
          { name: 'payload', type: 'bytes' },
        ],
      },
    ],
    [{ taskType, payload: payloadBytes }],
  );
}

async function pollForResult(
  extProxyUrl: string,
  instructionId: string,
  timeoutMs = 15_000,
  intervalMs = 2_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${extProxyUrl}/result/${instructionId}`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string } & Record<string, unknown>;
        if (body.status && body.status !== 'pending') return body;
      }
    } catch {
      // transient — keep polling until timeout.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

interface SegmentBInput {
  config: OrchestratorConfig;
}

const RLUSD_DEMO_AMOUNT = '1'; // conservative demo amount, well under n-payment's caps

// See report.ts's comment: runHarnessed fixes the skill input type to Dict; we
// narrow via cast inside execute rather than through the generic.
const segmentBSkill: SkillDef<Record<string, unknown>, { results: SegmentResult[] } & Record<string, unknown>> = {
  name: 'e2e.segmentB.localFullLoop',
  version: '1.0.0',
  harness: {
    enforcer: {
      strategies: [{ kind: 'schema', required: ['results'] }],
      maxHeals: 2,
      mode: 'strict',
    },
    guard: {
      // T4-3: caps how many on-chain calls this segment can make per run — defends
      // against a retry loop accidentally spamming instructions on the local chain.
      // ratePerMin is the real GuardConfig field for this (no maxCalls field exists).
      ratePerMin: 4,
    },
    monitor: { exporters: ['file'] },
  },
  execute: async (rawInput): Promise<{ results: SegmentResult[] } & Record<string, unknown>> => {
    const { config } = rawInput as unknown as SegmentBInput;
    const results: SegmentResult[] = [];
    const cwd = new URL(SCAFFOLD_DIR, import.meta.url).pathname;
    let ngrokProc: ReturnType<typeof spawn> | undefined;

    try {
      // --- Task 3: deploy + register locally, then boot the local devnet stack ---
      const deployResult = await runScaffoldScript(
        'scripts/pre-build.sh',
        [],
        { LOCAL_MODE: 'true', CHAIN: 'local' },
        cwd,
      );
      if (deployResult.code !== 0) {
        results.push({
          segment: 'B',
          step: 'deploy-local',
          status: 'error',
          message: `pre-build.sh (local) exited ${deployResult.code}. stderr: ${deployResult.stderr.slice(0, 1500)}`,
        });
        return { results };
      }

      const instructionSenderAddress = readLocalInstructionSenderAddress(cwd);
      if (!instructionSenderAddress) {
        results.push({
          segment: 'B',
          step: 'deploy-local',
          status: 'error',
          message:
            'pre-build.sh (local) exited 0 but config/extension.env did not contain INSTRUCTION_SENDER.',
        });
        return { results };
      }

      results.push({
        segment: 'B',
        step: 'deploy-local',
        status: 'real',
        evidence: { address: instructionSenderAddress },
        message: 'Deployed HyperMoveInstructionSender and registered the extension on the local Hardhat devnet.',
      });

      const startResult = await runScaffoldScript(
        'scripts/start-services.sh',
        ['--chain', 'local'],
        { LOCAL_MODE: 'true', SIMULATED_TEE: 'true' },
        cwd,
      );
      if (startResult.code !== 0) {
        results.push({
          segment: 'B',
          step: 'boot-local-stack',
          status: 'error',
          message: `start-services.sh --chain local exited ${startResult.code}. stderr: ${startResult.stderr.slice(0, 1500)}`,
        });
        return { results };
      }

      const localExtProxyUrl = `http://localhost:${config.extProxyPortLocal}`;
      const info = await fetchInfo(localExtProxyUrl);
      if (!info || typeof info.platform === 'undefined') {
        results.push({
          segment: 'B',
          step: 'boot-local-stack',
          status: 'error',
          message: `ext-proxy /info did not return an expected platform field after boot. Got: ${JSON.stringify(info)}`,
        });
        return { results };
      }

      results.push({
        segment: 'B',
        step: 'boot-local-stack',
        status: 'simulated',
        evidence: { url: localExtProxyUrl, extra: { platform: String(info.platform) } },
        message: 'Local Hardhat devnet + ext-proxy + extension-tee booted with SIMULATED_TEE=true.',
      });

      // --- Task 4: ngrok tunnel fronting the local ext-proxy ---
      const tunnel = await startNgrokTunnel(config.extProxyPortLocal);
      ngrokProc = tunnel.proc;
      results.push({
        segment: 'B',
        step: 'ngrok-tunnel',
        status: 'real',
        evidence: { url: tunnel.url },
        message: `ngrok tunnel established, fronting local ext-proxy on port ${config.extProxyPortLocal}.`,
      });

      // --- Task 4: submit both OPTypes on-chain against the local deployment ---
      const account = config.deploymentPrivateKey
        ? (`0x${config.deploymentPrivateKey.replace(/^0x/, '')}` as `0x${string}`)
        : undefined;

      // instructionSenderAddress was already read from config/extension.env above,
      // right after the local deploy step — real value, not a placeholder.
      if (account && instructionSenderAddress) {
        const walletClient = createWalletClient({
          account,
          transport: http(config.chainUrl),
        });

        const financialMessage = encodeFinancialActionMessage(
          'SWAP',
          RLUSD_DEMO_AMOUNT,
          'xrpl',
        );
        const genericMessage = encodeGenericAgentTaskMessage('SEARCH', {
          query: 'flare confidential compute',
        });

        // sendFinancialAction(SWAP, message) — traceable message for Segment C.
        const financialTxHash = await walletClient.writeContract({
          address: instructionSenderAddress,
          abi: INSTRUCTION_SENDER_ABI,
          functionName: 'sendFinancialAction',
          args: [opCommandToBytes32('SWAP'), financialMessage],
          chain: undefined,
        });

        results.push({
          segment: 'B',
          step: 'submit-financial-action',
          status: 'real',
          evidence: {
            txHash: financialTxHash,
            extra: { action: 'SWAP', amount: RLUSD_DEMO_AMOUNT, chain: 'xrpl' },
          },
          message: 'Submitted sendFinancialAction(SWAP, {amount, chain:"xrpl"}) on the local chain.',
        });

        const genericTxHash = await walletClient.writeContract({
          address: instructionSenderAddress,
          abi: INSTRUCTION_SENDER_ABI,
          functionName: 'sendGenericAgentTask',
          args: [genericMessage],
          chain: undefined,
        });

        results.push({
          segment: 'B',
          step: 'submit-generic-agent-task',
          status: 'real',
          evidence: { txHash: genericTxHash },
          message: 'Submitted sendGenericAgentTask(SEARCH,...) on the local chain.',
        });

        // --- poll ext-proxy for both results (via the ngrok URL, load-bearing) ---
        const financialResult = await pollForResult(tunnel.url, financialTxHash);
        results.push({
          segment: 'B',
          step: 'poll-financial-action-result',
          status: financialResult ? 'real' : 'error',
          message: financialResult
            ? `FINANCIAL_ACTION resolved: ${JSON.stringify(financialResult)}`
            : 'Timed out polling ext-proxy for FINANCIAL_ACTION result.',
        });

        const genericResult = await pollForResult(tunnel.url, genericTxHash);
        results.push({
          segment: 'B',
          step: 'poll-generic-agent-task-result',
          status: genericResult ? 'real' : 'error',
          message: genericResult
            ? `GENERIC_AGENT_TASK resolved: ${JSON.stringify(genericResult)}`
            : 'Timed out polling ext-proxy for GENERIC_AGENT_TASK result.',
        });
      } else {
        results.push({
          segment: 'B',
          step: 'submit-instructions',
          status: 'error',
          message:
            'Skipped on-chain submission — DEPLOYMENT_PRIVATE_KEY or LOCAL_INSTRUCTION_SENDER address not available.',
        });
      }

      return { results };
    } finally {
      if (ngrokProc) ngrokProc.kill();
      await runScaffoldScript('scripts/stop-services.sh', [], {}, cwd).catch(() => {});
    }
  },
};

export async function runSegmentB(
  config: OrchestratorConfig,
  agentId = 'e2e-coston2-flare-xrpl',
): Promise<SegmentResult[]> {
  const { output, verified, checks } = await runHarnessed(
    segmentBSkill,
    { config },
    { agentId },
  );

  if (!verified || !Array.isArray(output.results)) {
    return [
      {
        segment: 'B',
        step: 'harness-verify',
        status: 'error',
        message: `Segment B output failed harness verification: ${JSON.stringify(checks)}`,
      },
    ];
  }

  return output.results;
}
