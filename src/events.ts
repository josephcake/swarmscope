/**
 * Swarmscope event format.
 * Shaped like an OpenTelemetry span: trace and span ids, unix-nanosecond times,
 * a status, and a flat attribute map. GenAI semantic-convention names are used
 * where they exist; Swarmscope fields live under bn.*.
 *
 * Wire schema_version stays "1". Vocabulary revision 1.1 uses agent.action and
 * bn.tags. agent.trade_action and bn.tickers are still accepted and stored
 * under the new names.
 *
 * Any agent id is accepted (a lowercase slug). Nothing here is an allowlist of
 * real deployments, and the server never calls out to check an id.
 */

export const NET_SCHEMA_VERSION = '1';
/** Documented vocabulary revision. Not a wire field. */
export const NET_VOCABULARY = '1.1';

export const NET_EVENT_NAMES = [
  'agent.message',
  'agent.handoff',
  'agent.file_write',
  'agent.action',
  'agent.alert',
  'agent.review',
  'agent.heartbeat',
] as const;
export type NetEventName = (typeof NET_EVENT_NAMES)[number];

export const NET_SOURCES = ['watcher', 'self-report', 'transcript', 'relay'] as const;
export type NetSource = (typeof NET_SOURCES)[number];
export const NET_STATUS = ['UNSET', 'OK', 'ERROR'] as const;
export const NET_TRANSFER_MODES = ['return_to_caller', 'pass_control'] as const;

export const NET_LIMITS = {
  bodyBytes: 64 * 1024,
  batch: 100,
  label: 60,
  tags: 12,
  file: 120,
  idMin: 8,
  idMax: 64,
  pastMs: 24 * 3600_000,
  futureMs: 2 * 60_000,
  /** Local single-user ceilings. High enough for the live viewer and a busy swarm. */
  postsPerMin: 600,
  eventsPerMin: 5000,
  pageMax: 500,
  retentionMs: 7 * 24 * 3600_000,
  slugMax: 32,
} as const;

/** Default gen_ai.operation.name per event name (OTel GenAI well-known values). */
export const DEFAULT_OPERATION: Record<NetEventName, string> = {
  'agent.message': 'invoke_agent',
  'agent.handoff': 'execute_tool',
  'agent.review': 'invoke_agent',
  'agent.file_write': 'execute_tool',
  'agent.action': 'execute_tool',
  'agent.alert': 'invoke_agent',
  'agent.heartbeat': 'invoke_agent',
};

const NEEDS_TARGET: readonly NetEventName[] = ['agent.message', 'agent.handoff', 'agent.review'];

const ATTR_KEYS = new Set([
  'gen_ai.agent.id',
  'gen_ai.agent.name',
  'gen_ai.operation.name',
  'gen_ai.conversation.id',
  'gen_ai.tool.name',
  'gen_ai.transfer.mode',
  'bn.target.id',
  'bn.label',
  'bn.source',
  'bn.tags',
  'bn.tickers',
  'bn.file',
  'bn.test',
]);

const TOP_KEYS = new Set([
  'schema_version',
  'event_id',
  'name',
  'trace_id',
  'span_id',
  'parent_span_id',
  'parent_id',
  'start_time_unix_nano',
  'end_time_unix_nano',
  'status',
  'attributes',
]);

export interface NetEventV1 {
  schema_version: '1';
  event_id: string;
  name: NetEventName;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  parent_id?: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  status: { code: (typeof NET_STATUS)[number]; message?: string };
  attributes: {
    'gen_ai.agent.id'?: string;
    'gen_ai.agent.name'?: string;
    'gen_ai.operation.name': string;
    'gen_ai.conversation.id'?: string;
    'gen_ai.tool.name'?: string;
    'gen_ai.transfer.mode'?: (typeof NET_TRANSFER_MODES)[number];
    'gen_ai.transfer.target.name'?: string;
    'bn.target.id'?: string;
    'bn.label': string;
    'bn.source': NetSource;
    'bn.tags'?: string[];
    'bn.file'?: string;
    'bn.test'?: true;
  };
}

export interface NetStreamEvent extends NetEventV1 {
  seq: number;
  received_unix_ms: number;
}

export class NetEventError extends Error {}

