import { useEffect, useMemo, useState } from 'react'
import { useTheme } from './useTheme'

type Activity = { id: string; timestamp: number; name: string; kind: string | null; tool: string | null;
  status: string | null; success: boolean | null; durationMs: number | null }
type TokenPoint = { timestamp: number; total: number; input: number | null; output: number | null;
  cachedInput: number | null; cacheWrite: number | null; reasoningOutput: number | null }
type Session = { id: string; firstSeen: number; lastSeen: number; models: string[]; prompts: number;
  apiRequests: number; errors: number; toolCalls: number; approvals: number; completedResponses: number;
  observedTokens: number | null; inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens: number | null; cacheWriteTokens: number | null;
  reasoningOutputTokens: number | null; medianRequestMs: number | null;
  requestTimeline: { timestamp: number; durationMs: number; status: string | null; success: boolean | null }[];
  toolStats: { tool: string; count: number; failures: number; medianDurationMs: number | null }[];
  tokenTimeline: TokenPoint[]; activityCount: number; recentEvents: Activity[] }
type Prompt = { id: string; timestamp: number; text: string | null }
type Period = 'today' | '7' | '30' | '90' | 'all' | 'custom'

const number = (value: number) => new Intl.NumberFormat().format(value)
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const date = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
const localDate = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
const dayStart = (value: string) => new Date(`${value}T00:00:00`).getTime()
const nextDay = (value: string) => { const day = new Date(`${value}T00:00:00`); day.setDate(day.getDate() + 1); return day.getTime() }
const shortId = (id: string) => id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id
const safeDecode = (value: string) => { try { return decodeURIComponent(value) } catch { return '' } }
const time = (ms: number | null) => ms === null ? 'Unavailable' : `${Math.round(ms)} ms`
const shown = (value: number | null) => value === null ? 'Unavailable' : number(value)

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>
}

function Timeline({ points }: { points: TokenPoint[] }) {
  if (!points.length) return <div className="chart-empty">No completed responses with token counts in this period.</div>
  const ordered = [...points].sort((a, b) => a.timestamp - b.timestamp)
  const cumulative: { timestamp: number; total: number }[] = []
  let total = 0
  for (const point of ordered) { total += point.total; cumulative.push({ timestamp: point.timestamp, total }) }
  const min = ordered[0].timestamp
  const span = ordered.at(-1)!.timestamp - min
  const x = (timestamp: number, index: number) => 64 + (span === 0 ? (ordered.length === 1 ? .5 : index / (ordered.length - 1)) : (timestamp - min) / span) * 706
  const y = (value: number) => 205 - value / Math.max(1, total) * 170
  const path = cumulative.map((point, index) => `${index ? 'L' : 'M'}${x(point.timestamp, index).toFixed(1)},${y(point.total).toFixed(1)}`).join(' ')
  const area = `M${x(min, 0).toFixed(1)},205 ${path.replace(/^M/, 'L')} L${x(ordered.at(-1)!.timestamp, ordered.length - 1).toFixed(1)},205 Z`
  return <div className="timeline"><svg viewBox="0 0 800 240" role="img" aria-label="Cumulative observed tokens over time">
    {[0, .5, 1].map((fraction) => <g key={fraction}><line x1="64" x2="770" y1={205 - fraction * 170} y2={205 - fraction * 170} className="grid-line" /><text x="49" y={210 - fraction * 170} textAnchor="end">{compact(Math.round(total * fraction))}</text></g>)}
    <path d={area} className="timeline-area" /><path d={path} className="timeline-line" />
    {cumulative.map((point, index) => <circle key={`${point.timestamp}-${index}`} cx={x(point.timestamp, index)} cy={y(point.total)} r="4.5" className="timeline-dot" tabIndex={0} aria-label={`${date(point.timestamp)}: ${number(ordered[index].total)} tokens in response; ${number(point.total)} cumulative`}><title>{date(point.timestamp)} · {number(ordered[index].total)} tokens in response · {number(point.total)} cumulative</title></circle>)}
    <text x="64" y="232">{date(min)}</text><text x="770" y="232" textAnchor="end">{date(ordered.at(-1)!.timestamp)}</text>
  </svg><p>Each point adds the token count reported by one completed response.</p></div>
}

