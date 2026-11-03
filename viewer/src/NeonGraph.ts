import type { NetNode } from './types';
import {
  ERROR_INK, edgeGlow, edgeWidth, fitView, hitTest, inkFor, nextQuality, restState, volumeGlow, zoomAbout,
  nextNode, type Bounds, type Dir, type GraphEdge, type GraphEvent, type Loop, type Stuck, type View,
} from '../../src/graph';

/**
 * Canvas renderer: a small force layout, glowing orbs, thin flowing edges, fine particle streaks,
 * and neon glow from cached radial sprites (no shadowBlur, so it stays smooth). React owns the data;
 * this class owns the frame loop, including zoom, pan, and pinch.
 */

import { GRAY, TEAM_INK, nodeInk } from './ink';
export { TEAM_INK, nodeInk };
export const nodeRadius = (n: NetNode) => (n.kind === 'room' ? 9 : 5 + Math.min(5, n.level) * 1.8);

export interface GraphInput {
  nodes: NetNode[];
  edges: GraphEdge[];
  /** Recent events to draw as a numbered trail, oldest first; empty when the trail is off. */
  trail: GraphEvent[];
  /** Node id -> last activity (epoch ms). */
  lastActive: Map<string, number>;
  focus: string | null;
  /** Agents to ring in amber (open handoff too long, or failing). */
  stuck?: Map<string, Stuck>;
  /** Pairs handing work back and forth: a badge on the pair. */
  loops?: Loop[];
}
export interface GraphCallbacks {
  onSelect: (id: string) => void;
  /** Keyboard navigation: select exactly this node (null clears). */
  onFocus?: (id: string | null) => void;
  onView: (k: number, userView: boolean) => void;
}

interface Body { x: number; y: number; vx: number; vy: number; fixed: boolean; ph: number }
interface Particle { from: string; to: string; key: string; start: number; color: string; n: number; err: boolean; done?: boolean }
interface Ping { node: string; start: number; color: string; err: boolean }

const TRAVEL_MS = 1500;
const PING_MS = 1300;
const FLASH_MS = 1800;
const HOT_MS = 20 * 60e3;
const STUCK_INK = '#ffb000';
const HEAT_MS = 15 * 60e3;
const ZMIN = 0.2;
const ZMAX = 5;
const STREAK = 8;

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Quadratic edge from a to b, bowed to one side by `bow` (scaled with length so long edges arc), ending `rb` short of b. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, rb: number, bow: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const x2 = b.x - (dx / d) * rb;
  const y2 = b.y - (dy / d) * rb;
  const bw = bow * Math.max(0.7, Math.min(2.4, d / 150));
  const mx = (a.x + x2) / 2 - (dy / d) * bw;
  const my = (a.y + y2) / 2 + (dx / d) * bw;
  return {
    a, mx, my, x2, y2,
    at: (t: number) => ({ x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * x2, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * y2 }),
  };
}

export class NeonGraph {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private ww = 1000;
  private wh = 680;
  private bodies = new Map<string, Body>();
  private byId = new Map<string, NetNode>();
  private input: GraphInput = { nodes: [], edges: [], trail: [], lastActive: new Map(), focus: null };
  private links: { a: string; b: string; k: number }[] = [];
  private particles: Particle[] = [];
  private pings: Ping[] = [];
  private flashes = new Map<string, number>();
  private hits = new Map<string, number>();
  private view: View = { k: 1, x: 0, y: 0 };
  private override: View | null = null;
  private placed = false;
  /** The fitted view follows the layout only until this time; afterwards the camera holds still. */
  private fitUntil = 0;
  private raf = 0;
  private t = 0;
  private quality: 0 | 1 | 2 = 2;
  private frames = 0;
  private fpsAt = 0;
  private slow = 0;
  private sprites = new Map<string, HTMLCanvasElement>();
  private hover: string | null = null;
  private reduce = false;
  private mq: MediaQueryList;
  private ro: ResizeObserver;
  private lastK = 0;
  private lastUser = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { mode: 'pan' | 'node' | 'pinch' | null; node?: string; moved: number; last?: { x: number; y: number }; dist?: number } = { mode: null, moved: 0 };

