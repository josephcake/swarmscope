import { KIND_NAMES, NET_EVENT_NAMES, NET_SOURCES, NetEventError, type NetEventName } from './events.js';

export interface ReportArgs {
  from?: unknown;
  to?: unknown;
  kind?: unknown;
  label?: unknown;
  status?: unknown;
  source?: unknown;
  tool?: unknown;
  operation?: unknown;
  conversation?: unknown;
  name?: unknown;
  tickers?: unknown;
  file?: unknown;
  parent_id?: unknown;
  event_id?: unknown;
  test?: unknown;
}

const KEYS = new Set([
  'from',
  'to',
  'kind',
  'label',
  'status',
  'source',
  'tool',
  'operation',
  'conversation',
  'name',
  'tickers',
  'file',
  'parent_id',
  'event_id',
  'test',
]);

/**
 * Flat report (MCP tool, CLI, POST /api/v1/emit) → a raw v1 event.
 * checkNetEvent does the real validation.
 */
export function rawFromReport(args: ReportArgs, nowMs: number, newId: () => string): Record<string, unknown> {
  for (const k of Object.keys(args)) {
    if (!KEYS.has(k)) throw new NetEventError(`Unknown argument "${k}".`);
  }
  const kind = String(args.kind ?? '');
  if (!KIND_NAMES.includes(kind)) throw new NetEventError(`kind must be one of ${KIND_NAMES.join(', ')}.`);
  if (args.label === undefined || args.label === '') throw new NetEventError('label is required.');
  if (args.test !== undefined && typeof args.test !== 'boolean') throw new NetEventError('test must be true or false.');
  const attributes: Record<string, unknown> = {
    'gen_ai.agent.id': args.from,
    'bn.label': args.label,
    'bn.source': args.source ?? 'self-report',
  };
  if (args.to !== undefined) attributes['bn.target.id'] = args.to;
  if (args.name !== undefined) attributes['gen_ai.agent.name'] = args.name;
  if (args.tool !== undefined) attributes['gen_ai.tool.name'] = args.tool;
  if (args.operation !== undefined) attributes['gen_ai.operation.name'] = args.operation;
  if (args.conversation !== undefined) attributes['gen_ai.conversation.id'] = args.conversation;
  if (args.tickers !== undefined) attributes['bn.tickers'] = args.tickers;
  if (args.file !== undefined) attributes['bn.file'] = args.file;
  if (args.test === true) attributes['bn.test'] = true;
  if (args.source !== undefined && !NET_SOURCES.includes(args.source as never)) {
    throw new NetEventError(`source must be one of ${NET_SOURCES.join(', ')}.`);
  }
  const raw: Record<string, unknown> = {
    schema_version: '1',
    event_id: args.event_id ?? newId(),
    name: `agent.${kind}` as NetEventName,
    start_time_unix_nano: (BigInt(nowMs) * 1_000_000n).toString(),
    status: args.status ?? 'ok',
    attributes,
  };
  if (!NET_EVENT_NAMES.includes(raw.name as NetEventName)) throw new NetEventError(`kind must be one of ${KIND_NAMES.join(', ')}.`);
  if (args.parent_id !== undefined) raw.parent_id = args.parent_id;
  return raw;
}
