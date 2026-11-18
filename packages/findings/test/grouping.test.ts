import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyUsage, type Finding, type Grouping, type KnownIssue, type RunState } from '@persona-swarm/core'
import { describe, expect, it } from 'vitest'
import {
  extractJson,
  groupFindings,
  groupingBrief,
  groupingListing,
  groupingRequest,
  loadRun,
  parseGroupingAnswer,
  readGrouping,
  renderReport,
  saveGrouping,
  triageRun,
} from '../src/index.js'

const report = (id: string, title: string, actual: string, minute: number, extra: Partial<Finding> = {}): Finding => ({
  id,
  session: minute % 2 ? 'phone' : 'desk',
  t: `2026-10-18T10:${String(minute).padStart(2, '0')}:00.000Z`,
  title,
  whatIDid: 'used the editor',
  expected: 'readable labels',
  actual,
  feltSeverity: 'annoying',
  confidence: 'sure',
  kind: 'bug',
  url: `http://app/cases/3f2a9c1e-0000-4000-8000-00000000000${minute % 10}`,
  evidence: { eventSeqs: [], signals: [] },
  votes: [],
  source: 'persona',
  ...extra,
})

/** Duplicates that wording misses (as on a real smoke run), one a tester kept apart, and one about a known issue. */
const REPORTS = [
  report('F-1', 'Landmark names pile on top of each other on the X-ray', 'the point names near the neck are written over each other', 1),
  report('F-2', 'Breadcrumb wraps with a lone arrow at the start of the second line', 'the trail breaks onto two lines', 2),
  report('F-3', 'Dates shown in three different styles on one screen', 'Acquired 2026-10-16, Created 10/18/2026', 3),
  report('F-4', 'Overlapping labels unreadable in the chin and cervical spine areas', 'C2, C3, C4 labels overlap', 4),
  report('F-5', 'Breadcrumb middle step says just Patient', 'it reads Dashboard, Patient, T0', 5, { notSameAs: ['F-2'] }),
]

const KNOWN: KnownIssue[] = [
  { id: 'K-A8', title: 'Date formats differ across the app (ISO, locale, 15 Oct 2026)' },
  { id: 'K-B7', title: 'Phone: editor toolbar overflows' },
]

function makeRun(findings: Finding[] = REPORTS, known: KnownIssue[] = KNOWN): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ps-grouping-')), '20261018-100000-abcd')
  mkdirSync(join(dir, 'events'), { recursive: true })
  const state: RunState = {
    runId: '20261018-100000-abcd',
    version: 1,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:30:00.000Z',
    status: 'finished',
    mode: 'explore',
    cohort: { id: 'c', file: '/nowhere/cohort.yaml' },
    target: { id: 't', name: 'Shop', baseUrl: 'http://app' },
    host: { platform: 'test', node: 'v22', tool: 'persona-swarm', pid: 1 },
    governor: { level: 'ok', freePercent: 50, samples: 1 },
    budgets: { minutesPerPersona: 10, turnsPerPersona: 50 },
    limits: { maxBrowsers: 1, maxAgents: 1, minFreeMemoryPercent: 10, stopBelowFreeMemoryPercent: 5 },
    sessions: {},
    totals: { ...emptyUsage(), findings: findings.length },
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify(state))
  writeFileSync(join(dir, 'findings.jsonl'), `${findings.map((item) => JSON.stringify({ type: 'finding', ...item })).join('\n')}\n`)
  writeFileSync(join(dir, 'known-issues.json'), JSON.stringify(known))
  return dir
}

const grouping = (groups: Grouping['groups'], extra: Partial<Grouping> = {}): Grouping => ({
  version: 1,
  by: 'test-model',
  t: '2026-10-18T11:00:00.000Z',
  covered: REPORTS.map((item) => item.id),
  groups,
  ...extra,
})

