/**
 * Loopback checks for the local HTTP server.
 *
 * SDK 1.32.2 exports localhostHostValidation (Express middleware). It allows
 * localhost, 127.0.0.1, and [::1], and it does not look at the port. This
 * version has no Origin helper. The deprecated transport flags compare the
 * raw header string, so the middleware is the check we use.
 * A present Origin is judged with that same hostname allowlist.
 */
import { timingSafeEqual } from 'node:crypto';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
const allowHostname = localhostHostValidation();
function sdkAllowsHost(hostHeader) {
    let ok = false;
    const res = {
        status() {
            return this;
        },
        json() {
            ok = false;
        },
    };
    allowHostname({ headers: { host: hostHeader } }, res, () => {
        ok = true;
    });
    return ok;
}
/** Host must be a loopback name on the server's port. Missing Host is refused. */
export function loopbackHost(hostHeader, port) {
    if (!hostHeader || !sdkAllowsHost(hostHeader))
        return false;
    let parsed;
    try {
        parsed = new URL(`http://${hostHeader}`);
    }
    catch {
        return false;
    }
    const headerPort = parsed.port === '' ? 80 : Number(parsed.port);
    return headerPort === port;
}
/**
 * A missing Origin is allowed (stdio clients and curl omit it).
 * A present Origin must be http(s) on a loopback hostname. The port is not
 * compared: the Host check already pins the destination port.
 */
export function loopbackOrigin(origin) {
    if (origin === undefined || origin === '')
        return true;
    let url;
    try {
        url = new URL(origin);
    }
    catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return false;
    return sdkAllowsHost(url.host);
}
export function isJsonContentType(header) {
    if (!header)
        return false;
    const media = header.split(',')[0]?.split(';')[0]?.trim().toLowerCase();
    return media === 'application/json';
}
/** True when the header is `Bearer <token>` and the token matches. */
export function bearerOk(header, token) {
    if (typeof header !== 'string' || !token)
        return false;
    const match = /^Bearer\s+([!-~]+)\s*$/i.exec(header);
    if (!match)
        return false;
    const got = Buffer.from(match[1]);
    const want = Buffer.from(token);
    if (got.length !== want.length)
        return false;
    return timingSafeEqual(got, want);
}
/** JSON-RPC body that calls the report_event tool, including a batch. */
export function mcpWritesEvent(body) {
    const list = Array.isArray(body) ? body : [body];
    return list.some((msg) => {
        if (!msg || typeof msg !== 'object')
            return false;
        const method = msg.method;
        const params = msg.params;
        if (method !== 'tools/call' || !params || typeof params !== 'object')
            return false;
        return params.name === 'report_event';
    });
}
