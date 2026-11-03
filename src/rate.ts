import { NET_LIMITS } from './events.js';

interface Bucket {
  start: number;
  posts: number;
  events: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Fixed one-minute window. Returns seconds to wait, or 0 when the call may proceed.
 * A single local user shares one bucket; this only stops a runaway loop.
 */
export function allowWrite(events: number, now = Date.now(), key = 'local'): number {
  let w = buckets.get(key);
  if (!w || now - w.start >= 60_000) {
    w = { start: now, posts: 0, events: 0 };
    buckets.set(key, w);
  }
  if (w.posts + 1 > NET_LIMITS.postsPerMin || w.events + events > NET_LIMITS.eventsPerMin) {
    return Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000));
  }
  w.posts += 1;
  w.events += events;
  return 0;
}

/** Test hook. */
export function resetRates(): void {
  buckets.clear();
}
