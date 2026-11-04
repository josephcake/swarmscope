import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureToken, tokenPath } from '../src/token.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('install token', () => {
  it('creates a 0600 file and keeps the same value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmscope-token-'));
    dirs.push(dir);
    const first = ensureToken(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
    expect(ensureToken(dir)).toBe(first);
    expect(tokenPath(dir).endsWith('/token')).toBe(true);
  });
});