const ID_RE = /^[A-Za-z0-9._:-]+$/;
const SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Legacy bn.tickers values: an uppercase symbol, optionally with one class letter. */
const LEGACY_TICKER_RE = /^[A-Z]{1,6}(\.[A-Z])?$/;
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const TOKENISH = /[A-Za-z0-9_\-+/=]{24,}/;
const URLISH = /(https?:|www\.|\/\/|@)/i;
const LABEL_OK = /^[\p{L}\p{N}\p{P}\p{Zs}$+<=>^`|~]*$/u;

export const KIND_NAMES = NET_EVENT_NAMES.map((n) => n.slice('agent.'.length));

/** Map the deprecated kind name onto the vocabulary 1.1 name. */
export function canonicalKind(kind: string): string {
  return kind === 'trade_action' ? 'action' : kind;
}

function legacyTag(raw: string): string {
  if (SLUG_RE.test(raw)) return raw;
  if (LEGACY_TICKER_RE.test(raw)) return raw.toLowerCase().replaceAll('.', '-');
  return raw;
}

function readTags(value: unknown, field: string, legacy: boolean): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of short slugs.`);
  if (value.length > NET_LIMITS.tags) fail(`${field} must be ${NET_LIMITS.tags} short slugs or fewer.`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') fail(`${field} must be an array of short slugs.`);
    const slug = legacy ? legacyTag(item) : item;
    if (!SLUG_RE.test(slug)) {
      fail(`${field} must be up to ${NET_LIMITS.tags} short slugs: a letter, then letters, digits, "_" or "-".`);
    }
    out.push(slug);
  }
  return out;
}

function fail(msg: string): never {
  throw new NetEventError(msg);
}

/** Labels: 60 characters or fewer, one line, no URLs, emails, or token-like strings. */
export function checkLabel(v: unknown, field = 'bn.label'): string {
  if (typeof v !== 'string') fail(`${field} must be a string.`);
  const s = v.trim();
  if (!s) fail(`${field} must not be empty.`);
  if ([...s].length > NET_LIMITS.label) fail(`${field} must be ${NET_LIMITS.label} characters or fewer.`);
  if (!LABEL_OK.test(s)) fail(`${field} has characters outside letters, digits, punctuation and spaces.`);
  if (URLISH.test(s)) fail(`${field} must not contain a URL or an email address.`);
  if (TOKENISH.test(s)) fail(`${field} looks like it contains a token or key.`);
  return s;
}

/** Lowercase agent id: a letter, then letters, digits, "_" or "-", 1–32 characters. */
export function checkSlug(v: unknown, field: string): string {
  if (typeof v !== 'string') fail(`${field} must be a string.`);
  const s = v.trim().toLowerCase();
  if (!SLUG_RE.test(s)) {
    fail(`${field} must be a lowercase slug: a letter, then up to 31 letters, digits, "_" or "-".`);
  }
  return s;
}

/** Title-case a slug for display when the sender did not pass a name. */
export function displayName(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function nanos(v: unknown, field: string): bigint {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return BigInt(Math.round(v / 1e6)) * 1_000_000n;
  }
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
  return fail(`${field} must be unix nanoseconds, as a decimal string (preferred) or a number.`);
}

