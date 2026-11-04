/**
 * Loopback HTTP server: the viewer, the event API, a tiny emit endpoint,
 * optional OTLP/HTTP JSON, stateless Streamable HTTP MCP, and a WebSocket live stream.
 * Binds 127.0.0.1 only. No telemetry and no outbound calls.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { join, normalize, sep } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { NET_LIMITS, NetEventError, batchOf, checkNetEvent, newEventId } from './events.js';
import { OtlpError, otlpToEvents } from './otlp.js';
import { createMcpServer } from './mcp.js';
import { publicDir } from './paths.js';
import { rawFromReport, type ReportArgs } from './report.js';
import { allowWrite } from './rate.js';
import type { Store } from './store.js';
import { VERSION } from './version.js';

export class AddressInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`127.0.0.1:${port} is already in use. Another Swarmscope viewer is probably running.`);
    this.name = 'AddressInUseError';
    this.port = port;
  }
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...extra, 'content-length': String(Buffer.byteLength(payload)) });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}): void {
  send(res, status, { error: { code, message } }, extra);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > max) return Promise.reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function decodeBody(req: IncomingMessage): Promise<Buffer> {
  const raw = await readBody(req, NET_LIMITS.bodyBytes);
  const enc = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (enc === 'identity' || enc === '') return raw;
  if (enc !== 'gzip') throw Object.assign(new Error('encoding'), { code: 'encoding' });
  const out = gunzipSync(raw);
  if (out.byteLength > NET_LIMITS.bodyBytes) throw Object.assign(new Error('too_large'), { code: 'too_large' });
  return out;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function safePublic(root: string, pathname: string): string | null {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) return null;
  const rootNorm = normalize(root).replace(/[/\\]+$/, '') || sep;
  const full = normalize(join(rootNorm, rel));
  if (full !== rootNorm && !full.startsWith(rootNorm + sep)) return null;
  return full;
}

function serveFile(res: ServerResponse, file: string): void {
  const ext = file.slice(file.lastIndexOf('.'));
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  createReadStream(file).pipe(res);
}

export async function startHttp(opts: { store: Store; port: number }): Promise<RunningServer> {
  const { store } = opts;
  const root = publicDir();
  let cursor = store.head();

  const server = createServer((req, res) => {
    void route(req, res).catch((e) => {
      if (res.headersSent) return;
      const code = (e as { code?: string }).code;
      if (code === 'too_large') fail(res, 413, 'too_large', `Body is over ${NET_LIMITS.bodyBytes} bytes.`);
      else if (code === 'encoding') fail(res, 415, 'bad_encoding', 'Content-Encoding must be gzip or none.');
      else {
        console.error('swarmscope:', e instanceof Error ? e.message : e);
        fail(res, 500, 'internal', 'Internal error.');
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  };

  const flush = () => {
    for (let i = 0; i < 20; i++) {
      const page = store.since(cursor, 200);
      if (!page.events.length) {
        cursor = Math.max(cursor, page.head_seq);
        return;
      }
      broadcast({ type: 'events', events: page.events, head_seq: page.head_seq });
      const prev = cursor;
      cursor = page.next_since;
      if (cursor === prev || cursor >= page.head_seq) return;
    }
  };

  const timer = setInterval(flush, 400);
  timer.unref?.();

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname.replace(/\/+$/, '') !== '/api/v1/network/stream') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }
    if (sockets.size >= 20) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      let budget = { start: Date.now(), n: 0 };
      ws.send(JSON.stringify({ type: 'hello', head_seq: store.head(), heartbeat: store.heartbeat(), server_unix_ms: Date.now() }));
      ws.on('message', (data: RawData, isBinary) => {
        const text = isBinary ? '' : String(data);
        const size = isBinary ? 2048 : text.length;
        const now = Date.now();
        if (now - budget.start >= 60_000) budget = { start: now, n: 0 };
        budget.n += 1;
        if (size > 1024 || budget.n > 30) {
          ws.close(1008, 'read-only stream: send only ping');
          return;
        }
        if (text === 'ping') ws.send('pong');
      });
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => sockets.delete(ws));
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (path === '/mcp') {
      await handleMcp(req, res);
      return;
    }

    if (path === '/api/v1/health' && method === 'GET') {
      send(res, 200, { ok: true, version: VERSION, backend: store.backend });
      return;
    }

    if (path === '/api/v1/network' && method === 'GET') {
      send(res, 200, store.network());
      return;
    }

    if (path === '/api/v1/network/events' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '200');
      if (!Number.isInteger(since) || since < 0) return fail(res, 400, 'bad_since', 'since must be a non-negative integer.');
      if (!Number.isInteger(limit) || limit < 1 || limit > NET_LIMITS.pageMax) {
        return fail(res, 400, 'bad_limit', `limit must be 1-${NET_LIMITS.pageMax}.`);
      }
      const kind = url.searchParams.get('kind') ?? undefined;
      const from = url.searchParams.get('from') ?? undefined;
      const to = url.searchParams.get('to') ?? undefined;
      const skipTest = url.searchParams.get('skip_test') === '1';
      send(res, 200, store.since(since, limit, { skipTest, kind, from, to }));
      return;
    }

    if (path === '/api/v1/network/events' && method === 'POST') {
      await postEvents(req, res);
      return;
    }

    if (path === '/api/v1/emit' && method === 'POST') {
      await postEmit(req, res);
      return;
    }

    if (path === '/v1/traces' && method === 'POST') {
      await postOtlp(req, res);
      return;
    }

    if (path === '/api/v1/network/stream' && method === 'GET') {
      fail(res, 426, 'upgrade_required', 'This path is a WebSocket. Poll GET /api/v1/network/events instead.', { upgrade: 'websocket' });
      return;
    }

    if (path.startsWith('/api/') || path.startsWith('/v1/') || path === '/mcp') {
      const allow = path.endsWith('/events') || path === '/api/v1/emit' || path === '/v1/traces' ? 'GET, POST' : 'GET';
      fail(res, 405, 'method_not_allowed', `${method} is not allowed on ${path}.`, { allow: path === '/api/v1/network/events' ? 'GET, POST' : allow });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      fail(res, 405, 'method_not_allowed', `${method} is not allowed.`, { allow: 'GET' });
      return;
    }

    const index = join(root, 'index.html');
    const wantsAsset = url.pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(url.pathname);
    let file = safePublic(root, url.pathname === '/' ? '/index.html' : url.pathname);
    const found = !!file && existsSync(file) && statSync(file).isFile();
    if (!found) {
      if (wantsAsset && url.pathname !== '/index.html') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not found');
        return;
      }
      file = existsSync(index) ? index : null;
    }
    if (!file) {
      send(res, 200, {
        ok: true,
        message: 'Swarmscope is running, but the viewer bundle is missing. Run npm run build.',
        viewer: false,
      });
      return;
    }
    if (method === 'HEAD') {
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end();
      return;
    }
    serveFile(res, file);
  }

  async function postEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const buf = await decodeBody(req);
    let body: unknown;
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch {
      return fail(res, 400, 'bad_json', 'Body is not valid JSON.');
    }
    let raw: unknown[];
    try {
      raw = batchOf(body);
    } catch (e) {
      return fail(res, 400, 'bad_batch', (e as Error).message);
    }
    const wait = allowWrite(raw.length);
    if (wait) return fail(res, 429, 'rate_limited', 'Too many events. Retry later.', { 'retry-after': String(wait) });
    const result = store.ingestRaw(raw);
    flush();
    send(res, 207, result);
  }

  async function postEmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const buf = await decodeBody(req);
    let body: ReportArgs;
    try {
      body = JSON.parse(buf.toString('utf8')) as ReportArgs;
    } catch {
      return fail(res, 400, 'bad_json', 'Body is not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'bad_json', 'Body must be an object.');
    const wait = allowWrite(1);
    if (wait) return fail(res, 429, 'rate_limited', 'Too many events. Retry later.', { 'retry-after': String(wait) });
    try {
      const now = Date.now();
      const ev = checkNetEvent(rawFromReport(body, now, () => newEventId('http')), now);
      const result = store.ingestValid([ev], now);
      flush();
      send(res, 200, {
        event_id: ev.event_id,
        accepted: result.accepted.includes(ev.event_id),
        duplicate: result.duplicates.includes(ev.event_id),
        head_seq: result.head_seq,
      });
    } catch (e) {
      if (e instanceof NetEventError) return fail(res, 400, 'bad_event', e.message);
      throw e;
    }
  }

  async function postOtlp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      send(res, 415, { code: 3, message: 'Send OTLP/HTTP JSON (Content-Type: application/json).' });
      return;
    }
    const buf = await decodeBody(req);
    let parsed;
    try {
      parsed = otlpToEvents(JSON.parse(buf.toString('utf8')));
    } catch (e) {
      const message = e instanceof OtlpError ? e.message : e instanceof SyntaxError ? 'Body is not valid JSON.' : 'Bad OTLP body.';
      if (!(e instanceof OtlpError) && !(e instanceof SyntaxError)) throw e;
      send(res, 400, { code: 3, message });
      return;
    }
    const now = Date.now();
    const bad = new Map<number, string>(parsed.rejected.map((r) => [r.span, r.reason]));
    const valid = [];
    for (const it of parsed.items) {
      if (bad.has(it.span)) continue;
      try {
        valid.push(checkNetEvent(it.event, now));
      } catch (e) {
        if (!(e instanceof NetEventError)) throw e;
        bad.set(it.span, e.message);
      }
    }
    const keep = valid.filter((ev) => !parsed.items.some((it) => bad.has(it.span) && it.event.event_id === ev.event_id));
    const wait = allowWrite(Math.max(1, parsed.items.length));
    if (wait) {
      send(res, 429, { code: 8, message: 'Too many events. Retry later.' }, { 'retry-after': String(wait) });
      return;
    }
    const result = store.ingestValid(keep, now);
    flush();
    const headers = { 'x-swarmscope-accepted': String(result.accepted.length), 'x-swarmscope-duplicates': String(result.duplicates.length) };
    if (!bad.size) {
      send(res, 200, {}, headers);
      return;
    }
    const first = [...bad.entries()].slice(0, 3).map(([i, r]) => `span ${i}: ${r}`).join('; ');
    send(res, 200, { partialSuccess: { rejectedSpans: bad.size, errorMessage: first } }, headers);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const buf = await readBody(req, NET_LIMITS.bodyBytes);
    let parsed: unknown;
    if (buf.length) {
      try {
        parsed = JSON.parse(buf.toString('utf8'));
      } catch {
        send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not valid JSON.' } });
        return;
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = createMcpServer(store);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    };
    res.on('finish', done);
    res.on('close', done);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      done();
      throw e;
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new AddressInUseError(opts.port));
      else reject(err);
    };
    server.once('error', onError);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        for (const ws of sockets) {
          try {
            ws.close(1000, 'bye');
          } catch {
            /* ignore */
          }
        }
        wss.close();
        server.close(() => resolve());
      }),
  };
}
