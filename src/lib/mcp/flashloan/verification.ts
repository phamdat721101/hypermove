import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { hash, ResearchError, VERSION } from './contracts';

export const researchEvidenceSchema = z.object({
  network: z.enum(['robinhood', 'sui']), build_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), registry_hash: z.string().regex(/^[a-f0-9]{64}$/),
  engine_version: z.literal(VERSION), verified_at: z.string().datetime(), expires_at: z.string().datetime(),
  source: z.string().url(), checks: z.array(z.enum(['deterministic', 'local_e2e', 'live_quote', 'live_simulation'])),
}).strict();
export type ResearchEvidence = z.infer<typeof researchEvidenceSchema>;
export function implementationFingerprint() {
  const modules = ['contracts', 'networks', 'discovery', 'evm', 'math', 'simulation', 'engine', 'verification', 'sui', 'sui-contracts', 'public-worker', 'public-contracts', 'public-proof', 'transport'];
  const integration = process.env.FLASHLOAN_CANDIDATE_RESEARCH_V2 === 'true' || process.env.FLASHLOAN_POOL_RESOLUTION_V1 === 'true';
  if (integration) modules.push('integration-contracts', 'pool-resolution', 'candidate-v2');
  const paths = [process.env.FLASHLOAN_ENGINE ?? 'services/flashloan/target/release/flashloan-engine', 'services/flashloan/native/main.rs', 'services/flashloan/Cargo.toml', 'services/flashloan/Cargo.lock', 'package.json', 'pnpm-lock.yaml', 'services/flashloan/contracts/ResearchExecutor.sol', 'services/flashloan/out/ResearchExecutor.sol/ResearchExecutor.json', ...modules.flatMap((name) => ['src/lib/mcp/flashloan/' + name + '.ts', 'services/flashloan/dist/src/lib/mcp/flashloan/' + name + '.js'])];
  if (integration) paths.push('src/lib/mcp/flashloan/integration.schema.json', 'services/flashloan/dist/src/lib/mcp/flashloan/integration.schema.json');
  const records = paths.filter((path) => existsSync(resolve(path))).map((path) => [path, createHash('sha256').update(readFileSync(resolve(path))).digest('hex')]);
  if (records.length < 4) throw new ResearchError('BUILD_FINGERPRINT_UNAVAILABLE', 'Research release sources or compiled artifacts are missing.');
  return hash({ runtime: process.versions.node, records });
}
export function registryHash(deployments: unknown, suiDeployments: unknown = []) { return hash({ version: VERSION, build_fingerprint: implementationFingerprint(), deployments, sui_deployments: suiDeployments }); }
export function researchVerified(network: string, evidence: ResearchEvidence[], registry: string, clock = Date.now) {
  const now = clock();
  return evidence.some((e) => e.network === network && e.build_fingerprint === implementationFingerprint() && e.registry_hash === registry && e.engine_version === VERSION && Date.parse(e.verified_at) <= now && Date.parse(e.expires_at) > now && ['deterministic', 'local_e2e', 'live_quote', 'live_simulation'].every((check) => e.checks.includes(check as ResearchEvidence['checks'][number])));
}
export function requireResearch(network: string, evidence: ResearchEvidence[], registry: string) {
  if ((network === 'robinhood' || network === 'sui') && !researchVerified(network, evidence, registry)) throw new ResearchError('CAPABILITY_UNAVAILABLE', 'Research requires current deterministic, local E2E and live native verification evidence for this deployment registry. Discovery is available independently.');
}
