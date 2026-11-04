/**
 * Per-install bearer token for HTTP writes.
 * The file is ~/.swarmscope/token, mode 0600. Callers may log the path.
 * Never log or include the token value.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

export function tokenPath(dir = dataDir()): string {
  return join(dir, 'token');
}

function readTrimmed(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text || null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Create the token on first use and tighten the file mode to 0600. */
export function ensureToken(dir = dataDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = tokenPath(dir);
  const existing = readTrimmed(path);
  if (existing) {
    chmodSync(path, 0o600);
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  const payload = `${token}\n`;
  try {
    writeFileSync(path, payload, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const raced = readTrimmed(path);
    if (raced) {
      chmodSync(path, 0o600);
      return raced;
    }
    writeFileSync(path, payload, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return token;
}