  constructor(private canvas: HTMLCanvasElement, private cb: GraphCallbacks) {
    this.ctx = canvas.getContext('2d', { alpha: true })!;
    this.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduce = this.mq.matches;
    this.mq.addEventListener('change', this.onMotion);
    // Phones start one step lighter; any device steps down further if it can't hold 45 fps.
    if (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 760) this.quality = 1;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDbl);
    canvas.addEventListener('keydown', this.onKey);
  }

  destroy() {
    this.stop();
    this.ro.disconnect();
    this.mq.removeEventListener('change', this.onMotion);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('dblclick', this.onDbl);
    c.removeEventListener('keydown', this.onKey);
  }

  start() {
    if (this.raf) return;
    this.fpsAt = performance.now();
    this.frames = 0;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setInput(input: GraphInput) {
    const prev = this.input;
    this.input = input;
    this.byId = new Map(input.nodes.map((n) => [n.id, n]));
    if (prev.nodes !== input.nodes) {
      const m = this.bodies;
      let added = false;
      input.nodes.forEach((n, i) => {
        if (m.has(n.id)) return;
        const near = n.manager ? m.get(n.manager) : undefined;
        const a = (i / Math.max(1, input.nodes.length)) * Math.PI * 2;
        const R = Math.min(this.ww, this.wh) * 0.32;
        added = true;
        m.set(n.id, near
          ? { x: near.x + Math.cos(a) * 40, y: near.y + Math.sin(a) * 40, vx: 0, vy: 0, fixed: false, ph: i * 2.399 }
          : { x: this.ww / 2 + Math.cos(a) * R, y: this.wh / 2 + Math.sin(a) * R, vx: 0, vy: 0, fixed: false, ph: i * 2.399 });
      });
      let gone = false;
      for (const id of [...m.keys()]) if (!this.byId.has(id)) { m.delete(id); gone = true; }
      if (gone || added) this.refit(); // only when the set of nodes changes
      if (!this.placed && input.nodes.length) {
        this.placed = true;
        for (let i = 0; i < 260; i++) this.step(false); // settle before the first paint
      }
    }
    // Springs: the org tree, plus a weaker pull along edges that carry traffic.
    const seen = new Set<string>();
    const links: { a: string; b: string; k: number }[] = [];
    for (const n of input.nodes) if (n.manager && this.byId.has(n.manager)) { links.push({ a: n.id, b: n.manager, k: 1 }); seen.add(`${n.id}|${n.manager}`); seen.add(`${n.manager}|${n.id}`); }
    for (const e of input.edges) if (!seen.has(`${e.from}|${e.to}`)) { links.push({ a: e.from, b: e.to, k: 0.35 }); seen.add(`${e.from}|${e.to}`); seen.add(`${e.to}|${e.from}`); }
    this.links = links;
  }

  /** One live event: a particle along the edge in the kind's color (red for errors), `n` > 1 for a burst. */
  emit(e: GraphEvent, n: number, delayMs: number) {
    if (!this.bodies.has(e.from) || !this.bodies.has(e.to)) return;
    const err = e.status === 'error';
    const p: Particle = { from: e.from, to: e.to, key: `${e.from}>${e.to}>${e.kind === 'handoff' ? 'handoff' : 'flow'}`, start: performance.now() + delayMs, color: err ? ERROR_INK : inkFor(e.kind), n, err };
    if (e.from === e.to || this.reduce) {
      // No travel: light the edge and ring the node in place.
      p.start = performance.now() + delayMs - TRAVEL_MS;
    }
    this.particles.push(p);
    if (this.particles.length > 80) this.particles.splice(0, this.particles.length - 80);
  }

  /** Back to the fitted view: clears the user's view (the only way it is cleared). */
  fit() {
    this.override = null;
    this.refit();
    this.notifyView(true);
  }
  zoomBy(f: number) {
    this.setUser(zoomAbout(this.override ?? this.view, this.w / 2, this.h / 2, f, ZMIN, ZMAX));
  }

  private refit() {
    this.fitUntil = performance.now() + 2500;
  }

  // ---------------------------------------------------------------- layout

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const cap = this.quality === 0 ? 1 : this.quality === 1 ? 1.5 : 2;
    const dpr = Math.min(cap, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    // A real resize refits; a pixel or two of layout jitter does not move the camera.
    if (Math.abs(w - this.w) > 4 || Math.abs(h - this.h) > 4) this.refit();
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // World sized to the stage, so a phone gets a tall layout and big screens get room.
    this.ww = Math.max(380, Math.min(1400, w));
    this.wh = this.ww * Math.max(0.5, Math.min(1.8, h / w));
    if (!this.raf) this.frame();
  }

  private step(motion: boolean) {
    const s = this.ww / 1000;
    const list = [...this.bodies.values()];
    const rep = 5200 * s * s;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = rep / d2;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    const len = 120 * s;
    for (const l of this.links) {
      const a = this.bodies.get(l.a);
      const b = this.bodies.get(l.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - len) * 0.012 * l.k;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    const wander = motion ? 0.22 * s : 0;
    // Centering follows the stage's shape: wide stages spread sideways, tall (phone) stages spread down.
    const ar = Math.sqrt(this.wh / this.ww);
    const cx = 0.0019 * ar, cy = 0.0019 / ar;
    for (const b of list) {
      if (b.fixed) { b.vx = 0; b.vy = 0; continue; }
      b.vx += (this.ww / 2 - b.x) * cx + Math.sin(this.t / 140 + b.ph) * wander;
      b.vy += (this.wh / 2 - b.y) * cy + Math.cos(this.t / 170 + b.ph * 1.3) * wander;
      b.vx *= 0.86; b.vy *= 0.86;
      b.x = Math.max(30, Math.min(this.ww - 30, b.x + b.vx));
      b.y = Math.max(30, Math.min(this.wh - 30, b.y + b.vy));
    }
  }

  private bounds(): Bounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, b] of this.bodies) {
      const n = this.byId.get(id);
      const r = n ? nodeRadius(n) : 10;
      minX = Math.min(minX, b.x - r - 30); maxX = Math.max(maxX, b.x + r + 30);
      minY = Math.min(minY, b.y - r - 8); maxY = Math.max(maxY, b.y + r + 24); // room for the label
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: this.ww, maxY: this.wh };
  }

  // ---------------------------------------------------------------- frame

  private frame() {
    const now = performance.now();
    const wall = Date.now();
    this.t += 1;
    const motion = !this.reduce;
    this.step(motion);

    // Viewport: the user's view if they set one; otherwise the fit, which tracks the layout only
    // briefly after load, a resize, new nodes, or Fit. Nothing else (selection included) moves it.
    if (this.override) this.view = this.override;
    else if (now < this.fitUntil || !this.lastK) {
      const fit = fitView(this.bounds(), this.w, this.h, Math.min(28, this.w * 0.05), 0.25, 1.8);
      const a = motion && this.lastK ? 0.12 : 1;
      this.view = { k: this.view.k + (fit.k - this.view.k) * a, x: this.view.x + (fit.x - this.view.x) * a, y: this.view.y + (fit.y - this.view.y) * a };
    }
    this.notifyView(false);

    // Particles arriving: ring the target, light the edge, flash errors.
    for (const p of this.particles) {
      if (!p.done && now - p.start >= TRAVEL_MS) {
        p.done = true;
        this.pings.push({ node: p.to, start: now, color: p.color, err: p.err });
        this.hits.set(p.key, wall);
        if (p.err) { this.flashes.set(p.key, now + FLASH_MS); this.flashes.set(p.to, now + FLASH_MS); }
        const a = this.bodies.get(p.from);
        const b = this.bodies.get(p.to);
        if (a && b && motion && a !== b) {
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
          a.vx += (dx / d) * 2.5; a.vy += (dy / d) * 2.5; b.vx -= (dx / d) * 2.5; b.vy -= (dy / d) * 2.5;
        }
      }
    }
    this.particles = this.particles.filter((p) => !p.done);
    this.pings = this.pings.filter((p) => now - p.start < PING_MS);

    this.draw(now, wall, motion);

    // Frame rate, and stepping quality down if this device can't keep up.
    this.frames += 1;
    if (now - this.fpsAt >= 1000) {
      const fps = (this.frames * 1000) / (now - this.fpsAt);
      this.slow = fps < 45 ? this.slow + 1 : 0;
      const q = nextQuality(this.quality, fps, this.slow);
      if (q !== this.quality) { this.quality = q; this.slow = 0; this.resize(); }
      const ds = this.canvas.dataset;
      ds.fps = fps.toFixed(1);
      ds.quality = String(this.quality);
      this.frames = 0;
      this.fpsAt = now;
    }
    const ds = this.canvas.dataset;
    ds.zoom = this.view.k.toFixed(3);
    ds.userView = this.override ? '1' : '0';
    ds.particles = String(this.particles.length);
    ds.view = `${this.view.k.toFixed(4)},${this.view.x.toFixed(1)},${this.view.y.toFixed(1)}`;
  }

  private notifyView(force: boolean) {
    const user = !!this.override;
    if (force || user !== this.lastUser || Math.abs(this.view.k - this.lastK) > this.lastK * 0.01) {
      this.lastK = this.view.k;
      this.lastUser = user;
      this.cb.onView(this.view.k, user);
    }
  }

  private sprite(color: string) {
    let s = this.sprites.get(color);
    if (!s) {
      s = document.createElement('canvas');
      s.width = s.height = 64;
      const g = s.getContext('2d')!;
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, color);
      grad.addColorStop(0.35, color + 'aa');
      grad.addColorStop(1, color + '00');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      this.sprites.set(color, s);
    }
    return s;
  }
  private glow(x: number, y: number, r: number, color: string, alpha: number) {
    if (alpha <= 0.01) return;
    const c = this.ctx;
    c.globalAlpha = Math.min(1, alpha);
    c.drawImage(this.sprite(color), x - r, y - r, r * 2, r * 2);
  }

  private draw(now: number, wall: number, motion: boolean) {
    const c = this.ctx;
    const { k, x: vx, y: vy } = this.view;
    const dpr = this.dpr;
    const q = this.quality;
    const { focus, edges, trail, lastActive } = this.input;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.setTransform(dpr * k, 0, 0, dpr * k, dpr * vx, dpr * vy);
    const lw = 1 / Math.sqrt(k);

    c.globalAlpha = 1;
    // Faint dotted field, so empty space still reads as a map.
    c.fillStyle = 'rgba(150, 190, 230, 0.22)';
    const step = 36;
    const dot = Math.max(0.6, 1.1 / k);
    for (let gx = step; gx < this.ww; gx += step) {
      for (let gy = step; gy < this.wh; gy += step) {
        c.fillRect(gx, gy, dot, dot);
      }
    }

    const neighbor = (id: string) => !focus || id === focus || edges.some((e) => (e.from === focus && e.to === id) || (e.to === focus && e.from === id));
    const pos = (id: string) => this.bodies.get(id);

    // Org tree: faint dotted guides.
    c.setLineDash([1 / k, 6 / k]);
    c.strokeStyle = 'rgba(0, 240, 255, 0.1)';
    c.lineWidth = lw;
    c.beginPath();
    for (const n of this.input.nodes) {
      const a = pos(n.id);
      const b = n.manager ? pos(n.manager) : undefined;
      if (a && b) { c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); }
    }
    c.stroke();
    c.setLineDash([]);

    // Edges: a fine additive glow, then a hairline core; handoffs dotted and bowed the other way.
    c.lineCap = 'round';
    for (const e of edges) {
      const a = pos(e.from), b = pos(e.to);
      const nb = this.byId.get(e.to), na = this.byId.get(e.from);
      if (!a || !b || !na || !nb) continue;
      const hand = e.cls === 'handoff';
      const cv = curve(a, b, nodeRadius(nb) + 4, hand ? -26 : 18);
      const recent = Math.max(edgeGlow(wall - e.last), edgeGlow(wall - (this.hits.get(e.key) ?? 0)));
      const vol = volumeGlow(e.count24);
      const hot = wall - e.last < HOT_MS;
      const dim = focus && e.from !== focus && e.to !== focus ? 0.12 : 1;
      const flash = (this.flashes.get(e.key) ?? 0) > now;
      const blink = flash ? 0.5 + 0.5 * Math.sin(now / 70) : 0;
      const ia = nodeInk(na)[1], ib = nodeInk(nb)[1];
      const width = (0.55 + edgeWidth(e.count24) * 0.28) * lw;
      const path = () => { c.beginPath(); c.moveTo(a.x, a.y); c.quadraticCurveTo(cv.mx, cv.my, cv.x2, cv.y2); };
      let stroke: string | CanvasGradient = flash ? ERROR_INK : ia;
      if (!flash && q === 2 && ia !== ib) {
        const g = c.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, ia);
        g.addColorStop(1, ib);
        stroke = g;
      }
      if (hand) {
        c.setLineDash([0.5 * lw, 5 * lw]);
        c.lineDashOffset = motion && hot ? -(now / 45) % (5.5 * lw * 100) : 0;
      }
      if (q > 0) {
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = dim * Math.min(0.5, 0.035 + 0.08 * vol + 0.32 * recent + blink * 0.4);
        c.strokeStyle = stroke;
        c.lineWidth = width * 4 + 3 * lw;
        path();
        c.stroke();
        c.globalCompositeOperation = 'source-over';
      }
      c.globalAlpha = dim * Math.min(1, 0.32 + 0.3 * vol + 0.4 * recent + (hot ? 0.12 : 0) + blink);
      c.strokeStyle = stroke;
      c.lineWidth = hand ? width + 0.9 * lw : width;
      path();
      c.stroke();
      c.setLineDash([]);
      // Arrowhead at the target: an open hairline chevron.
      const dx = cv.x2 - cv.mx, dy = cv.y2 - cv.my, d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d, s = 2.6 * lw + width;
      c.strokeStyle = flash ? ERROR_INK : ib;
      c.lineWidth = Math.max(0.8 * lw, width);
      c.beginPath();
      c.moveTo(cv.x2 - ux * s * 1.8 - uy * s, cv.y2 - uy * s * 1.8 + ux * s);
      c.lineTo(cv.x2, cv.y2);
      c.lineTo(cv.x2 - ux * s * 1.8 + uy * s, cv.y2 - uy * s * 1.8 - ux * s);
      c.stroke();
    }

    // Event trail: the last few events in order, numbered (newest brightest).
    if (trail.length) {
      const n = trail.length;
      trail.forEach((e, i) => {
        const a = pos(e.from), b = pos(e.to), nb = this.byId.get(e.to);
        if (!a || !b || !nb) return;
        const w = (i + 1) / n;
        const color = e.status === 'error' ? ERROR_INK : inkFor(e.kind);
        c.globalAlpha = 0.25 + 0.7 * w;
        c.strokeStyle = color;
        c.lineWidth = (0.6 + w * 0.8) * lw;
        c.setLineDash([0.5 * lw, 4 * lw]);
        if (a === b) {
          c.beginPath();
          c.arc(a.x, a.y - nodeRadius(nb) - 10, 9, 0, Math.PI * 2);
          c.stroke();
        } else {
          const cv = curve(a, b, nodeRadius(nb) + 2, 34 + (i % 4) * 10);
          c.beginPath(); c.moveTo(a.x, a.y); c.quadraticCurveTo(cv.mx, cv.my, cv.x2, cv.y2); c.stroke();
        }
        c.setLineDash([]);
        const m = a === b ? { x: a.x, y: a.y - nodeRadius(nb) - 19 } : curve(a, b, nodeRadius(nb) + 2, 34 + (i % 4) * 10).at(0.5);
        const r = 7 * lw;
        c.globalAlpha = 0.6 + 0.4 * w;
        c.fillStyle = 'rgba(5, 6, 15, 0.8)';
        c.beginPath(); c.arc(m.x, m.y, r, 0, Math.PI * 2); c.fill();
        c.strokeStyle = color; c.lineWidth = 0.7 * lw; c.stroke();
        c.fillStyle = '#eaf6ff';
        c.font = `500 ${8.5 * lw}px Rajdhani, sans-serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(i + 1), m.x, m.y + 0.5 * lw);
      });
    }

    // Particles in flight.
    c.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const t = (now - p.start) / TRAVEL_MS;
      if (t < 0 || t > 1) continue;
      const a = pos(p.from), b = pos(p.to), nb = this.byId.get(p.to);
      if (!a || !b || !nb) continue;
      const cv = curve(a, b, nodeRadius(nb) + 2, p.key.endsWith('handoff') ? -26 : 18);
      const e = ease(t);
      // A fine streak: short tapered segments trailing the head along the edge curve.
      const len = q === 0 ? 0.08 : 0.16;
      const steps = q === 0 ? 3 : STREAK;
      let prev = cv.at(e);
      c.lineCap = 'round';
      for (let i = 1; i <= steps; i++) {
        const pt = cv.at(Math.max(0, e - (len * i) / steps));
        const f = 1 - i / (steps + 1);
        c.globalAlpha = 0.85 * f;
        c.strokeStyle = p.color;
        c.lineWidth = (0.5 + 1.6 * f) * lw;
        c.beginPath(); c.moveTo(prev.x, prev.y); c.lineTo(pt.x, pt.y); c.stroke();
        prev = pt;
      }
      const head = cv.at(e);
      this.glow(head.x, head.y, 9 * lw, p.color, 0.8);
      c.globalAlpha = 1;
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(head.x, head.y, 1.4 * lw, 0, Math.PI * 2); c.fill();
      if (p.n > 1) {
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = p.color;
        c.font = `500 ${10 * lw}px Rajdhani, sans-serif`;
        c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(`×${p.n}`, head.x + 8 * lw, head.y - 8 * lw);
        c.globalCompositeOperation = 'lighter';
      }
    }

    // Node glow: pulses while active, brighter with recent activity.
    for (const n of this.input.nodes) {
      const b = pos(n.id);
      if (!b) continue;
      const idle = wall - (lastActive.get(n.id) ?? 0);
      const rest = restState(idle);
      if (rest === 'cold' || (q === 0 && idle > HOT_MS)) continue;
      const heat = Math.max(0, 1 - idle / HEAT_MS);
      const pulse = motion && idle < HOT_MS ? 0.5 + 0.5 * Math.sin(now / 420 + b.ph) : 0.5;
      const r = nodeRadius(n);
      const dim = neighbor(n.id) ? 1 : 0.2;
      this.glow(b.x, b.y, r * (2.8 + heat * 1.8 + pulse * 0.7), nodeInk(n)[1], dim * (rest === 'idle' ? 0.1 : 0.14 + heat * 0.4 + pulse * 0.12));
    }
    c.globalCompositeOperation = 'source-over';

    // Arrival rings.
    for (const p of this.pings) {
      const b = pos(p.node), n = this.byId.get(p.node);
      if (!b || !n) continue;
      const t = (now - p.start) / PING_MS;
      c.globalAlpha = 1 - t;
      c.strokeStyle = p.color;
      c.lineWidth = (p.err ? 1.6 : 0.9) * lw;
      c.beginPath(); c.arc(b.x, b.y, nodeRadius(n) + 4 + (motion ? (1 - (1 - t) ** 3) * 30 : 6), 0, Math.PI * 2); c.stroke();
    }

    // Nodes: small glowing orbs (lit core, hairline ring) in team inks; rooms as fine dashed rings.
    for (const n of this.input.nodes) {
      const b = pos(n.id);
      if (!b) continue;
      const r = nodeRadius(n);
      const rest = restState(wall - (lastActive.get(n.id) ?? 0));
      // Cold bots keep a faint tint of their team ink so the map still reads by team.
      const ink = rest === 'cold' ? [GRAY[0], nodeInk(n)[1], GRAY[2]] : nodeInk(n);
      const dim = neighbor(n.id) ? 1 : 0.25;
      const alpha = dim * (rest === 'cold' ? 0.42 : rest === 'idle' ? 0.7 : 1);
      const hov = this.hover === n.id;
      if (n.kind === 'room') {
        c.globalAlpha = alpha;
        c.fillStyle = 'rgba(5, 6, 15, 0.35)';
        c.beginPath(); c.arc(b.x, b.y, r, 0, Math.PI * 2); c.fill();
        c.setLineDash([1.5 * lw, 3 * lw]);
        c.strokeStyle = hov ? '#ffffff' : ink[2]; c.lineWidth = 0.8 * lw; c.stroke();
        c.setLineDash([]);
        c.globalAlpha = alpha * 0.8;
        c.fillStyle = ink[2];
        c.beginPath(); c.arc(b.x, b.y, 1.4 * lw, 0, Math.PI * 2); c.fill();
      } else {
        c.globalAlpha = alpha;
        const g = c.createRadialGradient(b.x - r * 0.25, b.y - r * 0.3, 0, b.x, b.y, r);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.25, ink[2]);
        g.addColorStop(0.7, ink[1]);
        g.addColorStop(1, ink[1] + '00');
        c.fillStyle = g;
        c.beginPath(); c.arc(b.x, b.y, r, 0, Math.PI * 2); c.fill();
        c.globalAlpha = alpha * (hov ? 1 : 0.6);
        c.strokeStyle = hov ? '#ffffff' : ink[1];
        c.lineWidth = (hov ? 1.1 : 0.7) * lw;
        c.beginPath(); c.arc(b.x, b.y, r + 3, 0, Math.PI * 2); c.stroke();
      }
      if ((this.flashes.get(n.id) ?? 0) > now) {
        c.globalAlpha = 0.5 + 0.5 * Math.sin(now / 70);
        c.strokeStyle = ERROR_INK; c.lineWidth = 1.4 * lw;
        c.beginPath(); c.arc(b.x, b.y, r + 6, 0, Math.PI * 2); c.stroke();
      }
      const st = this.input.stuck?.get(n.id);
      if (st) {
        // Stuck: a slow amber ring, solid for failures, dashed for an open handoff.
        c.globalAlpha = 0.65 + (motion ? 0.35 * Math.sin(now / 500) : 0.2);
        c.strokeStyle = STUCK_INK; c.lineWidth = 1.3 * lw;
        if (st.reason === 'handoff') c.setLineDash([2 * lw, 3 * lw]);
        c.beginPath(); c.arc(b.x, b.y, r + 11, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
      }
      if (focus === n.id) {
        c.globalAlpha = 1;
        c.strokeStyle = '#fcee0a'; c.lineWidth = 1 * lw;
        c.setLineDash([3 * lw, 4 * lw]);
        c.lineDashOffset = motion ? -(now / 60) % 1000 : 0;
        c.beginPath(); c.arc(b.x, b.y, r + 7, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
      }
    }

    // Labels in screen space so they stay crisp at any zoom.
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fs = Math.max(10, Math.min(15, 11.5 * Math.sqrt(k)));
    c.font = `500 ${fs}px Rajdhani, sans-serif`;
    if ('letterSpacing' in c) (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.04em';
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.lineJoin = 'round';
    for (const n of this.input.nodes) {
      const b = pos(n.id);
      if (!b) continue;
      const idle = wall - (lastActive.get(n.id) ?? 0);
      if (q === 0 && idle > HOT_MS && focus !== n.id && this.hover !== n.id) continue;
      const sx = b.x * k + vx, sy = (b.y + nodeRadius(n) + 3) * k + vy + 5;
      if (sx < -60 || sx > this.w + 60 || sy < -20 || sy > this.h + 20) continue;
      const rest = restState(idle);
      const dim = neighbor(n.id) ? 1 : 0.3;
      c.globalAlpha = dim * (rest === 'cold' ? 0.55 : rest === 'idle' ? 0.75 : 1);
      c.strokeStyle = 'rgba(3, 4, 11, 0.7)';
      c.lineWidth = 3;
      c.strokeText(n.name, sx, sy);
      c.fillStyle = focus === n.id ? '#fcee0a' : idle < HOT_MS ? '#f2f8ff' : '#b9c8e4';
      c.fillText(n.name, sx, sy);
    }
    // Ping-pong badges: a pill between the two agents of each loop.
    for (const l of this.input.loops ?? []) {
      const a = pos(l.a), b = pos(l.b);
      if (!a || !b) continue;
      const mx = ((a.x + b.x) / 2) * k + vx, my = ((a.y + b.y) / 2) * k + vy;
      const text = `⇄ loop ×${l.count}`;
      c.font = `500 ${Math.max(10, fs - 1)}px Rajdhani, sans-serif`;
      const tw = c.measureText(text).width + 14, th = fs + 6;
      c.globalAlpha = 0.94;
      c.fillStyle = 'rgba(5, 6, 15, 0.72)';
      c.beginPath(); c.roundRect(mx - tw / 2, my - th / 2, tw, th, th / 2); c.fill();
      c.strokeStyle = STUCK_INK; c.lineWidth = 0.8; c.stroke();
      c.fillStyle = STUCK_INK; c.textBaseline = 'middle';
      c.fillText(text, mx, my + 0.5);
    }
    c.globalAlpha = 1;
    if ('letterSpacing' in c) (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    this.canvas.dataset.loops = String(this.input.loops?.length ?? 0);
    this.canvas.dataset.stuck = [...(this.input.stuck?.keys() ?? [])].join(',');
  }

  // ---------------------------------------------------------------- gestures (from the SVG version)

  private local(ev: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  private nodeAt(sx: number, sy: number) {
    const list = this.input.nodes.map((n) => { const b = this.bodies.get(n.id)!; return { id: n.id, x: b?.x ?? -1e9, y: b?.y ?? -1e9, r: nodeRadius(n) }; });
    return hitTest(list, this.view, sx, sy, window.matchMedia('(pointer: coarse)').matches ? 14 : 6);
  }
  private setUser(v: View) {
    this.override = v;
    this.view = v;
  }
  private onMotion = () => { this.reduce = this.mq.matches; };
  private onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const p = this.local(ev);
    const unit = ev.deltaMode === 1 ? 16 : 1;
    this.setUser(zoomAbout(this.override ?? this.view, p.x, p.y, Math.exp(-ev.deltaY * unit * (ev.ctrlKey ? 0.01 : 0.0018)), ZMIN, ZMAX));
  };
  private onDbl = (ev: MouseEvent) => {
    const p = this.local(ev);
    if (this.nodeAt(p.x, p.y)) return;
    this.setUser(zoomAbout(this.override ?? this.view, p.x, p.y, 1.6, ZMIN, ZMAX));
  };
  private onKey = (ev: KeyboardEvent) => {
    const v = this.override ?? this.view;
    const pan = (dx: number, dy: number) => this.setUser({ ...v, x: v.x + dx, y: v.y + dy });
    const dirs: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (dirs[ev.key] && !ev.shiftKey && this.cb.onFocus) {
      // Arrows move the selection between bots (screen positions); Shift+arrows pan.
      const pts = this.input.nodes.flatMap((n) => { const b = this.bodies.get(n.id); return b ? [{ id: n.id, x: b.x, y: b.y }] : []; });
      const id = nextNode(pts, this.input.focus, dirs[ev.key]);
      if (id) this.cb.onFocus(id);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape' && this.input.focus && this.cb.onFocus) { this.cb.onFocus(null); ev.preventDefault(); return; }
    if (ev.key === '+' || ev.key === '=') this.zoomBy(1.25);
    else if (ev.key === '-') this.zoomBy(0.8);
    else if (ev.key === '0' || ev.key === 'f') this.fit();
    else if (ev.key === 'ArrowLeft') pan(40, 0);
    else if (ev.key === 'ArrowRight') pan(-40, 0);
    else if (ev.key === 'ArrowUp') pan(0, 40);
    else if (ev.key === 'ArrowDown') pan(0, -40);
    else return;
    ev.preventDefault();
  };
  private onDown = (ev: PointerEvent) => {
    this.canvas.setPointerCapture(ev.pointerId);
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = { mode: 'pinch', moved: 99, dist: Math.hypot(a.x - b.x, a.y - b.y), last: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      return;
    }
    const p = this.local(ev);
    const id = this.nodeAt(p.x, p.y);
    if (id) {
      const b = this.bodies.get(id);
      if (b) b.fixed = true;
      this.gesture = { mode: 'node', node: id, moved: 0, last: { x: ev.clientX, y: ev.clientY } };
    } else {
      this.gesture = { mode: 'pan', moved: 0, last: { x: ev.clientX, y: ev.clientY } };
      this.canvas.classList.add('panning');
    }
  };
  private onMove = (ev: PointerEvent) => {
    if (!this.pointers.has(ev.pointerId)) {
      const p = this.local(ev);
      const id = this.nodeAt(p.x, p.y);
      if (id !== this.hover) { this.hover = id; this.canvas.style.cursor = id ? 'pointer' : ''; }
      return;
    }
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const g = this.gesture;
    if (g.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const pm = this.local({ clientX: mid.x, clientY: mid.y }), pl = this.local({ clientX: g.last!.x, clientY: g.last!.y });
      const v = this.override ?? this.view;
      this.setUser(zoomAbout({ ...v, x: v.x + (pm.x - pl.x), y: v.y + (pm.y - pl.y) }, pm.x, pm.y, dist / (g.dist || dist), ZMIN, ZMAX));
      g.dist = dist;
      g.last = mid;
      return;
    }
    if (!g.last) return;
    const dx = ev.clientX - g.last.x, dy = ev.clientY - g.last.y;
    g.moved += Math.abs(dx) + Math.abs(dy);
    if (g.mode === 'node' && g.node) {
      const b = this.bodies.get(g.node);
      const p = this.local(ev);
      if (b && g.moved >= 4) { b.x = (p.x - this.view.x) / this.view.k; b.y = (p.y - this.view.y) / this.view.k; }
    } else if (g.mode === 'pan' && g.moved >= 2) {
      const v = this.override ?? this.view;
      this.setUser({ ...v, x: v.x + dx, y: v.y + dy });
    }
    g.last = { x: ev.clientX, y: ev.clientY };
  };
  private onUp = (ev: PointerEvent) => {
    this.pointers.delete(ev.pointerId);
    const g = this.gesture;
    if (g.mode === 'node' && g.node) {
      const b = this.bodies.get(g.node);
      if (b) b.fixed = false;
      // Selecting never moves the camera.
      if (g.moved < 6) this.cb.onSelect(g.node);
    }
    if (this.pointers.size === 0) {
      this.gesture = { mode: null, moved: 0 };
      this.canvas.classList.remove('panning');
    } else if (g.mode === 'pinch') {
      const [p] = [...this.pointers.values()];
      this.gesture = { mode: 'pan', moved: 99, last: p };
    }
  };
  private onLeave = () => {
    if (this.hover) { this.hover = null; this.canvas.style.cursor = ''; }
  };
}
