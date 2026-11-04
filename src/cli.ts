#!/usr/bin/env node
/**
 * Swarmscope command line.
 *   swarmscope            MCP on stdio, viewer on 127.0.0.1:4319
 *   swarmscope ui         viewer only
 *   swarmscope demo       sample network, then the viewer
 *   swarmscope emit ...   record one event into the local log
 */
import { realpathSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { seedDemo } from './demo.js';
import { NetEventError, checkNetEvent, newEventId } from './events.js';
import { AddressInUseError, startHttp } from './http.js';
import { createMcpServer } from './mcp.js';
import { dataDir, defaultDbPath, portFromEnv, retentionMs } from './paths.js';
import { rawFromReport, type ReportArgs } from './report.js';
import { openStore, type Store } from './store.js';
import { ensureToken, tokenPath } from './token.js';
import { VERSION } from './version.js';

interface Opts {
  db?: string;
  port?: number;
  help: boolean;
  version: boolean;
  command?: string;
  rest: string[];
}

function need(args: string[], flag: string): string {
  const v = args.shift();
  if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
  return v;
}

/** Global flags are accepted before or after the command. `--port` used to be ignored after it. */
export function parseArgs(argv: string[]): Opts {
  const opts: Opts = { help: false, version: false, rest: [] };
  const args = [...argv];
  let commandSet = false;
  while (args.length) {
    const a = args[0];
    if (a === '--help' || a === '-h') {
      opts.help = true;
      args.shift();
      continue;
    }
    if (a === '--version' || a === '-v') {
      opts.version = true;
      args.shift();
      continue;
    }
    if (a === '--db') {
      args.shift();
      opts.db = need(args, '--db');
      continue;
    }
    if (a === '--port') {
      args.shift();
      opts.port = Number(need(args, '--port'));
      continue;
    }
    if (a === '--home') {
      args.shift();
      process.env.SWARMSCOPE_HOME = need(args, '--home');
      continue;
    }
    if (a === '--') {
      args.shift();
      if (!commandSet && args.length) {
        opts.command = args.shift();
        commandSet = true;
      }
      opts.rest.push(...args);
      break;
    }
    if (!commandSet) {
      if (a.startsWith('-')) throw new Error(`Unknown flag ${a}. Try swarmscope --help.`);
      opts.command = args.shift();
      commandSet = true;
      continue;
    }
    opts.rest.push(args.shift()!);
  }
  return opts;
}

export function helpText(): string {
  return `Swarmscope ${VERSION} — local map of your AI agents

Usage
  swarmscope                 MCP server on stdio, viewer on 127.0.0.1:4319
  swarmscope ui              open the viewer
  swarmscope demo            load a sample network, then open the viewer
  swarmscope emit [flags]    record one event

Emit
  --from <slug>              sending agent (required)
  --to <slug>                receiving agent (required for message, handoff, review)
  --kind <kind>              message | handoff | review | file_write | action | alert | heartbeat
  --label <text>             short neutral gist, 60 characters or fewer
  --tags <slugs>             comma-separated short slugs
  --status ok|error          default ok
  --tool <name>              tool the agent used
  --file <path>              relative path
  --parent <event_id>        event that caused this one
  --id <event_id>            stable id (deduped if you send it again)
  --test                     mark as verification traffic

Options
  --port <n>                 viewer port (default 4319, or SWARMSCOPE_PORT)
  --db <path>                event database (default ~/.swarmscope/events.db)
  --home <dir>               data directory (default ~/.swarmscope, or SWARMSCOPE_HOME)
  --help                     show this help

The demo command uses ~/.swarmscope/demo.db and does not touch your real log.
Set SWARMSCOPE_RETENTION_DAYS to change how long events are kept (default 7).
Set SWARMSCOPE_NO_UI=1 to run the MCP server without the viewer.
HTTP writes need the bearer token in ~/.swarmscope/token (mode 0600).
The value is never printed. swarmscope emit reads that file when a viewer is
already running. Stdio MCP does not use the token.
Nothing leaves this machine.
`;
}

function flagValue(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value.`);
  rest.splice(i, 2);
  return v;
}

function listFlag(rest: string[], name: string): string[] | undefined {
  const v = flagValue(rest, name);
  if (v === undefined) return undefined;
  return v.split(',').map((part) => part.trim()).filter(Boolean);
}

function reportFromFlags(rest: string[]): ReportArgs {
  const args = [...rest];
  const from = flagValue(args, '--from');
  const to = flagValue(args, '--to');
  const kind = flagValue(args, '--kind');
  const label = flagValue(args, '--label');
  const status = flagValue(args, '--status');
  const tool = flagValue(args, '--tool');
  const file = flagValue(args, '--file');
  const parent = flagValue(args, '--parent');
  const id = flagValue(args, '--id');
  const name = flagValue(args, '--name');
  const tags = listFlag(args, '--tags');
  const tickers = listFlag(args, '--tickers');
  const testAt = args.indexOf('--test');
  const test = testAt >= 0;
  if (test) args.splice(testAt, 1);
  for (const extra of args) {
    if (extra.startsWith('--')) throw new Error(`Unknown flag ${extra}.`);
    throw new Error(`Unexpected argument "${extra}".`);
  }
  const report: ReportArgs = { from, kind, label, source: 'relay' };
  if (to) report.to = to;
  if (status) report.status = status;
  if (tool) report.tool = tool;
  if (file) report.file = file;
  if (parent) report.parent_id = parent;
  if (id) report.event_id = id;
  if (name) report.name = name;
  if (tags) report.tags = tags;
  if (tickers) report.tickers = tickers;
  if (test) report.test = true;
  return report;
}

function connectionRefused(err: unknown): boolean {
  const seen = new Set<unknown>();
  const stack = [err];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') return true;
    const cause = (current as { cause?: unknown }).cause;
    if (cause) stack.push(cause);
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) stack.push(...errors);
  }
  return false;
}

/** Post to a running viewer. Returns 'down' only when nothing is listening. */
async function postEmit(port: number, token: string, body: ReportArgs): Promise<'down' | Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/v1/emit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (connectionRefused(e)) return 'down';
    throw e;
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(json?.error?.message ?? `The local viewer returned HTTP ${res.status}.`);
  }
  return (json ?? {}) as Record<string, unknown>;
}

async function emit(store: Store, rest: string[], port: number, token: string, directOnly: boolean): Promise<void> {
  const report = reportFromFlags(rest);
  if (!directOnly) {
    const posted = await postEmit(port, token, report);
    if (posted !== 'down') {
      process.stdout.write(JSON.stringify(posted) + '\n');
      return;
    }
  }
  const now = Date.now();
  const ev = checkNetEvent(rawFromReport(report, now, () => newEventId('cli')), now);
  const result = store.ingestValid([ev], now);
  process.stdout.write(
    JSON.stringify({
      event_id: ev.event_id,
      accepted: result.accepted.includes(ev.event_id),
      duplicate: result.duplicates.includes(ev.event_id),
      head_seq: result.head_seq,
    }) + '\n',
  );
}

async function serve(store: Store, port: number, token: string): Promise<void> {
  const running = await startHttp({ store, port, token });
  console.log(`Swarmscope viewer  ${running.url}`);
  console.log(`Data               ${dataDir()}`);
  console.log(`Write token        ${tokenPath()}`);
  const stop = async () => {
    await running.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

async function mcp(store: Store, port: number, token: string): Promise<void> {
  if (process.env.SWARMSCOPE_NO_UI !== '1') {
    try {
      const running = await startHttp({ store, port, token });
      console.error(`Swarmscope viewer  ${running.url}`);
      console.error(`Write token        ${tokenPath()}`);
      const stopUi = () => void running.close();
      process.on('SIGINT', stopUi);
      process.on('SIGTERM', stopUi);
    } catch (e) {
      if (e instanceof AddressInUseError) console.error(`Swarmscope viewer already running on ${e.message.match(/127\.0\.0\.1:\d+/)?.[0] ?? 'that port'}.`);
      else throw e;
    }
  }
  console.error('Swarmscope MCP server on stdio.');
  const server = createMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function demo(port: number, token: string, explicitDb?: string): Promise<void> {
  const path = explicitDb || defaultDbPath(true);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(path + suffix, { force: true });
  }
  const store = openStore(path, { retentionMs: retentionMs() });
  const seeded = seedDemo(store);
  console.log(`Sample network     ${seeded.agents} agents, ${seeded.events} events`);
  console.log(`Demo database      ${path}`);
  await serve(store, port, token);
}

export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.version) {
    console.log(VERSION);
    return;
  }
  if (opts.help || opts.command === 'help') {
    console.log(helpText());
    return;
  }
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }
  const port = opts.port ?? portFromEnv();
  const token = ensureToken();
  const command = opts.command ?? 'mcp';
  if (command === 'demo') {
    await demo(port, token, opts.db);
    return;
  }
  const db = opts.db || defaultDbPath(false);
  const store = openStore(db, { retentionMs: retentionMs() });
  if (command === 'emit') {
    try {
      await emit(store, opts.rest, port, token, opts.db !== undefined);
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'ui') {
    await serve(store, port, token);
    return;
  }
  if (command === 'mcp') {
    await mcp(store, port, token);
    return;
  }
  store.close();
  throw new Error(`Unknown command "${command}". Try swarmscope --help.`);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => {
    const message = err instanceof NetEventError || err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
