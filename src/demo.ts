/**
 * A made-up swarm so the viewer has something to show on first launch.
 * Names are generic roles. Nothing here is a real agent, team, or deployment.
 */
import { checkNetEvent, type NetEventV1 } from './events.js';
import type { AgentInput, Store } from './store.js';

export const DEMO_AGENTS: AgentInput[] = [
  { id: 'studio', name: 'Studio', team: 'Room', kind: 'room', role: 'room', level: 1, manager: null },
  { id: 'lab', name: 'Lab', team: 'Room', kind: 'room', role: 'room', level: 1, manager: 'studio' },
  { id: 'archive', name: 'Archive', team: 'Room', kind: 'room', role: 'room', level: 1, manager: 'studio' },
  { id: 'planner', name: 'Planner', team: 'Coordination', kind: 'agent', role: 'plans the work', level: 4, manager: 'studio' },
  { id: 'researcher', name: 'Researcher', team: 'Research', kind: 'agent', role: 'gathers sources', level: 3, manager: 'planner' },
  { id: 'coder', name: 'Coder', team: 'Build', kind: 'agent', role: 'writes the change', level: 3, manager: 'planner' },
  { id: 'reviewer', name: 'Reviewer', team: 'Review', kind: 'agent', role: 'signs off', level: 3, manager: 'planner' },
  { id: 'navigator', name: 'Navigator', team: 'Ops', kind: 'agent', role: 'tracks status', level: 2, manager: 'planner' },
  { id: 'librarian', name: 'Librarian', team: 'Memory', kind: 'agent', role: 'keeps notes', level: 2, manager: 'researcher' },
  { id: 'indexer', name: 'Indexer', team: 'Research', kind: 'agent', role: 'files findings', level: 2, manager: 'researcher' },
  { id: 'editor', name: 'Editor', team: 'Build', kind: 'agent', role: 'shapes the draft', level: 2, manager: 'coder' },
  { id: 'runner', name: 'Runner', team: 'Ops', kind: 'agent', role: 'runs checks', level: 2, manager: 'coder' },
  { id: 'critic', name: 'Critic', team: 'Review', kind: 'agent', role: 'finds gaps', level: 2, manager: 'reviewer' },
  { id: 'archivist', name: 'Archivist', team: 'Memory', kind: 'agent', role: 'stores records', level: 2, manager: 'librarian' },
  { id: 'scribe', name: 'Scribe', team: 'Build', kind: 'agent', role: 'writes the summary', level: 2, manager: 'editor' },
];

const BACKGROUND: [string, string, string, string][] = [
  ['researcher', 'librarian', 'agent.message', 'message · sources'],
  ['coder', 'editor', 'agent.handoff', 'handoff · draft slice'],
  ['editor', 'scribe', 'agent.message', 'message · wording'],
  ['indexer', 'researcher', 'agent.message', 'message · index ready'],
  ['navigator', 'planner', 'agent.message', 'message · status'],
  ['critic', 'coder', 'agent.review', 'review · notes'],
  ['archivist', 'librarian', 'agent.handoff', 'handoff · records'],
  ['runner', 'coder', 'agent.message', 'message · checks'],
  ['librarian', 'indexer', 'agent.message', 'message · filed'],
  ['scribe', 'planner', 'agent.message', 'message · brief'],
  ['planner', 'coder', 'agent.handoff', 'handoff · task'],
  ['researcher', 'planner', 'agent.message', 'message · finding'],
];

export interface BuiltDemo {
  agents: AgentInput[];
  events: NetEventV1[];
}

