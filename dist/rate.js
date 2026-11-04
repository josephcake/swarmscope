import { NET_LIMITS } from './events.js';
const buckets = new Map();
/**
 * Fixed one-minute window. Returns seconds to wait, or 0 when the call may proceed.
 * A single local user shares one bucket; this only stops a runaway loop.
 */
export function allowWrite(events, now = Date.now(), key = 'local') {
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
export function resetRates() {
    buckets.clear();
}
