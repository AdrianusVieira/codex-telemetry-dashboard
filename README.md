# Codex telemetry dashboard

A local dashboard for exploring Codex conversations, token usage, prompts, API performance, and tool activity from OpenTelemetry logs. It is modeled on the [Claude Code telemetry dashboard](https://github.com/AdrianusVieira/claude-code-telemetry-dashboard), but only displays values observed in Codex events. It does not calculate cost, infer active time, or assign responses to prompts by proximity.

## Start

Requires Node.js 20.19+.

```sh
npm ci
npm start
```

Open [http://127.0.0.1:18765](http://127.0.0.1:18765). The OTLP HTTP/JSON log receiver listens on `http://127.0.0.1:18766/v1/logs`. Both listeners bind only to loopback. Data is stored in the Git-ignored `data/telemetry.sqlite3` file. To use other ports or a database path after building, run `npm run server -- --dashboard-port 18865 --otlp-port 18866 --db data/other.sqlite3`.

For UI development, run `npm run dev` and open `http://127.0.0.1:18767`. Vite proxies `/api` to the local dashboard on port 18765.

## Connect Codex

Add the following to your **user-level** `~/.codex/config.toml`, preserving any settings already there:

```toml
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:18766/v1/logs", protocol = "json" } }
log_user_prompt = true
```

Restart Codex, then send a prompt in a new or existing conversation. Codex batches events asynchronously, so they may not appear immediately. The dashboard refreshes every 10 seconds. It records events emitted while the receiver is running; it does not backfill earlier activity. `log_user_prompt = true` is optional, but required for prompt text. With it enabled, Codex sends raw prompt text to the local receiver; this receiver sanitizes it before storage. Disable prompt text by setting the value to `false` or removing the line.

Codex ignores `otel` in a project's `.codex/config.toml`. Configure it in `~/.codex/config.toml` instead. This receiver accepts OTLP **HTTP/JSON logs** only. It does not ingest OTLP protobuf, gRPC, metrics, or traces. Keep the dashboard running while using Codex; it does not backfill earlier conversations. The ports differ from the Claude dashboard so both can run at once.

The documented Codex configuration and event types are described in [OpenAI's observability documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml).

## What the dashboard shows

| View | Source |
| --- | --- |
| Conversations | Distinct conversation IDs in received log events. |
| Prompts | `codex.user_prompt` events; text is present only after prompt export is enabled. |
| Observed tokens | Token counts in `response.completed` stream events when present. Input plus output is used only when both counts are present and the event does not report a total. |
| Cached input, cache write, and reasoning output | Counts when present on completed response events. Cached input and reasoning output are subsets of input and output respectively. Cache write is shown separately and not added to observed total. |
| Request count, errors, and median duration | `codex.api_request` events with their observed status, success, and duration. |
| Tool and approval activity | `codex.tool_result` and `codex.tool_decision` events. |

The overview shows counts and a cumulative token timeline. A conversation page shows its observed model names, timestamps, token breakdown, response usage, request durations, tool activity, prompts, and recent events. Date filters use event timestamps. The dashboard can delete locally stored events for a conversation and ignore later events carrying the same ID; it does not delete the Codex conversation itself.

An **Unavailable** label means the needed field was not observed. “Observed tokens” can be partial when some completed responses have no token counts; the UI shows how many completions supplied counts. The dashboard does not display dollar cost, project names, custom chat titles, active time, or tokens by prompt because the documented Codex OTEL logs do not supply the necessary fields or joins. It also does not store or display account emails. Token charts are by completed response, not by API request or prompt. The installed Codex CLI includes optional `cached_token_count`, `cache_write_token_count`, and `reasoning_token_count` telemetry attribute names; the dashboard displays them only when the actual log record contains them.

## Privacy and limits

The receiver never saves raw OTLP payloads. It stores only event timestamps, conversation ID, model, event kind, tool name, status, success, duration, token counts, and sanitized prompt text. It does not store tool output snippets, request or response bodies, error details, or unknown attributes. The sanitizer masks common credentials, emails, personal identifiers, and long opaque strings, but automated detection cannot guarantee perfect redaction. Keep the database private if prompt export is enabled.

This version is verified with synthetic records and a live Codex OTLP HTTP/JSON stream. The live stream uses `timeUnixNano = 0` and supplies the event time in `event.timestamp`; the parser also accepts `observedTimeUnixNano` when needed. Codex's documented event list is representative rather than a complete schema, so field-level coverage may vary with Codex versions and transports. Unknown events and records without conversation ID or any usable timestamp are ignored. If a documented field appears under a new attribute name, update the allowlist in `server/otlp.ts`.

## Verify

```sh
npm test
npm run build
```