/** Build a valid sample log relative to `now`. Reviewer is stuck; planner and researcher are in a loop. */
export function buildDemo(now: number): BuiltDemo {
  let n = 0;
  const events: NetEventV1[] = [];
  const push = (
    msAgo: number,
    name: string,
    from: string,
    to: string | undefined,
    label: string,
    extra: Record<string, unknown> = {},
    status: 'ok' | 'error' = 'ok',
  ) => {
    n += 1;
    const attributes: Record<string, unknown> = {
      'gen_ai.agent.id': from,
      'bn.label': label,
      'bn.source': 'self-report',
      ...extra,
    };
    if (to) attributes['bn.target.id'] = to;
    events.push(
      checkNetEvent(
        {
          schema_version: '1',
          event_id: `demo-${String(n).padStart(4, '0')}`,
          name,
          start_time_unix_nano: (BigInt(now - msAgo) * 1_000_000n).toString(),
          status,
          attributes,
        },
        now,
      ),
    );
  };

  // Older hours, so the sparkline has a shape. None of these send as reviewer.
  for (let hour = 12; hour >= 1; hour--) {
    for (let k = 0; k < 4; k++) {
      const [from, to, name, label] = BACKGROUND[(hour * 3 + k) % BACKGROUND.length];
      const ago = hour * 3600_000 + k * 8 * 60_000;
      push(ago, name, from, to, label);
    }
  }

  // One old error, outside the default 6h window, and one alert.
  push(10 * 3600_000, 'agent.message', 'runner', 'coder', 'message · check failed', {}, 'error');
  push(3 * 3600_000, 'agent.alert', 'runner', undefined, 'alert · check waiting');

  // Reviewer last spoke 90 minutes ago, then went quiet.
  push(90 * 60_000, 'agent.review', 'reviewer', 'critic', 'review · earlier pass');

  // A handoff to reviewer that stays open (stuck ring).
  push(23 * 60_000, 'agent.handoff', 'coder', 'reviewer', 'handoff · draft', { 'gen_ai.tool.name': 'apply_edit' });

  // Planner ↔ researcher handoffs, alternating inside 30 minutes (loop badge).
  push(24 * 60_000, 'agent.handoff', 'researcher', 'planner', 'handoff · question', { 'gen_ai.conversation.id': 'thread-outline' });
  push(20 * 60_000, 'agent.handoff', 'planner', 'researcher', 'handoff · direction', { 'gen_ai.conversation.id': 'thread-outline' });
  push(16 * 60_000, 'agent.handoff', 'researcher', 'planner', 'handoff · findings', { 'gen_ai.conversation.id': 'thread-outline' });
  push(12 * 60_000, 'agent.handoff', 'planner', 'researcher', 'handoff · next pass', { 'gen_ai.conversation.id': 'thread-outline' });
  push(8 * 60_000, 'agent.handoff', 'researcher', 'planner', 'handoff · revised notes', { 'gen_ai.conversation.id': 'thread-outline' });

  // A file write with no receiver, plus a trail of fresh traffic so the graph is lit.
  push(40 * 60_000, 'agent.file_write', 'librarian', undefined, 'file write · sources.md', { 'bn.file': 'notes/sources.md' });
  push(14 * 60_000, 'agent.message', 'archivist', 'librarian', 'message · filed');
  push(9 * 60_000, 'agent.message', 'scribe', 'editor', 'message · summary');
  push(6 * 60_000, 'agent.message', 'indexer', 'librarian', 'message · index ready');
  push(4 * 60_000, 'agent.message', 'runner', 'coder', 'message · checks passed');
  push(110_000, 'agent.handoff', 'librarian', 'archivist', 'handoff · notes');
  push(90_000, 'agent.message', 'navigator', 'planner', 'message · status');
  push(70_000, 'agent.message', 'researcher', 'indexer', 'message · sources ready');
  push(50_000, 'agent.handoff', 'coder', 'editor', 'handoff · next step', { 'gen_ai.tool.name': 'apply_edit' });
  push(30_000, 'agent.message', 'editor', 'scribe', 'message · line notes');

  return { agents: DEMO_AGENTS, events };
}

/** Replace the store contents with the sample network. */
export function seedDemo(store: Store, now = Date.now()): { events: number; agents: number } {
  const built = buildDemo(now);
  store.upsertAgents(built.agents);
  const chunk = 80;
  for (let i = 0; i < built.events.length; i += chunk) {
    store.ingestValid(built.events.slice(i, i + chunk), now);
  }
  store.setMeta('demo', '1');
  return { events: built.events.length, agents: built.agents.length };
}
