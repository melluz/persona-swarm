import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Finding,
  fingerprint,
  type Grouping,
  type KnownIssue,
  problemProfile,
  problemProfileSimilarity,
  type RunEvent,
  readJsonFile,
  routePattern,
  type SessionState,
  type Severity,
  withFileLock,
  wordSet,
  writeFileAtomic,
} from '@persona-swarm/core'
import { readGrouping } from './grouping.js'
import { type LoadedRun, loadRun } from './load.js'
import { withJudgements } from './review.js'

export interface TriagedFinding {
  id: string
  session: string
  title: string
  flags: string[]
  cluster: string
  fingerprint: string
  votes: number
  suggestedSeverity: Severity | 'harness' | 'environment'
  /** Earlier runs in which the same fingerprint was seen. */
  seenInRuns: string[]
  knownIssue?: string
  /** Why it was matched to the known issue: its wording, or a grouping model's or agent's judgment. */
  knownIssueMatch?: { source: 'wording' | 'grouping'; by?: string; reason?: string; score?: number }
}

/** Why two reports are in one cluster. */
export interface ClusterLink {
  a: string
  b: string
  /** Who judged them the same: the testers themselves, a grouping model or agent, or wording and page. */
  source: 'tester' | 'grouping' | 'wording'
  /** The model or agent, for a grouping link. */
  by?: string
  reason?: string
  /** Wording similarity (with the same-page bonus), for a wording link. */
  score?: number
}

export interface Cluster {
  id: string
  title: string
  members: string[]
  /** Every session that reported or confirmed one of the members. */
  sessions: string[]
  /** Reports plus confirmations. */
  reports: number
  /** What joined the members: one link fewer than there are members. */
  links: ClusterLink[]
}

export interface GroupingSummary {
  by: string
  t: string
  groups: number
  /** Links that joined reports nothing else had joined. */
  joined: number
  /** Reports the grouping matched to a known issue. */
  knownIssues: number
  /** Grouping links a tester's "not the same" kept apart. */
  keptApart: ClusterLink[]
  /** Reports filed after the grouping ran: group again to cover them. */
  notCovered: string[]
  costUsd?: number
}

export interface KnownIssueSeen {
  id: string
  title: string
  /** Sessions that confirmed it, or reported something that matches it. */
  sessions: string[]
  /** This run's reports that match it. */
  findings: string[]
}

export interface SessionMetrics {
  session: string
  name: string
  proficiency: number
  device: string
  input: string
  driver: string
  model: string
  status: string
  outcome?: string
  minutes: number
  actions: number
  actionErrors: number
  harnessErrors: number
  harnessErrorRate: number
  backs: number
  reloads: number
  screenshots: number
  outlines: number
  notes: number
  findings: number
  /** Reports held back because they looked like one already filed. */
  reportsHeld: number
  confirmations: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  firstFindingMinutes?: number
  diary?: { ease: number; trust: number; wouldUse: string }
}

export interface Triage {
  runId: string
  t: string
  findings: Record<string, TriagedFinding>
  clusters: Cluster[]
  knownIssues: KnownIssueSeen[]
  sessions: SessionMetrics[]
  /** The model's or agent's grouping that was applied, if the run has one. */
  grouping?: GroupingSummary
  /** Why the run's grouping.json was not used. */
  groupingError?: string
  totals: {
    findings: number
    clusters: number
    knownIssuesSeen: number
    flaggedHarness: number
    flaggedEnvironment: number
    /** Sessions plus grouping. */
    costUsd: number
    sessions: number
    finished: number
  }
}

export interface Registry {
  fingerprints: Record<string, { title: string; firstSeen: string; runs: string[]; status?: string }>
}

const BASE: Record<Finding['feltSeverity'], Severity> = { blocking: 'major', annoying: 'minor', minor: 'minor', cosmetic: 'cosmetic' }
const LADDER: Severity[] = ['cosmetic', 'minor', 'major', 'blocker']

function bump(severity: Severity, steps: number): Severity {
  return LADDER[Math.min(LADDER.length - 1, LADDER.indexOf(severity) + steps)] ?? severity
}

const ms = (iso: string) => Date.parse(iso)

/** Tools that look, speak or report: not actions on the app. */
const NOT_ACTIONS = new Set(['note', 'report_problem', 'confirm_problem', 'finish', 'outline', 'screenshot', 'find_text'])