describe('grouping requests', () => {
  it('lists every report and known issue, with pages, and the pairs testers kept apart', async () => {
    const request = groupingRequest(await loadRun(makeRun()))
    expect(request.detail).toBe('full')
    expect(request.reports.map((item) => item.id)).toEqual(['F-1', 'F-2', 'F-3', 'F-4', 'F-5'])
    expect(request.apart).toEqual([['F-5', 'F-2']])
    const listing = groupingListing(request)
    expect(listing).toContain('F-4 (page /cases/:id, tester desk): Overlapping labels')
    expect(listing).toContain('Happened: C2, C3, C4 labels overlap')
    expect(listing).toContain('K-A8: Date formats differ')
    expect(listing).toContain('- F-5 and F-2')
    expect(groupingBrief(request, { kind: 'json' })).toContain('Answer with only a JSON object')
  })

  it('shortens reports to fit, keeping every one in the request, and refuses what cannot fit at all', async () => {
    const run = await loadRun(makeRun())
    const request = groupingRequest(run)
    const short = groupingRequest(run, { maxChars: groupingListing(request).length - 1 })
    expect(short.detail).toBe('short')
    expect(short.reports).toHaveLength(5)
    const titles = groupingListing(request, 'titles').length
    expect(groupingRequest(run, { maxChars: titles }).detail).toBe('titles')
    expect(() => groupingRequest(run, { maxChars: titles - 1 })).toThrow(/do not fit/)
  })
})

