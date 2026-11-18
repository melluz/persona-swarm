import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyUsage, type Finding, type RunState } from '@persona-swarm/core'
import { triageRun } from '@persona-swarm/findings'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeModel, startFakeModel } from '../../../drivers/ai-sdk/test/fake-openai.js'
import { applyGroupingAnswer, groupRun, writeGroupingBrief } from '../src/grouping.js'

const report = (id: string, title: string, minute: number): Finding => ({
  id,
  session: minute % 2 ? 'phone' : 'desk',
  t: `2026-10-18T10:0${minute}:00.000Z`,
  title,
  whatIDid: 'used the editor',
  expected: 'readable labels',
  actual: title,
  feltSeverity: 'annoying',
  confidence: 'sure',
  kind: 'bug',
  url: 'http://app/cases/1',
  evidence: { eventSeqs: [], signals: [] },
  votes: [],
  source: 'persona',
})

function makeRun(findings: Finding[]): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ps-cli-grouping-')), '20261018-100000-abcd')
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
  writeFileSync(join(dir, 'findings.jsonl'), findings.map((item) => `${JSON.stringify({ type: 'finding', ...item })}\n`).join(''))
  writeFileSync(join(dir, 'known-issues.json'), JSON.stringify([{ id: 'K-B7', title: 'Phone: editor toolbar overflows' }]))
  return dir
}

const REPORTS = [
  report('F-1', 'Landmark names pile on top of each other', 1),
  report('F-2', 'Overlapping labels in the chin area', 2),
  report('F-3', 'Toolbar cut off on the right', 3),
]
const ANSWER = {
  groups: [
    { ids: ['F-1', 'F-2'], reason: 'labels overlap' },
    { ids: ['F-3', 'K-B7'], reason: 'toolbar overflow' },
  ],
}

/** An agent's command line: reads the task on stdin, prints an answer in a CLI-style envelope. */
const agent = (answer: unknown, exitCode = 0) => [
  process.execPath,
  '-e',
  `let task = ''; process.stdin.on('data', (d) => (task += d)); process.stdin.on('end', () => { if (!task.includes('Answer with only a JSON object')) process.exit(9); console.log(JSON.stringify({ type: 'result', result: 'Here: ' + ${JSON.stringify(JSON.stringify(answer))} })); console.error('agent stderr'); process.exit(${exitCode}) })`,
]

let model: FakeModel | undefined
afterEach(async () => {
  await model?.close()
  model = undefined
})

