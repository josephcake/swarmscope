/**
 * MCP tools on top of the local store.
 * stdio for desktop clients, and stateless Streamable HTTP at /mcp.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KIND_NAMES, NET_SOURCES, NetEventError, checkNetEvent, kindOf, newEventId, type NetStreamEvent } from './events.js';
import { rawFromReport } from './report.js';
import { allowWrite } from './rate.js';
import type { NetworkSnapshot, Store } from './store.js';
import { VERSION } from './version.js';

export const LIST_DEFAULT = 50;
export const LIST_MAX = 200;
export const EDGES_MAX = 200;

const instructions = [
  'Swarmscope is a local map of your AI agents and the messages, handoffs, reviews, and tool calls between them.',
  'Call report_event when one agent talks to another. Call get_network for agents and edges. Call list_events to page the log.',
  'Everything stays on this machine. Labels are short and neutral: no URLs, emails, secrets, or message text.',
  'Sending the same event_id again is a no-op.',
].join(' ');

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: 'swarmscope', version: VERSION }, { instructions });

  server.registerTool(
    'report_event',
    {
      title: 'Report an agent event',
      description:
        'Record one event from an agent: a message, handoff, review, file write, alert, heartbeat, or a tool call (set tool). ' +
        'from and to are lowercase slugs you choose (for example planner, researcher, coder). ' +
        'to is required for message, handoff, and review. label is a short neutral gist, 60 characters or fewer. ' +
        'Set test=true for traffic you do not want in network totals. The same event_id is stored once.',
      inputSchema: {
        from: z.string().describe('Sending agent id, a lowercase slug.'),
        to: z.string().optional().describe('Receiving agent id. Required for message, handoff, and review.'),
        kind: z.enum(KIND_NAMES as [string, ...string[]]).describe('Event kind.'),
        label: z.string().describe('Short neutral gist. No URLs, emails, or secrets.'),
        status: z.enum(['ok', 'error']).optional(),
        source: z.enum(NET_SOURCES).optional(),
        tool: z.string().optional().describe('Tool the agent used. Stored as gen_ai.tool.name.'),
        operation: z.string().optional().describe('Overrides gen_ai.operation.name.'),
        conversation: z.string().optional().describe('Thread id. Stored as gen_ai.conversation.id.'),
        name: z.string().optional().describe('Display name for the sending agent.'),
        tickers: z.array(z.string()).max(12).optional(),
        file: z.string().optional().describe('Relative path this event wrote or read.'),
        parent_id: z.string().optional().describe('event_id of the event that caused this one.'),
        event_id: z.string().optional().describe('Stable id. Generated when omitted.'),
        test: z.boolean().optional().describe('Verification traffic. Hidden from network totals.'),
      },
      annotations: { title: 'Report event', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const wait = allowWrite(1);
        if (wait) return toolError(`rate_limited: retry in ${wait}s`);
        const now = Date.now();
        const ev = checkNetEvent(rawFromReport(args, now, () => newEventId('mcp')), now);
        const r = store.ingestValid([ev], now);
        return toolOk({
          event_id: ev.event_id,
          accepted: r.accepted.includes(ev.event_id),
          duplicate: r.duplicates.includes(ev.event_id),
          head_seq: r.head_seq,
          test: !!ev.attributes['bn.test'],
        });
      } catch (e) {
        if (e instanceof NetEventError) return toolError(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    'get_network',
    {
      title: 'Get the agent network',
      description:
        'Agents on this machine and the edges between them. Each edge is {from, to, kind, count, first_ts, last_ts}, ' +
        `counted over the retention window. Test events are left out. At most ${EDGES_MAX} edges, newest first.`,
      inputSchema: {},
      annotations: { title: 'Get network', readOnlyHint: true, openWorldHint: false },
    },
    async () => toolOk(networkResult(store.network())),
  );

  server.registerTool(
    'list_events',
    {
      title: 'List agent events',
      description:
        `Events after a sequence number, oldest first (default ${LIST_DEFAULT}, max ${LIST_MAX}). ` +
        'Page with since set to next_since. Filter with kind, from, and to. Test events are skipped unless include_test is true.',
      inputSchema: {
        since: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(LIST_MAX).optional(),
        include_test: z.boolean().optional(),
        kind: z.enum(KIND_NAMES as [string, ...string[]]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      },
      annotations: { title: 'List events', readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const since = args.since ?? 0;
      const limit = args.limit ?? LIST_DEFAULT;
      const page = store.since(since, limit, {
        skipTest: args.include_test !== true,
        kind: args.kind,
        from: args.from,
        to: args.to,
      });
      const body: Record<string, unknown> = {
        events: page.events.map(compactEvent),
        next_since: page.next_since,
        head_seq: page.head_seq,
      };
      if (page.next_since < page.head_seq) {
        body.truncated = true;
        body.hint = `More events after seq ${page.next_since}. Call list_events with since=${page.next_since}.`;
      }
      return toolOk(body);
    },
  );

  return server;
}

export function compactEvent(e: NetStreamEvent): Record<string, unknown> {
  const a = e.attributes;
  const out: Record<string, unknown> = {
    seq: e.seq,
    event_id: e.event_id,
    time: new Date(Number(BigInt(e.start_time_unix_nano) / 1_000_000n)).toISOString(),
    kind: kindOf(e.name),
    from: a['gen_ai.agent.id'] ?? null,
    to: a['bn.target.id'] ?? null,
    label: a['bn.label'],
    status: e.status.code === 'ERROR' ? 'error' : 'ok',
    source: a['bn.source'],
  };
  if (a['gen_ai.tool.name']) out.tool = a['gen_ai.tool.name'];
  if (a['gen_ai.operation.name']) out.operation = a['gen_ai.operation.name'];
  if (a['bn.tickers']?.length) out.tickers = a['bn.tickers'];
  if (a['bn.file']) out.file = a['bn.file'];
  if (e.parent_id) out.parent_id = e.parent_id;
  if (a['bn.test']) out.test = true;
  return out;
}

export function networkResult(n: NetworkSnapshot): Record<string, unknown> {
  const edges = [...n.edges].sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0));
  const shown = edges.slice(0, EDGES_MAX);
  const out: Record<string, unknown> = {
    nodes: n.nodes.map((x) => ({
      id: x.id,
      name: x.name,
      team: x.team,
      kind: x.kind,
      role: x.role,
      last_seen: x.last_seen_unix_ms ? new Date(x.last_seen_unix_ms).toISOString() : null,
    })),
    edges: shown,
    edge_count: edges.length,
    head_seq: n.head_seq,
    demo: n.demo,
    retention_days: n.retention.days,
  };
  if (shown.length < edges.length) {
    out.truncated = true;
    out.hint = `Showing the ${shown.length} most recent of ${edges.length} edges. GET /api/v1/network returns every edge.`;
  }
  return out;
}

function toolOk(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}

function toolError(message: string) {
  const data = { error: message };
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, isError: true };
}
