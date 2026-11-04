import { describe, expect, it } from 'vitest';
import { batchOf, canonicalizeEvent, checkLabel, checkNetEvent, displayName, NetEventError, spanIdFor } from '../src/events.js';

const now = Date.parse('2026-06-15T18:00:00.000Z');

function raw(over: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) {
  return {
    schema_version: '1',
    event_id: 'evt-planner-01',
    name: 'agent.handoff',
    start_time_unix_nano: (BigInt(now - 60_000) * 1_000_000n).toString(),
    status: 'ok',
    attributes: {
      'gen_ai.agent.id': 'planner',
      'bn.target.id': 'coder',
      'bn.label': 'handoff · draft',
      ...attrs,
    },
    ...over,
  };
}

describe('event validation', () => {
  it('accepts a handoff and fills OTel defaults', () => {
    const ev = checkNetEvent(raw(), now);
    expect(ev.schema_version).toBe('1');
    expect(ev.attributes['gen_ai.agent.id']).toBe('planner');
    expect(ev.attributes['gen_ai.agent.name']).toBe('Planner');
    expect(ev.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(ev.attributes['gen_ai.transfer.target.name']).toBe('Coder');
    expect(ev.attributes['bn.source']).toBe('self-report');
    expect(ev.span_id).toBe(spanIdFor('evt-planner-01'));
    expect(ev.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.status).toEqual({ code: 'OK' });
  });

  it('lowercases slugs and keeps an explicit display name', () => {
    const ev = checkNetEvent(raw({}, { 'gen_ai.agent.id': 'Planner', 'gen_ai.agent.name': 'Ada' }), now);
    expect(ev.attributes['gen_ai.agent.id']).toBe('planner');
    expect(ev.attributes['gen_ai.agent.name']).toBe('Ada');
  });

  it('requires a different target for messages, handoffs, and reviews', () => {
    expect(() => checkNetEvent(raw({ name: 'agent.message' }, { 'bn.target.id': undefined }), now)).toThrow(NetEventError);
    expect(() => checkNetEvent(raw({}, { 'bn.target.id': 'planner' }), now)).toThrow(/differ/);
  });

  it('allows a file write with no target', () => {
    const ev = checkNetEvent(
      raw({ name: 'agent.file_write', event_id: 'evt-file-0001' }, { 'bn.target.id': undefined, 'bn.label': 'file write · notes.md', 'bn.file': 'notes/notes.md' }),
      now,
    );
    expect(ev.attributes['bn.target.id']).toBeUndefined();
    expect(ev.attributes['bn.file']).toBe('notes/notes.md');
    expect(ev.attributes['gen_ai.operation.name']).toBe('execute_tool');
  });

  it('rejects unknown fields, bad labels, paths, and stale times', () => {
    expect(() => checkNetEvent(raw({ extra: 1 }), now)).toThrow(/Unknown field/);
    expect(() => checkNetEvent(raw({}, { 'bn.secret': 'x' }), now)).toThrow(/Unknown attribute/);
    expect(() => checkLabel('see https://example.com/a')).toThrow(/URL/);
    expect(() => checkLabel('token ' + 'a'.repeat(24))).toThrow(/token/);
    expect(() => checkNetEvent(raw({}, { 'bn.file': '../secret.txt' }), now)).toThrow(/bn.file/);
    expect(() => checkNetEvent(raw({ start_time_unix_nano: (BigInt(now - 25 * 3600_000) * 1_000_000n).toString() }), now)).toThrow(/24 h/);
    expect(() => checkNetEvent(raw({ event_id: 'short' }), now)).toThrow(/event_id/);
  });

  it('accepts a batch wrapper and rejects a mixed body', () => {
    expect(batchOf({ events: [raw(), raw({ event_id: 'evt-planner-02' })] })).toHaveLength(2);
    expect(batchOf(raw())).toHaveLength(1);
    expect(() => batchOf({ events: [], extra: 1 })).toThrow(NetEventError);
  });

  it('derives a display name from a slug', () => {
    expect(displayName('code-reviewer')).toBe('Code Reviewer');
  });

  it('normalizes trade_action and tickers onto action and tags', () => {
    const ev = checkNetEvent(
      raw(
        { name: 'agent.trade_action', event_id: 'evt-action-01' },
        { 'bn.target.id': undefined, 'bn.label': 'action · filed', 'bn.tickers': ['AAPL', 'BRK.A'] },
      ),
      now,
    );
    expect(ev.name).toBe('agent.action');
    expect(ev.attributes['bn.tags']).toEqual(['aapl', 'brk-a']);
    expect(ev.attributes).not.toHaveProperty('bn.tickers');
    const tags = checkNetEvent(
      raw({ name: 'agent.action', event_id: 'evt-action-02' }, { 'bn.target.id': undefined, 'bn.tags': ['draft', 'needs-review'] }),
      now,
    );
    expect(tags.attributes['bn.tags']).toEqual(['draft', 'needs-review']);
    const stored = canonicalizeEvent({
      name: 'agent.trade_action',
      attributes: { 'bn.tickers': ['MSFT'], 'bn.label': 'action · old' },
    });
    expect(stored.name).toBe('agent.action');
    expect(stored.attributes['bn.tags']).toEqual(['msft']);
  });
});
