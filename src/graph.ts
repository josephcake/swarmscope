/**
 * Graph model: edge folding for the canvas, the API edge aggregate, sizing, glow,
 * partners, hourly activity, loops, stuck agents, and hit testing.
 * Pure functions, no DOM.
 */

export interface GraphEvent {
  at: string;
  from: string;
  to: string;
  kind: string;
  gist: string;
  id?: string;
  status?: 'ok' | 'error';
}

/** Kind colors: message cyan, handoff magenta, action yellow, review green, alert red. */
export const KIND_INK: Record<string, string> = {
  message: '#00f0ff',
  handoff: '#ff2bd6',
  action: '#fcee0a',
  alert: '#ff3b5c',
  review: '#39ff88',
  file_write: '#9fb0d0',
  heartbeat: '#6d80a6',
};
export const ERROR_INK = '#ff3b5c';
export const inkFor = (kind: string) => KIND_INK[kind === 'trade_action' ? 'action' : kind] ?? '#c77dff';

export type EdgeClass = 'handoff' | 'flow';
export const edgeClass = (kind: string): EdgeClass => (kind === 'handoff' ? 'handoff' : 'flow');

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  cls: EdgeClass;
  count24: number;
  count: number;
  last: number;
  errors: number;
  kinds: Record<string, number>;
}

/** API / MCP edge: one row per (from, to, kind). */
export interface EdgeAgg {
  from: string;
  to: string;
  kind: string;
  count: number;
  first_ts: string;
  last_ts: string;
}

export interface EdgeInput {
  from?: string | null;
  to?: string | null;
  kind: string;
  atMs: number;
  test?: boolean;
}

const DAY = 24 * 3600e3;

/**
 * Fold stored events into edges keyed by (from, to, kind).
 * Test events, missing ends, and self-events are not edges.
 * `first_ts` / `last_ts` are ISO 8601 UTC.
 */
export function aggregateEdges(events: EdgeInput[]): EdgeAgg[] {
  const map = new Map<string, { from: string; to: string; kind: string; count: number; first: number; last: number }>();
  for (const e of events) {
    if (e.test) continue;
    if (!e.from || !e.to || e.from === e.to) continue;
    const key = `${e.from}\0${e.to}\0${e.kind}`;
    let g = map.get(key);
    if (!g) {
      g = { from: e.from, to: e.to, kind: e.kind, count: 0, first: e.atMs, last: e.atMs };
      map.set(key, g);
    }
    g.count += 1;
    if (e.atMs < g.first) g.first = e.atMs;
    if (e.atMs > g.last) g.last = e.atMs;
  }
  return [...map.values()]
    .map((g) => ({
      from: g.from,
      to: g.to,
      kind: g.kind,
      count: g.count,
      first_ts: new Date(g.first).toISOString(),
      last_ts: new Date(g.last).toISOString(),
    }))
    .sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind)));
}

/** Fold events into canvas edges keyed by (from, to, class). Self-events make no edge. */
export function foldEdges(events: GraphEvent[], now: number, windowMs: number): GraphEdge[] {
  const map = new Map<string, GraphEdge>();
  for (const e of events) {
    if (e.from === e.to) continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    const inWin = age <= windowMs;
    const in24 = age <= DAY;
    if (!inWin && !in24) continue;
    const cls = edgeClass(e.kind);
    const key = `${e.from}>${e.to}>${cls}`;
    let g = map.get(key);
    if (!g) {
      g = { key, from: e.from, to: e.to, cls, count24: 0, count: 0, last: 0, errors: 0, kinds: {} };
      map.set(key, g);
    }
    if (in24) g.count24 += 1;
    if (inWin) {
      g.count += 1;
      g.kinds[e.kind] = (g.kinds[e.kind] ?? 0) + 1;
      if (e.status === 'error') g.errors += 1;
    }
    if (t > g.last) g.last = t;
  }
  return [...map.values()].filter((g) => g.count > 0);
}

export const edgeWidth = (count24: number) => 1 + Math.min(6, Math.log2(1 + Math.max(0, count24)) * 1.25);

export function edgeGlow(msSinceLast: number): number {
  if (msSinceLast < 0) return 1;
  if (msSinceLast >= 20_000) return 0;
  return 1 - msSinceLast / 20_000;
}

export const volumeGlow = (count24: number) => Math.min(1, Math.log2(1 + count24) / 6);

