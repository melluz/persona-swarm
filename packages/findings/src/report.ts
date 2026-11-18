import { join } from 'node:path'
import { type Finding, type MediaItem, type Review, readJsonFile, writeFileAtomic } from '@persona-swarm/core'
import { loadRun } from './load.js'
import { type ClusterLink, currentTriage, type SessionMetrics, type Triage, type TriagedFinding } from './triage.js'

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const dots = (n: number) => '●'.repeat(n) + '○'.repeat(Math.max(0, 5 - n))

/** Drivers that play through an outside agent report no usage: show a dash, not a misleading $0. */
const cost = (session: SessionMetrics) => (session.inputTokens || session.costUsd ? `$${session.costUsd.toFixed(2)}` : '–')

const mean = (values: number[]) => (values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : undefined)

/** Ease, trust and outcomes per group of sessions: how proficiency or input changes the experience. */
function aggregateRows(sessions: SessionMetrics[], key: (session: SessionMetrics) => string): string {
  const groups = new Map<string, SessionMetrics[]>()
  for (const session of sessions) groups.set(key(session), [...(groups.get(key(session)) ?? []), session])
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, members]) => {
      const diaries = members.flatMap((member) => (member.diary ? [member.diary] : []))
      const outcomes = ['completed', 'gave_up', 'blocked', 'ran_out_of_time'].map((outcome) => members.filter((member) => member.outcome === outcome).length)
      const use = ['yes', 'maybe', 'no'].map((answer) => diaries.filter((diary) => diary.wouldUse === answer).length)
      return `<tr><td>${esc(group)}</td><td class="num">${members.length}</td><td class="num">${mean(diaries.map((diary) => diary.ease)) ?? '–'}</td><td class="num">${mean(diaries.map((diary) => diary.trust)) ?? '–'}</td><td class="num">${use.join(' / ')}</td><td class="num">${outcomes.join(' / ')}</td><td class="num">${members.reduce((sum, member) => sum + member.findings + member.confirmations, 0)}</td></tr>`
    })
    .join('')
}

const STYLE = `
:root{--bg:#f4f5f2;--surface:#fff;--ink:#1b2126;--muted:#5d6872;--line:#d9dcd6;--accent:#1d6b58;--major:#b42318;--minor:#365f8a;--cos:#6b7480;--warn:#9a5b00;--soft:#eef1ec;
--f:"Inter Tight","Segoe UI",system-ui,sans-serif;--m:ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#111518;--surface:#181e22;--ink:#e5e9ec;--muted:#98a4ad;--line:#2a3238;--accent:#5fc7a8;--major:#ff8b7d;--minor:#93b8e0;--cos:#a2abb4;--warn:#f0b35a;--soft:#1e262b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--f);padding:32px max(16px,env(safe-area-inset-left)) 64px}
main{max-width:1180px;margin:0 auto;display:grid;gap:36px}h1{font-size:30px;margin:0}h2{font-size:21px;margin:0 0 10px}h3{font-size:16px;margin:0}
.muted{color:var(--muted)}.mono{font-family:var(--m);font-size:12.5px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}
.stat{background:var(--surface);padding:12px 14px}.stat b{display:block;font-size:24px}
.frame{overflow-x:auto;border:1px solid var(--line);background:var(--surface)}table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font:600 11px var(--m);text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:var(--soft);white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums}.prof{color:var(--accent);letter-spacing:1px;white-space:nowrap}
.chip{display:inline-block;font:600 11px var(--m);padding:1px 6px;border-radius:3px;background:var(--soft);color:var(--muted);margin:0 4px 4px 0;white-space:nowrap}
.chip.major,.chip.blocker,.chip.blocking{color:var(--major)}.chip.minor,.chip.annoying{color:var(--minor)}.chip.flag{color:var(--warn)}.chip.ok{color:var(--accent)}
.cluster{background:var(--surface);border:1px solid var(--line);padding:16px 18px;display:grid;gap:12px}
.finding{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:14px;border-top:1px solid var(--line);padding-top:12px}
.finding img{width:100%;border:1px solid var(--line);border-radius:4px}.finding dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:6px 0 0}
.finding dt{font:600 11px var(--m);color:var(--muted);text-transform:uppercase;padding-top:2px}.finding dd{margin:0}
details summary{cursor:pointer;color:var(--muted)}@media (max-width:760px){.finding{grid-template-columns:1fr}}
blockquote{margin:6px 0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
.why{font-size:13.5px;border-left:3px solid var(--line);padding-left:10px}`

