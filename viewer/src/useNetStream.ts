import { useEffect, useRef, useState } from 'react';
import type { StreamItem } from './types';

interface StreamEvent {
  seq: number;
  event_id: string;
  name: string;
  start_time_unix_nano: string;
  status?: { code: string };
  attributes: Record<string, unknown>;
}

interface Page {
  events: StreamEvent[];
  head_seq: number;
  next_since: number;
  server_unix_ms: number;
}

export interface NetStream {
  events: StreamItem[];
  connected: boolean;
  fetchedAt: number | null;
  transport: 'push' | 'poll';
}

const SHOW_TEST = typeof location !== 'undefined' && new URLSearchParams(location.search).get('test') === '1';

function toItem(e: StreamEvent): StreamItem | null {
  if (!SHOW_TEST && e.attributes['bn.test'] === true) return null;
  const from = e.attributes['gen_ai.agent.id'];
  if (typeof from !== 'string' || !from) return null;
  const target = e.attributes['bn.target.id'];
  const to = typeof target === 'string' && target ? target : from;
  const ms = Number(BigInt(e.start_time_unix_nano) / 1_000_000n);
  const rawKind = e.name.replace(/^agent\./, '');
  return {
    id: e.event_id,
    at: new Date(ms).toISOString(),
    from,
    to,
    kind: rawKind === 'trade_action' ? 'action' : rawKind,
    gist: String(e.attributes['bn.label'] ?? e.name),
    status: e.status?.code === 'ERROR' ? 'error' : 'ok',
  };
}

/**
 * Live event stream. WebSocket push, with polling when the socket is down.
 * On every connect, backfill from the last seq so nothing is missed.
 */
export function useNetStream(active: boolean): NetStream {
  const [events, setEvents] = useState<StreamItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [transport, setTransport] = useState<'push' | 'poll'>('poll');
  const seq = useRef<number | null>(null);
  const ids = useRef(new Set<string>());

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer = 0;
    let pollTimer = 0;
    let pingTimer = 0;
    let chain: Promise<unknown> = Promise.resolve();

    const add = (list: StreamEvent[]) => {
      const fresh = list.filter((e) => !ids.current.has(e.event_id));
      const items = fresh.map(toItem).filter((e): e is StreamItem => !!e);
      for (const e of list) ids.current.add(e.event_id);
      if (list.length) seq.current = Math.max(seq.current ?? 0, ...list.map((e) => e.seq));
      if (items.length) setEvents((cur) => [...cur, ...items].slice(-800));
    };

    const fetchPage = async (): Promise<void> => {
      if (seq.current == null) {
        const info = (await fetch('/api/v1/network', { cache: 'no-store' }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })) as { head_seq: number };
        if (seq.current == null) seq.current = Math.max(0, info.head_seq - 500);
      }
      for (let page = 0; page < 6 && !stopped; page++) {
        const res = await fetch(`/api/v1/network/events?since=${seq.current}&limit=500`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as Page;
        if (stopped) return;
        add(d.events);
        if (d.events.length < 500 || (seq.current ?? 0) >= d.head_seq) break;
      }
      if (!stopped) {
        setConnected(true);
        setFetchedAt(Date.now());
      }
    };

    const backfill = () => {
      const p = chain.then(fetchPage, fetchPage);
      chain = p.catch(() => undefined);
      return p;
    };

    const schedulePoll = () => {
      window.clearTimeout(pollTimer);
      if (stopped || ws) return;
      pollTimer = window.setTimeout(() => {
        void backfill().finally(() => schedulePoll());
      }, 2000);
    };

    const delay = () => {
      const base = Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      return base * (0.5 + Math.random());
    };

    const connect = () => {
      if (stopped || ws || document.hidden) return;
      let sock: WebSocket;
      try {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        sock = new WebSocket(`${proto}://${location.host}/api/v1/network/stream`);
      } catch {
        reconnectTimer = window.setTimeout(connect, delay());
        return;
      }
      ws = sock;
      sock.onopen = () => {
        if (ws !== sock) return;
        attempt = 0;
        setTransport('push');
        window.clearTimeout(pollTimer);
        void backfill();
        pingTimer = window.setInterval(() => {
          if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send('ping');
        }, 20_000);
      };
      sock.onmessage = (m) => {
        if (ws !== sock || typeof m.data !== 'string') return;
        if (m.data === 'pong') {
          setFetchedAt(Date.now());
          return;
        }
        let msg: { type?: string; events?: StreamEvent[]; head_seq?: number };
        try {
          msg = JSON.parse(m.data);
        } catch {
          return;
        }
        setConnected(true);
        setFetchedAt(Date.now());
        if (msg.type === 'events' && Array.isArray(msg.events)) {
          const list = msg.events;
          const gap = seq.current != null && list.length && list[0].seq > seq.current + 1;
          if (seq.current == null || gap) void backfill();
          else chain = chain.then(() => add(list));
        }
      };
      const dropped = () => {
        if (ws !== sock) return;
        ws = null;
        window.clearInterval(pingTimer);
        setTransport('poll');
        if (stopped) return;
        schedulePoll();
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connect, delay());
      };
      sock.onclose = dropped;
      sock.onerror = () => {
        /* close follows */
      };
    };

    const onVisibility = () => {
      if (!document.hidden && !ws) {
        window.clearTimeout(reconnectTimer);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedulePoll();
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      const sock = ws;
      ws = null;
      try {
        sock?.close(1000, 'bye');
      } catch {
        /* ignore */
      }
    };
  }, [active]);

  return { events, connected, fetchedAt, transport };
}