const ID = '([FK]-\\d+)'
/** What "the same …" may be about for it to be a claim about the problem ("the same page as F-2" is not). */
const PROBLEM = '(?:\\s+(?:problem|issue|bug|thing|error|fault|crash|failure|behaviou?r|one))?'
/** Phrases in which a tester says two reports are one: "same as F-2", "duplicate of F-2", "F-2 is a duplicate". */
const SAME_PHRASES = [
  new RegExp(`\\b(?:exact(?:ly)?\\s+)?(?:same|identical)${PROBLEM}\\s+(?:as|like)\\s+${ID}`, 'giu'),
  new RegExp(`\\b(?:duplicate|dupe|dup|copy|repeat)\\s+of\\s+${ID}`, 'giu'),
  new RegExp(`${ID}\\s+(?:is|was|looks|seems)\\s+(?:like\\s+)?(?:a\\s+)?(?:duplicate|dupe|dup)\\b`, 'giu'),
  // "F-2 is the same", "F-2 is the same problem", "F-2 is the same as this": not "F-2 is the same page".
  new RegExp(`${ID}\\s+(?:is|was)\\s+(?:the\\s+)?same${PROBLEM}(?=\\s*(?:[.,;:!?)]|$|\\s+(?:as|here|again)\\b))`, 'giu'),
  new RegExp(`\\b(?:already|previously)\\s+(?:reported|filed)\\s+(?:as|in)\\s+${ID}`, 'giu'),
]
const NEGATION = /\b(?:not|no|never|unlike|different|other)\b|n['’]t\b/i

/** The reports a text says it is the same as, unless the phrase is negated ("not the same as F-2"). */
export function saidSameAs(text: string): string[] {
  const ids = new Set<string>()
  for (const phrase of SAME_PHRASES)
    for (const match of text.matchAll(phrase)) {
      // Only the words just before, in the same sentence or clause, can negate it ("not the same as F-2").
      const before =
        text
          .slice(Math.max(0, (match.index ?? 0) - 24), match.index)
          .split(/[.!?;:\n]/)
          .at(-1) ?? ''
      if (!NEGATION.test(before) && !NEGATION.test(match[0])) ids.add(String(match[1]).toUpperCase())
    }
  return [...ids]
}

/**
 * What testers said themselves, in so many words: a report that calls itself the same as another
 * ("same as F-2", "duplicate of F-2"), or a confirmation whose note says so ("my F-4 is a duplicate of
 * this"). A mention alone ("unlike my F-2", "I already reported the dates as F-2") is not a link.
 */
export function explicitLinks(findings: Finding[]): [string, string][] {
  const byId = new Map(findings.map((finding) => [finding.id, finding]))
  const links: [string, string][] = []
  for (const finding of findings)
    for (const id of saidSameAs(`${finding.title}. ${finding.whatIDid}. ${finding.expected}. ${finding.actual}`))
      if (id !== finding.id && byId.has(id)) links.push([finding.id, id])
  for (const finding of findings)
    for (const vote of finding.votes) for (const id of saidSameAs(vote.note)) if (id !== finding.id && byId.has(id)) links.push([id, finding.id])
  return links
}

export interface Clustering {
  /** Each report's cluster, named by its earliest report. */
  roots: Map<string, string>
  /** The links that joined clusters, in the order they were applied. */
  links: ClusterLink[]
  /** Tester and grouping links not applied because a tester said two of the reports they would join differ. */
  refused: ClusterLink[]
}

/**
 * A grouping's links between this run's reports: each group chained, and reports that different groups
 * matched to one known issue (never a report whose tester said it is not that issue).
 */
function groupingLinks(grouping: Grouping, byId: Map<string, Finding>): ClusterLink[] {
  const links: ClusterLink[] = []
  const byKnown = new Map<string, { report: string; reason: string }[]>()
  for (const group of grouping.groups) {
    const reports = group.ids.filter((id) => byId.has(id))
    const known = group.ids.find((id) => !byId.has(id))
    for (const other of reports.slice(1)) links.push({ a: reports[0] as string, b: other, source: 'grouping', by: grouping.by, reason: group.reason })
    const member = reports.find((id) => !byId.get(id)?.notSameAs?.some((other) => other.toUpperCase() === known?.toUpperCase()))
    if (known && member) byKnown.set(known, [...(byKnown.get(known) ?? []), { report: member, reason: group.reason }])
  }
  for (const [known, entries] of byKnown)
    for (const entry of entries.slice(1))
      links.push({ a: (entries[0] as { report: string }).report, b: entry.report, source: 'grouping', by: grouping.by, reason: `both are ${known}` })
  return links
}

/**
 * Groups reports of the same problem: first what testers said (explicit links), then single-link
 * clustering on wording and page, strongest pairs first, then a grouping model's or agent's judgment
 * when the run has one, which can only add to what the others joined. Two reports a tester judged
 * different (not_same_as) never end up in one group. Each group is named by its earliest report, and
 * keeps the links that joined it.
 *
 * The wording threshold is conservative on purpose. On two real runs (19 and 65 reports) no unrelated
 * pair scored 0.36 or more, while wording alone found only some duplicates: the rest is left to the
 * testers (held reports, confirmations), to a grouping model or agent, and to the reviewer.
 */
export function groupFindings(findings: Finding[], options: { threshold?: number; grouping?: Grouping } = {}): Clustering {
  const scorer = wordingScorer(findings, options.threshold ?? 0.36)
  for (let row = 0; row < findings.length; row += 1) scorer.row(row)
  return joinReports(findings, scorer.pairs, options.grouping)
}

/**
 * The same as groupFindings, but it lets other work run every few milliseconds while it compares: a
 * re-triage during a live run (hundreds of reports) must not hold up the personas' actions.
 */
export async function groupFindingsGently(findings: Finding[], options: { threshold?: number; grouping?: Grouping } = {}): Promise<Clustering> {
  const scorer = wordingScorer(findings, options.threshold ?? 0.36)
  for (let row = 0; row < findings.length; ) {
    const until = performance.now() + 20
    while (row < findings.length && performance.now() < until) {
      scorer.row(row)
      row += 1
    }
    await new Promise((resolveTurn) => setImmediate(resolveTurn))
  }
  return joinReports(findings, scorer.pairs, options.grouping)
}

/** Wording-and-page pairs at or above the threshold, row by row. Each report's profile and page are worked out once. */
function wordingScorer(findings: Finding[], threshold: number) {
  const profiles = findings.map((finding) => problemProfile(finding))
  const routes = findings.map((finding) => (finding.url ? routePattern(finding.url) : ''))
  const pairs: ClusterLink[] = []
  return {
    pairs,
    row(i: number) {
      const a = profiles[i] as ReturnType<typeof problemProfile>
      for (let j = i + 1; j < findings.length; j += 1) {
        let score = problemProfileSimilarity(a, profiles[j] as ReturnType<typeof problemProfile>)
        if (routes[i] && routes[i] === routes[j]) score += 0.08
        if (score >= threshold)
          pairs.push({ a: (findings[i] as Finding).id, b: (findings[j] as Finding).id, source: 'wording', score: Math.round(score * 100) / 100 })
      }
    },
  }
}

/** Joins reports: testers' own links, then wording pairs (strongest first), then the grouping; never two a tester kept apart. */
function joinReports(findings: Finding[], pairs: ClusterLink[], grouping: Grouping | undefined): Clustering {
  const byId = new Map(findings.map((finding) => [finding.id, finding]))
  const parent = new Map(findings.map((finding) => [finding.id, finding.id]))
  const members = new Map(findings.map((finding) => [finding.id, [finding.id]]))
  const root = (id: string): string => {
    let current = id
    while (parent.get(current) !== current) current = parent.get(current) as string
    // Every report on the way now points at the root: long chains of joins stay cheap to follow.
    for (let step = id; step !== current; ) {
      const next = parent.get(step) as string
      parent.set(step, current)
      step = next
    }
    return current
  }
  const apart = (a: string, b: string) =>
    Boolean(byId.get(a)?.notSameAs?.some((id) => id.toUpperCase() === b) || byId.get(b)?.notSameAs?.some((id) => id.toUpperCase() === a))
  const union = (a: string, b: string): 'joined' | 'same' | 'apart' => {
    const [ra, rb] = [root(a), root(b)]
    if (ra === rb) return 'same'
    const [ma, mb] = [members.get(ra) ?? [], members.get(rb) ?? []]
    if (ma.some((x) => mb.some((y) => apart(x, y)))) return 'apart'
    const first = Date.parse((byId.get(ra) as Finding).t) <= Date.parse((byId.get(rb) as Finding).t) ? ra : rb
    const second = first === ra ? rb : ra
    parent.set(second, first)
    members.set(first, [...(members.get(first) ?? []), ...(members.get(second) ?? [])])
    members.delete(second)
    return 'joined'
  }

  const candidates: ClusterLink[] = explicitLinks(findings).map(([a, b]) => ({ a, b, source: 'tester' }))
  // Appended one by one: spreading a large list into push() would overflow the stack.
  for (const pair of [...pairs].sort((x, y) => (y.score ?? 0) - (x.score ?? 0))) candidates.push(pair)
  if (grouping) for (const link of groupingLinks(grouping, byId)) candidates.push(link)

  const links: ClusterLink[] = []
  const refused: ClusterLink[] = []
  for (const link of candidates) {
    if (link.a === link.b || !byId.has(link.a) || !byId.has(link.b)) continue
    const result = union(link.a, link.b)
    if (result === 'joined') links.push(link)
    else if (result === 'apart' && link.source !== 'wording') refused.push(link)
  }
  return { roots: new Map(findings.map((finding) => [finding.id, root(finding.id)])), links, refused }
}

/** Each report's cluster (see groupFindings). */
export function clusterFindings(findings: Finding[], threshold = 0.36): Map<string, string> {
  return groupFindings(findings, { threshold }).roots
}

const LEAVING_WORDS = /\b(link|links|window|tab|website|site|open|opens|opened|opening)\b/i

/**
 * The test, not the app, stopped a link or pop-up shortly before this report, and the report talks
 * about it: its words name the blocked address (help, chat, portal) or a link or window.
 */
export function aboutBlockedNavigation(finding: Finding, events: RunEvent[], windowMs = 3 * 60_000): boolean {
  const reportedAt = ms(finding.t)
  const blocked = events.filter(
    (event) => event.type === 'device.signal' && event.kind === 'blocked' && ms(event.t) <= reportedAt && reportedAt - ms(event.t) <= windowMs,
  )
  if (!blocked.length) return false
  const text = `${finding.title} ${finding.actual}`
  if (LEAVING_WORDS.test(text)) return true
  const said = wordSet(text)
  return blocked.some((event) => {
    let path = ''
    try {
      path = new URL(String(event.url)).pathname
    } catch {
      return false
    }
    return [...wordSet(path)].some((word) => /\p{L}/u.test(word) && said.has(word))
  })
}

type ProfiledIssue = { issue: KnownIssue; profile: ReturnType<typeof problemProfile> }

const profileIssues = (issues: KnownIssue[]): ProfiledIssue[] =>
  issues.map((issue) => ({ issue, profile: problemProfile({ title: issue.title, actual: issue.description ?? '' }) }))

function bestKnownIssue(finding: Finding, issues: ProfiledIssue[], threshold: number): { issue: KnownIssue; score: number } | undefined {
  const profile = problemProfile(finding)
  let best: { issue: KnownIssue; score: number } | undefined
  for (const { issue, profile: other } of issues) {
    if (finding.notSameAs?.some((id) => id.toUpperCase() === issue.id.toUpperCase())) continue
    const score = problemProfileSimilarity(profile, other)
    if (score >= threshold && (!best || score > best.score)) best = { issue, score }
  }
  return best
}

/** The known issue a report most likely describes, unless its reporter said it is a different one. */
export function matchKnownIssue(finding: Finding, issues: KnownIssue[], threshold = 0.35): KnownIssue | undefined {
  return bestKnownIssue(finding, profileIssues(issues), threshold)?.issue
}

/**
 * Did the actions just before this report fail inside the harness rather than in the app? Only the
 * last few minutes count, and the action right before the report must itself be a harness failure:
 * a persona who hit harness errors earlier and then acted successfully is reporting the app.
 */
export function harnessSuspect(finding: Finding, events: RunEvent[], windowMs = 3 * 60_000): boolean {
  const reportedAt = ms(finding.t)
  const recent = events
    .filter(
      (event) =>
        event.type === 'tool.result' &&
        ms(event.t) <= reportedAt &&
        reportedAt - ms(event.t) <= windowMs &&
        !NOT_ACTIONS.has(String(event.tool)) &&
        event.refused !== true,
    )
    .slice(-6)
  if (!recent.length || recent.at(-1)?.harnessError !== true) return false
  return recent.filter((event) => event.harnessError === true).length / recent.length >= 0.5
}

function environmentFlags(finding: Finding, runEvents: RunEvent[]): string[] {
  const reportedAt = ms(finding.t)
  const flags = new Set<string>()
  for (const event of runEvents) {
    const at = ms(event.t)
    if (at > reportedAt || reportedAt - at > 6 * 60_000) continue
    if (event.type === 'dependency' && ['refused-waited-too-long', 'upstream-error', 'upstream-timeout', 'stubbed'].includes(String(event.event)))
      flags.add(`environment:${String(event.dependency)}`)
    if (event.type === 'governor' && event.level === 'critical' && reportedAt - at < 2 * 60_000) flags.add('governor')
  }
  return [...flags]
}

function sessionMetrics(state: SessionState, events: RunEvent[], findings: Finding[]): SessionMetrics {
  const results = events.filter((event) => event.type === 'tool.result')
  const calls = events.filter((event) => event.type === 'tool.call')
  const count = (tool: string) => calls.filter((event) => event.tool === tool).length
  const actions = results.filter((event) => !NOT_ACTIONS.has(String(event.tool)) && event.refused !== true)
  const start = state.startedAt ? ms(state.startedAt) : events[0] ? ms(events[0].t) : 0
  const end = state.endedAt ? ms(state.endedAt) : events.at(-1) ? ms((events.at(-1) as RunEvent).t) : start
  const own = findings.filter((finding) => finding.session === state.id).sort((a, b) => ms(a.t) - ms(b.t))
  const diary = events.find((event) => event.type === 'diary')
  const harnessErrors = results.filter((event) => event.harnessError === true).length
  return {
    session: state.id,
    name: state.name,
    proficiency: state.proficiency,
    device: state.device,
    input: state.input,
    driver: state.driver,
    model: state.model,
    status: state.status,
    ...(state.outcome ? { outcome: state.outcome } : {}),
    minutes: Math.round(((end - start) / 60_000) * 10) / 10,
    actions: actions.length,
    actionErrors: actions.filter((event) => event.ok === false && event.harnessError !== true).length,
    harnessErrors,
    harnessErrorRate: results.length ? Math.round((harnessErrors / results.length) * 100) / 100 : 0,
    backs: count('back'),
    reloads: count('reload'),
    screenshots: count('screenshot'),
    outlines: count('outline') + count('find_text'),
    notes: count('note'),
    findings: own.length,
    reportsHeld: results.filter((event) => event.tool === 'report_problem' && String(event.message).startsWith('held')).length,
    confirmations: count('confirm_problem'),
    costUsd: Math.round(state.usage.costUsd * 10_000) / 10_000,
    inputTokens: state.usage.inputTokens,
    outputTokens: state.usage.outputTokens,
    ...(own[0] && start ? { firstFindingMinutes: Math.round(((ms(own[0].t) - start) / 60_000) * 10) / 10 } : {}),
    ...(diary ? { diary: { ease: Number(diary.ease), trust: Number(diary.trust), wouldUse: String(diary.wouldUse) } } : {}),
  }
}

const modifiedAt = (file: string) => (existsSync(file) ? statSync(file).mtimeMs : 0)

/** Whether a run's triage.json is newer than everything it was made from (reports, the grouping, the known issues). */
export function triageIsFresh(runDir: string): boolean {
  const made = modifiedAt(join(runDir, 'triage.json'))
  return made > 0 && ['findings.jsonl', 'grouping.json', 'known-issues.json'].every((name) => modifiedAt(join(runDir, name)) <= made)
}

/**
 * The run's triage as it is now: triage.json when it is newer than its sources and covers every
 * report (one filed while a triage of a live run was working is newer than nothing, but not in it),
 * else a fresh one.
 */
export async function currentTriage(runDir: string, options: { registryFile?: string; write?: boolean } = {}): Promise<Triage> {
  if (triageIsFresh(runDir)) {
    const stored = await readJsonFile<Triage | undefined>(join(runDir, 'triage.json'), undefined).catch(() => undefined)
    const { findings } = await loadRun(runDir)
    if (stored && findings.every((finding) => stored.findings[finding.id])) return stored
  }
  return triageRun(runDir, options)
}

/**
 * The post-run pipeline. Deterministic and re-runnable: it reads the run folder and writes
 * `triage.json` (and updates the cross-run registry when one is given).
 */
export async function triageRun(runDir: string, options: { registryFile?: string; write?: boolean } = {}): Promise<Triage> {
  const loaded: LoadedRun = await loadRun(runDir)
  // What reviewers split ("not the same") counts as a tester's "not the same": never grouped, never matched.
  const run: LoadedRun = { ...loaded, findings: loaded.findings.map((finding) => withJudgements(finding, loaded.reviews[finding.id])) }
  const runEvents = run.sessions.includes('_run') ? await run.events('_run') : []
  const registry = options.registryFile ? await readJsonFile<Registry>(options.registryFile, { fingerprints: {} }) : { fingerprints: {} }
  const reportIds = new Set(run.findings.map((finding) => finding.id))
  const knownById = new Map(run.knownIssues.map((issue) => [issue.id, issue]))
  // A grouping names only this run's reports and known issues (the file may have been edited by hand).
  const stored = await readGrouping(run.dir)
  const groupingError = stored.error
  const grouping = stored.grouping && {
    ...stored.grouping,
    groups: stored.grouping.groups.map((group) => ({ ...group, ids: group.ids.filter((id) => reportIds.has(id) || knownById.has(id)) })),
  }
  const clustering = await groupFindingsGently(run.findings, grouping ? { grouping } : {})
  const clusters = clustering.roots
  const knownProfiles = profileIssues(run.knownIssues)
  const triaged: Record<string, TriagedFinding> = {}

  // The grouping's known issues, report by report (never one the reporter said it is not).
  const groupedKnown = new Map<string, { issue: KnownIssue; reason: string }>()
  const knownKeptApart: ClusterLink[] = []
  for (const group of grouping?.groups ?? []) {
    const issue = knownById.get(group.ids.find((id) => !reportIds.has(id)) ?? '')
    if (!issue) continue
    for (const id of group.ids) {
      const finding = run.findings.find((candidate) => candidate.id === id)
      if (!finding || groupedKnown.has(id)) continue
      if (finding.notSameAs?.some((other) => other.toUpperCase() === issue.id.toUpperCase()))
        knownKeptApart.push({ a: id, b: issue.id, source: 'grouping', by: grouping?.by as string, reason: group.reason })
      else groupedKnown.set(id, { issue, reason: group.reason })
    }
  }

  const knownSeen = new Map<string, KnownIssueSeen>(
    run.knownHits.map((hit) => [hit.id, { id: hit.id, title: hit.title, sessions: [...new Set(hit.votes.map((vote) => vote.session))], findings: [] }]),
  )
  for (const finding of run.findings) {
    const events = await run.events(finding.session)
    const flags = environmentFlags(finding, runEvents)
    if (harnessSuspect(finding, events)) flags.push('harness-suspect')
    if (aboutBlockedNavigation(finding, events)) flags.push('navigation-blocked')
    if (finding.confidence === 'unsure') flags.push('reporter-unsure')
    const fromGrouping = groupedKnown.get(finding.id)
    const byWording = fromGrouping ? undefined : bestKnownIssue(finding, knownProfiles, 0.35)
    const known = fromGrouping?.issue ?? byWording?.issue
    const knownIssueMatch: TriagedFinding['knownIssueMatch'] = fromGrouping
      ? { source: 'grouping', by: grouping?.by as string, ...(fromGrouping.reason ? { reason: fromGrouping.reason } : {}) }
      : byWording
        ? { source: 'wording', score: Math.round(byWording.score * 100) / 100 }
        : undefined
    if (known) {
      flags.push(`known:${known.id}`)
      const seen = knownSeen.get(known.id) ?? { id: known.id, title: known.title, sessions: [], findings: [] }
      seen.findings.push(finding.id)
      if (!seen.sessions.includes(finding.session)) seen.sessions.push(finding.session)
      knownSeen.set(known.id, seen)
    }
    const print = fingerprint(finding.title, finding.url)
    // Run ids sort by time: only runs before this one are "earlier" (re-triaging an old run must not count later ones).
    const earlier = (registry.fingerprints[print]?.runs ?? []).filter((runId) => runId < run.state.runId)
    const votes = finding.votes.length
    let suggested: TriagedFinding['suggestedSeverity'] = bump(BASE[finding.feltSeverity], votes >= 2 ? 1 : 0)
    if (flags.includes('harness-suspect')) suggested = 'harness'
    else if (flags.some((flag) => flag.startsWith('environment:'))) suggested = 'environment'
    triaged[finding.id] = {
      id: finding.id,
      session: finding.session,
      title: finding.title,
      flags,
      cluster: clusters.get(finding.id) ?? finding.id,
      fingerprint: print,
      votes,
      suggestedSeverity: suggested,
      seenInRuns: earlier,
      ...(known ? { knownIssue: known.id, knownIssueMatch } : {}),
    }
  }

  const groups = new Map<string, Finding[]>()
  for (const finding of run.findings) {
    const id = clusters.get(finding.id) ?? finding.id
    groups.set(id, [...(groups.get(id) ?? []), finding])
  }
  const clusterList: Cluster[] = [...groups.entries()]
    .map(([id, members]) => ({
      id,
      title: members.find((member) => member.id === id)?.title ?? members[0]?.title ?? id,
      members: members.map((member) => member.id),
      sessions: [...new Set(members.flatMap((member) => [member.session, ...member.votes.map((vote) => vote.session)]))],
      reports: members.length + members.reduce((sum, member) => sum + member.votes.length, 0),
      links: clustering.links.filter((link) => clusters.get(link.a) === id),
    }))
    .sort((a, b) => b.sessions.length - a.sessions.length || b.reports - a.reports)

  const groupingCost = grouping?.costUsd ?? 0
  const summary: GroupingSummary | undefined = grouping && {
    by: grouping.by,
    t: grouping.t,
    groups: grouping.groups.length,
    joined: clustering.links.filter((link) => link.source === 'grouping').length,
    knownIssues: groupedKnown.size,
    keptApart: [...clustering.refused.filter((link) => link.source === 'grouping'), ...knownKeptApart],
    notCovered: run.findings.filter((finding) => !grouping.covered.includes(finding.id)).map((finding) => finding.id),
    ...(grouping.costUsd !== undefined ? { costUsd: grouping.costUsd } : {}),
  }

  const sessions: SessionMetrics[] = []
  for (const state of Object.values(run.state.sessions)) sessions.push(sessionMetrics(state, await run.events(state.id), run.findings))

  const triage: Triage = {
    runId: run.state.runId,
    t: new Date().toISOString(),
    findings: triaged,
    clusters: clusterList,
    knownIssues: [...knownSeen.values()],
    sessions,
    ...(summary ? { grouping: summary } : {}),
    ...(groupingError ? { groupingError } : {}),
    totals: {
      findings: run.findings.length,
      clusters: clusterList.length,
      knownIssuesSeen: knownSeen.size,
      flaggedHarness: Object.values(triaged).filter((finding) => finding.flags.includes('harness-suspect')).length,
      flaggedEnvironment: Object.values(triaged).filter((finding) => finding.flags.some((flag) => flag.startsWith('environment:'))).length,
      costUsd: Math.round((sessions.reduce((sum, session) => sum + session.costUsd, 0) + groupingCost) * 10_000) / 10_000,
      sessions: sessions.length,
      finished: sessions.filter((session) => session.status === 'finished').length,
    },
  }

  if (options.write !== false) {
    await writeFileAtomic(`${run.dir}/triage.json`, `${JSON.stringify(triage, null, 2)}\n`)
    const registryFile = options.registryFile
    if (registryFile)
      // Re-read under the lock: another run or the UI may have added fingerprints since.
      await withFileLock(registryFile, async () => {
        const current = await readJsonFile<Registry>(registryFile, { fingerprints: {} })
        for (const finding of Object.values(triaged)) {
          const entry = current.fingerprints[finding.fingerprint] ?? { title: finding.title, firstSeen: run.state.runId, runs: [] }
          if (!entry.runs.includes(run.state.runId)) entry.runs = [...entry.runs, run.state.runId].sort()
          if (run.state.runId < entry.firstSeen) entry.firstSeen = run.state.runId
          const review = run.reviews[finding.id]
          if (review) entry.status = review.status
          current.fingerprints[finding.fingerprint] = entry
        }
        await writeFileAtomic(registryFile, `${JSON.stringify(current, null, 2)}\n`)
      })
  }
  return triage
}
