import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startHttp } from '../src/http.js';
import { resetRates } from '../src/rate.js';
import { openStore } from '../src/store.js';

const TOKEN = 'local-test-token';

const dirs: string[] = [];

afterEach(() => {
  resetRates();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmscope-http-'));
  dirs.push(dir);
  const store = openStore(join(dir, 'events.db'), { retentionMs: 7 * 24 * 3600_000 });
  const server = await startHttp({ store, port: 0, token: TOKEN });
  return {
    store,
    url: server.url,
    token: TOKEN,
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
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

function hostOf(url: string): string {
  return new URL(url).host;
}

function ask(
  url: string,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const path = init.path ?? `${u.pathname}${u.search}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: u.port,
        path,
        method: init.method ?? 'GET',
        setHost: false,
        headers: init.headers ?? { host: hostOf(url) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const emitBody = JSON.stringify({ from: 'planner', to: 'coder', kind: 'handoff', label: 'handoff · draft' });

describe('HTTP guards', () => {
  it('rejects a non-loopback Host and a Host on the wrong port', async () => {
    const { url, close } = await boot();
    const port = new URL(url).port;
    expect((await ask(url, { path: '/api/v1/health', headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await ask(url, { path: '/api/v1/health', headers: { host: '127.0.0.1.evil.example' } })).status).toBe(403);
    expect((await ask(url, { path: '/api/v1/health', headers: { host: '127.0.0.1:1' } })).status).toBe(403);
    expect((await ask(url, { path: '/api/v1/health', headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
    expect((await ask(url, { path: '/api/v1/health', headers: { host: `localhost:${port}` } })).status).toBe(200);
    expect((await ask(url, { path: '/api/v1/health', headers: { host: `[::1]:${port}` } })).status).toBe(200);
    await close();
  });

  it('rejects a non-loopback Origin and still serves the viewer', async () => {
    const { url, close } = await boot();
    const host = hostOf(url);
    expect((await ask(url, { path: '/api/v1/health', headers: { host, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await ask(url, { path: '/api/v1/health', headers: { host, origin: 'null' } })).status).toBe(403);
    const page = await ask(url, { path: '/', headers: { host, origin: url } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="root"');
    const net = await ask(url, { path: '/api/v1/network', headers: { host, origin: url } });
    expect(net.status).toBe(200);
    expect(JSON.parse(net.body).nodes).toEqual([]);

    const ws = new WebSocket(url.replace('http', 'ws') + '/api/v1/network/stream', { headers: { origin: 'https://evil.example' } });
    const denied = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      ws.once('open', () => reject(new Error('socket opened')));
      ws.once('error', () => undefined);
    });
    expect(denied).toBe(403);

    const ok = new WebSocket(url.replace('http', 'ws') + '/api/v1/network/stream', { headers: { origin: url } });
    const hello = await new Promise<string>((resolve, reject) => {
      ok.once('message', (data) => resolve(String(data)));
      ok.once('error', reject);
    });
    expect(JSON.parse(hello).type).toBe('hello');
    ok.close();
    await close();
  });

  it('refuses a text/plain write and requires the bearer token', async () => {
    const { url, close } = await boot();
    const host = hostOf(url);
    const plain = await ask(url, {
      method: 'POST',
      path: '/api/v1/emit',
      headers: {
        host,
        'content-type': 'text/plain',
        authorization: `Bearer ${TOKEN}`,
      },
      body: emitBody,
    });
    expect(plain.status).toBe(415);
    const missing = await ask(url, {
      method: 'POST',
      path: '/api/v1/emit',
      headers: { host, 'content-type': 'application/json' },
      body: emitBody,
    });
    expect(missing.status).toBe(401);
    const wrong = await ask(url, {
      method: 'POST',
      path: '/api/v1/network/events',
      headers: { host, 'content-type': 'application/json', authorization: 'Bearer not-the-token' },
      body: emitBody,
    });
    expect(wrong.status).toBe(401);
    const ok = await ask(url, {
      method: 'POST',
      path: '/api/v1/emit',
      headers: { host, 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: emitBody,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).accepted).toBe(true);
    const net = await ask(url, { path: '/api/v1/network', headers: { host } });
    const edges = JSON.parse(net.body).edges as { count: number }[];
    expect(edges).toHaveLength(1);
    await close();
  });

  it('requires the token for report_event over HTTP and not for a read', async () => {
    const { url, close } = await boot();
    const host = hostOf(url);
    const call = (name: string, args: Record<string, unknown>) =>
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const headers = { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const denied = await ask(url, {
      method: 'POST',
      path: '/mcp',
      headers,
      body: call('report_event', { from: 'planner', to: 'coder', kind: 'handoff', label: 'handoff · draft' }),
    });
    expect(denied.status).toBe(401);
    const written = await ask(url, {
      method: 'POST',
      path: '/mcp',
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      body: call('report_event', { from: 'planner', to: 'coder', kind: 'handoff', label: 'handoff · draft' }),
    });
    expect(written.status).toBe(200);
    const read = await ask(url, {
      method: 'POST',
      path: '/mcp',
      headers,
      body: call('get_network', {}),
    });
    expect(read.status).toBe(200);
    expect(read.body).toContain('planner');
    await close();
  });

  it('stores trade_action and tickers as action and tags', async () => {
    const { url, close } = await boot();
    const res = await fetch(`${url}/api/v1/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ from: 'runner', kind: 'trade_action', label: 'action · filed', tickers: ['AAPL', 'BRK.A'] }),
    });
    expect(res.status).toBe(200);
    const page = (await fetch(`${url}/api/v1/network/events?since=0`).then((r) => r.json())) as {
      events: { name: string; attributes: Record<string, unknown> }[];
    };
    expect(page.events[0].name).toBe('agent.action');
    expect(page.events[0].attributes['bn.tags']).toEqual(['aapl', 'brk-a']);
    expect(page.events[0].attributes['bn.tickers']).toBeUndefined();
    await close();
  });
});
