/**
 * Local event log. SQLite (node:sqlite) when the runtime has it, otherwise a JSON file.
 * Both backends share one Store so edge aggregation, dedupe, and retention match.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { NetEventError, checkNetEvent, displayName, kindOf, } from './events.js';
import { aggregateEdges, teamFor } from './graph.js';
function silenceExperimental() {
    const orig = process.emit.bind(process);
    process.emit = ((event, ...args) => {
        if (event === 'warning') {
            const w = args[0];
            if (w && typeof w === 'object' && w.name === 'ExperimentalWarning')
                return false;
        }
        return orig(event, ...args);
    });
}
function rowFrom(r) {
    return {
        seq: Number(r.seq),
        event_id: r.event_id,
        received_ms: Number(r.received_ms),
        start_ms: Number(r.start_ms),
        from_id: r.from_id,
        to_id: r.to_id,
        kind: r.kind,
        test: r.test === true || r.test === 1,
        body: r.body,
    };
}
class SqliteEngine {
    backend = 'sqlite';
    db;
    constructor(path) {
        silenceExperimental();
        const require = createRequire(import.meta.url);
        const { DatabaseSync } = require('node:sqlite');
        mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        received_ms INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        from_id TEXT,
        to_id TEXT,
        kind TEXT NOT NULL,
        test INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_received ON events (received_ms);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        team TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        level INTEGER NOT NULL,
        manager TEXT,
        heartbeat_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    }
    close() {
        this.db.close();
    }
    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        }
        catch (e) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                /* already closed */
            }
            throw e;
        }
    }
    head() {
        const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get();
        return Number(r?.s ?? 0);
    }
    insertEvent(row) {
        const inserted = this.db
            .prepare(`INSERT INTO events (event_id, received_ms, start_ms, from_id, to_id, kind, test, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING
         RETURNING seq`)
            .all(row.event_id, row.received_ms, row.start_ms, row.from_id, row.to_id, row.kind, row.test ? 1 : 0, row.body);
        return inserted.length ? Number(inserted[0].seq) : null;
    }
    scan(afterSeq, limit) {
        const rows = this.db
            .prepare(`SELECT seq, event_id, received_ms, start_ms, from_id, to_id, kind, test, body
         FROM events WHERE seq > ? ORDER BY seq LIMIT ?`)
            .all(afterSeq, limit);
        return rows.map((r) => rowFrom(r));
    }
    edgeInputs() {
        const rows = this.db
            .prepare('SELECT from_id, to_id, kind, start_ms, test FROM events')
            .all();
        return rows.map((r) => ({ from: r.from_id, to: r.to_id, kind: r.kind, atMs: Number(r.start_ms), test: r.test === 1 }));
    }
    oldestReceived() {
        const r = this.db.prepare('SELECT MIN(received_ms) AS m FROM events').get();
        return r?.m == null ? null : Number(r.m);
    }
    maxSeen() {
        const rows = this.db
            .prepare('SELECT from_id AS id, MAX(start_ms) AS m FROM events WHERE from_id IS NOT NULL AND test = 0 GROUP BY from_id')
            .all();
        return new Map(rows.map((r) => [r.id, Number(r.m)]));
    }
    deleteOlderThan(ms) {
        this.db.prepare('DELETE FROM events WHERE received_ms < ?').run(ms);
        const r = this.db.prepare('SELECT changes() AS c').get();
        return Number(r.c);
    }
    agents() {
        return this.db.prepare('SELECT * FROM agents ORDER BY id').all().map(normalizeAgent);
    }
    getAgent(id) {
        const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
        return r ? normalizeAgent(r) : null;
    }
    insertAgent(a) {
        this.db
            .prepare('INSERT INTO agents (id, name, team, kind, role, level, manager, heartbeat_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(a.id, a.name, a.team, a.kind, a.role, a.level, a.manager, a.heartbeat_ms);
    }
    updateAgent(id, patch) {
        const cur = this.getAgent(id);
        if (!cur)
            return;
        const next = { ...cur, ...patch, id };
        this.db
            .prepare('UPDATE agents SET name = ?, team = ?, kind = ?, role = ?, level = ?, manager = ?, heartbeat_ms = ? WHERE id = ?')
            .run(next.name, next.team, next.kind, next.role, next.level, next.manager, next.heartbeat_ms, id);
    }
    metaGet(k) {
        const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
        return r ? r.v : null;
    }
    metaSet(k, v) {
        this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
    }
}
class JsonEngine {
    path;
    backend = 'json';
    data;
    mtime = 0;
    constructor(path) {
        this.path = path;
        mkdirSync(dirname(path), { recursive: true });
        this.data = this.read();
    }
    close() {
        this.save();
    }
    read() {
        if (!existsSync(this.path)) {
            this.mtime = 0;
            return { events: [], agents: [], meta: {}, seq: 0 };
        }
        const st = statSync(this.path);
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
        this.mtime = st.mtimeMs;
        parsed.events ??= [];
        parsed.agents ??= [];
        parsed.meta ??= {};
        parsed.seq ??= parsed.events.reduce((m, e) => Math.max(m, e.seq), 0);
        return parsed;
    }
    reload() {
        if (!existsSync(this.path))
            return;
        const st = statSync(this.path);
        if (st.mtimeMs !== this.mtime)
            this.data = this.read();
    }
    save() {
        const tmp = `${this.path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.data));
        renameSync(tmp, this.path);
        this.mtime = statSync(this.path).mtimeMs;
    }
    transaction(fn) {
        this.reload();
        const snap = structuredClone(this.data);
        try {
            const out = fn();
            this.save();
            return out;
        }
        catch (e) {
            this.data = snap;
            throw e;
        }
    }
    head() {
        this.reload();
        return this.data.events.reduce((m, e) => Math.max(m, e.seq), 0);
    }
    insertEvent(row) {
        if (this.data.events.some((e) => e.event_id === row.event_id))
            return null;
        this.data.seq += 1;
        this.data.events.push({ ...row, seq: this.data.seq });
        return this.data.seq;
    }
    scan(afterSeq, limit) {
        this.reload();
        return this.data.events
            .filter((e) => e.seq > afterSeq)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, limit);
    }
    edgeInputs() {
        this.reload();
        return this.data.events.map((e) => ({ from: e.from_id, to: e.to_id, kind: e.kind, atMs: e.start_ms, test: e.test }));
    }
    oldestReceived() {
        this.reload();
        if (!this.data.events.length)
            return null;
        return this.data.events.reduce((m, e) => Math.min(m, e.received_ms), Infinity);
    }
    maxSeen() {
        this.reload();
        const m = new Map();
        for (const e of this.data.events) {
            if (e.test || !e.from_id)
                continue;
            m.set(e.from_id, Math.max(m.get(e.from_id) ?? 0, e.start_ms));
        }
        return m;
    }
    deleteOlderThan(ms) {
        const before = this.data.events.length;
        this.data.events = this.data.events.filter((e) => e.received_ms >= ms);
        return before - this.data.events.length;
    }
    agents() {
        this.reload();
        return this.data.agents.map(normalizeAgent).sort((a, b) => a.id.localeCompare(b.id));
    }
    getAgent(id) {
        return this.data.agents.find((a) => a.id === id) ?? null;
    }
    insertAgent(a) {
        this.data.agents.push(a);
    }
    updateAgent(id, patch) {
        const i = this.data.agents.findIndex((a) => a.id === id);
        if (i < 0)
            return;
        this.data.agents[i] = { ...this.data.agents[i], ...patch, id };
    }
    metaGet(k) {
        this.reload();
        return this.data.meta[k] ?? null;
    }
    metaSet(k, v) {
        this.data.meta[k] = v;
    }
}
function normalizeAgent(a) {
    return {
        id: a.id,
        name: a.name,
        team: a.team,
        kind: a.kind === 'room' ? 'room' : 'agent',
        role: a.role,
        level: Number(a.level) || 1,
        manager: a.manager ?? null,
        heartbeat_ms: a.heartbeat_ms == null ? null : Number(a.heartbeat_ms),
    };
}
function startMsOf(e) {
    return Number(BigInt(e.start_time_unix_nano) / 1000000n);
}
export class Store {
    engine;
    retention;
    constructor(engine, retention) {
        this.engine = engine;
        this.retention = retention;
    }
    get backend() {
        return this.engine.backend;
    }
    get retentionMs() {
        return this.retention;
    }
    close() {
        this.engine.close();
    }
    head() {
        return this.engine.head();
    }
    /** Validate and store a batch. One bad event does not drop the rest. */
    ingestRaw(rawList, now = Date.now()) {
        const valid = [];
        const rejected = [];
        rawList.forEach((r, index) => {
            try {
                valid.push(checkNetEvent(r, now));
            }
            catch (e) {
                if (!(e instanceof NetEventError))
                    throw e;
                const id = r && typeof r === 'object' ? r.event_id : undefined;
                rejected.push({ id: typeof id === 'string' && id.length <= 64 ? id : null, index, reason: e.message });
            }
        });
        const stored = this.ingestValid(valid, now);
        return { ...stored, rejected };
    }
    ingestValid(events, now = Date.now()) {
        return this.engine.transaction(() => {
            const accepted = [];
            const duplicates = [];
            for (const e of events) {
                const startMs = startMsOf(e);
                const from = e.attributes['gen_ai.agent.id'];
                const to = e.attributes['bn.target.id'];
                if (from)
                    this.noteAgent(from, e.attributes['gen_ai.agent.name']);
                if (to)
                    this.noteAgent(to, undefined);
                if (from)
                    e.attributes['gen_ai.agent.name'] = this.engine.getAgent(from)?.name ?? e.attributes['gen_ai.agent.name'];
                if (e.name === 'agent.handoff' && to) {
                    e.attributes['gen_ai.transfer.target.name'] = this.engine.getAgent(to)?.name ?? displayName(to);
                }
                if (e.name === 'agent.heartbeat') {
                    const prev = this.heartbeat();
                    if (!prev || startMs >= prev.event_unix_ms) {
                        this.engine.metaSet('heartbeat', JSON.stringify({ received_unix_ms: now, event_unix_ms: startMs }));
                    }
                    if (from)
                        this.engine.updateAgent(from, { heartbeat_ms: Math.max(startMs, this.engine.getAgent(from)?.heartbeat_ms ?? 0) });
                    accepted.push(e.event_id);
                    continue;
                }
                const seq = this.engine.insertEvent({
                    event_id: e.event_id,
                    received_ms: now,
                    start_ms: startMs,
                    from_id: from ?? null,
                    to_id: to ?? null,
                    kind: kindOf(e.name),
                    test: e.attributes['bn.test'] === true,
                    body: JSON.stringify(e),
                });
                if (seq == null)
                    duplicates.push(e.event_id);
                else
                    accepted.push(e.event_id);
            }
            const last = Number(this.engine.metaGet('prune_at') ?? 0);
            if (now - last > 3600_000) {
                this.pruneNow(now);
                this.engine.metaSet('prune_at', String(now));
            }
            return { accepted, duplicates, rejected: [], head_seq: this.engine.head() };
        });
    }
    /** Drop events received before the retention horizon. Returns how many rows went. */
    prune(now = Date.now()) {
        return this.engine.transaction(() => this.pruneNow(now));
    }
    pruneNow(now) {
        const deleted = this.engine.deleteOlderThan(now - this.retention);
        this.engine.metaSet('prune', JSON.stringify({ at: now, deleted }));
        return deleted;
    }
    noteAgent(id, proposed) {
        const derived = displayName(id);
        const existing = this.engine.getAgent(id);
        if (!existing) {
            this.engine.insertAgent({
                id,
                name: proposed && proposed !== derived ? proposed : derived,
                team: teamFor(id),
                kind: 'agent',
                role: 'agent',
                level: 2,
                manager: null,
                heartbeat_ms: null,
            });
            return;
        }
        if (proposed && proposed !== derived && proposed !== existing.name)
            this.engine.updateAgent(id, { name: proposed });
    }
    upsertAgents(rows) {
        this.engine.transaction(() => {
            for (const row of rows) {
                const existing = this.engine.getAgent(row.id);
                if (!existing) {
                    this.engine.insertAgent({
                        id: row.id,
                        name: row.name,
                        team: row.team,
                        kind: row.kind,
                        role: row.role,
                        level: row.level,
                        manager: row.manager ?? null,
                        heartbeat_ms: null,
                    });
                }
                else {
                    this.engine.updateAgent(row.id, {
                        name: row.name,
                        team: row.team,
                        kind: row.kind,
                        role: row.role,
                        level: row.level,
                        manager: row.manager ?? null,
                    });
                }
            }
        });
    }
    setMeta(k, v) {
        this.engine.transaction(() => this.engine.metaSet(k, v));
    }
    heartbeat() {
        const raw = this.engine.metaGet('heartbeat');
        if (!raw)
            return null;
        const v = JSON.parse(raw);
        return { received_unix_ms: v.received_unix_ms, event_unix_ms: v.event_unix_ms };
    }
    since(seq, limit, opts = {}) {
        const out = [];
        let cursor = seq;
        let guard = 0;
        while (out.length < limit && guard < 20_000) {
            const rows = this.engine.scan(cursor, 200);
            if (!rows.length) {
                cursor = Math.max(cursor, this.engine.head());
                break;
            }
            let hit = false;
            for (const row of rows) {
                guard += 1;
                cursor = row.seq;
                if (opts.skipTest && row.test)
                    continue;
                if (opts.kind && row.kind !== opts.kind)
                    continue;
                if (opts.from && row.from_id !== opts.from)
                    continue;
                if (opts.to && row.to_id !== opts.to)
                    continue;
                const body = JSON.parse(row.body);
                out.push({ ...body, seq: row.seq, received_unix_ms: row.received_ms });
                hit = true;
                if (out.length >= limit)
                    break;
            }
            if (out.length >= limit)
                break;
            if (rows.length < 200) {
                cursor = Math.max(cursor, this.engine.head());
                break;
            }
            if (!hit && guard > 20_000)
                break;
        }
        return {
            events: out,
            next_since: cursor,
            head_seq: this.engine.head(),
            heartbeat: this.heartbeat(),
            server_unix_ms: Date.now(),
        };
    }
    network() {
        const seen = this.engine.maxSeen();
        const nodes = this.engine.agents().map((a) => {
            const fromEvents = seen.get(a.id) ?? null;
            const beat = a.heartbeat_ms;
            const last = fromEvents == null ? beat : beat == null ? fromEvents : Math.max(fromEvents, beat);
            return {
                id: a.id,
                name: a.name,
                team: a.team,
                kind: a.kind,
                role: a.role,
                level: a.level,
                manager: a.manager,
                last_seen_unix_ms: last,
            };
        });
        const prune = this.engine.metaGet('prune');
        const parsed = prune ? JSON.parse(prune) : null;
        return {
            schema_version: '1',
            demo: this.engine.metaGet('demo') === '1',
            nodes,
            edges: aggregateEdges(this.engine.edgeInputs()),
            head_seq: this.engine.head(),
            heartbeat: this.heartbeat(),
            retention: {
                days: this.retention / 86_400_000,
                oldest_received_unix_ms: this.engine.oldestReceived(),
                last_prune_unix_ms: parsed?.at ?? null,
                last_prune_deleted: parsed?.deleted ?? null,
            },
            server_unix_ms: Date.now(),
        };
    }
}
export function openStore(path, opts) {
    const retention = opts?.retentionMs ?? 7 * 24 * 3600_000;
    if (path.endsWith('.json'))
        return new Store(new JsonEngine(path), retention);
    try {
        return new Store(new SqliteEngine(path), retention);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/node:sqlite|Cannot find|ERR_UNKNOWN_BUILTIN_MODULE|Unknown built-in/i.test(msg)) {
            const jsonPath = path.replace(/\.db$/i, '') + '.json';
            return new Store(new JsonEngine(jsonPath), retention);
        }
        throw e;
    }
}
