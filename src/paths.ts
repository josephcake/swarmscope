import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default viewer port. The server binds 127.0.0.1 only. */
export const DEFAULT_PORT = 4319;

export function dataDir(): string {
  const fromEnv = process.env.SWARMSCOPE_HOME?.trim();
  return fromEnv || join(homedir(), '.swarmscope');
}

/** SQLite file for live data, or the demo file when `demo` is set. */
export function defaultDbPath(demo = false): string {
  if (!demo && process.env.SWARMSCOPE_DB?.trim()) return process.env.SWARMSCOPE_DB.trim();
  return join(dataDir(), demo ? 'demo.db' : 'events.db');
}

/** Retention window. SWARMSCOPE_RETENTION_DAYS, default 7. */
export function retentionMs(): number {
  const raw = process.env.SWARMSCOPE_RETENTION_DAYS;
  const days = raw === undefined || raw.trim() === '' ? 7 : Number(raw);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) return 7 * 24 * 3600_000;
  return Math.round(days * 24 * 3600_000);
}

export function portFromEnv(fallback = DEFAULT_PORT): number {
  const raw = process.env.SWARMSCOPE_PORT;
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

/** Built viewer files. Resolved next to the compiled server, or dist/public when running TypeScript directly. */
export function publicDir(): string {
  const beside = fileURLToPath(new URL('./public/', import.meta.url));
  if (existsSync(join(beside, 'index.html'))) return beside;
  const dist = fileURLToPath(new URL('../dist/public/', import.meta.url));
  if (existsSync(join(dist, 'index.html'))) return dist;
  return beside;
}