describe('grouping answers', () => {
  it('reads what models and agents write, and keeps only what the run has', async () => {
    const request = groupingRequest(await loadRun(makeRun()))
    const { groups, problems } = parseGroupingAnswer(
      {
        groups: [
          { ids: ['f1', 'F-4'], reason: 'labels overlap' },
          { ids: ['F-3', 'K-A8', 'K-B7'], reason: 'date formats' },
          { ids: ['F-99', 'F-2'] },
          { ids: ['K-A8', 'K-B7'] },
          ['F-5', 'F-2'],
        ],
      },
      request,
    )
    expect(groups).toEqual([
      { ids: ['F-1', 'F-4'], reason: 'labels overlap' },
      { ids: ['F-3', 'K-A8'], reason: 'date formats' },
      { ids: ['F-5', 'F-2'], reason: '' },
    ])
    expect(problems.join('\n')).toMatch(/kept K-A8/)
    expect(problems.join('\n')).toMatch(/"F-99" is not a report/)
    expect(problems.join('\n')).toMatch(/group 4 has none of this run's reports/)
    expect(problems.join('\n')).toMatch(/F-5 and F-2 share a group, but a tester said they differ/)
    expect(parseGroupingAnswer([['F-1', 'F-4']], request).groups).toEqual([{ ids: ['F-1', 'F-4'], reason: '' }])
    expect(parseGroupingAnswer('nonsense', request).problems).toEqual([expect.stringMatching(/no list of groups/)])
  })

  it('finds the JSON in fenced blocks, prose, and an agent CLI envelope', () => {
    const answer = { groups: [{ ids: ['F-1', 'F-4'], reason: 'x' }] }
    // A list of ids quoted in the prose is not the answer that follows it.
    expect(extractJson(`Group 1: ["F-1", "F-4"] since both overlap. ${JSON.stringify(answer)}`)).toEqual(answer)
    expect(extractJson('[]')).toEqual([])
    expect(extractJson(JSON.stringify(answer))).toEqual(answer)
    expect(extractJson(`Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\nDone.`)).toEqual(answer)
    expect(extractJson(`I looked [carefully] at all of them. ${JSON.stringify(answer)} That is all.`)).toEqual(answer)
    expect(extractJson(JSON.stringify({ type: 'result', result: `Sure: ${JSON.stringify(answer)}` }))).toEqual(answer)
    expect(extractJson('no json here')).toBeUndefined()
  })
})

describe('triage with a grouping', () => {
  it('joins what wording missed, explains every link, and never overrides a tester', () => {
    const { roots, links, refused } = groupFindings(REPORTS, {
      grouping: grouping([
        { ids: ['F-1', 'F-4'], reason: 'labels overlap' },
        { ids: ['F-5', 'F-2'], reason: 'breadcrumb' },
      ]),
    })
    expect(roots.get('F-4')).toBe('F-1')
    expect(roots.get('F-5')).toBe('F-5')
    expect(links).toEqual([{ a: 'F-1', b: 'F-4', source: 'grouping', by: 'test-model', reason: 'labels overlap' }])
    expect(refused).toEqual([{ a: 'F-5', b: 'F-2', source: 'grouping', by: 'test-model', reason: 'breadcrumb' }])
    // Without the grouping, wording alone leaves them apart.
    expect(groupFindings(REPORTS).roots.get('F-4')).toBe('F-4')
  })

  it("only adds to what wording found: a join wording made is not counted as the grouping's", async () => {
    const twins = [...REPORTS, report('F-6', 'Landmark names pile on top of each other on the X-ray', 'the point names near the neck overlap', 6)]
    const { links } = groupFindings(twins, { grouping: grouping([{ ids: ['F-1', 'F-6', 'F-4'], reason: 'labels overlap' }]) })
    expect(links.find((link) => link.b === 'F-6')).toMatchObject({ source: 'wording' })
    expect(links.find((link) => link.b === 'F-4')).toMatchObject({ source: 'grouping' })
  })

  it('joins reports that two groups matched to one known issue', () => {
    const { roots, links } = groupFindings(REPORTS, {
      grouping: grouping([
        { ids: ['F-1', 'K-B7'], reason: 'a' },
        { ids: ['F-4', 'K-B7'], reason: 'b' },
      ]),
    })
    expect(roots.get('F-4')).toBe('F-1')
    expect(links[0]).toMatchObject({ a: 'F-1', b: 'F-4', reason: 'both are K-B7' })
  })

  it('applies the stored grouping: clusters, known issues, what it could not cover, its cost', async () => {
    const dir = makeRun()
    await saveGrouping(
      dir,
      grouping(
        [
          { ids: ['F-1', 'F-4'], reason: 'labels overlap' },
          { ids: ['F-3', 'K-A8'], reason: 'three date styles' },
          { ids: ['F-5', 'F-2'], reason: 'breadcrumb' },
        ],
        { covered: ['F-1', 'F-2', 'F-3', 'F-4'], costUsd: 0.02 },
      ),
    )
    const triage = await triageRun(dir)
    expect(triage.findings['F-4']?.cluster).toBe('F-1')
    expect(triage.clusters.find((cluster) => cluster.id === 'F-1')?.links).toEqual([
      { a: 'F-1', b: 'F-4', source: 'grouping', by: 'test-model', reason: 'labels overlap' },
    ])
    expect(triage.findings['F-3']).toMatchObject({
      knownIssue: 'K-A8',
      knownIssueMatch: { source: 'grouping', by: 'test-model', reason: 'three date styles' },
      flags: ['known:K-A8'],
    })
    expect(triage.knownIssues).toEqual([{ id: 'K-A8', title: KNOWN[0]?.title, sessions: ['phone'], findings: ['F-3'] }])
    expect(triage.grouping).toMatchObject({ by: 'test-model', groups: 3, joined: 1, knownIssues: 1, notCovered: ['F-5'], costUsd: 0.02 })
    expect(triage.grouping?.keptApart.map((link) => [link.a, link.b])).toEqual([['F-5', 'F-2']])
    expect(triage.totals.costUsd).toBe(0.02)
    expect(triage.totals.clusters).toBe(4)
    const html = await renderReport(dir)
    expect(html).toContain('F-1 and F-4: test-model, &quot;labels overlap&quot;')
    expect(html).toContain('K-A8, by test-model: &quot;three date styles&quot;')
    expect(html).toContain('Kept apart because a tester or a reviewer said they differ: F-5 and F-2')
  })

  it('does not match a report to a known issue its tester ruled out, nor join it through that issue', async () => {
    const dir = makeRun([...REPORTS.slice(0, 2), report('F-3', 'Dates shown in three styles', 'mixed', 3, { notSameAs: ['K-A8'] }), REPORTS[4] as Finding])
    await saveGrouping(
      dir,
      grouping([
        { ids: ['F-3', 'K-A8'], reason: 'dates' },
        { ids: ['F-5', 'K-A8'], reason: 'dates too' },
      ]),
    )
    const triage = await triageRun(dir)
    expect(triage.findings['F-3']?.knownIssue).toBeUndefined()
    expect(triage.findings['F-5']?.knownIssue).toBe('K-A8')
    expect(triage.findings['F-3']?.cluster).toBe('F-3')
    expect(triage.grouping?.keptApart).toEqual([{ a: 'F-3', b: 'K-A8', source: 'grouping', by: 'test-model', reason: 'dates' }])
  })

  it('goes on without a grouping file that is damaged, and says why', async () => {
    const dir = makeRun()
    writeFileSync(join(dir, 'grouping.json'), '{"by": 3')
    expect((await readGrouping(dir)).error).toMatch(/not valid JSON/)
    const triage = await triageRun(dir)
    expect(triage.groupingError).toMatch(/not valid JSON/)
    expect(triage.totals.findings).toBe(5)
    writeFileSync(join(dir, 'grouping.json'), '{"groups": []}')
    expect((await triageRun(dir)).groupingError).toMatch(/does not look like a grouping/)
    expect(JSON.parse(readFileSync(join(dir, 'triage.json'), 'utf8')).groupingError).toBeTruthy()
  })
})
