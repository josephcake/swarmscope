/**
 * OTLP/HTTP JSON → v1 events.
 * A span is an event when it names one (bn.event.name), or a handoff when it
 * carries a transfer target or mode, or a message when it carries bn.target.id.
 * Span events named agentmesh.agent.message become agent.message events.
 * Any attribute outside the v1 set rejects that span.
 */
import { NET_EVENT_NAMES, NET_LIMITS, checkSlug } from './events.js';
const PASS = [
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
];
const MAPPING = ['bn.event.name', 'bn.event.id', 'gen_ai.transfer.target.name'];
const ALLOWED = new Set([...PASS, ...MAPPING]);
const MSG_EVENT = 'agentmesh.agent.message';
const MSG_ALLOWED = new Set(['agentmesh.message.to', 'agentmesh.message.kind', 'bn.event.id', 'bn.label']);
export class OtlpError extends Error {
}
function anyValue(v) {
    if (!v || typeof v !== 'object')
        return undefined;
    const o = v;
    if ('stringValue' in o)
        return o.stringValue;
    if ('boolValue' in o)
        return o.boolValue;
    if ('intValue' in o)
        return typeof o.intValue === 'string' ? Number(o.intValue) : o.intValue;
    if ('doubleValue' in o)
        return o.doubleValue;
    if ('arrayValue' in o) {
        const vals = o.arrayValue?.values;
        return Array.isArray(vals) ? vals.map(anyValue) : [];
    }
    return undefined;
}
function attrs(list, allowed, where) {
    if (list === undefined)
        return {};
    if (!Array.isArray(list))
        throw new OtlpError(`${where} attributes must be a list.`);
    const out = {};
    for (const kv of list) {
        if (!kv || typeof kv.key !== 'string')
            throw new OtlpError(`${where} attribute without a key.`);
        if (!allowed.has(kv.key))
            throw new OtlpError(`Unknown ${where} attribute "${kv.key.slice(0, 60)}".`);
        out[kv.key] = anyValue(kv.value);
    }
    return out;
}
const hexId = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-fA-F]{${n}}$`).test(v) && !/^0+$/.test(v) ? v.toLowerCase() : undefined;
function nanos(v) {
    if (typeof v === 'string' && /^\d{1,20}$/.test(v))
        return v;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
        return String(v);
    return undefined;
}
function status(s) {
    if (!s || typeof s !== 'object')
        return undefined;
    const o = s;
    const c = o.code;
    const code = c === 2 || c === 'STATUS_CODE_ERROR' ? 'ERROR' : c === 1 || c === 'STATUS_CODE_OK' ? 'OK' : 'UNSET';
    return typeof o.message === 'string' && o.message ? { code, message: o.message } : { code };
}
/** A transfer target may be a slug or a display name that slugifies cleanly. */
function slugForTarget(name) {
    if (typeof name !== 'string' || !name.trim())
        return undefined;
    const raw = name.trim().toLowerCase().replace(/\s+/g, '-');
    try {
        return checkSlug(raw, 'gen_ai.transfer.target.name');
    }
    catch {
        return undefined;
    }
}
export function otlpToEvents(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.resourceSpans)) {
        throw new OtlpError('Body must be an OTLP ExportTraceServiceRequest: {"resourceSpans": [...]}.');
    }
    const spans = [];
    for (const rs of body.resourceSpans) {
        for (const ss of (rs?.scopeSpans ?? [])) {
            for (const sp of ss?.spans ?? [])
                spans.push(sp);
        }
    }
    if (!spans.length)
        throw new OtlpError('No spans in the request.');
    if (spans.length > NET_LIMITS.batch)
        throw new OtlpError(`At most ${NET_LIMITS.batch} spans per request.`);
    const items = [];
    const rejected = [];
    spans.forEach((sp, i) => {
        try {
            if (!sp || typeof sp !== 'object')
                throw new OtlpError('A span must be an object.');
            const a = attrs(sp.attributes, ALLOWED, 'span');
            const spanId = hexId(sp.spanId, 16);
            if (!spanId)
                throw new OtlpError('spanId must be 16 hex characters.');
            const base = {
                schema_version: '1',
                trace_id: hexId(sp.traceId, 32),
                start_time_unix_nano: nanos(sp.startTimeUnixNano),
            };
            const pass = {};
            for (const k of PASS)
                if (a[k] !== undefined)
                    pass[k] = a[k];
            let name;
            if (a['bn.event.name'] !== undefined) {
                const n = String(a['bn.event.name']);
                name = n.startsWith('agent.') ? n : `agent.${n}`;
                if (name === 'agent.trade_action')
                    name = 'agent.action';
                if (!NET_EVENT_NAMES.includes(name)) {
                    throw new OtlpError(`bn.event.name "${n.slice(0, 30)}" is not a v1 event name.`);
                }
            }
            else if (a['gen_ai.transfer.target.name'] !== undefined || a['gen_ai.transfer.mode'] !== undefined)
                name = 'agent.handoff';
            else if (a['bn.target.id'] !== undefined)
                name = 'agent.message';
            if (a['gen_ai.transfer.target.name'] !== undefined) {
                const to = slugForTarget(a['gen_ai.transfer.target.name']);
                if (!to)
                    throw new OtlpError('gen_ai.transfer.target.name is not a valid agent slug.');
                if (pass['bn.target.id'] !== undefined && String(pass['bn.target.id']).toLowerCase() !== to) {
                    throw new OtlpError('gen_ai.transfer.target.name and bn.target.id disagree.');
                }
                pass['bn.target.id'] = to;
            }
            const out = [];
            if (name) {
                const ev = {
                    ...base,
                    event_id: typeof a['bn.event.id'] === 'string' ? a['bn.event.id'] : `otlp-${spanId}`,
                    name,
                    span_id: spanId,
                    end_time_unix_nano: nanos(sp.endTimeUnixNano),
                    status: status(sp.status),
                    attributes: pass,
                };
                const parent = hexId(sp.parentSpanId, 16);
                if (parent)
                    ev.parent_span_id = parent;
                out.push(ev);
            }
            const evs = Array.isArray(sp.events) ? sp.events : [];
            evs.forEach((se, j) => {
                if (!se || se.name !== MSG_EVENT)
                    return;
                const m = attrs(se.attributes, MSG_ALLOWED, 'span event');
                const msgAttrs = {};
                for (const k of ['gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.conversation.id', 'bn.source', 'bn.test']) {
                    if (pass[k] !== undefined)
                        msgAttrs[k] = pass[k];
                }
                msgAttrs['bn.target.id'] = m['agentmesh.message.to'];
                if (m['bn.label'] !== undefined)
                    msgAttrs['bn.label'] = m['bn.label'];
                out.push({
                    ...base,
                    event_id: typeof m['bn.event.id'] === 'string' ? m['bn.event.id'] : `otlp-${spanId}-m${j}`,
                    name: 'agent.message',
                    start_time_unix_nano: nanos(se.timeUnixNano) ?? base.start_time_unix_nano,
                    parent_span_id: spanId,
                    attributes: msgAttrs,
                });
            });
            if (!out.length) {
                throw new OtlpError('Span is not a network event: set bn.event.name, a handoff target, bn.target.id, or an agentmesh.agent.message span event.');
            }
            for (const ev of out) {
                for (const k of Object.keys(ev))
                    if (ev[k] === undefined)
                        delete ev[k];
                items.push({ span: i, event: ev });
            }
        }
        catch (e) {
            if (!(e instanceof OtlpError))
                throw e;
            rejected.push({ span: i, reason: e.message });
        }
    });
    if (items.length > NET_LIMITS.batch)
        throw new OtlpError(`At most ${NET_LIMITS.batch} events per request (span events count).`);
    return { items, rejected, spans: spans.length };
}
