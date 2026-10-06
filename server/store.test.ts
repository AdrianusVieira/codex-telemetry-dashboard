import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { Store } from './store.js'

const attr = (key: string, value: string | number | boolean) => ({ key, value: typeof value === 'string' ? { stringValue: value } : typeof value === 'boolean' ? { boolValue: value } : { intValue: String(value) } })
function log(name: string, fields: Record<string, string | number | boolean>, ms: number) {
  return { timeUnixNano: String(BigInt(ms) * 1_000_000n), body: { stringValue: `codex.${name}` },
    attributes: [attr('conversation.id', 'conversation-1'), ...Object.entries(fields).map(([key, value]) => attr(key, value))] }
}
function payload(...records: ReturnType<typeof log>[]) {
  return { resourceLogs: [{ resource: { attributes: [attr('model', 'gpt-test')] }, scopeLogs: [{ logRecords: records }] }] }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-telemetry-test-'))
  const path = join(dir, 'telemetry.sqlite3')
  const store = new Store(path)
  return { store, path, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('ingests allowlisted Codex logs, deduplicates retries, and counts cached tokens only once', () => {
  const f = fixture()
  try {
    const now = Date.now()
    const records = payload(
      log('conversation_starts', {}, now - 3000),
      log('user_prompt', { prompt: 'Check API_KEY=topsecret and me@example.com' }, now - 2000),
      log('api_request', { duration_ms: 850, success: true, status: 200 }, now - 1000),
      log('tool_result', { tool: 'exec_command', duration_ms: 32, success: true, output: 'private tool output' }, now - 500),
      log('sse_event', { event: 'response.completed', input_token_count: 100, output_token_count: 20,
        cached_token_count: 40, cache_write_token_count: 12, reasoning_token_count: 5 }, now),
    )
    assert.equal(f.store.ingestLogs(records), 5)
    assert.equal(f.store.ingestLogs(records), 0)
    const session = f.store.sessions().sessions[0]
    assert.equal(session.observedTokens, 120)
    assert.equal(session.inputTokens, 100)
    assert.equal(session.outputTokens, 20)
    assert.equal(session.cachedInputTokens, 40)
    assert.equal(session.cacheWriteTokens, 12)
    assert.equal(session.reasoningOutputTokens, 5)
    assert.equal(session.medianRequestMs, 850)
    assert.equal(session.requestTimeline.length, 1)
    assert.deepEqual(session.toolStats, [{ tool: 'exec_command', count: 1, failures: 0, medianDurationMs: 32 }])
    assert.equal(session.prompts, 1)
    const prompts = f.store.sessionPrompts('conversation-1', 30)
    assert.equal(prompts.length, 1)
    assert.doesNotMatch(prompts[0].text!, /topsecret|me@example.com/)
    const db = new Database(f.path, { readonly: true })
    try {
      const raw = JSON.stringify(db.prepare('SELECT * FROM events').all())
      assert.doesNotMatch(raw, /topsecret|me@example.com|private tool output/)
      assert.doesNotMatch(raw, /API_KEY=topsecret/)
    } finally { db.close() }
  } finally { f.close() }
})

test('does not invent token counts and permanently ignores deleted conversation IDs', () => {
  const f = fixture()
  try {
    const now = Date.now()
    const record = payload(log('sse_event', { kind: 'response.completed' }, now))
    assert.equal(f.store.ingestLogs(record), 1)
    const session = f.store.sessions().sessions[0]
    assert.equal(session.completedResponses, 1)
    assert.equal(session.observedTokens, null)
    assert.equal(f.store.deleteConversation('conversation-1'), true)
    assert.equal(f.store.sessions().sessions.length, 0)
    assert.equal(f.store.ingestLogs(record), 0)
    assert.equal(f.store.sessions().sessions.length, 0)
  } finally { f.close() }
})

test('ignores records without a conversation ID or a timestamp', () => {
  const f = fixture()
  try {
    assert.equal(f.store.ingestLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [
      { body: { stringValue: 'codex.user_prompt' }, attributes: [attr('prompt', 'hello')] },
      { timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), body: { stringValue: 'codex.user_prompt' }, attributes: [attr('prompt', 'hello')] },
    ] }] }] }), 0)
    assert.equal(f.store.sessions().sessions.length, 0)
  } finally { f.close() }
})

test('uses Codex event timestamp when OTLP timeUnixNano is zero', () => {
  const f = fixture()
  try {
    const eventTime = Date.now() - 2000
    const observedTime = eventTime + 1000
    const record = log('user_prompt', { prompt: 'Hello', 'event.timestamp': new Date(eventTime).toISOString() }, eventTime)
    record.timeUnixNano = '0'
    const received = { ...record, observedTimeUnixNano: String(BigInt(observedTime) * 1_000_000n) }
    assert.equal(f.store.ingestLogs(payload(received)), 1)
    const session = f.store.sessions().sessions[0]
    assert.equal(session.firstSeen, eventTime)
    assert.equal(session.prompts, 1)
  } finally { f.close() }
})
