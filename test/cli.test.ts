import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { helpText, main, parseArgs } from '../src/cli.js';
import { startHttp } from '../src/http.js';
import { resetRates } from '../src/rate.js';
import { openStore } from '../src/store.js';
import { ensureToken } from '../src/token.js';

const dirs: string[] = [];
const prevHome = process.env.SWARMSCOPE_HOME;

afterEach(() => {
  resetRates();
  if (prevHome === undefined) delete process.env.SWARMSCOPE_HOME;
  else process.env.SWARMSCOPE_HOME = prevHome;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function capture(run: () => Promise<void>): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return run().finally(() => {
    process.stdout.write = write;
  }).then(() => out);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe('command line', () => {
  it('honors --port after the command', () => {
    expect(parseArgs(['ui', '--port', '4400'])).toMatchObject({ command: 'ui', port: 4400, rest: [] });
    expect(parseArgs(['--port', '4400', 'ui'])).toMatchObject({ command: 'ui', port: 4400 });
    const emit = parseArgs(['emit', '--from', 'planner', '--port', '4500', '--kind', 'message']);
    expect(emit.port).toBe(4500);
    expect(emit.rest).toEqual(['--from', 'planner', '--kind', 'message']);
  });

  it('documents the token path and the action kind without the old names', () => {
    const out = helpText();
    expect(out).toContain('action');
    expect(out).not.toContain('trade_action');
    expect(out).toContain('.swarmscope/token');
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });

  it('reads the token file when a viewer is already running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmscope-cli-'));
    dirs.push(dir);
    const token = ensureToken(dir);
    const store = openStore(join(dir, 'server.db'), { retentionMs: 7 * 24 * 3600_000 });
    const server = await startHttp({ store, port: 0, token });
    try {
      const out = await capture(() =>
        main([
          '--home',
          dir,
          '--port',
          String(server.port),
          'emit',
          '--from',
          'planner',
          '--to',
          'coder',
          '--kind',
          'handoff',
          '--label',
          'handoff · draft',
        ]),
      );
      const body = JSON.parse(out) as { accepted: boolean };
      expect(body.accepted).toBe(true);
      expect(out).not.toContain(token);
      const net = store.network();
      expect(net.edges[0]).toMatchObject({ from: 'planner', to: 'coder', kind: 'handoff' });
    } finally {
      await server.close();
      store.close();
    }
  });

  it('writes the local log when no viewer is listening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmscope-cli-'));
    dirs.push(dir);
    const port = await freePort();
    const out = await capture(() =>
      main([
        '--home',
        dir,
        '--port',
        String(port),
        'emit',
        '--from',
        'planner',
        '--to',
        'coder',
        '--kind',
        'action',
        '--label',
        'action · note',
        '--tags',
        'draft,review',
      ]),
    );
    expect(JSON.parse(out).accepted).toBe(true);
    const store = openStore(join(dir, 'events.db'), { retentionMs: 7 * 24 * 3600_000 });
    try {
      const page = store.since(0, 10);
      expect(page.events[0].name).toBe('agent.action');
      expect(page.events[0].attributes['bn.tags']).toEqual(['draft', 'review']);
    } finally {
      store.close();
    }
  });
});