/** Why two reports are together, in a reviewer's words. */
export function describeLink(link: ClusterLink): string {
  const pair = `${link.a} and ${link.b}`
  if (link.source === 'tester') return `${pair}: a tester said they are the same`
  if (link.source === 'wording') return `${pair}: similar wording${link.score !== undefined ? ` (${link.score})` : ''}`
  return `${pair}: ${link.by ?? 'grouping'}${link.reason ? `, "${link.reason}"` : ''}`
}

/** How a report was matched to a known issue. */
export function describeKnownMatch(triaged: TriagedFinding): string {
  const match = triaged.knownIssueMatch
  if (!triaged.knownIssue || !match) return triaged.knownIssue ?? ''
  if (match.source === 'wording') return `${triaged.knownIssue}, by wording${match.score !== undefined ? ` (${match.score})` : ''}`
  return `${triaged.knownIssue}, by ${match.by ?? 'grouping'}${match.reason ? `: "${match.reason}"` : ''}`
}

/** What the run's grouping did, or why it was not used. */
function groupingNote(triage: Triage): string {
  if (triage.groupingError) return `<p class="muted">The grouping was not used: ${esc(triage.groupingError)}</p>`
  const grouping = triage.grouping
  if (!grouping) return ''
  const apart = grouping.keptApart.length
    ? ` Kept apart because a tester or a reviewer said they differ: ${grouping.keptApart.map((link) => `${esc(link.a)} and ${esc(link.b)}`).join(', ')}.`
    : ''
  const later = grouping.notCovered.length ? ` Filed after the grouping, not covered: ${esc(grouping.notCovered.join(', '))}.` : ''
  return `<p class="muted">Grouped with ${esc(grouping.by)} (${esc(grouping.t.replace('T', ' ').slice(0, 16))} UTC): ${grouping.groups} group(s), ${grouping.joined} join(s) wording had missed, ${grouping.knownIssues} report(s) matched to known issues.${apart}${later}</p>`
}

/** The files a report was made with, from the run's media.json: what they are, their ground truth and notes. */
function mediaRows(finding: Finding, media: Record<string, MediaItem[]>): string {
  const names = finding.evidence.media ?? []
  if (!names.length) return ''
  const known = new Map((media[finding.session] ?? []).map((item) => [item.name, item]))
  const rows = names.map((name) => {
    const item = known.get(name)
    const details = [item?.description, item?.tags.length ? `tags ${item.tags.join(', ')}` : '', item?.notes].filter(Boolean).map(esc)
    return `<div><span class="mono">${esc(name)}</span>${details.length ? ` · ${details.join(' · ')}` : ''}${item?.truth ? `<div class="muted mono">truth: ${esc(item.truth)}</div>` : ''}</div>`
  })
  return `<dt>Files</dt><dd>${rows.join('')}</dd>`
}

