import { createHash } from 'node:crypto'

type Obj = Record<string, unknown>
export type CodexEvent = {
  id: string
  timestampMs: number
  conversationId: string
  name: string
  model: string | null
  kind: string | null
  tool: string | null
  status: string | null
  success: boolean | null
  durationMs: number | null
  promptText: string | null
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
}

const EVENT_NAMES = new Set([
  'conversation_starts', 'api_request', 'sse_event', 'websocket_request',
  'websocket_event', 'user_prompt', 'tool_decision', 'tool_result',
])

function object(value: unknown): Obj { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function scalar(value: unknown): unknown {
  const item = object(value)
  if ('stringValue' in item) return item.stringValue
  if ('intValue' in item) return item.intValue
  if ('doubleValue' in item) return item.doubleValue
  if ('boolValue' in item) return item.boolValue
  return value
}
function attributes(value: unknown): Obj {
  const result: Obj = {}
  for (const entry of array(value)) {
    const item = object(entry)
    if (typeof item.key === 'string') result[item.key] = scalar(item.value)
  }
  return result
}
function first(attrs: Obj, ...keys: string[]): unknown {
  for (const key of keys) if (attrs[key] !== undefined && attrs[key] !== null) return attrs[key]
  return null
}
function label(value: unknown, max = 200): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const result = String(value).trim()
  return result ? result.slice(0, max) : null
}
function count(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}
function duration(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
function success(value: unknown): boolean | null {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return null
}
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  try {
    const ms = Number(BigInt(value) / 1_000_000n)
    return Number.isSafeInteger(ms) && ms > 0 ? ms : null
  } catch { return null }
}
function eventName(attrs: Obj, record: Obj): string | null {
  const raw = label(first(attrs, 'event.name', 'event_name', 'name')) || label(scalar(record.body))
  if (!raw) return null
  const name = raw.replace(/^codex\./, '')
  return EVENT_NAMES.has(name) ? name : null
}

/** Extracts an allowlist of fields; raw OTLP bodies and unknown attributes are never returned. */
export function parseLogs(payload: unknown): CodexEvent[] {
  const events: CodexEvent[] = []
  for (const resourceLog of array(object(payload).resourceLogs)) {
    const resource = object(resourceLog)
    const resourceAttrs = attributes(object(resource.resource).attributes)
    for (const scopeLog of array(resource.scopeLogs)) {
      const scope = object(scopeLog)
      const scopeAttrs = attributes(object(scope.scope).attributes)
      for (const logRecord of array(scope.logRecords)) {
        const record = object(logRecord)
        const attrs = { ...resourceAttrs, ...scopeAttrs, ...attributes(record.attributes) }
        const conversationId = label(first(attrs,
          'conversation.id', 'conversation_id', 'codex.conversation.id',
          'thread.id', 'thread_id', 'session.id'), 160)
        const name = eventName(attrs, record)
        const timestampMs = timestamp(record.timeUnixNano)
        if (!conversationId || !name || timestampMs === null) continue

        const kind = label(first(attrs, 'event.kind', 'event_kind', 'kind', 'event.type', 'type', 'event'))
        const isCompletion = (name === 'sse_event' || name === 'websocket_event') && kind === 'response.completed'
        const inputTokens = isCompletion ? count(first(attrs, 'input_token_count', 'input_tokens')) : null
        const outputTokens = isCompletion ? count(first(attrs, 'output_token_count', 'output_tokens')) : null
        const cachedInputTokens = isCompletion ? count(first(attrs, 'cached_token_count', 'cached_input_token_count', 'cached_input_tokens')) : null
        const cacheWriteTokens = isCompletion ? count(first(attrs, 'cache_write_token_count', 'cache_write_tokens')) : null
        const reasoningOutputTokens = isCompletion ? count(first(attrs, 'reasoning_token_count', 'reasoning_output_token_count', 'reasoning_output_tokens')) : null
        const reportedTotal = isCompletion ? count(first(attrs, 'total_token_count', 'total_tokens')) : null
        const totalTokens = reportedTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
        const promptText = name === 'user_prompt'
          ? label(first(attrs, 'prompt', 'prompt.text', 'user.prompt', 'user_prompt', 'content'), 16_001)
          : null
        // The hash deduplicates an identical exporter retry without persisting its payload.
        const id = createHash('sha256').update(JSON.stringify({ resource: resource.resource, record })).digest('hex')
        events.push({
          id, timestampMs, conversationId, name,
          model: label(first(attrs, 'model', 'model.name'), 100), kind,
          tool: label(first(attrs, 'tool', 'tool.name', 'tool_name'), 100),
          status: label(first(attrs, 'status', 'status_code', 'http.status_code'), 100),
          success: success(first(attrs, 'success', 'ok')),
          durationMs: duration(first(attrs, 'duration_ms', 'duration.ms')),
          promptText, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens,
          reasoningOutputTokens, totalTokens,
        })
      }
    }
  }
  return events
}
