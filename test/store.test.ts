import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkNetEvent, type NetEventV1 } from '../src/events.js';
import { openStore, type Store } from '../src/store.js';

const now = Date.parse('2026-06-15T18:00:00.000Z');
const dirs: string[] = [];

function tempStore(ext: '.db' | '.json'): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmscope-'));
  dirs.push(dir);
  const path = join(dir, `events${ext}`);
  return { store: openStore(path, { retentionMs: 7 * 24 * 3600_000 }), path };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function event(id: string, from: string, to: string | undefined, kind = 'agent.message', extra: Record<string, unknown> = {}): NetEventV1 {
  return checkNetEvent(
    {
      schema_version: '1',
      event_id: id,
      name: kind,
      start_time_unix_nano: (BigInt(now - 5_000) * 1_000_000n).toString(),
      status: 'ok',
      attributes: {
        'gen_ai.agent.id': from,
        'bn.label': kind === 'agent.handoff' ? 'handoff · draft' : 'message · status',
        ...(to ? { 'bn.target.id': to } : {}),
        ...extra,
      },
    },
    now,
  );
}

function suite(ext: '.db' | '.json') {
  it('dedupes by event id and aggregates edges', () => {
    const { store } = tempStore(ext);
    const first = store.ingestValid([event('evt-000001', 'planner', 'coder', 'agent.handoff')], now);
    const again = store.ingestValid([event('evt-000001', 'planner', 'coder', 'agent.handoff')], now);
    expect(first.accepted).toEqual(['evt-000001']);
    expect(again.duplicates).toEqual(['evt-000001']);
    const net = store.network();
    expect(net.edges).toEqual([
      expect.objectContaining({ from: 'planner', to: 'coder', kind: 'handoff', count: 1 }),
    ]);
    expect(net.nodes.find((n) => n.id === 'planner')?.name).toBe('Planner');
    expect(net.nodes.find((n) => n.id === 'coder')?.last_seen_unix_ms).toBeNull();
    expect(net.nodes.find((n) => n.id === 'planner')?.last_seen_unix_ms).toBe(now - 5_000);
    store.close();
  });

  it('leaves test events out of network totals and can page past them', () => {
    const { store } = tempStore(ext);
    store.ingestValid(
      [
        event('evt-000001', 'planner', 'coder'),
        event('evt-000002', 'planner', 'coder', 'agent.message', { 'bn.test': true, 'bn.label': 'message · check' }),
        event('evt-000003', 'coder', 'editor'),
      ],
      now,
    );
    expect(store.network().edges.every((e) => e.count === 1)).toBe(true);
    expect(store.network().edges).toHaveLength(2);
    const hidden = store.since(0, 10, { skipTest: true });
    expect(hidden.events.map((e) => e.event_id)).toEqual(['evt-000001', 'evt-000003']);
    const all = store.since(0, 1, { skipTest: false });
    expect(all.events).toHaveLength(1);
    const next = store.since(all.next_since, 10, { skipTest: false });
    expect(next.events.map((e) => e.event_id)).toEqual(['evt-000002', 'evt-000003']);
    const filtered = store.since(0, 10, { from: 'coder' });
    expect(filtered.events.map((e) => e.event_id)).toEqual(['evt-000003']);
    store.close();
  });

  it('keeps a custom display name and prunes by received time', () => {
    const { store } = tempStore(ext);
    store.ingestValid([event('evt-000001', 'planner', 'coder', 'agent.message', { 'gen_ai.agent.name': 'Ada' })], now);
    expect(store.network().nodes.find((n) => n.id === 'planner')?.name).toBe('Ada');
    store.ingestValid([event('evt-000002', 'planner', 'researcher')], now);
    expect(store.network().nodes.find((n) => n.id === 'planner')?.name).toBe('Ada');
    const removed = store.prune(now + store.retentionMs + 10_000);
    expect(removed).toBe(2);
    expect(store.head()).toBe(0);
    store.close();
  });

  it('reports rejected rows without dropping the rest of a batch', () => {
    const { store } = tempStore(ext);
    const good = event('evt-000001', 'planner', 'coder');
    const result = store.ingestRaw([good, { schema_version: '1', event_id: 'nope' }], now);
    expect(result.accepted).toEqual(['evt-000001']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/name|event_id|schema/);
    store.close();
  });
}

describe('sqlite store', () => suite('.db'));
describe('json store', () => suite('.json'));