function findingBlock(finding: Finding, triage: Triage | undefined, review: Review | undefined, media: Record<string, MediaItem[]> = {}): string {
  const triaged = triage?.findings[finding.id]
  const flags = triaged?.flags ?? []
  const status = review
    ? `<span class="chip ${review.status === 'approved' ? 'ok' : ''}">${esc(review.status)}${review.severity ? ` · ${esc(review.severity)}` : ''}</span>`
    : ''
  return `<article class="finding" id="${esc(finding.id)}"><div>
<h3><span class="mono">${esc(finding.id)}</span> ${esc(finding.title)}</h3>
<div><span class="chip ${esc(finding.feltSeverity)}">felt ${esc(finding.feltSeverity)}</span><span class="chip ${esc(triaged?.suggestedSeverity ?? '')}">suggested ${esc(triaged?.suggestedSeverity ?? '?')}</span><span class="chip">${esc(finding.kind)}</span>${status}${flags.map((flag) => `<span class="chip flag">${esc(flag)}</span>`).join('')}${finding.votes.length ? `<span class="chip ok">+${finding.votes.length} confirmed</span>` : ''}${triaged?.seenInRuns.length ? `<span class="chip flag">seen in ${triaged.seenInRuns.length} earlier run(s)</span>` : ''}</div>
<dl><dt>Who</dt><dd>${esc(finding.session)}${finding.confidence === 'unsure' ? ' (not sure)' : ''}</dd><dt>Did</dt><dd>${esc(finding.whatIDid)}</dd><dt>Expected</dt><dd>${esc(finding.expected)}</dd><dt>Happened</dt><dd>${esc(finding.actual)}</dd><dt>Page</dt><dd class="mono">${esc(finding.url)}</dd>${mediaRows(finding, media)}${triaged?.knownIssue ? `<dt>Known</dt><dd>${esc(describeKnownMatch(triaged))}</dd>` : ''}</dl>
${finding.votes.length ? `<details><summary>Confirmations (${finding.votes.length})</summary>${finding.votes.map((vote) => `<blockquote>${esc(vote.session)}: ${esc(vote.note)}${vote.screenshot ? ` <a href="${esc(vote.screenshot)}">their screen</a>` : ''}</blockquote>`).join('')}</details>` : ''}
${finding.evidence.signals.length ? `<details><summary>Signals (${finding.evidence.signals.length})</summary><pre class="mono" style="white-space:pre-wrap">${esc(finding.evidence.signals.join('\n'))}</pre></details>` : ''}
</div><div>${finding.evidence.screenshot ? `<a href="${esc(finding.evidence.screenshot)}"><img loading="lazy" alt="Screen when ${esc(finding.id)} was reported" src="${esc(finding.evidence.screenshot)}"></a>` : ''}</div></article>`
}

/** Renders the run report (self-contained HTML; screenshots are referenced relative to the run folder). */
export async function renderReport(runDir: string, options: { registryFile?: string } = {}): Promise<string> {
  const run = await loadRun(runDir)
  // A triage that leaves reports out (a run stopped before its wrap-up, then resumed) is made again.
  const triage = await currentTriage(runDir, options.registryFile ? { registryFile: options.registryFile } : {})
  const state = run.state
  const byId = new Map(run.findings.map((finding) => [finding.id, finding]))
  const media = (await readJsonFile<{ sessions?: Record<string, MediaItem[]> }>(join(run.dir, 'media.json'), {})).sessions ?? {}
  const sessions = triage.sessions
    .map(
      (session) =>
        `<tr><td>${esc(session.name)}<div class="muted mono">${esc(session.session)}</div></td><td class="prof">${dots(session.proficiency)}</td><td>${esc(session.device)}</td><td class="mono">${esc(session.driver)}<br>${esc(session.model)}</td><td>${esc(session.status)}${session.outcome ? `<br><span class="muted">${esc(session.outcome)}</span>` : ''}</td><td class="num">${session.minutes}</td><td class="num">${session.actions}</td><td class="num">${session.actionErrors}</td><td class="num">${Math.round(session.harnessErrorRate * 100)}%</td><td class="num">${session.backs}/${session.reloads}</td><td class="num">${session.notes}</td><td class="num">${session.findings}</td><td class="num">${session.diary ? `${session.diary.ease}/${session.diary.trust} · ${esc(session.diary.wouldUse)}` : '–'}</td><td class="num">${cost(session)}</td></tr>`,
    )
    .join('')
  const clusters = triage.clusters
    .map((cluster) => {
      const members = cluster.members.map((id) => byId.get(id)).filter((finding): finding is Finding => Boolean(finding))
      const why = (cluster.links ?? []).map((link) => `<div>${esc(describeLink(link))}</div>`).join('')
      return `<section class="cluster"><h2>${esc(cluster.title)}</h2><div class="muted">Seen by ${cluster.sessions.length} tester${cluster.sessions.length === 1 ? '' : 's'} (${esc(cluster.sessions.join(', '))}) · ${cluster.members.length} report${cluster.members.length === 1 ? '' : 's'}, ${cluster.reports - cluster.members.length} confirmation${cluster.reports - cluster.members.length === 1 ? '' : 's'}</div>${why ? `<div class="muted why">${why}</div>` : ''}${members.map((finding) => findingBlock(finding, triage, run.reviews[finding.id], media)).join('')}</section>`
    })
    .join('')
  const diaries: string[] = []
  for (const session of run.sessions.filter((id) => id !== '_run')) {
    const diary = (await run.events(session)).find((event) => event.type === 'diary')
    if (diary) diaries.push(`<tr><td>${esc(session)}</td><td>${esc(diary.outcome)}</td><td>${esc(diary.summary)}</td><td>${esc(diary.why)}</td></tr>`)
  }
  const known = (triage.knownIssues ?? [])
    .map(
      (issue) =>
        `<tr><td class="mono">${esc(issue.id)}</td><td>${esc(issue.title)}</td><td>${esc(issue.sessions.join(', '))}</td><td>${issue.findings.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join(', ') || '–'}</td></tr>`,
    )
    .join('')
  const withDiary = triage.sessions.filter((session) => session.diary)
  const aggregate =
    withDiary.length >= 2
      ? `<section><h2>Across the cohort</h2><div class="frame"><table><thead><tr><th>Group</th><th class="num">Sessions</th><th class="num">Ease</th><th class="num">Trust</th><th class="num">Would use yes/maybe/no</th><th class="num">Completed/gave up/blocked/out of time</th><th class="num">Reports + confirmations</th></tr></thead><tbody>${aggregateRows(triage.sessions, (session) => `proficiency ${session.proficiency}`)}${aggregateRows(triage.sessions, (session) => `${session.input} input`)}</tbody></table></div></section>`
      : ''
  const totalCost = triage.sessions.some((session) => session.inputTokens || session.costUsd) ? `$${triage.totals.costUsd.toFixed(2)}` : '–'
  const started = state.createdAt.replace('T', ' ').slice(0, 16)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(state.target.name)} · run ${esc(state.runId)}</title><style>${STYLE}</style></head><body><main>
