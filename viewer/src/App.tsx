import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  foldEdges,
  groupBursts,
  hourly,
  inkFor,
  pingPongs,
  restState,
  stuckBots,
  teamFor,
  topPartners,
  type GraphEvent,
  type Stuck,
} from '../../src/graph';
import type { NeonGraph } from './NeonGraph';
import Replay from './Replay';
import { nodeInk, TEAM_INK } from './ink';
import { smoothPath } from './smooth';
import type { NetNode, StreamItem } from './types';
import { useNetStream } from './useNetStream';

const WINDOWS = [
  { id: '1h', label: '1h', ms: 3600e3 },
  { id: '6h', label: '6h', ms: 6 * 3600e3 },
  { id: '24h', label: '24h', ms: 24 * 3600e3 },
  { id: 'all', label: 'All', ms: Infinity },
] as const;

const HOT_MS = 20 * 60e3;
const TRAIL_N = 12;

interface ApiNode {
  id: string;
  name: string;
  team: string;
  kind: 'agent' | 'room';
  role: string;
  level: number;
  manager: string | null;
  last_seen_unix_ms: number | null;
}

interface NetworkResponse {
  demo?: boolean;
  nodes: ApiNode[];
  retention?: { days: number };
  head_seq: number;
}

const evKey = (e: StreamItem) => e.id;
const kindLabel = (k: string) => k.replaceAll('_', ' ');

