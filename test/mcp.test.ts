import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import { resetRates } from '../src/rate.js';
import { openStore, type Store } from '../src/store.js';

const dirs: string[] = [];

async function session() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmscope-mcp-'));
  dirs.push(dir);
  const store: Store = openStore(join(dir, 'events.db'), { retentionMs: 7 * 24 * 3600_000 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'swarmscope-test', version: '0.0.0' });
  const server = createMcpServer(store);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, store, close: async () => { await client.close(); await server.close(); store.close(); } };
}

afterEach(() => {
  resetRates();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function payload(result: { content: { type: string; text?: string }[]; isError?: boolean }) {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  return { json: JSON.parse(text) as Record<string, unknown>, isError: result.isError === true };
}

describe('MCP tools', () => {
  it('lists the three tools', async () => {
    const { client, close } = await session();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['get_network', 'list_events', 'report_event']);
    await close();
  });

  it('reports an event, aggregates an edge, and pages the log', async () => {
    const { client, close } = await session();
    const reported = payload(
      await client.callTool({
        name: 'report_event',
        arguments: { from: 'planner', to: 'coder', kind: 'handoff', label: 'handoff · draft', tool: 'apply_edit' },
      }),
    );
    expect(reported.isError).toBe(false);
    expect(reported.json.accepted).toBe(true);
    expect(reported.json.duplicate).toBe(false);

    const again = payload(
      await client.callTool({
        name: 'report_event',
        arguments: {
          from: 'planner',
          to: 'coder',
          kind: 'handoff',
          label: 'handoff · draft',
          event_id: reported.json.event_id,
        },
      }),
    );
    expect(again.json.duplicate).toBe(true);

    const network = payload(await client.callTool({ name: 'get_network', arguments: {} }));
    const edges = network.json.edges as { from: string; to: string; kind: string; count: number; first_ts: string; last_ts: string }[];
    expect(edges).toEqual([
      expect.objectContaining({ from: 'planner', to: 'coder', kind: 'handoff', count: 1 }),
    ]);
    expect(edges[0].first_ts).toBe(edges[0].last_ts);

    const page = payload(await client.callTool({ name: 'list_events', arguments: { limit: 10 } }));
    const events = page.json.events as { kind: string; from: string; to: string; tool?: string; label: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'handoff', from: 'planner', to: 'coder', tool: 'apply_edit', label: 'handoff · draft' });
    expect(page.json.next_since).toBe(page.json.head_seq);
    await close();
  });

  it('returns a tool error the caller can correct', async () => {
    const { client, close } = await session();
    const bad = payload(
      await client.callTool({
        name: 'report_event',
        arguments: { from: 'planner', to: 'coder', kind: 'handoff', label: 'see https://example.com/secret' },
      }),
    );
    expect(bad.isError).toBe(true);
    expect(String(bad.json.error)).toMatch(/URL/);
    const network = payload(await client.callTool({ name: 'get_network', arguments: {} }));
    expect(network.json.edges).toEqual([]);
    await close();
  });
});
