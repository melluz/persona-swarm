// persona-swarm web UI: runs, live monitor, session replay, findings review. No build step.

const view = document.getElementById('view')
const crumbs = document.getElementById('crumbs')
const liveIndicator = document.getElementById('live-indicator')
const lightbox = document.getElementById('lightbox')

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const dots = (n) => '●'.repeat(n) + '○'.repeat(Math.max(0, 5 - n))
const money = (n) => `$${(n ?? 0).toFixed(2)}`
/** Usage as a driver reported it; drivers played by an outside agent report none. */
const spend = (usage) => (usage?.inputTokens || usage?.costUsd ? money(usage.costUsd) : '–')
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')
const ago = (iso) => {
  if (!iso) return ''
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}
const api = async (path, init = {}) => {
  // Writes are JSON with a same-origin check on the server; other sites cannot send them.
  const options = init.method === 'POST' ? { ...init, headers: { 'content-type': 'application/json', ...init.headers }, body: init.body ?? '{}' } : init
  const response = await fetch(`/api${path}`, options)
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText)
  return response.json()
}
/** A run file's URL, every segment encoded: safe inside attributes. */
const fileUrl = (runId, path) => `/api/runs/${encodeURIComponent(runId)}/files/${String(path).split('/').map(encodeURIComponent).join('/')}`
/** Ids come from the address bar: only plain ones reach a view. */
const ID = /^[\w.@-]+$/

const cleanup = []
const onLeave = (fn) => cleanup.push(fn)
// Each navigation bumps the generation; late callbacks of a view that was left must not render.
let generation = 0
const stillCurrent = () => {
  const mine = generation
  return () => mine === generation
}

function setCrumbs(items) {
  crumbs.innerHTML = items.map(([label, href]) => (href ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)).join('<span>/</span>')
}

function openLightbox(src) {
  lightbox.querySelector('img').src = src
  lightbox.showModal()
}
document.addEventListener('click', (event) => {
  const zoom = event.target.closest('[data-zoom]')
  if (!zoom) return
  // A link with data-zoom still works with a modifier key (new tab); a plain click zooms.
  if (zoom.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey)) return
  event.preventDefault()
  openLightbox(zoom.dataset.zoom)
})

