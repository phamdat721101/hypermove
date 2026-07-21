import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import {
  toOpHash,
  fromOpHash,
  decodeAction,
  encodeGenericAgentTaskMessage,
  encodeActionResult,
  unsupportedOpTypeLog,
  unsupportedOpCommandLog,
  type WireAction,
  type DecodedAction,
  type DecodeError,
} from '../src/action-codec.js';
import {
  OP_TYPE_FINANCIAL_ACTION,
  OP_TYPE_GENERIC_AGENT_TASK,
  OP_COMMAND_SWAP,
  OP_COMMAND_SEARCH,
  OP_COMMAND_COMPUTE,
} from '../src/config.js';

const FINANCIAL_TUPLE = [
  {
    name: '',
    type: 'tuple',
    components: [
      { name: 'action', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'chain', type: 'string' },
    ],
  },
] as const;

function buildAction(opType: string, opCommand: string, originalMessage: Hex): WireAction {
  return {
    data: {
      id: '0x1234' as Hex,
      submissionTag: 'submit',
      message: JSON.stringify({
        opType: toOpHash(opType),
        opCommand: toOpHash(opCommand),
        originalMessage,
      }),
    },
  };
}

describe('toOpHash / fromOpHash', () => {
  it('round-trips a short string', () => {
    const h = toOpHash('SEARCH');
    expect(fromOpHash(h)).toBe('SEARCH');
  });

  it('produces exactly 32 bytes', () => {
    expect(toOpHash('X').slice(2).length).toBe(64);
  });

  it('truncates strings over 32 chars, matching Go ToHash', () => {
    const long = 'A'.repeat(40);
    const h = toOpHash(long);
    expect(fromOpHash(h)).toBe('A'.repeat(32));
  });
});

describe('decodeAction — FINANCIAL_ACTION', () => {
  it('decodes a well-formed SWAP action', () => {
    const originalMessage = encodeAbiParameters(FINANCIAL_TUPLE, [{ action: 'SWAP', amount: '100', chain: 'coston2' }]);
    const action = buildAction(OP_TYPE_FINANCIAL_ACTION, OP_COMMAND_SWAP, originalMessage);
    const result = decodeAction(action) as DecodedAction;
    expect(result.opType).toBe('FINANCIAL_ACTION');
    expect(result.opCommand).toBe('SWAP');
    expect(result.financial).toEqual({ action: 'SWAP', amount: '100', chain: 'coston2' });
  });
});

describe('decodeAction — GENERIC_AGENT_TASK / HyperMove commands', () => {
  it('decodes a well-formed SEARCH action with JSON arguments', () => {
    const originalMessage = encodeGenericAgentTaskMessage('SEARCH', { query: 'flare tee', total: 5 });
    const action = buildAction(OP_TYPE_GENERIC_AGENT_TASK, OP_COMMAND_SEARCH, originalMessage);
    const result = decodeAction(action) as DecodedAction;
    expect(result.opType).toBe('GENERIC_AGENT_TASK');
    expect(result.opCommand).toBe('SEARCH');
    expect(result.generic?.taskType).toBe('SEARCH');
    expect(result.generic?.argumentsJson).toEqual({ query: 'flare tee', total: 5 });
  });

  it('decodes COMPUTE (the original Sub-PRD A placeholder command)', () => {
    const originalMessage = encodeGenericAgentTaskMessage('SUMMARIZE', {});
    const action = buildAction(OP_TYPE_GENERIC_AGENT_TASK, OP_COMMAND_COMPUTE, originalMessage);
    const result = decodeAction(action) as DecodedAction;
    expect(result.opCommand).toBe('COMPUTE');
  });

  it('returns null argumentsJson (never throws) for a non-JSON payload', () => {
    const originalMessage = encodeGenericAgentTaskMessage('SEARCH', {} as Record<string, unknown>);
    // Corrupt: rebuild with a non-JSON payload by hand, same tuple shape.
    const badMessage = encodeAbiParameters(
      [
        {
          name: '',
          type: 'tuple',
          components: [
            { name: 'taskType', type: 'string' },
            { name: 'payload', type: 'bytes' },
          ],
        },
      ] as const,
      [{ taskType: 'SEARCH', payload: `0x${Buffer.from('not json').toString('hex')}` as Hex }],
    );
    const action = buildAction(OP_TYPE_GENERIC_AGENT_TASK, OP_COMMAND_SEARCH, badMessage);
    const result = decodeAction(action) as DecodedAction;
    expect(result.generic?.argumentsJson).toBeNull();
    expect(originalMessage).toBeDefined(); // keep the unused encode call meaningful/non-dead
  });
});