function ActivityList({ events }: { events: Activity[] }) {
  const names: Record<string, string> = { conversation_starts: 'Conversation started', user_prompt: 'Prompt sent',
    api_request: 'API request', sse_event: 'Stream event', websocket_request: 'WebSocket request',
    websocket_event: 'WebSocket event', tool_decision: 'Tool decision', tool_result: 'Tool finished' }
  return <ol className="event-list">{events.length ? events.map((event) => <li key={event.id} className="event-item">
    <span className={`event-dot ${event.success === false ? 'error-dot' : ''}`} />
    <span className="event-label">{names[event.name] || event.name}{event.kind ? ` · ${event.kind}` : ''}{event.tool ? ` · ${event.tool}` : ''}{event.status ? ` · ${event.status}` : ''}</span>
    <time>{date(event.timestamp)}</time>
  </li>) : <li className="empty-line">No activity recorded.</li>}</ol>
}

function ResponseBars({ points }: { points: TokenPoint[] }) {
  if (!points.length) return <p className="chart-empty">No response token counts available.</p>
  const max = Math.max(...points.map((point) => point.total), 1)
  return <div className="response-list">{points.map((point, index) => <div className="response-row" key={`${point.timestamp}-${index}`}>
    <span className="response-index">#{index + 1}</span><span className="response-track" title={`${number(point.total)} tokens · ${date(point.timestamp)}`}>
      <span className="response-fill" style={{ width: `${Math.max(2, point.total / max * 100)}%` }} /></span>
    <strong>{number(point.total)}</strong><time>{date(point.timestamp)}</time>
    <small>Input {shown(point.input)} · Output {shown(point.output)} · Cached input {shown(point.cachedInput)} · Cache write {shown(point.cacheWrite)} · Reasoning output {shown(point.reasoningOutput)}</small>
  </div>)}</div>
}

