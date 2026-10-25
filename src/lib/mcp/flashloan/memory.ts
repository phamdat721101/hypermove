import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createKnowledgeHelper, type KnowledgeHelper } from 'nim-skill';
import { hash, ResearchError, type Input } from './contracts';
import type { Repository } from './storage';

export function knowledgeFor(root: string, owner: string): KnowledgeHelper {
  return createKnowledgeHelper({ root: join(root, hash(owner)), projectId: 'flashloan-' + hash(owner).slice(0, 24), network: false, graph: { enabled: true, maxDepth: 2, maxNodes: 30, maxEdges: 60, budget: 2000 } });
}
export async function syncMemory(root: string, owner: string, input: Input<'nim_memory_sync_flashloan_lesson'>, repo: Repository) {
  const knowledge = knowledgeFor(root, owner);
  if (input.operation === 'RETRIEVE') {
    if (!input.query) throw new ResearchError('INVALID_INPUT', 'Retrieval requires a query.');
    const query = await knowledge.query(input.query, { budget: 1000, topK: 5 });
    const hydrated = knowledge.hydrate(query.hits.map((h) => h.id), { sequence: query.snapshotSequence, budget: 1000 });
    return { query, hydrated, advisory: true };
  }
  if (input.operation === 'PROPOSE') {
    if (!input.report_id) throw new ResearchError('INVALID_INPUT', 'A committed report artifact is required.');
    const report = await repo.artifact(owner, input.report_id);
    if (report.kind !== 'report') throw new ResearchError('INVALID_INPUT', 'Only research reports can become lesson evidence.');
    const data = report.data as Record<string, unknown>;
    const evidence = `Research report ${report.id}\nStatus: ${String(data.status)}\nContent hash: ${report.content_hash}\nProducer: ${report.producer_version}\nEvidence is contextual; this report establishes no general trading rule.\n`;
    const dir = join(root, hash(owner), 'report-sources'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, report.id + '.md'); await writeFile(file, evidence, { mode: 0o600 });
    const packet = await knowledge.ingest(file, { maxPacketTokens: 1500 });
    if (!packet.proposal) return { unchanged: true, report_id: report.id };
    const proposal = knowledge.propose(packet.proposal);
    return { proposal_id: proposal.proposalId, citations: packet.chunks.map((c) => c.citation), activated_procedures: false, candidate_type: 'SOURCE_EVIDENCE', inference_policy: 'PROVISIONAL_OWNER_APPROVAL_REQUIRED' };
  }
  if (!input.proposal_id) throw new ResearchError('INVALID_INPUT', 'A proposal ID is required.');
  const proposal = knowledge.store.readProposal(input.proposal_id);
  // This API cannot be used to smuggle procedures or policy changes into knowledge.
  if (proposal.records.some((r) => r.kind !== 'source')) throw new ResearchError('APPROVAL_REQUIRED', 'Only grounded report-source proposals can be committed by this tool.');
  if (input.operation === 'VALIDATE') { knowledge.propose(proposal); return { validated: true, proposal_id: input.proposal_id, scope: 'REPORT_SOURCE', procedure_approval: false }; }
  return knowledge.commitProposal(input.proposal_id);
}
