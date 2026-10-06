import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseLogs, type CodexEvent } from './otlp.js'
import { sanitizePrompt } from './sanitize.js'

export type TimeWindow = number | { start: number; end: number } | null
type Row = {
  id: string; timestamp_ms: number; conversation_id: string; name: string
  model: string | null; kind: string | null; tool: string | null; status: string | null
  success: number | null; duration_ms: number | null; prompt_text: string | null
  input_tokens: number | null; output_tokens: number | null; cached_input_tokens: number | null
  cache_write_tokens: number | null
  reasoning_output_tokens: number | null; total_tokens: number | null
}

function bounds(window: TimeWindow): [number, number] {
  if (window === null) return [0, Number.MAX_SAFE_INTEGER]
  if (typeof window === 'number') return [Date.now() - window * 86_400_000, Number.MAX_SAFE_INTEGER]
  return [window.start, window.end]
}
function median(values: number[]): number | null {
  if (!values.length) return null
  values.sort((a, b) => a - b)
  const half = Math.floor(values.length / 2)
  return values.length % 2 ? values[half] : (values[half - 1] + values[half]) / 2
}
function isError(row: Row): boolean {
  return row.name === 'api_request' && (row.success === 0 || (row.status !== null && /^\d+$/.test(row.status) && Number(row.status) >= 400))
}
function activity(row: Row) {
  return { id: row.id, timestamp: row.timestamp_ms, name: row.name, kind: row.kind,
    tool: row.tool, status: row.status, success: row.success === null ? null : row.success === 1,
    durationMs: row.duration_ms }
}

