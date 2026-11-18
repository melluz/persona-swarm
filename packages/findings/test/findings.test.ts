import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPORTER_TYPES, emptyUsage, type Finding, type RunEvent, type RunState } from '@persona-swarm/core'
import { describe, expect, it } from 'vitest'
import {
  aboutBlockedNavigation,
  BUILT_IN_EXPORTERS,
  clusterFindings,
  defang,
  exporterIds,
  exportRun,
  harnessSuspect,
  matchKnownIssue,
  readFindingsFile,
  renderReport,
  setApart,
  setReview,
  triageRun,
  writeReport,
} from '../src/index.js'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const finding = (id: string, title: string, actual: string, t: string, session = 's1'): Finding => ({
  id,
  session,
  t,
  title,
  whatIDid: 'clicked save',
  expected: 'saved',
  actual,
  feltSeverity: 'blocking',
  confidence: 'sure',
  kind: 'bug',
  url: 'http://app/orders/new',
  evidence: { eventSeqs: [], signals: [] },
  votes: [],
  source: 'persona',
})

function fakeRun(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ps-findings-')), '20261017-000000-abcd')
  mkdirSync(join(dir, 'events'), { recursive: true })
  const session = {
    id: 's1',
    personaId: 'p',
    name: 'Pat',
    proficiency: 2,
    device: 'Laptop',
    input: 'mouse',
    toolProfile: 'sight',
    driver: 'mock',
    model: 'default',
    status: 'finished' as const,
    attempts: 1,
    turns: 5,
    toolCalls: 6,
    toolErrors: 0,
    harnessErrors: 4,
    findings: 3,
    usage: emptyUsage(),
    startedAt: '2026-10-17T10:00:00.000Z',
    endedAt: '2026-10-17T10:10:00.000Z',
  }
  const state: RunState = {
    runId: '20261017-000000-abcd',
    version: 1,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:10:00.000Z',
    status: 'finished',
    mode: 'explore',
    cohort: { id: 'c', file: '/nowhere/cohort.yaml' },
    target: { id: 't', name: 'Shop', baseUrl: 'http://app' },
    host: { platform: 'test', node: 'v22', tool: 'persona-swarm', pid: 1 },
    governor: { level: 'ok', freePercent: 50, samples: 1 },
    budgets: { minutesPerPersona: 10, turnsPerPersona: 50 },
    limits: { maxBrowsers: 1, maxAgents: 1, minFreeMemoryPercent: 10, stopBelowFreeMemoryPercent: 5 },
    sessions: { s1: session },
    totals: { ...emptyUsage(), findings: 3 },
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify(state))
  const events: Partial<RunEvent>[] = [
    { t: '2026-10-17T10:01:00.000Z', seq: 1, session: 's1', type: 'tool.result', tool: 'click_at', ok: false, harnessError: true },
    { t: '2026-10-17T10:01:10.000Z', seq: 2, session: 's1', type: 'tool.result', tool: 'click_at', ok: false, harnessError: true },
    { t: '2026-10-17T10:01:20.000Z', seq: 3, session: 's1', type: 'tool.result', tool: 'click_at', ok: false, harnessError: true },
    { t: '2026-10-17T10:01:30.000Z', seq: 4, session: 's1', type: 'tool.result', tool: 'click_at', ok: false, harnessError: true },
    { t: '2026-10-17T10:05:00.000Z', seq: 5, session: 's1', type: 'tool.result', tool: 'click', ok: true },
    { t: '2026-10-17T10:05:10.000Z', seq: 6, session: 's1', type: 'tool.result', tool: 'click', ok: true },
    { t: '2026-10-17T10:05:20.000Z', seq: 7, session: 's1', type: 'tool.result', tool: 'click', ok: true },
  ]
  writeFileSync(join(dir, 'events', 's1.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
  const findings = [
    finding('F-1', 'Clicking the map never adds a point', 'nothing happens', '2026-10-17T10:02:00.000Z'),
    finding('F-2', 'Saving with a long name does nothing', 'no message, nothing saved', '2026-10-17T10:06:00.000Z'),
    finding('F-3', 'Save does nothing when the name is long', 'nothing saved and no error message', '2026-10-17T10:07:00.000Z'),
  ]
  writeFileSync(join(dir, 'findings.jsonl'), `${findings.map((item) => JSON.stringify({ type: 'finding', ...item })).join('\n')}\n`)
  return dir
}

describe('triage', () => {
  it('clusters paraphrases and keeps unrelated reports apart', () => {
    const clusters = clusterFindings([
      finding('F-2', 'Saving with a long name does nothing', 'no message, nothing saved', '2026-10-17T10:06:00.000Z'),
      finding('F-3', 'Save does nothing when the name is long', 'nothing saved and no error message', '2026-10-17T10:07:00.000Z'),
      finding('F-4', 'The dark mode switch does not stick', 'theme resets', '2026-10-17T10:08:00.000Z'),
    ])
    expect(clusters.get('F-3')).toBe('F-2')
    expect(clusters.get('F-4')).toBe('F-4')
  })

  it('flags a report made right after harness failures', async () => {
    const dir = fakeRun()
    const triage = await triageRun(dir)
    expect(triage.findings['F-1']?.flags).toContain('harness-suspect')
    expect(triage.findings['F-1']?.suggestedSeverity).toBe('harness')
    expect(triage.findings['F-2']?.flags).not.toContain('harness-suspect')
    expect(triage.clusters[0]?.members.sort()).toEqual(['F-2', 'F-3'])
    expect(triage.sessions[0]).toMatchObject({ session: 's1', harnessErrors: 4, findings: 3 })
    const report = readFileSync(await writeReport(dir), 'utf8')
    expect(report).toContain('Saving with a long name does nothing')
    expect(report).toContain('harness-suspect')
  })

  it('groups the reports of a real run the way a reviewer did', async () => {
    // 19 reports from three agent personas on the fixture app, before reports were held for a second look.
    const { findings } = await readFindingsFile(fixture('kiln-external-run.jsonl'))
    expect(findings).toHaveLength(19)
    const clusters = clusterFindings(findings)
    const group = (id: string) =>
      [...clusters.entries()]
        .filter(([, root]) => root === clusters.get(id))
        .map(([member]) => member)
        .sort()
    expect(group('F-2')).toEqual(['F-2', 'F-3', 'F-4'])
    expect(group('F-5')).toEqual(['F-12', 'F-17', 'F-5'])
    expect(group('F-18')).toEqual(['F-18', 'F-19'])
    expect(group('F-9')).toEqual(['F-13', 'F-9'])
    expect(group('F-1')).toEqual(['F-1', 'F-7'])
    for (const alone of ['F-10', 'F-11', 'F-14']) expect(group(alone)).toEqual([alone])
  })

  it('flags reports about a link the test stopped, not every report made after it', () => {
    const blocked = [
      { t: '2026-10-17T10:00:00.000Z', seq: 1, session: 's1', type: 'device.signal' as const, kind: 'blocked', url: 'http://elsewhere.test/help' },
    ]
    const at = '2026-10-17T10:01:00.000Z'
    expect(aboutBlockedNavigation(finding('F-1', 'Help centre does nothing when tapped', 'nothing happens', at), blocked)).toBe(true)
    expect(aboutBlockedNavigation(finding('F-2', 'The link to the supplier does nothing', 'stays on settings', at), blocked)).toBe(true)
    expect(aboutBlockedNavigation(finding('F-3', 'Dark mode checkbox changes nothing', 'the theme stays light', at), blocked)).toBe(false)
    expect(aboutBlockedNavigation(finding('F-4', 'Help centre does nothing', 'nothing', '2026-10-17T10:09:00.000Z'), blocked)).toBe(false)
  })

  it('follows what testers said and never merges what they kept apart', () => {
    const date = (id: string, t: string, extra: Partial<Finding> = {}) =>
      ({ ...finding(id, 'Delivery date shows as a raw timestamp', '2026-11-20T00:00:00.000Z', t), ...extra }) as Finding
    const kept = clusterFindings([date('F-1', '2026-10-17T10:01:00.000Z'), date('F-2', '2026-10-17T10:02:00.000Z', { notSameAs: ['F-1'] })])
    expect(kept.get('F-2')).toBe('F-2')
    const linked = clusterFindings([
      {
        ...finding('F-1', 'The photo never appears', 'says 0 KB', '2026-10-17T10:01:00.000Z', 'a'),
        votes: [{ session: 'b', t: '', note: 'Same here. My F-2 is a duplicate of this.' }],
      },
      finding('F-2', 'Picture upload seems lost', 'not on the order page after reopening', '2026-10-17T10:02:00.000Z', 'b'),
    ])
    expect(linked.get('F-2')).toBe('F-1')
  })

  it('matches known issues unless the reporter said otherwise', async () => {
    const known = [{ id: 'K-1', title: 'Search ignores accented names', description: 'jose does not find José' }]
    const report = finding('F-1', 'Search does not find José when I type jose', 'no results for accented names', '2026-10-17T10:01:00.000Z')
    expect(matchKnownIssue(report, known)?.id).toBe('K-1')
    expect(matchKnownIssue({ ...report, notSameAs: ['k-1'] }, known)).toBeUndefined()

    const dir = fakeRun()
    writeFileSync(join(dir, 'known-issues.json'), JSON.stringify([{ id: 'K-7', title: 'Saving with a long customer name does nothing' }]))
    writeFileSync(
      join(dir, 'findings.jsonl'),
      `${readFileSync(join(dir, 'findings.jsonl'), 'utf8')}${JSON.stringify({ type: 'vote', findingId: 'K-7', known: true, title: 'Saving with a long customer name does nothing', session: 's2', t: '2026-10-17T10:08:00.000Z', note: 'still there' })}\n`,
    )
    const triage = await triageRun(dir)
    expect(triage.findings['F-2']).toMatchObject({ knownIssue: 'K-7', flags: expect.arrayContaining(['known:K-7']) })
    expect(triage.knownIssues).toEqual([
      { id: 'K-7', title: 'Saving with a long customer name does nothing', sessions: ['s2', 's1'], findings: ['F-2', 'F-3'] },
    ])
    expect(triage.totals.knownIssuesSeen).toBe(1)
    expect(readFileSync(await writeReport(dir), 'utf8')).toContain('Known issues seen')
  })

  it('reads harness failures from events directly, looking past screenshots', () => {
    const events = [1, 2, 3].map((seq) => ({ t: `2026-10-17T10:0${seq}:00.000Z`, seq, session: 's', type: 'tool.result' as const, harnessError: true }))
    expect(harnessSuspect(finding('F-9', 'x', 'y', '2026-10-17T10:05:00.000Z', 's'), events)).toBe(true)
    // Looking at the screen before reporting is not an action that succeeded.
    const looked = [...events, { t: '2026-10-17T10:04:00.000Z', seq: 4, session: 's', type: 'tool.result' as const, tool: 'screenshot', ok: true }]
    expect(harnessSuspect(finding('F-9', 'x', 'y', '2026-10-17T10:05:00.000Z', 's'), looked)).toBe(true)
  })
})

describe('review and export', () => {
  it('exports approved findings once, through a webhook and a command', async () => {
    const dir = fakeRun()
    await triageRun(dir)
    await setReview(dir, 'F-2', { status: 'approved', severity: 'major', note: 'real' })
    await setReview(dir, 'F-1', { status: 'approved' })
    const received: unknown[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `ISSUE-${received.length}` }))
      })
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
    const configs = [
      { type: 'webhook', with: { url }, only: 'approved' as const },
      {
        type: 'command',
        id: 'echo',
        with: { command: [process.execPath, '-e', "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('CMD-1'))"] },
        only: 'approved' as const,
      },
    ]
    const first = await exportRun(dir, configs)
    // F-1 is a harness artefact: never exported, even when approved.
    expect(first[0]?.outcomes.map((outcome) => outcome.findingId)).toEqual(['F-2'])
    expect(first[0]?.outcomes[0]?.externalId).toBe('ISSUE-1')
    expect(first[1]?.outcomes[0]).toMatchObject({ ok: true, externalId: 'CMD-1' })
    expect((received[0] as { severity: string }).severity).toBe('major')
    const second = await exportRun(dir, configs)
    expect(second.every((result) => result.outcomes.length === 0)).toBe(true)
    server.close()
  })

  it('files each finding once even when exports overlap, and keeps file exports whole', async () => {
    const dir = fakeRun()
    await setReview(dir, 'F-2', { status: 'approved' })
    await setReview(dir, 'F-3', { status: 'approved' })
    let posts = 0
    // Answers in plain text, as many chat webhooks do: still a delivery.
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        posts += 1
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      })
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-hook-token`
    const configs = [
      { type: 'webhook', with: { url }, only: 'approved' as const },
      { type: 'markdown', with: {}, only: 'approved' as const },
    ]
    const [one, two] = await Promise.allSettled([exportRun(dir, configs), exportRun(dir, configs)])
    // The second waits for the lock briefly, then finds everything already filed (or says an export is running).
    expect(one.status === 'fulfilled' || two.status === 'fulfilled').toBe(true)
    expect(posts).toBe(2)
    const recorded = JSON.parse(readFileSync(join(dir, 'exports.json'), 'utf8')) as Record<string, Record<string, string>>
    expect(Object.keys(recorded.webhook ?? {})).toEqual(['F-2', 'F-3'])
    expect(JSON.stringify(recorded)).not.toContain('secret-hook-token')

    await setReview(dir, 'F-1', { status: 'approved' })
    await exportRun(dir, configs.slice(1))
    const markdown = readFileSync(join(dir, 'export.md'), 'utf8')
    // F-1 is harness-suspect: never exported. The earlier findings are still in the file.
    expect(markdown).toContain('## F-2')
    expect(markdown).toContain('## F-3')
    expect(markdown).not.toContain('## F-1')
    expect(() =>
      exporterIds([
        { type: 'webhook', with: {}, only: 'approved' },
        { type: 'webhook', with: {}, only: 'approved' },
      ]),
    ).toThrow(/share the id/)
    // The config schema knows the same exporter types as this package.
    expect(Object.keys(BUILT_IN_EXPORTERS).sort()).toEqual(EXPORTER_TYPES.filter((type) => type !== 'module').sort())
    server.close()
  })

  it('survives a command that ignores its input or hangs, and records every success', async () => {
    const dir = fakeRun()
    await setReview(dir, 'F-2', { status: 'approved' })
    // A big finding and a command that exits without reading it: no crash, a failed outcome.
    const findingsFile = join(dir, 'findings.jsonl')
    writeFileSync(findingsFile, readFileSync(findingsFile, 'utf8').replace('"nothing saved and no error message"', `"${'x'.repeat(20_000)}"`))
    await setReview(dir, 'F-3', { status: 'approved' })
    const quits = await exportRun(dir, [{ type: 'command', id: 'quits', with: { command: [process.execPath, '-e', 'process.exit(3)'] }, only: 'approved' }])
    expect(quits[0]?.outcomes.every((outcome) => !outcome.ok)).toBe(true)
    const hangs = await exportRun(dir, [
      { type: 'command', id: 'hangs', with: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutSec: 1 }, only: 'approved' },
    ])
    expect(hangs[0]?.outcomes[0]).toMatchObject({ ok: false, error: expect.stringContaining('timed out') })
    // A success with no id to show (a chat post) is still recorded: never sent twice.
    const module = join(dir, 'poster.mjs')
    writeFileSync(
      module,
      'export default () => ({ type: "poster", async export(items) { return items.map((item) => ({ findingId: item.finding.id, ok: true })) } })\n',
    )
    const first = await exportRun(dir, [{ type: 'module', id: 'poster', with: { path: module }, only: 'approved' }])
    expect(first[0]?.outcomes.filter((outcome) => outcome.ok)).toHaveLength(2)
    const second = await exportRun(dir, [{ type: 'module', id: 'poster', with: { path: module }, only: 'approved' }])
    expect(second[0]?.outcomes).toHaveLength(0)
  })

  it('does not count actions refused for want of budget as harness failures', () => {
    const events = [1, 2, 3].map((seq) => ({
      t: `2026-10-17T10:0${seq}:00.000Z`,
      seq,
      session: 's',
      type: 'tool.result' as const,
      tool: 'press',
      ok: false,
      refused: true,
    }))
    expect(harnessSuspect(finding('F-9', 'x', 'y', '2026-10-17T10:05:00.000Z', 's'), events)).toBe(false)
  })

  it('suspects the harness after one action that failed in it, as after many', () => {
    const one = [{ t: '2026-10-17T10:04:30.000Z', seq: 1, session: 's', type: 'tool.result' as const, tool: 'click', ok: false, harnessError: true }]
    expect(harnessSuspect(finding('F-9', 'Save does nothing', 'nothing', '2026-10-17T10:05:00.000Z', 's'), one)).toBe(true)
  })

  it('takes a link from what a tester said, not from a report merely mentioned', () => {
    const at = (minute: number) => `2026-10-17T10:0${minute}:00.000Z`
    const clusters = clusterFindings([
      finding('F-1', 'Delivery date shows a raw timestamp', 'shows 2026-11-20T00:00', at(1), 'a'),
      finding('F-2', 'Delete icon is tiny', 'I already reported the date problem as F-1. This one is the icon.', at(2), 'b'),
      finding('F-3', 'Order list does not refresh', 'not the same as F-1: the list stays old', at(3), 'c'),
      finding('F-4', 'Timestamp instead of a date on the order page', 'Same problem as F-1, seen on my phone', at(4), 'd'),
    ])
    expect(clusters.get('F-2')).toBe('F-2')
    expect(clusters.get('F-3')).toBe('F-3')
    expect(clusters.get('F-4')).toBe('F-1')
  })

  it('files an interrupted send only after a person says so, and nothing a timeout may have delivered twice', async () => {
    const dir = fakeRun()
    await setReview(dir, 'F-2', { status: 'approved' })
    const hangs = {
      type: 'command' as const,
      id: 'tracker',
      with: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutSec: 1 },
      only: 'approved' as const,
    }
    expect((await exportRun(dir, [hangs]))[0]?.outcomes[0]).toMatchObject({ ok: false, error: expect.stringContaining('timed out') })
    // The tracker may have filed it before the time ran out: the next export holds it back and says why.
    const again = await exportRun(dir, [hangs])
    expect(again[0]?.outcomes).toHaveLength(0)
    expect(again[0]?.skipped[0]).toMatchObject({ findingId: 'F-2', reason: expect.stringContaining('--retry-unsure') })
    const works = { type: 'command' as const, id: 'tracker', with: { command: [process.execPath, '-e', 'console.log("T-1")'] }, only: 'approved' as const }
    expect((await exportRun(dir, [works], { retryUnsure: true }))[0]?.outcomes[0]).toMatchObject({ ok: true, externalId: 'T-1' })
    // A plain refusal (the tracker said no) is no doubt: it is sent again next time.
    await setReview(dir, 'F-3', { status: 'approved' })
    const refuses = { type: 'command' as const, id: 'strict', with: { command: [process.execPath, '-e', 'process.exit(3)'] }, only: 'approved' as const }
    await exportRun(dir, [refuses])
    expect((await exportRun(dir, [refuses]))[0]?.outcomes.length).toBe(2)
  })

  it('keeps persona text from pinging people or linking issues on GitHub', () => {
    expect(defang('@admin says #3 is like #12, see me@example.com')).toBe('@\u200badmin says #\u200b3 is like #\u200b12, see me@\u200bexample.com')
    expect(defang('### What happened')).toBe('### What happened')
  })

  it('splits a group a reviewer says is wrong, and keeps it split through later reviews', async () => {
    const dir = fakeRun()
    expect((await triageRun(dir)).findings['F-3']?.cluster).toBe('F-2')
    await setApart(dir, 'f-3', 'F-2')
    expect((await triageRun(dir)).findings['F-3']?.cluster).toBe('F-3')
    await setReview(dir, 'F-3', { status: 'approved' })
    expect((await triageRun(dir)).findings['F-3']?.cluster).toBe('F-3')
    await expect(setApart(dir, 'F-3', 'F-99')).rejects.toThrow(/not another report/)
  })

  it("keeps a reviewer's severity through later decisions unless they clear it", async () => {
    const dir = fakeRun()
    await setReview(dir, 'F-2', { status: 'approved', severity: 'major' })
    expect(await setReview(dir, 'F-2', { status: 'needs-info' })).toMatchObject({ status: 'needs-info', severity: 'major' })
    expect((await setReview(dir, 'F-2', { status: 'approved', severity: null })).severity).toBeUndefined()
  })

  it('holds back a finding a dropped connection may have delivered, and sends again one that never left', async () => {
    const dir = fakeRun()
    await setReview(dir, 'F-2', { status: 'approved' })
    // A tracker that takes the request and drops the connection without answering.
    const dropping = createServer((req) => req.on('data', () => {}).on('end', () => req.socket.destroy()))
    await new Promise<void>((resolveListen) => dropping.listen(0, '127.0.0.1', resolveListen))
    try {
      const url = `http://127.0.0.1:${(dropping.address() as AddressInfo).port}/hook`
      const hook = { type: 'webhook' as const, id: 'hook', with: { url }, only: 'approved' as const }
      expect((await exportRun(dir, [hook]))[0]?.outcomes[0]).toMatchObject({ ok: false, error: expect.stringContaining('may have arrived') })
      expect((await exportRun(dir, [hook]))[0]?.skipped[0]?.reason).toContain('--retry-unsure')
    } finally {
      await new Promise<void>((resolveClose) => dropping.close(() => resolveClose()))
    }
    // Nothing listening: the request never left, so the next export sends it again.
    const spare = createServer()
    await new Promise<void>((resolveListen) => spare.listen(0, '127.0.0.1', resolveListen))
    const port = (spare.address() as AddressInfo).port
    await new Promise<void>((resolveClose) => spare.close(() => resolveClose()))
    const closed = { type: 'webhook' as const, id: 'closed', with: { url: `http://127.0.0.1:${port}/hook` }, only: 'approved' as const }
    expect((await exportRun(dir, [closed]))[0]?.outcomes[0]).toMatchObject({ ok: false, error: expect.stringContaining('could not be reached') })
    expect((await exportRun(dir, [closed]))[0]?.outcomes).toHaveLength(1)
  })

  it('triages again when triage.json, however new, leaves out a report', async () => {
    const dir = fakeRun()
    await triageRun(dir)
    const triage = JSON.parse(readFileSync(join(dir, 'triage.json'), 'utf8'))
    delete triage.findings['F-3']
    // Written after the report it misses (a report filed while a live re-triage was working).
    writeFileSync(join(dir, 'triage.json'), JSON.stringify(triage))
    expect(await renderReport(dir)).toContain('Save does nothing when the name is long')
    expect(JSON.parse(readFileSync(join(dir, 'triage.json'), 'utf8')).findings['F-3']).toBeTruthy()
  })

  it('reports every finding, triaging again when triage.json is older than the reports', async () => {
    const dir = fakeRun()
    await triageRun(dir)
    // A resumed run that was stopped before its wrap-up: a report newer than the triage.
    const late = finding('F-4', 'Printing the order shows a blank page', 'blank', '2026-10-17T10:09:00.000Z')
    await new Promise((resolveLater) => setTimeout(resolveLater, 20))
    writeFileSync(join(dir, 'findings.jsonl'), `${readFileSync(join(dir, 'findings.jsonl'), 'utf8')}${JSON.stringify({ type: 'finding', ...late })}\n`)
    expect(await renderReport(dir)).toContain('Printing the order shows a blank page')
  })
})