export interface Partner {
  id: string;
  sent: number;
  received: number;
  total: number;
}

export function topPartners(events: GraphEvent[], id: string, limit = 5): Partner[] {
  const m = new Map<string, Partner>();
  for (const e of events) {
    if (e.from === e.to) continue;
    const other = e.from === id ? e.to : e.to === id ? e.from : null;
    if (!other) continue;
    const p = m.get(other) ?? { id: other, sent: 0, received: 0, total: 0 };
    if (e.from === id) p.sent += 1;
    else p.received += 1;
    p.total += 1;
    m.set(other, p);
  }
  return [...m.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id)).slice(0, limit);
}

export function hourly(events: GraphEvent[], now: number, hours = 24, id?: string): Record<string, number>[] {
  const out: Record<string, number>[] = Array.from({ length: hours }, () => ({}));
  for (const e of events) {
    if (id && e.from !== id && e.to !== id) continue;
    const age = now - Date.parse(e.at);
    if (age < 0 || age >= hours * 3600e3) continue;
    const b = out[hours - 1 - Math.floor(age / 3600e3)];
    b[e.kind] = (b[e.kind] ?? 0) + 1;
  }
  return out;
}

export function groupBursts<T extends GraphEvent>(events: T[], gapMs = 10_000): { e: T; n: number }[] {
  const out: { e: T; n: number; t: number }[] = [];
  for (const e of events) {
    const t = Date.parse(e.at);
    const prev = out.length ? out[out.length - 1] : null;
    if (
      prev &&
      e.kind === 'file_write' &&
      prev.e.kind === 'file_write' &&
      prev.e.from === e.from &&
      prev.e.to === e.to &&
      Math.abs(t - prev.t) <= gapMs
    ) {
      prev.n += 1;
      prev.t = t;
      continue;
    }
    out.push({ e, n: 1, t });
  }
  return out.map(({ e, n }) => ({ e, n }));
}

export interface View {
  k: number;
  x: number;
  y: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function fitView(b: Bounds, w: number, h: number, pad: number, kMin: number, kMax: number): View {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const k = Math.max(kMin, Math.min(kMax, Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh)));
  return { k, x: w / 2 - ((b.minX + b.maxX) / 2) * k, y: h / 2 - ((b.minY + b.maxY) / 2) * k };
}

export const resolveView = (override: View | null, fit: View): View => override ?? fit;

export function zoomAbout(v: View, px: number, py: number, factor: number, kMin: number, kMax: number): View {
  const k = Math.max(kMin, Math.min(kMax, v.k * factor));
  const r = k / v.k;
  return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
}

export function hitTest(
  nodes: { id: string; x: number; y: number; r: number }[],
  v: View,
  sx: number,
  sy: number,
  slopPx = 8,
): string | null {
  const wx = (sx - v.x) / v.k;
  const wy = (sy - v.y) / v.k;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const reach = n.r + slopPx / v.k;
    if ((n.x - wx) ** 2 + (n.y - wy) ** 2 <= reach * reach) return n.id;
  }
  return null;
}

export function nextQuality(current: 0 | 1 | 2, fps: number, slowSeconds: number): 0 | 1 | 2 {
  if (current > 0 && fps < 45 && slowSeconds >= 3) return (current - 1) as 0 | 1;
  return current;
}

export function restState(msIdle: number): 'active' | 'idle' | 'cold' {
  if (msIdle > 2 * 3600e3) return 'cold';
  if (msIdle > 30 * 60e3) return 'idle';
  return 'active';
}

export const LOOP = { windowMs: 30 * 60e3, minSwitches: 3, minEachWay: 2 } as const;
export interface Loop {
  a: string;
  b: string;
  count: number;
  switches: number;
  last: number;
}