describe('decodeAction — error paths', () => {
  it('flags malformed Data.Message JSON', () => {
    const action: WireAction = { data: { id: '0xabcd' as Hex, message: 'not json at all' } };
    const result = decodeAction(action) as DecodeError;
    expect(result.kind).toBe('bad_data_message');
  });

  it('flags an unknown OPType', () => {
    const action = buildAction('UNKNOWN_TYPE', OP_COMMAND_SWAP, '0x' as Hex);
    const result = decodeAction(action) as DecodeError;
    expect(result.kind).toBe('unsupported_op_type');
    if (result.kind === 'unsupported_op_type') {
      expect(result.receivedLabel).toBe('UNKNOWN_TYPE');
    }
  });

  it('flags an unknown OPCommand under FINANCIAL_ACTION', () => {
    const action = buildAction(OP_TYPE_FINANCIAL_ACTION, 'UNKNOWN_COMMAND', '0x' as Hex);
    const result = decodeAction(action) as DecodeError;
    expect(result.kind).toBe('unsupported_op_command');
    if (result.kind === 'unsupported_op_command') {
      expect(result.opTypeLabel).toBe('FINANCIAL_ACTION');
    }
  });

  it('flags an unknown OPCommand under GENERIC_AGENT_TASK', () => {
    const action = buildAction(OP_TYPE_GENERIC_AGENT_TASK, 'UNKNOWN_COMMAND', '0x' as Hex);
    const result = decodeAction(action) as DecodeError;
    expect(result.kind).toBe('unsupported_op_command');
  });

  it('flags an ABI-undecodable originalMessage without throwing', () => {
    const action = buildAction(OP_TYPE_FINANCIAL_ACTION, OP_COMMAND_SWAP, '0xdeadbeef' as Hex);
    const result = decodeAction(action) as DecodeError;
    expect(result.kind).toBe('bad_original_message');
  });
});

describe('encodeActionResult', () => {
  it('hex-encodes the JSON data payload', () => {
    const result = encodeActionResult({
      id: '0x01' as Hex,
      submissionTag: 'submit',
      status: 1,
      log: 'ok',
      opType: toOpHash(OP_TYPE_GENERIC_AGENT_TASK),
      opCommand: toOpHash(OP_COMMAND_SEARCH),
      version: '1.0.0',
      dataPayload: { ok: true, hits: 3 },
    });
    const decodedJson = JSON.parse(Buffer.from(result.data.slice(2), 'hex').toString('utf8'));
    expect(decodedJson).toEqual({ ok: true, hits: 3 });
    expect(result.status).toBe(1);
  });
});

describe('log message builders (cross-implementation wording consistency)', () => {
  it('unsupportedOpTypeLog mentions both known OPTypes', () => {
    const msg = unsupportedOpTypeLog(toOpHash('UNKNOWN'), 'UNKNOWN');
    expect(msg).toContain('unsupported op type');
    expect(msg).toContain('FINANCIAL_ACTION');
    expect(msg).toContain('GENERIC_AGENT_TASK');
  });

  it('unsupportedOpCommandLog lists provided valid commands', () => {
    const msg = unsupportedOpCommandLog('FINANCIAL_ACTION', toOpHash('UNKNOWN'), 'UNKNOWN', ['SWAP', 'SETTLE']);
    expect(msg).toContain('unsupported op command');
    expect(msg).toContain('SWAP');
    expect(msg).toContain('SETTLE');
  });
});