function titleCase(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function LiveBadge({ fetchedAt, connected, push }: { fetchedAt: number | null; connected: boolean; push: boolean }) {
  const now = useNow(1000);
  const age = fetchedAt ? Math.max(0, Math.round((now - fetchedAt) / 1000)) : null;
  const stale = !connected || age == null || age > 20;
  return (
    <span className={`live ${stale ? 'stale' : ''}`} role="status" data-testid="live" data-transport={push ? 'push' : 'poll'}>
      <i />
      {age == null ? 'connecting…' : `${stale ? 'stale' : 'live'}${push ? ' · push' : ''} · last update ${age < 2 ? 'just now' : `${age}s ago`}`}
    </span>
  );
}

function HourBars({ buckets, height = 36, label }: { buckets: Record<string, number>[]; height?: number; label: string }) {
  const id = useId().replace(/:/g, '');
  const totals = buckets.map((b) => Object.values(b).reduce((s, n) => s + n, 0));
  const max = Math.max(1, ...totals);
  const total = totals.reduce((s, n) => s + n, 0);
  const byKind: Record<string, number> = {};
  for (const b of buckets) for (const [k, n] of Object.entries(b)) byKind[k] = (byKind[k] ?? 0) + n;
  const lead = Object.entries(byKind).sort((a, b) => b[1] - a[1])[0]?.[0];
  const ink = lead ? inkFor(lead) : '#00f0ff';
  const pts = totals.map((n, i) => [(i / Math.max(1, totals.length - 1)) * 100, height - 2 - (n / max) * (height - 6)] as const);
  const line = smoothPath(pts);
  return (
    <svg className="bars" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${total} events in 24 hours`} style={{ height }}>
      <defs>
        <linearGradient id={`${id}f`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={ink} stopOpacity="0.28" />
          <stop offset="1" stopColor={ink} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#00f0ff" />
          <stop offset="1" stopColor={ink} />
        </linearGradient>
      </defs>
      <path d={`${line} L100 ${height} L0 ${height} Z`} fill={`url(#${id}f)`} />
      <path d={line} fill="none" stroke={`url(#${id}s)`} strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function KindMix({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return <div className="mix empty">No events in this window.</div>;
  return (
    <div className="mix">
      <div className="mix-bar">
        {entries.map(([k, n]) => (
          <i key={k} style={{ width: `${(n / total) * 100}%`, background: inkFor(k), color: inkFor(k) }} title={`${kindLabel(k)} ${n}`} />
        ))}
      </div>
      <div className="mix-keys">
        {entries.slice(0, 6).map(([k, n]) => (
          <span key={k}>
            <em style={{ background: inkFor(k), color: inkFor(k) }} />
            {kindLabel(k)} <b>{n}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

const stuckText = (s: Stuck, byId: Map<string, NetNode>, now: number) =>
  s.reason === 'handoff'
    ? `handoff from ${byId.get(s.from ?? '')?.name ?? 'someone'} open ${Math.max(1, Math.round((now - s.since) / 60e3))}m`
    : `last ${s.n} events failed`;

function NodePanel({
  node,
  byId,
  events,
  all,
  lastActive,
  now,
  stuck,
  onClose,
  onPick,
}: {
  node: NetNode;
  byId: Map<string, NetNode>;
  events: StreamItem[];
  all: StreamItem[];
  lastActive: number;
  now: number;
  stuck?: Stuck;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const mine = events.filter((e) => e.from === node.id || e.to === node.id);
  const sent = mine.filter((e) => e.from === node.id && e.to !== node.id).length;
  const recv = mine.filter((e) => e.to === node.id && e.from !== node.id).length;
  const partners = topPartners(mine, node.id, 6);
  const pmax = Math.max(1, ...partners.map((p) => p.total));
  const kinds: Record<string, number> = {};
  for (const e of mine) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const ink = nodeInk(node);
  const rest = lastActive ? restState(now - lastActive) : 'cold';
  const errors = mine.filter((e) => e.status === 'error').length;
  return (
    <aside className="panel" aria-label={`${node.name} details`} data-testid="panel">
      <header>
        <span
          className="gem"
          style={{
            background: `radial-gradient(circle at 40% 38%, #fff 0, ${ink[2]} 22%, ${ink[1]} 55%, transparent 72%)`,
            boxShadow: `0 0 18px ${ink[1]}66`,
          }}
        />
        <div>
          <h3>{node.name}</h3>
          <span>
            {node.role}
            {node.kind === 'room' ? '' : ` · ${node.team}`}
          </span>
        </div>
        <button type="button" className="x" aria-label="Close details" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="chips">
        <span className={`chip ${rest}`}>{rest}</span>
        <span className="chip">{lastActive ? `last seen ${ago(new Date(lastActive).toISOString(), now)}` : 'not seen yet'}</span>
        {stuck ? <span className="chip stuck">stuck · {stuckText(stuck, byId, now)}</span> : null}
        {errors ? (
          <span className="chip err">
            {errors} error{errors > 1 ? 's' : ''}
          </span>
        ) : null}
      </div>
      <div className="kpis">
        <div>
          <b>{sent}</b>
          <span>sent</span>
        </div>
        <div>
          <b>{recv}</b>
          <span>received</span>
        </div>
        <div>
          <b>{partners.length}</b>
          <span>partners</span>
        </div>
      </div>
      <h4>Last 24 hours</h4>
      <HourBars buckets={hourly(all, now, 24, node.id)} height={34} label={`${node.name} activity`} />
      <h4>Top partners</h4>
      {partners.length ? (
        <ul className="partners">
          {partners.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p.id)}>
                {byId.get(p.id)?.name ?? p.id}
              </button>
              <span className="pbar" title={`${p.sent} sent · ${p.received} received`}>
                <i className="s" style={{ width: `${(p.sent / pmax) * 100}%` }} />
                <i className="r" style={{ width: `${(p.received / pmax) * 100}%` }} />
              </span>
              <b>{p.total}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint">No traffic in this window.</p>
      )}
      <div className="pkey">
        <span>
          <em className="s" />
          sent
        </span>
        <span>
          <em className="r" />
          received
        </span>
      </div>
      <h4>By kind</h4>
      <KindMix counts={kinds} />
      <h4>Recent</h4>
      <ul className="recent">
        {mine
          .slice(-10)
          .reverse()
          .map((e, i) => {
            const out = e.from === node.id;
            const otherId = out ? e.to : e.from;
            const other = byId.get(otherId)?.name ?? otherId;
            return (
              <li key={`${evKey(e)}-${i}`} className={e.status === 'error' ? 'err' : ''}>
                <span className="num faint">{clock(e.at)}</span>
                <span>{e.from === e.to ? 'self' : `${out ? '→' : '←'} ${other}`}</span>
                <span className="kind" style={{ color: e.status === 'error' ? undefined : inkFor(e.kind) }}>
                  {kindLabel(e.kind)}
                </span>
                <p>{e.gist}</p>
              </li>
            );
          })}
        {!mine.length ? <li className="faint">Nothing in this window.</li> : null}
      </ul>
    </aside>
  );
}

export default function App() {
  const stream = useNetStream(true);
  const wallNow = useNow(5000);
  const [net, setNet] = useState<NetworkResponse | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [playAt, setPlayAt] = useState<number | null>(null);
  const replaying = replayOpen && playAt != null;
  const now = replaying ? playAt : wallNow;
  const [win, setWin] = useState<(typeof WINDOWS)[number]['id']>('6h');
  const [focus, setFocus] = useState<string | null>(null);
  const [showTrail, setShowTrail] = useState(false);
  const [zoom, setZoom] = useState({ k: 1, user: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const graph = useRef<NeonGraph | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch('/api/v1/network', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as NetworkResponse;
        if (!stop) {
          setNet(body);
          setNetError(null);
        }
      } catch (e) {
        if (!stop) setNetError(e instanceof Error ? e.message : 'Offline');
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 10_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [stream.events.length]);

  const windowMs = WINDOWS.find((w) => w.id === win)!.ms;
  const apiNodes = net?.nodes ?? [];
  const sourceEvents = stream.events;
  const nodes = useMemo<NetNode[]>(() => {
    const map = new Map<string, NetNode>();
    for (const n of apiNodes) {
      map.set(n.id, {
        id: n.id,
        name: n.name,
        team: n.team,
        kind: n.kind,
        role: n.role,
        level: n.level,
        manager: n.manager ?? undefined,
      });
    }
    for (const e of sourceEvents) {
      for (const id of [e.from, e.to]) {
        if (!id || map.has(id)) continue;
        map.set(id, { id, name: titleCase(id), team: teamFor(id), kind: 'agent', role: 'agent', level: 2 });
      }
    }
    return [...map.values()];
  }, [apiNodes, sourceEvents]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const allEvents = useMemo(
    () => (replaying ? sourceEvents.filter((e) => Date.parse(e.at) <= playAt) : sourceEvents),
    [sourceEvents, replaying, playAt],
  );
  const events = useMemo(() => allEvents.filter((e) => now - Date.parse(e.at) <= windowMs), [allEvents, now, windowMs]);
  const edges = useMemo(() => foldEdges(allEvents as GraphEvent[], now, windowMs), [allEvents, now, windowMs]);

  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [arrived, setArrived] = useState<Map<string, number>>(new Map());
  const freshTimer = useRef(0);
  const replayRef = useRef(false);
  replayRef.current = replayOpen;
  useEffect(() => {
    if (!stream.fetchedAt && !nodes.length) return;
    const g = graph.current;
    const keys = sourceEvents.map(evKey);
    if (replayRef.current && seen.current) {
      for (const k of keys) seen.current.add(k);
      return;
    }
    const fire = (list: StreamItem[], stagger: number) => {
      groupBursts(list as GraphEvent[]).forEach(({ e, n }, i) => g?.emit(e, n, i * stagger));
      const wall = Date.now();
      setArrived((cur) => {
        const next = new Map(cur);
        for (const e of list) {
          next.set(e.from, wall);
          next.set(e.to, wall);
        }
        return next;
      });
    };
    if (seen.current == null) {
      if (!g || !nodes.length) return;
      seen.current = new Set(keys);
      const recent = sourceEvents.filter((e) => Date.now() - Date.parse(e.at) < 30 * 60e3).slice(-6);
      if (recent.length) fire(recent, 450);
      return;
    }
    const added = sourceEvents.filter((e) => !seen.current!.has(evKey(e)) && Date.now() - Date.parse(e.at) < 10 * 60e3).slice(-12);
    for (const k of keys) seen.current.add(k);
    if (!added.length) return;
    fire(added, 260);
    setFresh(new Set(added.map(evKey)));
    window.clearTimeout(freshTimer.current);
    freshTimer.current = window.setTimeout(() => setFresh(new Set()), 6000);
  }, [stream.fetchedAt, sourceEvents, nodes.length, ready]);
  useEffect(() => () => window.clearTimeout(freshTimer.current), []);

  const lastActive = useMemo(() => {
    const m = new Map<string, number>();
    const bump = (id: string, t: number) => {
      if (t > (m.get(id) ?? 0)) m.set(id, t);
    };
    if (!replaying) {
      for (const [id, t] of arrived) bump(id, t);
      for (const n of apiNodes) if (n.last_seen_unix_ms) bump(n.id, n.last_seen_unix_ms);
    }
    for (const e of allEvents) {
      const t = Date.parse(e.at);
      bump(e.from, t);
      bump(e.to, t);
    }
    return m;
  }, [arrived, apiNodes, allEvents, replaying]);

  const loops = useMemo(() => pingPongs(allEvents as GraphEvent[], now), [allEvents, now]);
  const stuck = useMemo(() => {
    const agents = new Set(nodes.filter((n) => n.kind === 'agent').map((n) => n.id));
    const sent = new Map<string, number>();
    if (!replaying) {
      for (const n of apiNodes) if (n.last_seen_unix_ms) sent.set(n.id, n.last_seen_unix_ms);
    }
    return stuckBots(allEvents as GraphEvent[], now, agents, sent);
  }, [allEvents, now, nodes, apiNodes, replaying]);

  const touches = (e: { from: string; to: string }) => !focus || e.from === focus || e.to === focus;
  const trail = useMemo(() => (showTrail ? events.filter(touches).slice(-TRAIL_N) : []), [showTrail, events, focus]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    let g: NeonGraph | null = null;
    let gone = false;
    void import('./NeonGraph').then(({ NeonGraph: Engine }) => {
      if (gone || !canvasRef.current) return;
      g = new Engine(canvasRef.current, {
        onSelect: (id) => setFocus((f) => (f === id ? null : id)),
        onFocus: (id) => setFocus(id),
        onView: (k, user) => setZoom({ k, user }),
      });
      graph.current = g;
      g.start();
      setReady(true);
    });
    return () => {
      gone = true;
      g?.destroy();
      graph.current = null;
    };
  }, []);

  useEffect(() => {
    graph.current?.setInput({ nodes, edges, trail: trail as GraphEvent[], lastActive, focus, stuck, loops });
  }, [nodes, edges, trail, lastActive, focus, stuck, loops, ready]);

  const feed = events
    .filter(touches)
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 80);
  const kindCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [events]);
  const day = useMemo(() => hourly(allEvents as GraphEvent[], now, 24), [allEvents, now]);
  const agentCount = nodes.filter((n) => n.kind !== 'room').length;
  const activeAgents = nodes.filter((n) => n.kind !== 'room' && now - (lastActive.get(n.id) ?? 0) < HOT_MS).length;
  const errors = events.filter((e) => e.status === 'error').length;
  const focusNode = focus ? byId.get(focus) : undefined;
  const days = net?.retention?.days ?? 7;
  const legendTeams = ['Coordination', 'Research', 'Build', 'Review', 'Memory', 'Ops', 'Room'].filter((t) => TEAM_INK[t]);

  return (
    <div className="app" data-testid="swarmscope">
      <div className="aurora" aria-hidden="true" />
      <div className="main">
        <div className="bar">
          <div className="brand">
            <b>Swarmscope</b>
          </div>
          <div className="switch" role="tablist" aria-label="View">
            <button type="button" className="on" aria-current="page">
              Network
            </button>
          </div>
        </div>
        <div className="head">
          <div>
            <h1>Agent network</h1>
            <span className="faint">
              {net?.demo ? 'sample network · local only' : 'local only'} · kept {Number.isInteger(days) ? days : Math.round(days)} days
              {netError ? ` · ${netError}` : ''}
            </span>
          </div>
          <LiveBadge fetchedAt={stream.fetchedAt} connected={stream.connected} push={stream.transport === 'push'} />
          <div className="win" role="group" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button key={w.id} type="button" className={w.id === win ? 'on' : ''} aria-pressed={w.id === win} onClick={() => setWin(w.id)}>
                {w.label}
              </button>
            ))}
          </div>
          <div className="win" role="group" aria-label="View options">
            <button type="button" className={!showTrail ? 'on' : ''} aria-pressed={!showTrail} onClick={() => setShowTrail(false)}>
              Agents
            </button>
            <button type="button" className={showTrail ? 'on' : ''} aria-pressed={showTrail} onClick={() => setShowTrail(true)} data-testid="trail">
              Trail
            </button>
            <button
              type="button"
              className={replayOpen ? 'on' : ''}
              aria-pressed={replayOpen}
              onClick={() => {
                setReplayOpen((o) => !o);
                setPlayAt(null);
              }}
              data-testid="replay-btn"
            >
              Replay
            </button>
          </div>
        </div>
        <div className="stats">
          <div className="stat">
            <b>{events.length}</b>
            <span>events · {WINDOWS.find((w) => w.id === win)!.label}</span>
          </div>
          <div className="stat">
            <b className="c">
              {activeAgents}
              <small>/{agentCount}</small>
            </b>
            <span>active &lt; 20m</span>
          </div>
          <div className="stat">
            <b className="m">{kindCounts.handoff ?? 0}</b>
            <span>handoffs</span>
          </div>
          <div className="stat">
            <b className={errors ? 'r' : ''}>{errors}</b>
            <span>errors</span>
          </div>
          <div className="stat wide">
            <span>kind mix</span>
            <KindMix counts={kindCounts} />
          </div>
          <div className="stat wide">
            <span>last 24 hours, by hour</span>
            <HourBars buckets={day} label="Network activity" />
          </div>
        </div>
        <div className="legend">
          {legendTeams.map((team) => (
            <span key={team}>
              <em style={{ background: TEAM_INK[team][1], color: TEAM_INK[team][1] }} />
              {team}
            </span>
          ))}
          <span className="sep" />
          {['message', 'handoff', 'review', 'file_write', 'action', 'alert'].map((k) => (
            <span key={k}>
              <em className="line" style={{ background: inkFor(k), color: inkFor(k) }} />
              {kindLabel(k)}
            </span>
          ))}
          <span>
            <em className="dash" />
            handoff edge
          </span>
          <span>
            <em className="hot" />
            active &lt; 20m
          </span>
        </div>
        {replayOpen ? (
          <Replay
            events={sourceEvents}
            onAt={setPlayAt}
            onCross={(list) => groupBursts(list as GraphEvent[]).forEach(({ e, n }, i) => graph.current?.emit(e, n, i * 120))}
            onClose={() => {
              setReplayOpen(false);
              setPlayAt(null);
            }}
          />
        ) : null}
        {loops.length || stuck.size ? (
          <div className="alerts" data-testid="alerts">
            {loops.map((l) => (
              <button key={`${l.a}|${l.b}`} type="button" className="alert" data-testid="loop" onClick={() => setFocus(l.a)}>
                <b>⇄ loop</b> {byId.get(l.a)?.name ?? l.a} ↔ {byId.get(l.b)?.name ?? l.b} · {l.count} handoffs back and forth in 30m
              </button>
            ))}
            {[...stuck.values()].map((s) => (
              <button key={s.id} type="button" className="alert" data-testid="stuck" onClick={() => setFocus(s.id)}>
                <b>◌ stuck</b> {byId.get(s.id)?.name ?? s.id} · {stuckText(s, byId, now)}
              </button>
            ))}
          </div>
        ) : null}
        <div className={`stage ${focusNode ? 'has-panel' : ''}`}>
          <canvas
            ref={canvasRef}
            className="canvas"
            tabIndex={0}
            role="img"
            aria-label={`Agent network: ${nodes.length} nodes, ${edges.length} links in this window. Arrow keys move between agents, Escape clears, Shift+arrows pan, plus and minus zoom, 0 fits.`}
            data-testid="canvas"
          />
          <div className="zoom" aria-label="Zoom">
            <button type="button" aria-label="Zoom in" onClick={() => graph.current?.zoomBy(1.3)}>
              +
            </button>
            <button type="button" aria-label="Zoom out" onClick={() => graph.current?.zoomBy(1 / 1.3)}>
              −
            </button>
            <button type="button" aria-label="Fit the graph" className={zoom.user ? 'lit' : ''} onClick={() => graph.current?.fit()} data-testid="fit">
              Fit
            </button>
            <span>{Math.round(zoom.k * 100)}%</span>
          </div>
          <div className="hint">scroll or pinch to zoom · drag to pan · tap an agent or use the arrow keys</div>
          {!nodes.length ? (
            <div className="empty">
              <p>No agents yet.</p>
              <p className="faint">Run swarmscope demo, or report an event from an agent.</p>
            </div>
          ) : null}
          {focusNode ? (
            <NodePanel
              node={focusNode}
              byId={byId}
              events={events}
              all={allEvents}
              lastActive={lastActive.get(focusNode.id) ?? 0}
              now={now}
              stuck={stuck.get(focusNode.id)}
              onClose={() => setFocus(null)}
              onPick={(id) => setFocus(id)}
            />
          ) : null}
        </div>
      </div>
      <aside className="feed" data-testid="feed">
        <h2>
          Activity
          {focus ? (
            <button type="button" className="clear" onClick={() => setFocus(null)}>
              {byId.get(focus)?.name} ✕
            </button>
          ) : null}
          <span>{feed.length}</span>
        </h2>
        <ul>
          {feed.map((e, i) => (
            <li
              key={`${evKey(e)}-${i}`}
              className={`${now - Date.parse(e.at) < HOT_MS ? 'hot' : ''} ${fresh.has(evKey(e)) ? 'new' : ''} ${e.status === 'error' ? 'err' : ''}`}
            >
              <span className="time num faint">{clock(e.at)}</span>
              <span className="who">
                <b>{byId.get(e.from)?.name ?? e.from}</b>
                {e.from === e.to ? null : (
                  <>
                    {' '}
                    → <b>{byId.get(e.to)?.name ?? e.to}</b>
                  </>
                )}
              </span>
              <span className="kind" style={{ color: inkFor(e.kind) }}>
                {kindLabel(e.kind)}
              </span>
              <p>{e.gist}</p>
            </li>
          ))}
          {!feed.length ? <li className="faint empty-feed">Nothing in this window.</li> : null}
        </ul>
      </aside>
    </div>
  );
}
