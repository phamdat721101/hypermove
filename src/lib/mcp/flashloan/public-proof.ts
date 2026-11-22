import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, hash, ResearchError, boundaryEvent } from './contracts';
import { assertPublicValue, proofEnvelopeSchema, PUBLIC_LIMITS, type ProofEnvelope } from './public-contracts';

export class PublicProofs {
  constructor(private readonly key: string, readonly registry: string, private readonly clock = Date.now) {
    if (Buffer.byteLength(key) < 32) throw new ResearchError('PUBLIC_UNCONFIGURED', 'A separate public integrity key of at least 32 bytes is required.');
  }
  sign(kind: ProofEnvelope['kind'], payload: Record<string, unknown>, sourceExpiry?: string): ProofEnvelope {
    assertPublicValue(payload, PUBLIC_LIMITS.envelope_bytes);
    const now = this.clock(), end = Math.min(now + PUBLIC_LIMITS.proof_ttl_ms, sourceExpiry ? Date.parse(sourceExpiry) : Infinity);
    if (end <= now) throw new ResearchError('PROOF_EXPIRED', 'Source proof has expired; fetch a new snapshot.');
    const unsigned = { version: 2 as const, kind, issued_at: new Date(now).toISOString(), expires_at: new Date(end).toISOString(), registry_version: this.registry, content_hash: hash(payload), payload };
    const envelope = { ...unsigned, proof: { algorithm: 'HS256' as const, key_id: 'v2' as const, signature: this.signature(unsigned) } };
    assertPublicValue(envelope, PUBLIC_LIMITS.envelope_bytes);
    return envelope;
  }
  verify(raw: unknown, kind: ProofEnvelope['kind']) {
    assertPublicValue(raw, PUBLIC_LIMITS.envelope_bytes);
    const parsed = proofEnvelopeSchema.safeParse(raw);
    if (!parsed.success) { if (raw && typeof raw === 'object' && 'version' in raw && raw.version !== 2) throw new ResearchError('PROOF_VERSION', 'Incompatible proof version; refresh the snapshot.'); throw new ResearchError('INVALID_PROOF', 'Malformed integrity envelope.'); }
    const { proof, ...unsigned } = parsed.data;
    const expected = Buffer.from(this.signature(unsigned)); const actual = Buffer.from(proof.signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || hash(unsigned.payload) !== unsigned.content_hash) { boundaryEvent('EDGE-04', 'PUBLIC_INVALID_PROOF'); throw new ResearchError('INVALID_PROOF', 'Research payload was modified or has an invalid proof.'); }
    if (unsigned.kind !== kind) throw new ResearchError('PROOF_KIND', 'Wrong research payload kind.');
    if (unsigned.registry_version !== this.registry) throw new ResearchError('PROOF_VERSION', 'Deployment registry or engine version changed; fetch a new snapshot.');
    const now = this.clock(), issued = Date.parse(unsigned.issued_at), expires = Date.parse(unsigned.expires_at);
    if (issued > now || expires <= now || expires <= issued || expires - issued > PUBLIC_LIMITS.proof_ttl_ms) throw new ResearchError('PROOF_EXPIRED', 'Research proof has expired; fetch a new snapshot.');
    return parsed.data;
  }
  private signature(value: unknown) { return createHmac('sha256', this.key).update('hypermove-public-integrity-v2\n').update(canonical(value)).digest('base64url'); }
}
