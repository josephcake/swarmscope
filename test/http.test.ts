import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startHttp } from '../src/http.js';
import { resetRates } from '../src/rate.js';
import { openStore } from '../src/store.js';

const dirs: string[] = [];

afterEach(() => {
  resetRates();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmscope-http-'));
  dirs.push(dir);
  const store = openStore(join(dir, 'events.db'), { retentionMs: 7 * 24 * 3600_000 });
  const server = await startHttp({ store, port: 0 });
  return {
    store,
    url: server.url,
    close: async () => {
      await server.close();
      store.close();
    },
  };
}

describe('local HTTP', () => {
  it('accepts a flat emit and serves the edge', async () => {
    const { url, close } = await boot();
    const res = await fetch(`${url}/api/v1/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'researcher', to: 'planner', kind: 'message', label: 'message · sources ready' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; event_id: string };
    expect(body.accepted).toBe(true);
    const net = (await fetch(`${url}/api/v1/network`).then((r) => r.json())) as {
      edges: { from: string; to: string; kind: string; count: number }[];
    };
    expect(net.edges).toEqual([expect.objectContaining({ from: 'researcher', to: 'planner', kind: 'message', count: 1 })]);
    const bad = await fetch(`${url}/api/v1/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'researcher', kind: 'message', label: 'hello@example.com' }),
    });
    expect(bad.status).toBe(400);
    await close();
  });

  it('pushes new events over the websocket', async () => {
    const { url, close } = await boot();
    const ws = new WebSocket(url.replace('http', 'ws') + '/api/v1/network/stream');
    const hello = await new Promise<{ type: string }>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.once('error', reject);
    });
    expect(hello.type).toBe('hello');
    const next = new Promise<string>((resolve) => ws.once('message', (data) => resolve(data.toString())));
    ws.send('ping');
    expect(await next).toBe('pong');
    const pushed = new Promise<{ type: string; events: { event_id: string }[] }>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'events') resolve(msg);
      });
    });
    await fetch(`${url}/api/v1/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'coder', to: 'editor', kind: 'handoff', label: 'handoff · next step' }),
    });
    const msg = await pushed;
    expect(msg.events[0].event_id).toBeTruthy();
    ws.close();
    await close();
  });

  it('serves the viewer bundle when it has been built', async () => {
    const { url, close } = await boot();
    const html = await fetch(url).then((r) => r.text());
    const src = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(src).toBeTruthy();
    const asset = await fetch(url + src);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    const css = html.match(/href="([^"]+\.css)"/)?.[1];
    expect(css).toBeTruthy();
    expect((await fetch(url + css)).status).toBe(200);
    await close();
  });

  it('ingests an OTLP JSON span', async () => {
    const { url, close } = await boot();
    const spanId = '0123456789abcdef';
    const traceId = '0123456789abcdef0123456789abcdef';
    const res = await fetch(`${url}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId,
                    name: 'execute_tool coder',
                    startTimeUnixNano: (BigInt(Date.now() - 1000) * 1_000_000n).toString(),
                    endTimeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
                    status: { code: 1 },
                    attributes: [
                      { key: 'gen_ai.agent.id', value: { stringValue: 'coder' } },
                      { key: 'bn.event.name', value: { stringValue: 'handoff' } },
                      { key: 'bn.target.id', value: { stringValue: 'reviewer' } },
                      { key: 'bn.label', value: { stringValue: 'handoff · draft' } },
                      { key: 'bn.event.id', value: { stringValue: 'otlp-event-01' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-swarmscope-accepted')).toBe('1');
    const net = (await fetch(`${url}/api/v1/network`).then((r) => r.json())) as { edges: { from: string; to: string; kind: string }[] };
    expect(net.edges[0]).toMatchObject({ from: 'coder', to: 'reviewer', kind: 'handoff' });
    await close();
  });
});
