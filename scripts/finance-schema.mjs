#!/usr/bin/env node
// Finance contract integrity: the repo schema must equal the PRD's embedded
// `finance-contract` block byte-for-byte (after JSON normalisation) and hash to the
// pinned digest. Rates contract copied $defs must stay byte-equal to finance-wire:1.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PINNED = '8046b6f9d4ef51f9419481ccee4e49c567681df9fb3f48867b9194cff3de4edb';
const canonical = (v) => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  : JSON.stringify(v);
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');
const fail = (msg) => { console.error('FINANCE_SCHEMA_DRIFT: ' + msg); process.exit(1); };

const prd = readFileSync(new URL('../AI-FINANCE-UPGRADE-PRD.md', import.meta.url), 'utf8');
const block = /```json finance-contract\n([\s\S]*?)\n```/.exec(prd)?.[1];
if (!block) fail('PRD finance-contract block not found');
const fromPrd = JSON.parse(block);
const wire = JSON.parse(readFileSync(new URL('../src/lib/mcp/flashloan/finance/finance-v1.schema.json', import.meta.url), 'utf8'));
const rates = JSON.parse(readFileSync(new URL('../src/lib/mcp/flashloan/finance/finance-rates-v1.schema.json', import.meta.url), 'utf8'));
if (digest(fromPrd) !== PINNED) fail('PRD contract digest ' + digest(fromPrd) + ' != pinned');
if (digest(wire) !== PINNED) fail('repo finance-v1.schema.json digest ' + digest(wire) + ' != pinned');
for (const def of ['Digest', 'Uint', 'Decimal', 'Timestamp', 'EvmAddress', 'XrplAddress', 'Quantity', 'Amount', 'EvidenceRef', 'Observation', 'Coverage', 'Error']) {
  if (canonical(rates.$defs[def]) !== canonical(wire.$defs[def])) fail('rates $defs.' + def + ' diverged from finance-wire:1');
}
console.log('FINANCE_SCHEMA_OK finance-wire:1=' + PINNED + ' finance-rates:1=' + digest(rates));