/** Subscribes to a run's server-sent events; returns false when the run is not live. */
function stream(runId, handlers) {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`)
  source.addEventListener('state', (event) => handlers.state?.(JSON.parse(event.data)))
  source.addEventListener('event', (event) => handlers.event?.(JSON.parse(event.data)))
  source.addEventListener('end', () => source.close())
  onLeave(() => source.close())
  return source
}

// Runs list ------------------------------------------------------------------------------------

async function runsView() {
  const current = stillCurrent()
  setCrumbs([['Runs']])
  liveIndicator.hidden = true
  const runs = await api('/runs')
  if (!current()) return
  if (!runs.length) {
    view.innerHTML = `<div class="empty">No runs yet. Start one with <span class="mono">persona-swarm run cohort.yaml</span>.</div>`
    return
  }
  view.innerHTML = `<h1>Runs</h1><div class="frame"><table><thead><tr><th>Run</th><th>Target</th><th>Cohort</th><th>Status</th><th class="num">Sessions</th><th class="num">Reports</th><th class="num">Cost</th><th>Started</th></tr></thead><tbody>
${runs
  .map(
    (run) =>
      `<tr class="link" data-href="#/run/${esc(run.runId)}"><td class="mono">${esc(run.runId)}${run.live ? ' <span class="chip running">live</span>' : ''}</td><td>${esc(run.target.name)}</td><td>${esc(run.cohort.id)} <span class="muted">· ${esc(run.mode)}</span></td><td><span class="chip ${esc(run.status)}">${esc(run.status)}</span></td><td class="num">${run.sessions}${run.running ? ` (${run.running} running)` : ''}</td><td class="num">${run.findings}</td><td class="num">${money(run.costUsd)}</td><td>${esc(new Date(run.createdAt).toLocaleString())}</td></tr>`,
  )
  .join('')}</tbody></table></div>`
  for (const row of view.querySelectorAll('tr[data-href]'))
    row.addEventListener('click', () => {
      location.hash = row.dataset.href
    })
}

// Live monitor -----------------------------------------------------------------------------------

function sessionCard(runId, session, live) {
  const shot = session.lastScreenshot ? fileUrl(runId, session.lastScreenshot) : ''
  return `<article class="card" data-session="${esc(session.id)}">
<div class="screen" ${shot ? `data-zoom="${shot}"` : ''}>${shot ? `<img loading="lazy" alt="${esc(session.name)}'s screen" src="${shot}">` : '<span class="muted">no screen yet</span>'}<span class="chip ${esc(session.status)}">${esc(session.status)}${session.outcome ? ` · ${esc(session.outcome)}` : ''}</span></div>
<div class="body"><div class="row spread"><strong>${esc(session.name)}</strong><span class="prof" title="proficiency ${session.proficiency}">${dots(session.proficiency)}</span></div>
<div class="muted">${esc(session.device)} · ${esc(session.toolProfile)}</div>
<div class="mono muted">${esc(session.driver)} · ${esc(session.model)}</div>
<div class="counters"><span>${session.turns} turns</span><span>${session.toolCalls} actions</span><span title="app errors / harness errors">${session.toolErrors}/${session.harnessErrors} err</span><span>${session.findings} reports</span><span title="model cost">${spend(session.usage)}</span></div>
${session.lastNote ? `<div class="quote">“${esc(session.lastNote)}”</div>` : ''}
${session.error ? `<div class="chip failed" title="${esc(session.error)}">${esc(session.error.slice(0, 80))}</div>` : ''}
<div class="row"><a href="#/run/${esc(runId)}/session/${encodeURIComponent(session.id)}">Replay</a>${live && ['running', 'starting'].includes(session.status) ? `<button class="danger" data-stop="${esc(session.id)}">Stop</button>` : ''}<span class="muted">${esc(ago(session.lastActionAt))}</span></div></div></article>`
}

async function runView(runId) {
  const current = stillCurrent()
  let state = await api(`/runs/${encodeURIComponent(runId)}`)
  if (!current()) return
  setCrumbs([['Runs', '#/'], [runId]])
  const feed = []
  const render = () => {
    if (!current()) return
    const sessions = Object.values(state.sessions)
    const g = state.governor ?? { level: 'ok', freePercent: 100 }
    view.innerHTML = `<div class="row spread"><div><h1>${esc(state.target.name)}</h1><div class="muted">${esc(state.cohort.id)} · ${esc(state.mode)} · <span class="mono">${esc(state.runId)}</span></div></div>
<div class="row"><span class="chip ${esc(state.status)}">${esc(state.status)}</span>${state.statusReason ? `<span class="muted">${esc(state.statusReason)}</span>` : ''}
<a href="#/run/${esc(runId)}/findings"><button class="primary">Review findings (${state.totals.findings})</button></a><a href="${fileUrl(runId, 'report.html')}" target="_blank" rel="noopener"><button>Report</button></a>${state.live ? '<button class="danger" id="stop-run">Stop run</button>' : ''}</div></div>
<section class="stats"><div class="stat"><b>${sessions.filter((s) => s.status === 'running').length}/${sessions.length}</b>running</div><div class="stat"><b>${sessions.filter((s) => s.status === 'finished').length}</b>finished</div><div class="stat"><b>${state.totals.findings}</b>reports</div><div class="stat"><b>${spend(state.totals)}</b>${state.totals.inputTokens || state.totals.costUsd ? `${(state.totals.inputTokens / 1000).toFixed(0)}k in · ${(state.totals.outputTokens / 1000).toFixed(0)}k out` : 'no usage reported'}</div><div class="stat"><b>${g.freePercent}%</b>memory free · ${esc(g.level)}<div class="meter ${esc(g.level)}"><i style="width:${Math.min(100, g.freePercent)}%"></i></div></div></section>
<section class="grid">${sessions.map((session) => sessionCard(runId, session, state.live)).join('')}</section>
${feed.length ? `<section><h2>What they are saying</h2><div class="feed">${feed.map((item) => `<div><span class="mono muted">${esc(time(item.t))} ${esc(item.session)}</span> ${item.html}</div>`).join('')}</div></section>` : ''}`
    view.querySelector('#stop-run')?.addEventListener('click', async () => {
      if (confirm('Stop the whole run? Running personas are cancelled; the run can be resumed.'))
        await api(`/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' })
    })
    for (const button of view.querySelectorAll('[data-stop]'))
      button.addEventListener('click', () =>
        api(`/runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(button.dataset.stop)}/stop`, { method: 'POST' }),
      )
  }
  render()
  liveIndicator.hidden = !state.live
  if (state.live) {
    let scheduled = false
    stream(runId, {
      state: (next) => {
        state = { ...next, live: true }
        if (!scheduled) {
          scheduled = true
          requestAnimationFrame(() => {
            scheduled = false
            render()
          })
        }
      },
      event: (event) => {
        let html = ''
        if (event.type === 'note') html = `<em>“${esc(event.text)}”</em>`
        else if (event.type === 'finding') html = `<strong class="chip blocking">reported</strong> ${esc(event.findingId)}: ${esc(event.title)}`
        else if (event.type === 'error') html = `<span class="chip failed">error</span> ${esc(event.message)}`
        else if (event.type === 'diary') html = `<span class="chip ok">finished</span> ${esc(event.outcome)}: ${esc(event.summary)}`
        if (!html) return
        feed.unshift({ t: event.t, session: event.session, html })
        feed.length = Math.min(feed.length, 60)
      },
    })
  } else {
    const timer = setInterval(async () => {
      state = await api(`/runs/${encodeURIComponent(runId)}`).catch(() => state)
      render()
    }, 10_000)
    onLeave(() => clearInterval(timer))
  }
}

