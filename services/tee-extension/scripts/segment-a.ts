/**
 * segment-a.ts
 * ------------
 * Segment A — Coston2 (real): deploy HyperMoveInstructionSender, setExtensionId(),
 * register the extension on-chain via the scaffold's own pre-build.sh. Stops
 * explicitly at the T1 blocker (ext-proxy needs Flare indexer-DB credentials) —
 * never attempts to fake ext-proxy against Coston2.
 *
 * Per the PRD (Task 2): enforcer requires either a real success shape
 * ({extensionId, instructionSender, txHash}) or the literal blocked/T1 shape.
 * maxHeals: 0 — a deploy failure must surface as `error`, never be silently retried
 * into a fabricated success.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { runHarnessed, type SkillDef } from 'nim-skill';
import type { OrchestratorConfig } from './config.js';
import type { SegmentResult } from './types.js';

const SCAFFOLD_DIR =
  '../extension-examples/extension-scaffold';

interface ChildProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a scaffold script as a child process. Never receives or logs the raw
 *  private key value — it is passed via env to the child process only, which is
 *  the same mechanism the shell scripts themselves already expect
 *  (services/tee-extension/extension-examples/extension-scaffold/scripts/pre-build.sh
 *  reads DEPLOYMENT_PRIVATE_KEY from its own environment). */
function runScaffoldScript(
  scriptRelPath: string,
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<ChildProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptRelPath], {
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

interface ExtensionEnvFile {
  extensionId?: string;
  instructionSender?: string;
}

function parseExtensionEnvFile(path: string): ExtensionEnvFile {
  if (!existsSync(path)) return {};
  const contents = readFileSync(path, 'utf8');
  const out: ExtensionEnvFile = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('EXTENSION_ID=')) {
      out.extensionId = trimmed.slice('EXTENSION_ID='.length).replace(/['"]/g, '');
    }
    if (trimmed.startsWith('INSTRUCTION_SENDER=')) {
      out.instructionSender = trimmed
        .slice('INSTRUCTION_SENDER='.length)
        .replace(/['"]/g, '');
    }
  }
  return out;
}

interface SegmentAInput {
  config: OrchestratorConfig;
}

// See report.ts's comment: runHarnessed fixes the skill input type to Dict; we
// narrow via cast inside execute rather than through the generic.
const segmentASkill: SkillDef<Record<string, unknown>, { results: SegmentResult[] } & Record<string, unknown>> = {
  name: 'e2e.segmentA.coston2Register',
  version: '1.0.0',
  harness: {
    enforcer: {
      strategies: [{ kind: 'schema', required: ['results'] }],
      maxHeals: 0,
      mode: 'strict',
    },
    monitor: { exporters: ['file'] },
  },
  execute: async (rawInput): Promise<{ results: SegmentResult[] } & Record<string, unknown>> => {
    const { config } = rawInput as unknown as SegmentAInput;
    const results: SegmentResult[] = [];
    const cwd = new URL(SCAFFOLD_DIR, import.meta.url).pathname;

    if (!config.deploymentPrivateKey) {
      results.push({
        segment: 'A',
        step: 'deploy',
        status: 'error',
        message:
          'DEPLOYMENT_PRIVATE_KEY missing — cannot attempt Coston2 deploy. Supply via .env.coston2 (never in chat).',
      });
      return { results };
    }

    const deployEnv = {
      CHAIN: 'coston2',
      CHAIN_URL: config.chainUrl,
      ADDRESSES_FILE: config.addressesFile,
      DEPLOYMENT_PRIVATE_KEY: config.deploymentPrivateKey,
      LOCAL_MODE: 'false',
    };

    const deployResult = await runScaffoldScript('scripts/pre-build.sh', deployEnv, cwd);

    if (deployResult.code !== 0) {
      results.push({
        segment: 'A',
        step: 'deploy',
        status: 'error',
        message: `pre-build.sh exited with code ${deployResult.code}. stderr: ${deployResult.stderr.slice(0, 2000)}`,
      });
      return { results };
    }

    const extEnv = parseExtensionEnvFile(`${cwd}/config/extension.env`);
    if (!extEnv.extensionId || !extEnv.instructionSender) {
      results.push({
        segment: 'A',
        step: 'deploy',
        status: 'error',
        message:
          'pre-build.sh exited 0 but config/extension.env did not contain EXTENSION_ID/INSTRUCTION_SENDER as expected.',
      });
      return { results };
    }

    results.push({
      segment: 'A',
      step: 'deploy-and-register',
      status: 'real',
      evidence: {
        address: extEnv.instructionSender,
        extra: { extensionId: extEnv.extensionId },
      },
      message: `Deployed HyperMoveInstructionSender and registered extension ${extEnv.extensionId} on Coston2.`,
    });

    // Explicit, deliberate stop — do NOT call start-services.sh --chain coston2.
    // ext-proxy cannot start against Coston2 without Flare indexer-DB credentials.
    results.push({
      segment: 'A',
      step: 'start-ext-proxy',
      status: 'blocked',
      blockerId: 'T1',
      message:
        'ext-proxy cannot start against Coston2 without Flare indexer-DB credentials. ' +
        'Contact Flare support / @FlareDevs on X to request access, per services/tee-extension/README.md. ' +
        'This script deliberately does not attempt to fake ext-proxy connectivity.',
    });

    return { results };
  },
};

export async function runSegmentA(
  config: OrchestratorConfig,
  agentId = 'e2e-coston2-flare-xrpl',
): Promise<SegmentResult[]> {
  const { output, verified, checks } = await runHarnessed(
    segmentASkill,
    { config },
    { agentId },
  );

  if (!verified || !Array.isArray(output.results)) {
    return [
      {
        segment: 'A',
        step: 'harness-verify',
        status: 'error',
        message: `Segment A output failed harness verification: ${JSON.stringify(checks)}`,
      },
    ];
  }

  return output.results;
}
