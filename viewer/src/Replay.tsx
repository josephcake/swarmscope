/**
 * Plays the last 24 hours back through the live graph.
 * 1× is 10 minutes of network time per second.
 */
import { useEffect, useRef, useState } from 'react';

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;
/** Network milliseconds advanced per real millisecond at 1× (10 minutes of log per real second). */
const NET_PER_REAL_MS = 600;
const SPAN_MS = 24 * 3600e3;
const PUSH_MS = 120;

interface Ev {
  at: string;
  from: string;
  to: string;
  kind: string;
}

const fmt = (t: number) =>
  new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export default function Replay<E extends Ev>({
  events,
  onAt,
  onCross,
  onClose,
}: {
  events: E[];
  onAt: (at: number) => void;
  onCross: (list: E[]) => void;
  onClose: () => void;
}) {
  const [end] = useState(() => Date.now());
  const start = end - SPAN_MS;
  const [at, setAt] = useState(() => {
    const first = events.find((e) => Date.parse(e.at) >= start);
    return first ? Math.max(start, Date.parse(first.at) - 5 * 60e3) : start;
  });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(1);
  const atRef = useRef(at);
  const evRef = useRef(events);
  evRef.current = events;
  const cb = useRef({ onAt, onCross });
  cb.current = { onAt, onCross };

  useEffect(() => {
    cb.current.onAt(atRef.current);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let pushed = 0;
    const tick = (t: number) => {
      const prev = atRef.current;
      const next = Math.min(end, prev + (t - last) * speed * NET_PER_REAL_MS);
      last = t;
      atRef.current = next;
      const crossed = evRef.current.filter((e) => {
        const x = Date.parse(e.at);
        return x > prev && x <= next;
      });
      if (crossed.length) cb.current.onCross(crossed.slice(-12));
      if (t - pushed > PUSH_MS || next >= end) {
        pushed = t;
        setAt(next);
        cb.current.onAt(next);
      }
      if (next >= end) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);

  const seek = (t: number) => {
    atRef.current = t;
    setAt(t);
    cb.current.onAt(t);
  };
  const pct = ((at - start) / SPAN_MS) * 100;
  return (
    <div className="replay" role="group" aria-label="Replay the last 24 hours" data-testid="replay" data-playing={playing ? '1' : '0'}>
      <button
        type="button"
        className="rp-play"
        aria-label={playing ? 'Pause replay' : 'Play replay'}
        onClick={() => {
          if (!playing && atRef.current >= end) seek(start);
          setPlaying((p) => !p);
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="win" role="group" aria-label="Replay speed">
        {SPEEDS.map((s) => (
          <button key={s} type="button" className={s === speed ? 'on' : ''} aria-pressed={s === speed} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <input
        type="range"
        className="rp-scrub"
        min={start}
        max={end}
        step={60e3}
        value={at}
        aria-label="Replay time"
        aria-valuetext={fmt(at)}
        style={{ ['--p' as string]: `${pct}%` }}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <span className="rp-time num" data-testid="replay-time">
        {fmt(at)}
      </span>
      <button type="button" className="rp-live" onClick={onClose}>
        Back to live
      </button>
    </div>
  );
}
