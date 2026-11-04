import { describe, expect, it } from 'vitest';
import { buildDemo } from '../src/demo.js';
import { aggregateEdges, foldEdges, pingPongs, stuckBots, type GraphEvent } from '../src/graph.js';
import type { NetEventV1 } from '../src/events.js';

function asGraph(e: NetEventV1): GraphEvent {
  const ms = Number(BigInt(e.start_time_unix_nano) / 1_000_000n);
  return {
    id: e.event_id,
    at: new Date(ms).toISOString(),
    from: e.attributes['gen_ai.agent.id'] ?? '',
    to: e.attributes['bn.target.id'] ?? e.attributes['gen_ai.agent.id'] ?? '',
    kind: e.name.slice('agent.'.length),
    gist: e.attributes['bn.label'],
    status: e.status.code === 'ERROR' ? 'error' : 'ok',
  };
}

describe('edge aggregation', () => {
  it('folds by from, to, and kind, skipping tests and self events', () => {
    const edges = aggregateEdges([
      { from: 'planner', to: 'coder', kind: 'handoff', atMs: 1_000, test: false },
      { from: 'planner', to: 'coder', kind: 'handoff', atMs: 5_000, test: false },
      { from: 'planner', to: 'coder', kind: 'message', atMs: 4_000, test: false },
      { from: 'planner', to: 'coder', kind: 'handoff', atMs: 9_000, test: true },
      { from: 'librarian', to: 'librarian', kind: 'file_write', atMs: 2_000 },
      { from: 'runner', to: null, kind: 'alert', atMs: 3_000 },
    ]);
    expect(edges).toEqual([
      { from: 'planner', to: 'coder', kind: 'handoff', count: 2, first_ts: new Date(1_000).toISOString(), last_ts: new Date(5_000).toISOString() },
      { from: 'planner', to: 'coder', kind: 'message', count: 1, first_ts: new Date(4_000).toISOString(), last_ts: new Date(4_000).toISOString() },
    ]);
  });

  it('keeps a canvas edge only when the window still contains traffic', () => {
    const now = 1_000_000;
    const events: GraphEvent[] = [
      { at: new Date(now - 2 * 3600_000).toISOString(), from: 'a', to: 'b', kind: 'message', gist: 'old' },
      { at: new Date(now - 60_000).toISOString(), from: 'a', to: 'b', kind: 'handoff', gist: 'new' },
    ];
    const hour = foldEdges(events, now, 3600_000);
    expect(hour.map((e) => e.cls)).toEqual(['handoff']);
    expect(hour[0].count24).toBe(1);
    expect(hour[0].count).toBe(1);
    expect(foldEdges(events, now, 3 * 3600_000).map((e) => e.cls).sort()).toEqual(['flow', 'handoff']);
  });
});

describe('loops and stuck agents', () => {
  const now = Date.parse('2026-06-15T18:00:00.000Z');

  it('flags a back-and-forth handoff and an agent who never answered', () => {
    const built = buildDemo(now);
    const events = built.events.map(asGraph);
    const loops = pingPongs(events, now);
    expect(loops.some((l) => l.a === 'planner' && l.b === 'researcher')).toBe(true);
    const agents = new Set(built.agents.filter((a) => a.kind === 'agent').map((a) => a.id));
    const stuck = stuckBots(events, now, agents, new Map());
    expect(stuck.get('reviewer')).toMatchObject({ reason: 'handoff', from: 'coder' });
  });
});