/** Stable 16-hex span id from the event id (FNV-1a 64), used when the sender sends none. */
export function spanIdFor(eventId: string): string {
  let h = 0xcbf29ce484222325n;
  for (const c of new TextEncoder().encode(eventId)) {
    h ^= BigInt(c);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** 32-hex trace id: one trace per UTC day, so a day's network groups together. */
export function traceIdFor(nowMs: number, startNs: bigint): string {
  const day = new Date(Number(startNs / 1_000_000n) || nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  return `5c0e${day}`.padEnd(32, '0');
}

/**
 * Validate one v1 event. Throws NetEventError naming the field.
 * `nowMs` bounds the time window: no older than 24 h, no more than 2 min ahead.
 */
export function checkNetEvent(raw: unknown, nowMs: number): NetEventV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each event must be a JSON object.');
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!TOP_KEYS.has(k)) fail(`Unknown field "${k}".`);
  if (e.schema_version !== NET_SCHEMA_VERSION) fail('schema_version must be "1".');
  const id = e.event_id;
  if (typeof id !== 'string' || id.length < NET_LIMITS.idMin || id.length > NET_LIMITS.idMax || !ID_RE.test(id)) {
    fail(`event_id must be ${NET_LIMITS.idMin}-${NET_LIMITS.idMax} characters of A-Z a-z 0-9 . _ : -`);
  }
  const nameInput = e.name === 'agent.trade_action' ? 'agent.action' : e.name;
  if (!NET_EVENT_NAMES.includes(nameInput as NetEventName)) fail(`name must be one of ${NET_EVENT_NAMES.join(', ')}.`);
  const name = nameInput as NetEventName;

  const start = nanos(e.start_time_unix_nano, 'start_time_unix_nano');
  const startMs = Number(start / 1_000_000n);
  if (startMs < nowMs - NET_LIMITS.pastMs) fail('start_time_unix_nano is more than 24 h old.');
  if (startMs > nowMs + NET_LIMITS.futureMs) fail('start_time_unix_nano is more than 2 min in the future.');
  const end = e.end_time_unix_nano === undefined ? start : nanos(e.end_time_unix_nano, 'end_time_unix_nano');
  if (end < start) fail('end_time_unix_nano is before start_time_unix_nano.');

  for (const [k, n] of [
    ['trace_id', 32],
    ['span_id', 16],
    ['parent_span_id', 16],
  ] as const) {
    if (e[k] !== undefined && (typeof e[k] !== 'string' || !HEX(n).test(e[k] as string))) {
      fail(`${k} must be ${n} lowercase hex characters.`);
    }
  }

  let status: NetEventV1['status'] = { code: 'OK' };
  if (e.status === 'ok' || e.status === 'error') {
    status = { code: e.status === 'ok' ? 'OK' : 'ERROR' };
  } else if (e.status !== undefined) {
    const s = e.status as Record<string, unknown>;
    if (!s || typeof s !== 'object' || Array.isArray(s) || !NET_STATUS.includes(s.code as never)) {
      fail('status must be "ok", "error", or {"code": "OK" | "ERROR" | "UNSET"}.');
    }
    for (const k of Object.keys(s)) if (k !== 'code' && k !== 'message') fail(`Unknown field "status.${k}".`);
    status = { code: s.code as NetEventV1['status']['code'] };
    if (s.message !== undefined) status.message = checkLabel(s.message, 'status.message');
  }

  const a = (e.attributes ?? {}) as Record<string, unknown>;
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('attributes must be an object.');
  for (const k of Object.keys(a)) if (!ATTR_KEYS.has(k)) fail(`Unknown attribute "${k}".`);

  const attrs: NetEventV1['attributes'] = {
    'gen_ai.operation.name': DEFAULT_OPERATION[name],
    'bn.label': '',
    'bn.source': 'self-report',
  };
  if (a['gen_ai.agent.id'] !== undefined) attrs['gen_ai.agent.id'] = checkSlug(a['gen_ai.agent.id'], 'gen_ai.agent.id');
  else if (name !== 'agent.heartbeat') fail('attributes["gen_ai.agent.id"] is required.');
  if (a['bn.target.id'] !== undefined) attrs['bn.target.id'] = checkSlug(a['bn.target.id'], 'bn.target.id');
  else if (NEEDS_TARGET.includes(name)) fail(`attributes["bn.target.id"] is required for ${name}.`);
  if (attrs['gen_ai.agent.id'] && attrs['gen_ai.agent.id'] === attrs['bn.target.id']) {
    fail('bn.target.id must differ from gen_ai.agent.id.');
  }
  if (a['gen_ai.agent.name'] !== undefined) {
    attrs['gen_ai.agent.name'] = checkLabel(a['gen_ai.agent.name'], 'gen_ai.agent.name');
  } else if (attrs['gen_ai.agent.id']) {
    attrs['gen_ai.agent.name'] = displayName(attrs['gen_ai.agent.id']);
  }
  if (a['gen_ai.operation.name'] !== undefined) {
    const op = a['gen_ai.operation.name'];
    if (typeof op !== 'string' || !/^[a-z][a-z0-9_.]{1,39}$/.test(op)) {
      fail('gen_ai.operation.name must be a short lowercase identifier.');
    }
    attrs['gen_ai.operation.name'] = op;
  }
  for (const k of ['gen_ai.conversation.id', 'gen_ai.tool.name'] as const) {
    if (a[k] === undefined) continue;
    const v = a[k];
    if (typeof v !== 'string' || v.length < 1 || v.length > 64 || !ID_RE.test(v)) {
      fail(`${k} must be 1-64 characters of A-Z a-z 0-9 . _ : -`);
    }
    attrs[k] = v;
  }
  if (a['gen_ai.transfer.mode'] !== undefined) {
    if (name !== 'agent.handoff') fail('gen_ai.transfer.mode is allowed only on agent.handoff.');
    if (!NET_TRANSFER_MODES.includes(a['gen_ai.transfer.mode'] as never)) {
      fail(`gen_ai.transfer.mode must be ${NET_TRANSFER_MODES.join(' or ')}.`);
    }
    attrs['gen_ai.transfer.mode'] = a['gen_ai.transfer.mode'] as NetEventV1['attributes']['gen_ai.transfer.mode'];
  }
  if (name === 'agent.handoff' && attrs['bn.target.id']) {
    attrs['gen_ai.transfer.target.name'] = displayName(attrs['bn.target.id']);
  }
  attrs['bn.label'] = a['bn.label'] === undefined ? name.slice(6).replaceAll('_', ' ') : checkLabel(a['bn.label']);
  if (a['bn.source'] !== undefined) {
    if (!NET_SOURCES.includes(a['bn.source'] as never)) fail(`bn.source must be one of ${NET_SOURCES.join(', ')}.`);
    attrs['bn.source'] = a['bn.source'] as NetSource;
  }
  const tagValues: string[] = [];
  if (a['bn.tags'] !== undefined) tagValues.push(...readTags(a['bn.tags'], 'bn.tags', false));
  if (a['bn.tickers'] !== undefined) tagValues.push(...readTags(a['bn.tickers'], 'bn.tickers', true));
  const tags = [...new Set(tagValues)];
  if (tags.length > NET_LIMITS.tags) fail(`bn.tags must be ${NET_LIMITS.tags} short slugs or fewer.`);
  if (tags.length) attrs['bn.tags'] = tags;
  if (a['bn.file'] !== undefined) {
    const f = a['bn.file'];
    if (typeof f !== 'string' || !f || f.length > NET_LIMITS.file || f.startsWith('/') || f.includes('..') || !/^[A-Za-z0-9._\-/]+$/.test(f)) {
      fail(`bn.file must be a relative path of ${NET_LIMITS.file} characters or fewer.`);
    }
    attrs['bn.file'] = f;
  }
  if (a['bn.test'] !== undefined) {
    if (typeof a['bn.test'] !== 'boolean') fail('bn.test must be true or false.');
    if (a['bn.test']) attrs['bn.test'] = true;
  }

  const out: NetEventV1 = {
    schema_version: '1',
    event_id: id,
    name,
    trace_id: (e.trace_id as string) ?? traceIdFor(nowMs, start),
    span_id: (e.span_id as string) ?? spanIdFor(id),
    start_time_unix_nano: start.toString(),
    end_time_unix_nano: end.toString(),
    status,
    attributes: attrs,
  };
  if (e.parent_id !== undefined) {
    const p = e.parent_id;
    if (typeof p !== 'string' || p.length < NET_LIMITS.idMin || p.length > NET_LIMITS.idMax || !ID_RE.test(p)) {
      fail('parent_id must look like an event_id.');
    }
    if (p === id) fail('parent_id must differ from event_id.');
    out.parent_id = p;
  }
  if (e.parent_span_id !== undefined) out.parent_span_id = e.parent_span_id as string;
  else if (out.parent_id) out.parent_span_id = spanIdFor(out.parent_id);
  return out;
}

export function isTestEvent(e: { attributes?: Record<string, unknown> }): boolean {
  return e.attributes?.['bn.test'] === true;
}

/** Accept a single event or {"events":[...]}. */
export function batchOf(body: unknown): unknown[] {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'events' in body) {
    const ev = (body as { events: unknown }).events;
    if (!Array.isArray(ev)) fail('"events" must be an array.');
    if (Object.keys(body).length !== 1) fail('A batch body has only the "events" field.');
    if (ev.length === 0) fail('"events" is empty.');
    if (ev.length > NET_LIMITS.batch) fail(`A batch holds at most ${NET_LIMITS.batch} events.`);
    return ev;
  }
  return [body];
}

export function kindOf(name: string): string {
  return canonicalKind(name.startsWith('agent.') ? name.slice('agent.'.length) : name);
}

/**
 * Rewrite a stored event onto vocabulary 1.1.
 * Old rows may still say agent.trade_action or bn.tickers.
 */
export function canonicalizeEvent<T extends { name: string; attributes: Record<string, unknown> }>(event: T): T {
  const name = event.name === 'agent.trade_action' ? 'agent.action' : event.name;
  const legacy = event.attributes['bn.tickers'];
  if (name === event.name && legacy === undefined) return event;
  const attributes: Record<string, unknown> = { ...event.attributes };
  const tags: string[] = [];
  const push = (list: unknown, fromLegacy: boolean) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      tags.push(fromLegacy ? legacyTag(item) : item);
    }
  };
  push(attributes['bn.tags'], false);
  push(legacy, true);
  delete attributes['bn.tickers'];
  if (tags.length) attributes['bn.tags'] = [...new Set(tags)];
  return { ...event, name, attributes };
}

/** Short id for events the server mints (mcp-…, cli-…). */
export function newEventId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex}`;
}