// Replay -----------------------------------------------------------------------------------------

function describeEvent(event, pendingCalls) {
  switch (event.type) {
    case 'tool.call':
      pendingCalls.set(event.callId, event)
      return null
    case 'tool.result': {
      if (event.tool === 'report_problem' && String(event.message).startsWith('held'))
        return { cls: 'note', what: 'Report held back for a second look', detail: String(event.message).replace(/^held: /, '') }
      // Notes, reports, confirmations and the diary have their own, richer rows.
      if (['note', 'report_problem', 'confirm_problem', 'finish'].includes(event.tool) && event.ok) return null
      const call = pendingCalls.get(event.callId)
      const input = call
        ? Object.entries(call.input ?? {})
            .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.slice(0, 60)) : JSON.stringify(v)}`)
            .join(' ')
        : ''
      return { cls: event.ok ? 'act' : 'err', what: `${event.tool} ${input}`, detail: event.message, shot: event.screenshot }
    }
    case 'note':
      return { cls: 'note', what: `“${event.text}”` }
    case 'finding':
      return { cls: 'finding', what: `Reported ${event.findingId}: ${event.title}` }
    case 'vote':
      return { cls: 'finding', what: `Confirmed ${event.known ? 'known issue ' : ''}${event.findingId}`, detail: event.note || undefined }
    case 'agent.text':
      return { cls: 'agent', what: event.text }
    case 'device.signal':
      return event.kind === 'console.warning' ? null : { cls: 'err', what: `${event.kind}`, detail: event.text }
    case 'diary':
      return {
        cls: 'note',
        what: `Finished (${event.outcome}): ${event.summary}`,
        detail: `ease ${event.ease} · trust ${event.trust} · would use: ${event.wouldUse}`,
      }
    case 'session.start':
      return { cls: 'agent', what: `Session started (${event.driver} · ${event.model})` }
    case 'session.end':
      return { cls: 'agent', what: `Session ended: ${event.status} (${event.reason || event.stopReason})` }
    case 'notice':
      return { cls: 'agent', what: `Notice: ${event.text}` }
    case 'error':
      return { cls: 'err', what: event.message }
    default:
      return null
  }
}

async function replayView(runId, sessionId, focusSeq) {
  const current = stillCurrent()
  setCrumbs([['Runs', '#/'], [runId, `#/run/${runId}`], [sessionId]])
  const state = await api(`/runs/${encodeURIComponent(runId)}`)
  const session = state.sessions[sessionId]
  // A long session comes in pages: all of it, however many events.
  const events = []
  for (let after = 0; ; ) {
    const page = await api(`/runs/${encodeURIComponent(runId)}/events?session=${encodeURIComponent(sessionId)}&after=${after}`)
    for (const event of page) events.push(event)
    if (page.length < 5000 || !current()) break
    after = page.at(-1).seq
  }
  if (!current()) return
  const rows = []
  const pending = new Map()
  let lastShot = ''
  const add = (event) => {
    const described = describeEvent(event, pending)
    if (!described) return
    if (described.shot) lastShot = described.shot
    rows.push({ ...described, seq: event.seq, t: event.t, shot: described.shot ?? lastShot })
  }
  events.forEach(add)
  view.innerHTML = `<div class="row spread"><div><h1>${esc(session?.name ?? sessionId)}</h1><div class="muted">${esc(session?.device ?? '')} · ${esc(session?.toolProfile ?? '')} · ${esc(session?.driver ?? '')} ${esc(session?.model ?? '')}</div></div>
<div class="row"><button id="prev" title="Previous (←)">←</button><button id="play">Play</button><button id="next" title="Next (→)">→</button><label class="row muted"><input type="checkbox" id="only-acts"> actions only</label></div></div>
<div class="replay"><div class="timeline" id="timeline"></div><div class="viewer"><div class="shot" id="shot"><span class="muted">select a moment</span></div><div id="caption"></div></div></div>`
  const timeline = view.querySelector('#timeline')
  const shot = view.querySelector('#shot')
  const caption = view.querySelector('#caption')
  let selected = -1
  let onlyActs = false
  const visible = () =>
    rows.map((row, index) => ({ row, index })).filter(({ row }) => !onlyActs || row.cls === 'act' || row.cls === 'err' || row.cls === 'finding')
  const renderRow = (row, index) =>
    `<div class="ev ${row.cls}${index === selected ? ' sel' : ''}" data-i="${index}"><span class="t">${esc(time(row.t))} · #${row.seq}</span><span class="what">${esc(String(row.what).slice(0, 400))}</span>${row.detail ? `<span class="muted">${esc(String(row.detail).slice(0, 300))}</span>` : ''}</div>`
  const renderTimeline = () => {
    timeline.innerHTML = visible()
      .map(({ row, index }) => renderRow(row, index))
      .join('')
  }
  const select = (index) => {
    if (index < 0 || index >= rows.length) return
    selected = index
    const row = rows[index]
    timeline.querySelector('.sel')?.classList.remove('sel')
    const element = timeline.querySelector(`[data-i="${index}"]`)
    element?.classList.add('sel')
    element?.scrollIntoView({ block: 'nearest' })
    shot.innerHTML = row.shot
      ? `<img alt="Screen at #${row.seq}" src="${fileUrl(runId, row.shot)}" data-zoom="${fileUrl(runId, row.shot)}">`
      : '<span class="muted">no screenshot yet</span>'
    caption.innerHTML = `<div class="ev ${row.cls}" style="cursor:default"><span class="t">${esc(time(row.t))} · #${row.seq}</span><span class="what">${esc(row.what)}</span>${row.detail ? `<span class="muted">${esc(row.detail)}</span>` : ''}</div>`
  }
  const step = (delta) => {
    const list = visible().map(({ index }) => index)
    const position = list.indexOf(selected)
    const next = list[Math.max(0, Math.min(list.length - 1, position < 0 ? 0 : position + delta))]
    if (next !== undefined) select(next)
  }
  renderTimeline()
  timeline.addEventListener('click', (event) => {
    const element = event.target.closest('[data-i]')
    if (element) select(Number(element.dataset.i))
  })
  view.querySelector('#prev').addEventListener('click', () => step(-1))
  view.querySelector('#next').addEventListener('click', () => step(1))
  view.querySelector('#only-acts').addEventListener('change', (event) => {
    onlyActs = event.target.checked
    renderTimeline()
  })
  let player
  view.querySelector('#play').addEventListener('click', (event) => {
    if (player) {
      clearInterval(player)
      player = undefined
      event.target.textContent = 'Play'
      return
    }
    event.target.textContent = 'Pause'
    player = setInterval(() => step(1), 800)
  })
  onLeave(() => clearInterval(player))
  const keys = (event) => {
    if (event.target.closest('input, textarea, select')) return
    if (event.key === 'ArrowLeft') step(-1)
    if (event.key === 'ArrowRight') step(1)
  }
  document.addEventListener('keydown', keys)
  onLeave(() => document.removeEventListener('keydown', keys))
  const focus = focusSeq ? rows.findIndex((row) => row.seq >= focusSeq) : rows.length - 1
  select(focus >= 0 ? focus : rows.length - 1)
  liveIndicator.hidden = !state.live
  if (state.live)
    stream(runId, {
      event: (event) => {
        if (event.session !== sessionId) return
        const before = rows.length
        add(event)
        if (rows.length === before) return
        const atEnd = selected === before - 1
        if (!onlyActs || ['act', 'err', 'finding'].includes(rows.at(-1).cls)) timeline.insertAdjacentHTML('beforeend', renderRow(rows.at(-1), rows.length - 1))
        if (atEnd) select(rows.length - 1)
      },
    })
}