<header><div class="muted mono">persona-swarm · ${esc(state.mode)} run ${esc(state.runId)} · started ${esc(started)} UTC · ${esc(state.status)}${state.statusReason ? ` (${esc(state.statusReason)})` : ''}</div><h1>${esc(state.target.name)}</h1><div class="muted">${esc(state.cohort.id)}${state.cohort.description ? ` · ${esc(state.cohort.description)}` : ''} · ${esc(state.target.baseUrl)}</div></header>
<section class="stats"><div class="stat"><b>${triage.totals.sessions}</b>sessions (${triage.totals.finished} finished)</div><div class="stat"><b>${triage.totals.findings}</b>reports</div><div class="stat"><b>${triage.totals.clusters}</b>distinct problems</div><div class="stat"><b>${triage.totals.flaggedHarness}</b>harness-suspect</div><div class="stat"><b>${triage.totals.flaggedEnvironment}</b>environment-related</div><div class="stat"><b>${totalCost}</b>model cost</div></section>
<section><h2>Sessions</h2><div class="frame"><table><thead><tr><th>Persona</th><th>Prof.</th><th>Device</th><th>Driver</th><th>Status</th><th class="num">Min</th><th class="num">Actions</th><th class="num">App errors</th><th class="num">Harness err.</th><th class="num">Back/reload</th><th class="num">Notes</th><th class="num">Reports</th><th class="num">Ease/trust</th><th class="num">Cost</th></tr></thead><tbody>${sessions}</tbody></table></div></section>
${aggregate}
<section><h2>Problems, grouped</h2>${groupingNote(triage)}${clusters || '<p class="muted">No problems were reported.</p>'}</section>
${known ? `<section><h2>Known issues seen</h2><div class="frame"><table><thead><tr><th>Id</th><th>Issue</th><th>Seen by</th><th>Matching reports</th></tr></thead><tbody>${known}</tbody></table></div></section>` : ''}
${diaries.length ? `<section><h2>In their words</h2><div class="frame"><table><thead><tr><th>Session</th><th>Outcome</th><th>Summary</th><th>Why</th></tr></thead><tbody>${diaries.join('')}</tbody></table></div></section>` : ''}
<footer class="muted mono">Generated ${esc(new Date().toISOString())}. Suggested severities come from the personas' felt severity, confirmations and triage flags; review before filing.</footer>
</main></body></html>`
}

export async function writeReport(runDir: string, options: { registryFile?: string } = {}): Promise<string> {
  const run = await loadRun(runDir)
  const file = join(run.dir, 'report.html')
  await writeFileAtomic(file, await renderReport(runDir, options))
  return file
}