describe('grouping a run', () => {
  it('asks an agent command line and stores its answer for triage', async () => {
    const dir = makeRun(REPORTS)
    const outcome = await groupRun(dir, { command: agent(ANSWER), timeoutSec: 30 })
    if ('skipped' in outcome) throw new Error(outcome.skipped)
    expect(outcome.grouping.by).toBe('node -e')
    expect(outcome.grouping.groups).toEqual(ANSWER.groups)
    expect(outcome.grouping.covered).toEqual(['F-1', 'F-2', 'F-3'])
    const triage = await triageRun(dir)
    expect(triage.findings['F-2']?.cluster).toBe('F-1')
    expect(triage.findings['F-3']?.knownIssue).toBe('K-B7')
  })

  it('reports a failing agent command with its own words', async () => {
    const dir = makeRun(REPORTS)
    await expect(groupRun(dir, { command: agent(ANSWER, 3), timeoutSec: 30 })).rejects.toThrow(/node -e failed \(exit 3\): agent stderr/)
    await expect(groupRun(dir, { command: [process.execPath, '-e', 'console.log("no idea")'], timeoutSec: 30 })).rejects.toThrow(/printed no JSON answer/)
  })

  it('asks a model through the AI SDK, with its usage and cost', async () => {
    model = await startFakeModel([{ name: 'group_problems', args: ANSWER }])
    const dir = makeRun(REPORTS)
    const outcome = await groupRun(
      dir,
      { model: 'fake:grouper', timeoutSec: 30 },
      { providers: { fake: { type: 'openai-compatible', baseURL: model.url } }, prices: { 'fake:grouper': { input: 1, output: 4 } } },
    )
    if ('skipped' in outcome) throw new Error(outcome.skipped)
    expect(outcome.grouping).toMatchObject({ by: 'fake:grouper', groups: ANSWER.groups, usage: { inputTokens: 1000, outputTokens: 20 } })
    expect(outcome.grouping.costUsd).toBeCloseTo((1000 + 80) / 1_000_000)
    const prompt = JSON.stringify(model.requests[0]?.messages)
    expect(prompt).toContain('F-3 (page /cases/:id, tester phone): Toolbar cut off on the right')
    expect(prompt).toContain('K-B7: Phone: editor toolbar overflows')
  })

  it('writes a brief for an outside agent and applies its answer file', async () => {
    const dir = makeRun(REPORTS)
    const brief = await writeGroupingBrief(dir, (file) => `persona-swarm group ${dir} --from ${file}`)
    if ('skipped' in brief) throw new Error(brief.skipped)
    const text = readFileSync(brief.file, 'utf8')
    expect(text).toContain(`Write your answer as JSON to ${brief.answerFile}`)
    expect(text).toContain(`persona-swarm group ${dir} --from ${brief.answerFile}`)
    writeFileSync(brief.answerFile, `\`\`\`json\n${JSON.stringify({ groups: [...ANSWER.groups, { ids: ['F-9', 'F-1'] }] })}\n\`\`\``)
    // A report filed after the brief was written is not covered by this answer.
    writeFileSync(
      join(dir, 'findings.jsonl'),
      `${readFileSync(join(dir, 'findings.jsonl'), 'utf8')}${JSON.stringify({ type: 'finding', ...report('F-4', 'Late', 4) })}\n`,
    )
    const outcome = await applyGroupingAnswer(dir, brief.answerFile, 'my-agent')
    if ('skipped' in outcome) throw new Error(outcome.skipped)
    expect(outcome.grouping.by).toBe('my-agent')
    expect(outcome.grouping.covered).toEqual(['F-1', 'F-2', 'F-3'])
    expect((await triageRun(dir)).grouping?.notCovered).toEqual(['F-4'])
    expect(outcome.problems).toEqual([
      'group 3: "F-9" is not a report or known issue of this run',
      'group 3 has only F-1: a group needs two reports, or a report and a known issue',
    ])
    expect(JSON.parse(readFileSync(join(dir, 'grouping.json'), 'utf8')).groups).toEqual(ANSWER.groups)
  })

  it('refuses an answer it cannot use, and keeps the grouping the run already had', async () => {
    const dir = makeRun(REPORTS)
    await groupRun(dir, { command: agent(ANSWER), timeoutSec: 30 })
    const before = readFileSync(join(dir, 'grouping.json'), 'utf8')
    await expect(groupRun(dir, { command: agent({ groups: [{ ids: ['F-98', 'F-99'] }] }), timeoutSec: 30 })).rejects.toThrow(/none of the 1 group/)
    await expect(groupRun(dir, { command: agent({ verdict: 'all different' }), timeoutSec: 30 })).rejects.toThrow(/no list of groups/)
    expect(readFileSync(join(dir, 'grouping.json'), 'utf8')).toBe(before)
    // Every report on its own is what an agent writes for "no duplicates": the same as an empty list.
    const alone = await groupRun(dir, { command: agent({ groups: [['F-1'], ['F-2'], ['F-3']] }), timeoutSec: 30 })
    if ('skipped' in alone) throw new Error(alone.skipped)
    expect(alone.grouping.groups).toEqual([])
    // An empty list is an answer: nothing belongs together.
    const none = await groupRun(dir, { command: agent({ groups: [] }), timeoutSec: 30 })
    if ('skipped' in none) throw new Error(none.skipped)
    expect(none.grouping.groups).toEqual([])
  })

  it('skips a run with nothing to group', async () => {
    expect(await groupRun(makeRun([]), { command: agent(ANSWER), timeoutSec: 30 })).toEqual({ skipped: 'no reports to group' })
  })
})