// Findings review --------------------------------------------------------------------------------

const STATUSES = ['new', 'approved', 'rejected', 'duplicate', 'needs-info']
const SEVERITIES = ['', 'blocker', 'major', 'minor', 'cosmetic']

async function findingsView(runId) {
  const current = stillCurrent()
  setCrumbs([['Runs', '#/'], [runId, `#/run/${runId}`], ['Findings']])
  let data = await api(`/runs/${encodeURIComponent(runId)}/findings`)
  let filter = 'all'
  // What a reviewer typed or picked but has not saved (a note, a severity, duplicate-of) survives the page
  // being redrawn after another card is reviewed or a filter is clicked.
  const drafts = new Map()
  const draft = (id, field, value) => drafts.set(id, { ...(drafts.get(id) ?? {}), [field]: value })
  const render = () => {
    if (!current()) return
    const { findings, reviews, triage } = data
    const byId = new Map(findings.map((finding) => [finding.id, finding]))
    // Reports newer than the triage (a live run) appear on their own until it runs again.
    const single = (finding) => ({
      id: finding.id,
      title: finding.title,
      members: [finding.id],
      sessions: [finding.session, ...finding.votes.map((vote) => vote.session)],
      reports: 1 + finding.votes.length,
    })
    const grouped = new Set((triage?.clusters ?? []).flatMap((cluster) => cluster.members))
    const clusters = [...(triage?.clusters ?? []), ...findings.filter((finding) => !grouped.has(finding.id)).map(single)]
    const statusOf = (id) => reviews[id]?.status ?? 'new'
    const keep = (finding) => {
      const flags = triage?.findings?.[finding.id]?.flags ?? []
      if (filter === 'all') return true
      if (filter === 'flagged') return flags.length > 0
      return statusOf(finding.id) === filter
    }
    const counts = Object.fromEntries(STATUSES.map((status) => [status, findings.filter((finding) => statusOf(finding.id) === status).length]))
    view.innerHTML = `<div class="row spread"><div><h1>Findings</h1><div class="muted">${findings.length} reports · ${clusters.length} distinct problems</div></div>
<div class="row"><button id="retriage">Re-run triage</button><button id="export-dry">Export (dry run)</button><button id="export" class="primary">Export approved</button></div></div>
<div class="filters">${['all', ...STATUSES, 'flagged'].map((name) => `<button aria-pressed="${filter === name}" data-filter="${name}">${name}${counts[name] !== undefined ? ` (${counts[name]})` : ''}</button>`).join('')}</div>
<div id="export-result" class="muted"></div>
${groupingNote(triage, runId, findings.length)}
<datalist id="finding-ids">${findings.map((finding) => `<option value="${esc(finding.id)}">${esc(finding.title.slice(0, 60))}</option>`).join('')}</datalist>
${
  clusters
    .map((cluster) => {
      const members = cluster.members
        .map((id) => byId.get(id))
        .filter(Boolean)
        .filter(keep)
      if (!members.length) return ''
      const confirmations = cluster.reports - cluster.members.length
      // A join that wording or a grouper made can be split by the reviewer; a tester's own word stands.
      const why = (cluster.links ?? [])
        .map(
          (link) =>
            `<div>${esc(describeLink(link))}${link.source === 'tester' ? '' : ` <button class="apart" data-a="${esc(link.a)}" data-b="${esc(link.b)}" title="Split: these are different problems">not the same</button>`}</div>`,
        )
        .join('')
      return `<section class="cluster"><h2>${esc(cluster.title)} <span class="muted" style="font-weight:400;font-size:13px">seen by ${cluster.sessions.length} tester${cluster.sessions.length === 1 ? '' : 's'} (${esc(cluster.sessions.join(', '))}) · ${cluster.members.length} report${cluster.members.length === 1 ? '' : 's'}${confirmations ? `, ${confirmations} confirmation${confirmations === 1 ? '' : 's'}` : ''}</span></h2>${why ? `<div class="why muted">${why}</div>` : ''}${members.map((finding) => findingCard(runId, finding, reviews[finding.id], triage?.findings?.[finding.id], drafts.get(finding.id))).join('')}</section>`
    })
    .join('') || '<div class="empty">Nothing matches this filter.</div>'
}
${triage?.knownIssues?.length ? `<section class="cluster"><h2>Known issues seen</h2>${triage.knownIssues.map((issue) => `<div><span class="mono">${esc(issue.id)}</span> ${esc(issue.title)} <span class="muted">· ${esc(issue.sessions.join(', '))}${issue.findings.length ? ` · matches ${esc(issue.findings.join(', '))}` : ''}</span></div>`).join('')}</section>` : ''}`
    for (const button of view.querySelectorAll('button.apart'))
      button.addEventListener('click', async () => {
        button.disabled = true
        await api(`/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(button.dataset.b)}/apart`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: button.dataset.a }),
        })
        data = await api(`/runs/${encodeURIComponent(runId)}/findings`)
        render()
      })
    for (const button of view.querySelectorAll('[data-filter]'))
      button.addEventListener('click', () => {
        filter = button.dataset.filter
        render()
      })
    view.querySelector('#retriage').addEventListener('click', async () => {
      await api(`/runs/${encodeURIComponent(runId)}/triage`, { method: 'POST' })
      data = await api(`/runs/${encodeURIComponent(runId)}/findings`)
      render()
    })
    const runExport = async (dryRun) => {
      const out = view.querySelector('#export-result')
      const buttons = [view.querySelector('#export'), view.querySelector('#export-dry')]
      if (buttons.some((button) => button.disabled)) return
      for (const button of buttons) button.disabled = true
      out.textContent = 'Exporting…'
      try {
        const results = await api(`/runs/${encodeURIComponent(runId)}/export`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dryRun }),
        })
        out.textContent = results.length
          ? results
              .map(
                (r) =>
                  `${r.exporter}: ${r.outcomes.filter((o) => o.ok).length} ok, ${r.outcomes.filter((o) => !o.ok).length} failed${heldBack(r.skipped)}${dryRun ? ' (dry run)' : ''}`,
              )
              .join(' · ')
          : 'No exporters are configured in this cohort.'
      } catch (error) {
        out.textContent = `Export failed: ${error.message}`
      } finally {
        for (const button of buttons) button.disabled = false
      }
    }
    view.querySelector('#export-dry').addEventListener('click', () => runExport(true))
    view.querySelector('#export').addEventListener('click', () => runExport(false))
    for (const form of view.querySelectorAll('form.review')) {
      for (const field of form.querySelectorAll('textarea, input, select'))
        field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', (event) => draft(form.dataset.id, event.target.name, event.target.value))
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const body = Object.fromEntries(new FormData(form))
        body.status = event.submitter?.value ?? body.status
        const review = await api(`/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(form.dataset.id)}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        data.reviews[form.dataset.id] = review
        drafts.delete(form.dataset.id)
        render()
      })
    }
  }
  render()
}

/** Why two reports are together, in a reviewer's words (as in the HTML report). */
function describeLink(link) {
  const pair = `${link.a} and ${link.b}`
  if (link.source === 'tester') return `${pair}: a tester said they are the same`
  if (link.source === 'wording') return `${pair}: similar wording${link.score !== undefined ? ` (${link.score})` : ''}`
  return `${pair}: ${link.by ?? 'grouping'}${link.reason ? `, "${link.reason}"` : ''}`
}

function describeKnownMatch(triaged) {
  const match = triaged.knownIssueMatch
  if (!match) return triaged.knownIssue
  if (match.source === 'wording') return `${triaged.knownIssue}, by wording${match.score !== undefined ? ` (${match.score})` : ''}`
  return `${triaged.knownIssue}, by ${match.by ?? 'grouping'}${match.reason ? `: "${match.reason}"` : ''}`
}

/** What the run's model or agent grouping did, or how to get one. */
function groupingNote(triage, runId, reports) {
  if (triage?.groupingError) return `<div class="muted why">The grouping was not used: ${esc(triage.groupingError)}</div>`
  const grouping = triage?.grouping
  if (!grouping)
    return reports > 1
      ? `<div class="muted why">Wording found these groups. A model or an agent can find the rest: <span class="mono">persona-swarm group ${esc(runId)}</span></div>`
      : ''
  const apart = grouping.keptApart.length
    ? ` Kept apart (a tester or a reviewer said they differ): ${esc(grouping.keptApart.map((link) => `${link.a} and ${link.b}`).join(', '))}.`
    : ''
  const later = grouping.notCovered.length ? ` Filed after the grouping: ${esc(grouping.notCovered.join(', '))} (group again to cover them).` : ''
  return `<div class="muted why">Grouped with ${esc(grouping.by)}: ${grouping.groups} group(s), ${grouping.joined} join(s) wording had missed, ${grouping.knownIssues} report(s) matched to known issues.${apart}${later}</div>`
}

/** Findings an export held back, by reason. */
function heldBack(skipped) {
  if (!skipped?.length) return ''
  const byReason = new Map()
  for (const item of skipped) byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item.findingId])
  return `, held back: ${[...byReason].map(([reason, ids]) => `${ids.join(', ')} (${reason})`).join('; ')}`
}

function findingCard(runId, finding, review, triaged, draft) {
  const flags = triaged?.flags ?? []
  const shot = finding.evidence?.screenshot ? fileUrl(runId, finding.evidence.screenshot) : ''
  const seq = finding.evidence?.eventSeqs?.at(-1) ?? ''
  return `<article class="finding"><div>
<div class="row"><span class="mono">${esc(finding.id)}</span><strong>${esc(finding.title)}</strong></div>
<div class="row" style="margin:4px 0"><span class="chip ${esc(finding.feltSeverity)}">felt ${esc(finding.feltSeverity)}</span>${triaged ? `<span class="chip ${esc(triaged.suggestedSeverity)}">suggested ${esc(triaged.suggestedSeverity)}</span>` : ''}<span class="chip">${esc(finding.kind)}</span><span class="chip ${esc(review?.status ?? 'new')}">${esc(review?.status ?? 'new')}${review?.severity ? ` · ${esc(review.severity)}` : ''}</span>${flags.map((flag) => `<span class="chip flag">${esc(flag)}</span>`).join('')}${finding.votes.length ? `<span class="chip ok">+${finding.votes.length}</span>` : ''}${finding.confidence === 'unsure' ? '<span class="chip flag">reporter unsure</span>' : ''}</div>
<dl><dt>Who</dt><dd>${esc(finding.session)} · <a href="#/run/${esc(runId)}/session/${encodeURIComponent(finding.session)}/${seq}">open in replay</a></dd><dt>Did</dt><dd>${esc(finding.whatIDid)}</dd><dt>Expected</dt><dd>${esc(finding.expected)}</dd><dt>Happened</dt><dd>${esc(finding.actual)}</dd><dt>Page</dt><dd class="mono">${esc(finding.url)}</dd>${finding.evidence?.media?.length ? `<dt>Files</dt><dd class="mono">${finding.evidence.media.map(esc).join('<br>')}</dd>` : ''}${triaged?.knownIssue ? `<dt>Known</dt><dd>${esc(describeKnownMatch(triaged))}</dd>` : ''}${finding.evidence?.signals?.length ? `<dt>Signals</dt><dd class="mono">${finding.evidence.signals.map((s) => esc(s.slice(0, 200))).join('<br>')}</dd>` : ''}${finding.votes.length ? `<dt>Also seen</dt><dd>${finding.votes.map((vote) => `<div>${esc(vote.session)}${vote.note ? `: ${esc(vote.note)}` : ''}${vote.screenshot ? ` · <a href="${fileUrl(runId, vote.screenshot)}" data-zoom="${fileUrl(runId, vote.screenshot)}">their screen</a>` : ''}</div>`).join('')}</dd>` : ''}</dl>
<form class="review" data-id="${esc(finding.id)}"><button name="status" value="approved" class="primary">Approve</button><button name="status" value="rejected">Reject</button><button name="status" value="needs-info">Needs info</button>
<select name="severity" aria-label="Severity">${SEVERITIES.map((s) => `<option value="${s}" ${(draft?.severity ?? review?.severity ?? '') === s ? 'selected' : ''}>${s || 'severity…'}</option>`).join('')}</select>
<input name="duplicateOf" list="finding-ids" placeholder="duplicate of… (F-n)" aria-label="Duplicate of" value="${esc(draft?.duplicateOf ?? review?.duplicateOf ?? '')}" size="14"><button name="status" value="duplicate">Mark duplicate</button>
<textarea name="note" placeholder="Reviewer note" aria-label="Reviewer note">${esc(draft?.note ?? review?.note ?? '')}</textarea></form>
</div><div>${shot ? `<img loading="lazy" alt="Screen when ${esc(finding.id)} was reported" src="${shot}" data-zoom="${shot}">` : ''}</div></article>`
}

// Router -----------------------------------------------------------------------------------------

async function routeTo() {
  generation += 1
  for (const fn of cleanup.splice(0)) fn()
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  try {
    if (parts[0] === 'run' && (!ID.test(parts[1] ?? '') || (parts[2] === 'session' && !ID.test(parts[3] ?? '')))) throw new Error('that address is not a run')
    if (parts[0] === 'run' && parts[1] && parts[2] === 'session' && parts[3]) await replayView(parts[1], parts[3], Number(parts[4] || 0))
    else if (parts[0] === 'run' && parts[1] && parts[2] === 'findings') await findingsView(parts[1])
    else if (parts[0] === 'run' && parts[1]) await runView(parts[1])
    else await runsView()
  } catch (error) {
    view.innerHTML = `<div class="empty">Could not load this page: ${esc(error.message)}</div>`
  }
}
window.addEventListener('hashchange', routeTo)
routeTo()