/** Ping-pong: two agents handing work back and forth inside the window. */
export function pingPongs(
  events: GraphEvent[],
  now: number,
  o: { windowMs: number; minSwitches: number; minEachWay: number } = LOOP,
): Loop[] {
  const pairs = new Map<string, { a: string; b: string; seq: { t: number; ab: boolean }[] }>();
  for (const e of events) {
    if (e.kind !== 'handoff' || e.from === e.to) continue;
    const t = Date.parse(e.at);
    if (!(now - t <= o.windowMs) || t > now) continue;
    const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
    const k = `${a}|${b}`;
    const p = pairs.get(k) ?? { a, b, seq: [] };
    p.seq.push({ t, ab: e.from === a });
    pairs.set(k, p);
  }
  const out: Loop[] = [];
  for (const p of pairs.values()) {
    p.seq.sort((x, y) => x.t - y.t);
    let switches = 0;
    let ab = 0;
    p.seq.forEach((s, i) => {
      if (s.ab) ab += 1;
      if (i && s.ab !== p.seq[i - 1].ab) switches += 1;
    });
    const ba = p.seq.length - ab;
    if (switches >= o.minSwitches && ab >= o.minEachWay && ba >= o.minEachWay) {
      out.push({ a: p.a, b: p.b, count: p.seq.length, switches, last: p.seq[p.seq.length - 1].t });
    }
  }
  return out.sort((x, y) => y.last - x.last);
}

export const STUCK = { openMs: 20 * 60e3, lookbackMs: 2 * 3600e3, failRun: 3 } as const;
export interface Stuck {
  id: string;
  reason: 'handoff' | 'errors';
  since: number;
  from?: string;
  n?: number;
}

/**
 * Agents drawn with an amber ring:
 * - handoff: a handoff to the agent has stayed open longer than openMs and the agent has sent nothing since
 * - errors: the agent's last failRun events, all inside the lookback, all failed
 */
export function stuckBots(
  events: GraphEvent[],
  now: number,
  agents: Set<string>,
  lastSent: Map<string, number>,
  o: { openMs: number; lookbackMs: number; failRun: number } = STUCK,
): Map<string, Stuck> {
  const out = new Map<string, Stuck>();
  const sent = new Map(lastSent);
  const byFrom = new Map<string, GraphEvent[]>();
  for (const e of events) {
    const t = Date.parse(e.at);
    if (t > now) continue;
    if (t > (sent.get(e.from) ?? 0)) sent.set(e.from, t);
    if (now - t <= o.lookbackMs) {
      const l = byFrom.get(e.from) ?? [];
      l.push(e);
      byFrom.set(e.from, l);
    }
  }
  for (const e of events) {
    if (e.kind !== 'handoff' || e.from === e.to || !agents.has(e.to)) continue;
    const t = Date.parse(e.at);
    const open = now - t;
    if (open <= o.openMs || open > o.lookbackMs) continue;
    if ((sent.get(e.to) ?? 0) > t) continue;
    const prev = out.get(e.to);
    if (!prev || t < prev.since) out.set(e.to, { id: e.to, reason: 'handoff', since: t, from: e.from });
  }
  for (const [id, list] of byFrom) {
    if (!agents.has(id) || out.has(id)) continue;
    const last = list.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).slice(-o.failRun);
    if (last.length === o.failRun && last.every((e) => e.status === 'error')) {
      out.set(id, { id, reason: 'errors', since: Date.parse(last[0].at), n: o.failRun });
    }
  }
  return out;
}

export type Dir = 'left' | 'right' | 'up' | 'down';

export function nextNode(pts: { id: string; x: number; y: number }[], from: string | null, dir: Dir): string | null {
  if (!pts.length) return null;
  const cur = pts.find((p) => p.id === from);
  if (!cur) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return pts.reduce((best, p) => (Math.hypot(p.x - cx, p.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? p : best)).id;
  }
  const [ux, uy] = dir === 'left' ? [-1, 0] : dir === 'right' ? [1, 0] : dir === 'up' ? [0, -1] : [0, 1];
  let best: string | null = null;
  let score = Infinity;
  for (const p of pts) {
    if (p.id === cur.id) continue;
    const dx = p.x - cur.x;
    const dy = p.y - cur.y;
    const along = dx * ux + dy * uy;
    if (along <= 0.5) continue;
    const across = Math.abs(dx * uy - dy * ux);
    const s = along + 2 * across;
    if (s < score) {
      score = s;
      best = p.id;
    }
  }
  return best ?? cur.id;
}

/** Stable team bucket so agents that never set a team still get a distinct ink. */
export const TEAM_NAMES = ['Coordination', 'Research', 'Build', 'Review', 'Memory', 'Ops'] as const;

export function teamFor(id: string): (typeof TEAM_NAMES)[number] {
  let h = 0;
  for (const c of id) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return TEAM_NAMES[h % TEAM_NAMES.length];
}
