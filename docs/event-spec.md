# Swarmscope event format, v1

One event is one JSON object, shaped like an OpenTelemetry span. Attribute names follow the
OpenTelemetry GenAI semantic conventions where a name exists. Swarmscope's own fields use the
`bn.*` prefix.

The server is local. It listens on `127.0.0.1` only, keeps the log in your home directory, and
does not check agent ids against any remote list. An agent id is any lowercase slug you choose.

## Event

| Field | Required | Rules |
|---|---|---|
| `schema_version` | yes | Exactly `"1"`. |
| `event_id` | yes | 8–64 characters of `A-Z a-z 0-9 . _ : -`. The dedupe key. |
| `name` | yes | One of the kinds below. |
| `start_time_unix_nano` | yes | Unix time in nanoseconds, as a decimal string. Within the last 24 h and at most 2 min ahead. |
| `end_time_unix_nano` | no | At least `start`. Defaults to `start`. |
| `trace_id` | no | 32 lowercase hex. Default: one trace per UTC day. |
| `span_id` | no | 16 lowercase hex. Default: a hash of `event_id`. |
| `parent_span_id` | no | 16 lowercase hex. Default: derived from `parent_id` when that is set. |
| `parent_id` | no | `event_id` of the causing event. Must differ from `event_id`. |
| `status` | no | `"ok"`, `"error"`, or `{"code":"OK"\|"ERROR"\|"UNSET","message"?}`. Default `{"code":"OK"}`. |
| `attributes` | yes | Only the keys below. Unknown keys are rejected. |

## Kinds

| `name` | Meaning | Needs `bn.target.id` | Default `gen_ai.operation.name` |
|---|---|---|---|
| `agent.message` | A message or note from one agent to another | yes | `invoke_agent` |
| `agent.handoff` | Work handed to another agent | yes | `execute_tool` |
| `agent.review` | A verdict on another agent's work | yes | `invoke_agent` |
| `agent.file_write` | An agent wrote a file | no | `execute_tool` |
| `agent.trade_action` | A recorded action with a status | no | `execute_tool` |
| `agent.alert` | Something needs attention | no | `invoke_agent` |
| `agent.heartbeat` | The sender is alive. Not stored as an event. | no | `invoke_agent` |

A tool call is any of these with `gen_ai.tool.name` set. `report_event` accepts that as `tool`.

## Attributes

| Key | Required | Rules |
|---|---|---|
| `gen_ai.agent.id` | yes, except heartbeat | Sender slug: a letter, then up to 31 letters, digits, `_` or `-`. |
| `gen_ai.agent.name` | no | Display name. If omitted, a title-cased slug is stored. |
| `bn.target.id` | for message, handoff, review | Receiver slug. Must differ from the sender. |
| `gen_ai.operation.name` | no | Lowercase identifier, 2–40 characters. |
| `gen_ai.conversation.id` | no | Thread id, 1–64 id characters. |
| `gen_ai.tool.name` | no | Tool name, 1–64 id characters. |
| `gen_ai.transfer.mode` | no, handoff only | `return_to_caller` or `pass_control`. |
| `gen_ai.transfer.target.name` | server | On handoffs, the receiver's display name. |
| `bn.label` | no | Short neutral label, 60 characters or fewer. See below. |
| `bn.source` | no | `watcher`, `self-report`, `transcript`, or `relay`. |
| `bn.tickers` | no | Up to 12 uppercase symbols. |
| `bn.file` | no | Relative path, 120 characters or fewer, no `..`. |
| `bn.test` | no | `true` keeps the event in the log but out of network totals. |

### Label rules

60 characters or fewer. Letters, digits, punctuation, and spaces. No URLs, no `//`, no `@`,
and no token-like run of 24+ characters. Describe the kind of thing that happened. Do not put
message text, secrets, or personal data in a label.

## Edges

`get_network` and `GET /api/v1/network` return edges computed from stored events:

```json
{ "from": "planner", "to": "coder", "kind": "handoff", "count": 4, "first_ts": "2026-06-15T17:40:00.000Z", "last_ts": "2026-06-15T17:58:00.000Z" }
```

An edge is keyed by (`from`, `to`, `kind`). `kind` is the event name without the `agent.` prefix.
`first_ts` and `last_ts` are ISO 8601 UTC. Test events and events with no receiver are not edges.
The viewer draws a thinner picture on top of this: handoffs as dotted curves, everything else as a solid curve, folded by the pair.

## HTTP

Default base: `http://127.0.0.1:4319`

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/v1/emit` | Flat object: `from`, `kind`, `label`, optional `to`, `status`, `tool`, `file`, `parent_id`, `event_id`, `test` |
| `POST` | `/api/v1/network/events` | One event, or `{"events":[...]}` (1–100). Response is `207` with `accepted`, `duplicates`, `rejected`. |
| `GET` | `/api/v1/network/events?since=&limit=` | Events with `seq` greater than `since`, oldest first. `limit` is 1–500, default 200. |
| `GET` | `/api/v1/network` | Nodes, edges, retention, head sequence. |
| `GET` | `/api/v1/network/stream` | WebSocket. Server sends `hello`, then `events`. Client sends `ping`, server answers `pong`. |
| `POST` | `/v1/traces` | OTLP/HTTP JSON. Protobuf is not accepted. |
| `POST` | `/mcp` | Stateless MCP Streamable HTTP. |

There is no account and no token. The socket is bound to loopback.

Body limit is 64 KiB. The same `event_id` is stored once. Events are kept 7 days by default
(`SWARMSCOPE_RETENTION_DAYS`). Ordering is the server `seq`, which is arrival order.

## MCP

Tools: `report_event`, `get_network`, `list_events`.

`report_event` arguments: `from`, `kind`, `label` required; `to`, `status`, `source`, `tool`,
`operation`, `conversation`, `name`, `tickers`, `file`, `parent_id`, `event_id`, `test` optional.

`list_events` arguments: `since` (default 0), `limit` (default 50, max 200), `include_test`,
`kind`, `from`, `to`. Pass `since` back as `next_since` to page.

`get_network` returns agents plus edges `{from, to, kind, count, first_ts, last_ts}`.
