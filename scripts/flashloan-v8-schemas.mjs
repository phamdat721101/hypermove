import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { z } = require('zod');
const contracts = require('../services/flashloan/dist/src/lib/mcp/flashloan/v8-contracts.js');
const registry = require('../services/flashloan/dist/src/lib/mcp/flashloan/discovery-registry.js');
const schemas = {
  ...contracts.v8DocumentSchemas(),
  registry: z.toJSONSchema(registry.registryV1Schema, { io: 'input' }),
  registry_config: z.toJSONSchema(registry.discoveryRegistryConfigSchema, { io: 'input' }),
  inputs: Object.fromEntries(['discoveryV3InputSchema', 'moversV2InputSchema', 'watchlistInputSchema', 'registryInputSchema'].map((name) => [name, z.toJSONSchema(contracts[name], { io: 'input' })])),
};
const path = fileURLToPath(new URL('../docs/features/flashloan-v8.schema.json', import.meta.url));
const serialized = JSON.stringify(schemas, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== serialized) throw new Error('Flashloan v8 schema export is stale; compile the worker and run node scripts/flashloan-v8-schemas.mjs.');
  console.log(JSON.stringify({ marker: 'FLV8_MCP_SCHEMA_EXPORT', passed: true }));
} else writeFileSync(path, serialized);