export class Store {
  private db: Database.Database
  private deleted = new Set<string>()

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL, conversation_id TEXT NOT NULL,
        name TEXT NOT NULL, model TEXT, kind TEXT, tool TEXT, status TEXT, success INTEGER,
        duration_ms REAL, prompt_text TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cached_input_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_output_tokens INTEGER, total_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS events_conversation_time ON events(conversation_id, timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_time ON events(timestamp_ms);
      CREATE TABLE IF NOT EXISTS deleted_conversations (id TEXT PRIMARY KEY, deleted_ms INTEGER NOT NULL);
    `)
    const columns = this.db.pragma('table_info(events)') as { name: string }[]
    if (!columns.some((column) => column.name === 'cache_write_tokens')) {
      this.db.exec('ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER')
    }
    for (const row of this.db.prepare('SELECT id FROM deleted_conversations').all() as { id: string }[]) this.deleted.add(row.id)
  }

  close(): void { this.db.close() }

  ingestLogs(payload: unknown): number {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO events
      (id, timestamp_ms, conversation_id, name, model, kind, tool, status, success,
       duration_ms, prompt_text, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
       reasoning_output_tokens, total_tokens)
      VALUES (@id, @timestamp_ms, @conversation_id, @name, @model, @kind, @tool, @status,
       @success, @duration_ms, @prompt_text, @input_tokens, @output_tokens,
       @cached_input_tokens, @cache_write_tokens, @reasoning_output_tokens, @total_tokens)`)
    const events = parseLogs(payload)
    return this.db.transaction(() => {
      let added = 0
      for (const event of events) {
        if (this.deleted.has(event.conversationId)) continue
        added += insert.run(this.row(event)).changes
      }
      return added
    })()
  }

  private row(event: CodexEvent) {
    return {
      id: event.id, timestamp_ms: event.timestampMs, conversation_id: event.conversationId,
      name: event.name, model: event.model, kind: event.kind, tool: event.tool,
      status: event.status, success: event.success === null ? null : Number(event.success),
      duration_ms: event.durationMs, prompt_text: sanitizePrompt(event.promptText),
      input_tokens: event.inputTokens, output_tokens: event.outputTokens,
      cached_input_tokens: event.cachedInputTokens,
      cache_write_tokens: event.cacheWriteTokens,
      reasoning_output_tokens: event.reasoningOutputTokens, total_tokens: event.totalTokens,
    }
  }

  deleteConversation(id: string): boolean {
    const exists = this.db.prepare('SELECT 1 FROM events WHERE conversation_id = ? LIMIT 1').get(id)
    if (!exists) return false
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO deleted_conversations(id, deleted_ms) VALUES (?, ?)').run(id, Date.now())
      this.db.prepare('DELETE FROM events WHERE conversation_id = ?').run(id)
    })()
    this.deleted.add(id)
    return true
  }

  sessions(window: TimeWindow = 30) {
    const [start, end] = bounds(window)
    const rows = this.db.prepare('SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY timestamp_ms, rowid')
      .all(start, end) as Row[]
    const sessions = new Map<string, {
      id: string; firstSeen: number; lastSeen: number; models: string[]; prompts: number
      apiRequests: number; errors: number; toolCalls: number; approvals: number
      completedResponses: number; observedTokens: number | null; inputTokens: number | null
      outputTokens: number | null; cachedInputTokens: number | null; cacheWriteTokens: number | null
      reasoningOutputTokens: number | null
      medianRequestMs: number | null; requestTimeline: { timestamp: number; durationMs: number;
        status: string | null; success: boolean | null }[]
      toolStats: { tool: string; count: number; failures: number; medianDurationMs: number | null }[]
      tokenTimeline: { timestamp: number; total: number;
        input: number | null; output: number | null; cachedInput: number | null; cacheWrite: number | null;
        reasoningOutput: number | null }[]; activityCount: number; recentEvents: ReturnType<typeof activity>[]
    }>()
    const latencies = new Map<string, number[]>()
    const tools = new Map<string, Map<string, { count: number; failures: number; durations: number[] }>>()
    for (const row of rows) {
      let session = sessions.get(row.conversation_id)
      if (!session) {
        session = {
          id: row.conversation_id, firstSeen: row.timestamp_ms, lastSeen: row.timestamp_ms,
          models: [], prompts: 0, apiRequests: 0, errors: 0, toolCalls: 0, approvals: 0,
          completedResponses: 0, observedTokens: null, inputTokens: null, outputTokens: null,
          cachedInputTokens: null, cacheWriteTokens: null, reasoningOutputTokens: null, medianRequestMs: null,
          requestTimeline: [], toolStats: [], tokenTimeline: [], activityCount: 0, recentEvents: [],
        }
        sessions.set(row.conversation_id, session)
      }
      session.lastSeen = row.timestamp_ms
      session.activityCount++
      if (row.model && !session.models.includes(row.model)) session.models.push(row.model)
      if (row.name === 'user_prompt') session.prompts++
      if (row.name === 'api_request') {
        session.apiRequests++
        if (isError(row)) session.errors++
        if (row.duration_ms !== null) {
          const list = latencies.get(row.conversation_id) || []
          list.push(row.duration_ms)
          latencies.set(row.conversation_id, list)
          session.requestTimeline.push({ timestamp: row.timestamp_ms, durationMs: row.duration_ms,
            status: row.status, success: row.success === null ? null : row.success === 1 })
        }
      }
      if (row.name === 'tool_result') {
        session.toolCalls++
        const byTool = tools.get(row.conversation_id) || new Map()
        const key = row.tool || 'Unspecified tool'
        const stat = byTool.get(key) || { count: 0, failures: 0, durations: [] }
        stat.count++
        if (row.success === 0) stat.failures++
        if (row.duration_ms !== null) stat.durations.push(row.duration_ms)
        byTool.set(key, stat)
        tools.set(row.conversation_id, byTool)
      }
      if (row.name === 'tool_decision') session.approvals++
      if ((row.name === 'sse_event' || row.name === 'websocket_event') && row.kind === 'response.completed') {
        session.completedResponses++
        if (row.total_tokens !== null) {
          session.observedTokens = (session.observedTokens || 0) + row.total_tokens
          session.tokenTimeline.push({ timestamp: row.timestamp_ms, total: row.total_tokens,
            input: row.input_tokens, output: row.output_tokens, cachedInput: row.cached_input_tokens,
            cacheWrite: row.cache_write_tokens,
            reasoningOutput: row.reasoning_output_tokens })
        }
        if (row.input_tokens !== null) session.inputTokens = (session.inputTokens || 0) + row.input_tokens
        if (row.output_tokens !== null) session.outputTokens = (session.outputTokens || 0) + row.output_tokens
        if (row.cached_input_tokens !== null) session.cachedInputTokens = (session.cachedInputTokens || 0) + row.cached_input_tokens
        if (row.cache_write_tokens !== null) session.cacheWriteTokens = (session.cacheWriteTokens || 0) + row.cache_write_tokens
        if (row.reasoning_output_tokens !== null) session.reasoningOutputTokens = (session.reasoningOutputTokens || 0) + row.reasoning_output_tokens
      }
      session.recentEvents.unshift(activity(row))
      if (session.recentEvents.length > 12) session.recentEvents.pop()
    }
    const output = [...sessions.values()].map((session) => ({
      ...session, medianRequestMs: median(latencies.get(session.id) || []),
      toolStats: [...(tools.get(session.id) || new Map()).entries()].map(([tool, stat]) => ({
        tool, count: stat.count, failures: stat.failures, medianDurationMs: median(stat.durations),
      })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    })).sort((a, b) => b.lastSeen - a.lastSeen)
    return { periodDays: typeof window === 'number' ? window : null, sessions: output }
  }

  sessionEvents(id: string, window: TimeWindow, offset = 0, limit = 50) {
    const [start, end] = bounds(window)
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE conversation_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?')
      .get(id, start, end) as { count: number }).count
    const rows = this.db.prepare(`SELECT * FROM events WHERE conversation_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?
      ORDER BY timestamp_ms DESC, rowid DESC LIMIT ? OFFSET ?`).all(id, start, end, limit, offset) as Row[]
    return { total, offset, events: rows.map(activity) }
  }

  sessionPrompts(id: string, window: TimeWindow) {
    const [start, end] = bounds(window)
    const rows = this.db.prepare(`SELECT id, timestamp_ms, prompt_text FROM events
      WHERE conversation_id = ? AND name = 'user_prompt' AND timestamp_ms >= ? AND timestamp_ms < ?
      ORDER BY timestamp_ms DESC, rowid DESC`).all(id, start, end) as Row[]
    return rows.map((row) => ({ id: row.id, timestamp: row.timestamp_ms, text: row.prompt_text }))
  }
}