function SessionDetail({ session, query, onBack, onDelete }: { session: Session; query: string;
  onBack: () => void; onDelete: () => void }) {
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [events, setEvents] = useState<Activity[]>([])
  const [eventTotal, setEventTotal] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setPrompts([]); setEvents([]); setShowAll(false); setError('')
    Promise.all([
      fetch(`/api/sessions/${encodeURIComponent(session.id)}/prompts?${query}`, { signal: controller.signal }).then((res) => { if (!res.ok) throw Error('Prompt request failed'); return res.json() as Promise<Prompt[]> }),
      fetch(`/api/sessions/${encodeURIComponent(session.id)}/events?${query}&offset=0`, { signal: controller.signal }).then((res) => { if (!res.ok) throw Error('Activity request failed'); return res.json() as Promise<{ total: number; events: Activity[] }> }),
    ]).then(([promptRows, activity]) => { setPrompts(promptRows); setEvents(activity.events); setEventTotal(activity.total) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load details') })
    return () => controller.abort()
  }, [session.id, query])
  async function loadMore() {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/events?${query}&offset=${events.length}`)
      if (!response.ok) throw Error('Activity request failed')
      const next = await response.json() as { events: Activity[] }
      setEvents((current) => [...current, ...next.events]); setShowAll(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load activity') }
  }
  return <>
    <button className="text-button" onClick={onBack}>← All conversations</button>
    <div className="detail-heading"><div><p className="eyebrow">CONVERSATION</p><h1>{shortId(session.id)}</h1><p className="mono muted">{session.id}</p></div><button className="delete-button" onClick={onDelete}>Delete local data</button></div>
    <section className="panel context-panel"><div className="panel-head"><div><p className="eyebrow">CONTEXT</p><h2>Observed details</h2></div></div>
      <div className="context-grid"><div><span>Models</span><strong>{session.models.join(', ') || 'Unavailable'}</strong></div><div><span>First seen</span><strong>{date(session.firstSeen)}</strong></div><div><span>Last seen</span><strong>{date(session.lastSeen)}</strong></div><div><span>API errors</span><strong>{number(session.errors)}</strong></div><div><span>Tool results</span><strong>{number(session.toolCalls)}</strong></div><div><span>Tool decisions</span><strong>{number(session.approvals)}</strong></div></div>
    </section>
    <div className="stats detail-stats">
      <Stat label="Observed tokens" value={shown(session.observedTokens)} hint={`${session.tokenTimeline.length} of ${session.completedResponses} completions have counts`} />
      <Stat label="Prompts" value={number(session.prompts)} />
      <Stat label="API requests" value={number(session.apiRequests)} />
      <Stat label="Median request time" value={time(session.medianRequestMs)} />
    </div>
    <div className="two-column"><section className="panel"><div className="panel-head"><div><p className="eyebrow">USAGE</p><h2>Token breakdown</h2></div></div>
      <div className="panel-body"><div className="breakdown-grid"><div><span>Input</span><strong>{shown(session.inputTokens)}</strong></div><div><span>Output</span><strong>{shown(session.outputTokens)}</strong></div><div><span>Cached input</span><strong>{shown(session.cachedInputTokens)}</strong></div><div><span>Cache write</span><strong>{shown(session.cacheWriteTokens)}</strong></div><div><span>Reasoning output</span><strong>{shown(session.reasoningOutputTokens)}</strong></div></div><p className="note">Cached input is included in input. Reasoning output is included in output. Cache-write count is shown separately and not added to observed total.</p></div>
    </section><section className="panel"><div className="panel-head"><div><p className="eyebrow">PERFORMANCE</p><h2>Activity counts</h2></div></div>
      <div className="panel-body"><div className="breakdown-grid"><div><span>Completed responses</span><strong>{number(session.completedResponses)}</strong></div><div><span>API requests</span><strong>{number(session.apiRequests)}</strong></div><div><span>Tool results</span><strong>{number(session.toolCalls)}</strong></div><div><span>Errors</span><strong>{number(session.errors)}</strong></div></div></div>
    </section></div>
    <section className="panel"><div className="panel-head"><div><p className="eyebrow">USAGE OVER TIME</p><h2>Token timeline</h2></div><span className="chip">{session.tokenTimeline.length} responses with counts</span></div><div className="panel-body"><Timeline points={session.tokenTimeline} /></div></section>
    <section className="panel"><div className="panel-head"><div><p className="eyebrow">RESPONSE USAGE</p><h2>Tokens by completed response</h2></div><span className="chip">{session.tokenTimeline.length} with counts</span></div><div className="panel-body"><ResponseBars points={session.tokenTimeline} /></div></section>
    <div className="two-column"><section className="panel"><div className="panel-head"><div><p className="eyebrow">REQUEST PERFORMANCE</p><h2>API request durations</h2></div><span className="chip">{session.requestTimeline.length} timed</span></div><div className="panel-body"><div className="metric-list">{session.requestTimeline.length ? [...session.requestTimeline].reverse().slice(0, 20).map((request, index) => <div className="metric-row" key={`${request.timestamp}-${index}`}><span>{date(request.timestamp)}</span><strong>{time(request.durationMs)}</strong><small>{request.status || (request.success === false ? 'Failed' : 'Status unavailable')}</small></div>) : <p className="chart-empty">No request durations received.</p>}</div>{session.requestTimeline.length > 20 && <p className="note">Showing the latest 20 of {number(session.requestTimeline.length)} timed requests.</p>}</div></section>
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">TOOL ACTIVITY</p><h2>Tools used</h2></div><span className="chip">{session.toolStats.length}</span></div><div className="panel-body"><div className="metric-list">{session.toolStats.length ? session.toolStats.map((tool) => <div className="metric-row" key={tool.tool}><span>{tool.tool}</span><strong>{number(tool.count)} calls</strong><small>{tool.failures ? `${number(tool.failures)} failed · ` : ''}Median {time(tool.medianDurationMs)}</small></div>) : <p className="chart-empty">No tool-result events received.</p>}</div></div></section></div>
    <div className="two-column"><section className="panel"><div className="panel-head"><div><p className="eyebrow">INPUT</p><h2>Prompts</h2></div><span className="chip">{session.prompts}</span></div><div className="panel-body prompt-list">{prompts.length ? prompts.map((prompt) => <details key={prompt.id} className="prompt-item"><summary><time>{date(prompt.timestamp)}</time><span>{prompt.text ? prompt.text.split('\n')[0].slice(0, 100) : 'Prompt text unavailable'}</span></summary><pre>{prompt.text || 'Enable prompt export in Codex to capture future prompt text.'}</pre></details>) : <p className="chart-empty">No prompt events in this period.</p>}</div></section>
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">TIMELINE</p><h2>Recent activity</h2></div><span className="chip">{eventTotal || session.activityCount}</span></div><div className="panel-body"><ActivityList events={events} />{events.length < eventTotal && <button className="text-button" onClick={() => void loadMore()}>Load more activity</button>}{showAll && events.length >= eventTotal && <p className="note">All events loaded.</p>}</div></section></div>
    {error && <p className="error-message" role="alert">{error}</p>}
  </>
}

export default function App() {
  const { theme, toggleTheme } = useTheme()
  const [period, setPeriod] = useState<Period>('30')
  const [startDate, setStartDate] = useState(() => localDate(new Date()))
  const [endDate, setEndDate] = useState(() => localDate(new Date()))
  const [todayDate, setTodayDate] = useState(() => localDate(new Date()))
  const [sidebarVisible, setSidebarVisible] = useState(() => localStorage.getItem('dashboard-sidebar-visible') !== 'false')
  const [route, setRoute] = useState(location.hash || '#/')
  const [sessions, setSessions] = useState<Session[]>([])
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState<number | null>(null)
  const query = useMemo(() => {
    if (period === 'today') return `from=${dayStart(todayDate)}&to=${nextDay(todayDate)}`
    if (period !== 'custom') return `days=${period}`
    if (!startDate || !endDate) return null
    const start = dayStart(startDate)
    const end = nextDay(endDate)
    return Number.isFinite(start) && Number.isFinite(end) && start < end ? `from=${start}&to=${end}` : null
  }, [period, startDate, endDate, todayDate])
  useEffect(() => { const interval = window.setInterval(() => setTodayDate(localDate(new Date())), 10_000); return () => window.clearInterval(interval) }, [])
  useEffect(() => { const update = () => setRoute(location.hash || '#/'); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  useEffect(() => {
    if (!query) return
    let active = true
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sessions?${query}`, { cache: 'no-store' })
        if (!response.ok) throw Error(`Dashboard request failed (${response.status})`)
        const data = await response.json() as { sessions: Session[] }
        if (active) { setSessions(data.sessions); setUpdated(Date.now()); setError('') }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Could not load dashboard') }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 10_000)
    return () => { active = false; clearInterval(interval) }
  }, [query])
  function navigate(path = '/') { location.hash = `#${path}` }
  const selectedId = route.startsWith('#/session/') ? safeDecode(route.slice('#/session/'.length)) : null
  const selected = selectedId ? sessions.find((session) => session.id === selectedId) : null
  const sessionsView = route === '#/sessions'
  const points = sessions.flatMap((session) => session.tokenTimeline)
  const observed = sessions.reduce((sum, session) => sum + (session.observedTokens || 0), 0)
  const completions = sessions.reduce((sum, session) => sum + session.completedResponses, 0)
  const withCounts = points.length
  const requests = sessions.reduce((sum, session) => sum + session.apiRequests, 0)
  const prompts = sessions.reduce((sum, session) => sum + session.prompts, 0)
  const errors = sessions.reduce((sum, session) => sum + session.errors, 0)
  const tools = sessions.reduce((sum, session) => sum + session.toolCalls, 0)
  async function deleteSession(session: Session) {
    if (!confirm(`Delete stored telemetry for ${session.id}? Future events for this ID will be ignored.`)) return
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' })
      if (!response.ok) throw Error('Delete request failed')
      setSessions((current) => current.filter((item) => item.id !== session.id))
      if (selectedId === session.id) navigate('/sessions')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete conversation') }
  }
  const toggleSidebar = () => setSidebarVisible((visible) => { localStorage.setItem('dashboard-sidebar-visible', String(!visible)); return !visible })
  const periodFilter = <><label>Period<select value={period} onChange={(event) => setPeriod(event.target.value as Period)}><option value="today">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="all">All time</option><option value="custom">Custom range</option></select></label>{period === 'custom' && <><label>From<input type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} /></label><label>To<input type="date" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} /></label></>}</>
  return <div className="app-shell">{sidebarVisible && <aside className="sidebar" aria-label="Dashboard navigation"><div className="brand">Codex<span>telemetry</span></div><nav><p className="group-title">WORKSPACE</p><button className={`nav-item ${!sessionsView && !selectedId ? 'active' : ''}`} type="button" onClick={() => navigate()}>Dashboard</button><button className={`nav-item ${sessionsView || selectedId ? 'active' : ''}`} type="button" onClick={() => navigate('/sessions')}>Conversations</button></nav><div className="sidebar-footer"><div className="receiver-label"><i className="live-dot" /> Local receiver</div><button className="theme-toggle" type="button" onClick={toggleTheme}>{theme === 'dark' ? '☀' : '☾'} <span>{theme === 'dark' ? 'Light' : 'Dark'} mode</span></button><button className="theme-toggle" type="button" onClick={toggleSidebar}>◧ <span>Hide sidebar</span></button></div></aside>}
    <main className="main-area"><div className="page-content"><div className="top-actions">{!sidebarVisible && <><button className="plain-button" type="button" onClick={toggleSidebar}>☰ Show sidebar</button><button className="plain-button" type="button" onClick={toggleTheme}>{theme === 'dark' ? '☀ Light' : '☾ Dark'} mode</button></>}<span className="top-spacer" /><span className="top-status" role="status">{error ? <span className="error-message" role="alert">{error}</span> : updated ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(updated)}` : 'Waiting for telemetry'}</span></div>
      {selectedId ? <div className="filters detail-filters">{periodFilter}</div> : <div className="page-head"><div><p className="eyebrow">CODEX / OBSERVED ACTIVITY</p><h1>{sessionsView ? 'Conversations' : 'Dashboard'}</h1><p className="subtitle">Local OpenTelemetry data, with no cost estimates or inferred usage.</p></div><div className="filters">{periodFilter}</div></div>}
      {!query ? <section className="panel empty-state">Choose a valid start and end date.</section> : selectedId ? selected ? <SessionDetail key={`${selected.id}-${query}`} session={selected} query={query} onBack={() => navigate('/sessions')} onDelete={() => void deleteSession(selected)} /> : <section className="panel empty-state">Conversation not found in this period. <button className="text-button" onClick={() => navigate('/sessions')}>Back to conversations</button></section> : sessionsView ? <section className="panel"><div className="panel-head"><div><p className="eyebrow">BROWSE</p><h2>Conversations</h2></div><span className="chip">{sessions.length}</span></div>{sessions.length ? <div className="session-list">{sessions.map((session) => <div className="session-row" key={session.id}><button onClick={() => navigate(`/session/${encodeURIComponent(session.id)}`)}><strong>{shortId(session.id)}</strong><span>{session.models.join(', ') || 'Model unavailable'} · {session.prompts} prompts · {session.apiRequests} requests</span><small>{session.observedTokens === null ? 'Tokens unavailable' : `${number(session.observedTokens)} observed tokens`}</small></button><time>{date(session.lastSeen)}</time></div>)}</div> : <div className="empty-state">No Codex conversations received yet. Start the receiver and send a prompt from Codex.</div>}</section> : <>
        <div className="stats"><Stat label="Conversations" value={number(sessions.length)} hint="Distinct conversation IDs" /><Stat label="Prompts" value={number(prompts)} hint="Prompt events" /><Stat label="Observed tokens" value={withCounts ? compact(observed) : 'Unavailable'} hint={`${withCounts} of ${completions} completions with counts`} /><Stat label="API requests" value={number(requests)} /><Stat label="API errors" value={number(errors)} /><Stat label="Tool results" value={number(tools)} /></div>
        <section className="panel"><div className="panel-head"><div><p className="eyebrow">USAGE OVER TIME</p><h2>Token timeline</h2></div><span className="chip">{withCounts} responses across {sessions.length} {sessions.length === 1 ? 'conversation' : 'conversations'}</span></div><div className="panel-body"><Timeline points={points} /></div></section>
        <button className="plain-button browse-button" type="button" onClick={() => navigate('/sessions')}>Browse {sessions.length} {sessions.length === 1 ? 'conversation' : 'conversations'} →</button>
      </>}
      <footer className="footnote">Only observed Codex OTEL fields are stored. Missing token counts remain unavailable.</footer>
    </div></main></div>
}
