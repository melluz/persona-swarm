import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCohort, type RunEvent, readJsonLines } from '@persona-swarm/core'
import { saveGrouping } from '@persona-swarm/findings'
import { type FixtureApp, startFixtureApp } from '@persona-swarm/fixture-app'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { buildPlan, Orchestrator } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const mockMain = resolve(here, '../../../drivers/mock/dist/main.js')
const pythonDriver = resolve(here, '../../../drivers/python-reference/driver.py')
const externalDist = resolve(here, '../../../drivers/external/dist')
let app: FixtureApp
const workspace = mkdtempSync(join(tmpdir(), 'ps-engine-'))

beforeAll(async () => {
  app = await startFixtureApp()
  mkdirSync(join(workspace, 'personas'), { recursive: true })
  writeFileSync(join(workspace, 'persona-swarm.yaml'), stringify({ runsDir: 'runs', registry: '.persona-swarm/registry.json' }))
  writeFileSync(
    join(workspace, 'target.yaml'),
    stringify({
      id: 'kiln',
      name: 'Kiln Orders',
      baseUrl: app.url,
      brief: 'Kiln Orders keeps track of customer orders.',
      health: { url: `${app.url}/sign-in` },
      accounts: [
        { id: 'anna', username: 'anna@fixture.test', password: 'pw' },
        { id: 'mo', username: 'mo@fixture.test', password: 'pw' },
      ],
      signIn: {
        mode: 'scripted',
        url: '/sign-in',
        steps: [{ fill: 'Email', value: '{{username}}' }, { fill: 'Password', value: '{{password}}' }, { click: 'Sign in' }, { waitFor: 'New order' }],
      },
    }),
  )
  writeFileSync(
    join(workspace, 'personas', 'anna.yaml'),
    stringify({
      id: 'anna',
      name: 'Anna Script',
      proficiency: 4,
      background: 'Runs a bakery.',
      mission: { goal: 'Create an order for a customer with a long name.' },
      device: 'desktop-1440',
      account: 'anna',
    }),
  )
  writeFileSync(
    join(workspace, 'personas', 'mo.yaml'),
    stringify({
      id: 'mo',
      name: 'Mo Monkey',
      proficiency: 2,
      background: 'Presses everything.',
      mission: { goal: 'Explore.' },
      device: 'iphone-13',
      account: 'mo',
    }),
  )
  writeFileSync(
    join(workspace, 'cohort.yaml'),
    stringify({
      id: 'engine-test',
      target: 'target.yaml',
      personas: ['personas/*.yaml'],
      roles: { persona: { driver: 'mock' } },
      assign: {
        anna: {
          options: {
            mode: 'script',
            steps: [
              { tool: 'outline' },
              { tool: 'click', args: { ref: '$ref(button "New order")' } },
              { tool: 'wait', args: { seconds: 2, for_text: 'Customer name' } },
              { tool: 'outline' },
              { tool: 'fill', args: { ref: '$ref(textbox "Customer name")', text: 'Bartholomew Featherstonehaugh-Cholmondeley III' } },
              { tool: 'click', args: { ref: '$ref(button "Save order")' } },
              { tool: 'note', args: { text: 'I pressed Save and nothing happened.' } },
              {
                tool: 'report_problem',
                args: {
                  title: 'Saving an order with a long customer name does nothing',
                  what_i_did: 'Typed a 46-character name and pressed Save order',
                  what_i_expected: 'The order to be saved or an error to explain why not',
                  what_happened: 'Nothing happened, no message',
                  how_bad: 'blocking',
                  sure: true,
                },
                expect: 'Reported as F-',
              },
              { tool: 'finish', args: { outcome: 'blocked', summary: 'Could not save', ease: 3, trust: 4, would_use: 'no', why: 'saving failed' } },
            ],
          },
        },
        mo: { options: { mode: 'monkey', seed: 7 } },
      },
      budgets: { minutesPerPersona: 2, turnsPerPersona: 12 },
      schedule: { staggerSec: 0 },
      limits: { maxBrowsers: 2, maxAgents: 2, minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
    }),
  )
})

afterAll(async () => {
  await app?.close()
})

describe('Orchestrator with the mock driver', () => {
  it('runs two sessions end to end and produces findings, triage and a report', async () => {
    expect(existsSync(mockMain)).toBe(true)
    const plan = buildPlan(loadCohort(join(workspace, 'cohort.yaml')))
    expect(plan.sessions.map((session) => session.toolProfile).sort()).toEqual(['power', 'sight'])
    // A grouper that joins the run's first two reports: it runs once the sessions are over, before triage.
    const grouped: string[] = []
    const orchestrator = new Orchestrator(plan, {
      drivers: { mock: { command: [process.execPath, mockMain] } },
      handleSignals: false,
      registryFile: join(workspace, '.persona-swarm', 'registry.json'),
      group: async (runDir) => {
        grouped.push(runDir)
        expect(existsSync(join(runDir, 'triage.json'))).toBe(false)
        const ids = (await readJsonLines<{ type: string; id: string }>(join(runDir, 'findings.jsonl')))
          .filter((line) => line.type === 'finding')
          .map((line) => line.id)
        await saveGrouping(runDir, {
          version: 1,
          by: 'test-grouper',
          t: new Date().toISOString(),
          covered: ids,
          groups: [{ ids: ids.slice(0, 2), reason: 'test' }],
        })
        return 'grouping: 1 group(s) by test-grouper'
      },
    })
    const state = await orchestrator.run()
    expect(state.status, state.statusReason).toBe('finished')
    expect(state.sessions.anna?.status).toBe('finished')
    expect(state.sessions.anna?.outcome).toBe('blocked')
    expect(state.sessions.mo?.status).toBe('finished')
    expect(state.sessions.mo?.toolCalls).toBeGreaterThan(5)

    const runDir = orchestrator.runDir
    const findings = await readJsonLines<{ type: string; title: string }>(join(runDir, 'findings.jsonl'))
    expect(findings.some((line) => line.type === 'finding' && line.title.includes('long customer name'))).toBe(true)
    const events = await readJsonLines<RunEvent>(join(runDir, 'events', 'anna.jsonl'))
    expect(events.some((event) => event.type === 'diary')).toBe(true)
    expect(events.filter((event) => event.type === 'tool.result' && typeof event.screenshot === 'string').length).toBeGreaterThan(2)
    expect(existsSync(join(runDir, 'triage.json'))).toBe(true)
    expect(grouped).toEqual([runDir])
    expect(JSON.parse(readFileSync(join(runDir, 'triage.json'), 'utf8')).grouping).toMatchObject({ by: 'test-grouper', groups: 1 })
    expect(readFileSync(join(runDir, 'report.html'), 'utf8')).toContain('long customer name')
    expect(
      app
        .events()
        .filter((event) => event.type === 'sign-in')
        .map((event) => event.account)
        .sort(),
    ).toEqual(['anna@fixture.test', 'mo@fixture.test'])
    expect(existsSync(join(workspace, '.persona-swarm', 'registry.json'))).toBe(true)
  }, 180_000)

  it('runs a driver written in Python through the same protocol', async () => {
    writeFileSync(
      join(workspace, 'python-cohort.yaml'),
      stringify({
        id: 'python-test',
        target: 'target.yaml',
        personas: ['personas/anna.yaml'],
        roles: { persona: { driver: 'python' } },
        budgets: { minutesPerPersona: 1, turnsPerPersona: 5 },
        schedule: { staggerSec: 0 },
        limits: { minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
      }),
    )
    const orchestrator = new Orchestrator(buildPlan(loadCohort(join(workspace, 'python-cohort.yaml'))), {
      drivers: { python: { command: ['python3', pythonDriver] } },
      handleSignals: false,
    })
    const state = await orchestrator.run()
    expect(state.sessions.anna?.status, state.sessions.anna?.error).toBe('finished')
    expect(state.sessions.anna?.outcome).toBe('completed')
    const events = await readJsonLines<RunEvent>(join(orchestrator.runDir, 'events', 'anna.jsonl'))
    expect(events.some((event) => event.type === 'note' && String(event.text).includes('Python driver'))).toBe(true)
  }, 120_000)

  it('gives a gate verdict from journey checks over several attempts', async () => {
    const steps = (name: string) => [
      { tool: 'outline' },
      { tool: 'click', args: { ref: '$ref(button "New order")' } },
      { tool: 'wait', args: { seconds: 2, for_text: 'Customer name' } },
      { tool: 'outline' },
      { tool: 'fill', args: { ref: '$ref(textbox "Customer name")', text: name } },
      { tool: 'click', args: { ref: '$ref(button "Save order")' } },
      { tool: 'wait', args: { seconds: 2 } },
      { tool: 'finish', args: { outcome: 'completed', summary: 'done', ease: 5, trust: 5, would_use: 'yes', why: 'ok' } },
    ]
    // Hooks may be plain functions, and one that throws fails only its own step.
    writeFileSync(
      join(workspace, 'hooks.mjs'),
      `export default {
        beforeSession({ log, session }) { log('before ' + session) },
        afterSession({ log, session }) { log('after ' + session) },
        teardown() { throw new Error('teardown broke') },
        async check({ account, target }) {
          const events = await (await fetch(new URL('/__fixture/events', target.baseUrl))).json()
          const created = events.some((event) => event.type === 'order-created' && event.account === account?.username)
          return { passed: created, details: created ? 'an order exists' : 'no order was created' }
        },
      }\n`,
    )
    writeFileSync(
      join(workspace, 'gate-target.yaml'),
      stringify({
        id: 'kiln-gate',
        name: 'Kiln Orders',
        baseUrl: app.url,
        health: { url: `${app.url}/sign-in` },
        hooks: 'hooks.mjs',
        journeys: [{ id: 'create-order', name: 'Create an order', checks: ['An order exists for the account'] }],
        accounts: [
          { id: 'gina', username: 'gina@fixture.test', password: 'pw' },
          { id: 'lou', username: 'lou@fixture.test', password: 'pw' },
        ],
        signIn: {
          mode: 'scripted',
          url: '/sign-in',
          steps: [{ fill: 'Email', value: '{{username}}' }, { fill: 'Password', value: '{{password}}' }, { click: 'Sign in' }, { waitFor: 'New order' }],
        },
      }),
    )
    for (const id of ['gina', 'lou'])
      writeFileSync(
        join(workspace, 'personas', `gate-${id}.yaml`),
        stringify({ id, name: id, proficiency: 4, background: 'x', mission: { goal: 'Create an order.' }, device: 'desktop-1440', account: id }),
      )
    writeFileSync(
      join(workspace, 'gate-cohort.yaml'),
      stringify({
        id: 'gate-test',
        target: 'gate-target.yaml',
        mode: 'gate',
        gate: { attempts: 2, mustPass: 2 },
        personas: ['personas/gate-gina.yaml', 'personas/gate-lou.yaml'],
        roles: { persona: { driver: 'mock' } },
        assign: {
          gina: { options: { mode: 'script', steps: steps('Gina Short') } },
          lou: { options: { mode: 'script', steps: steps('Lou Has A Customer Name Far Longer Than Forty Characters') } },
        },
        budgets: { minutesPerPersona: 2, turnsPerPersona: 20 },
        schedule: { staggerSec: 0 },
        limits: { maxBrowsers: 2, maxAgents: 2, minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
      }),
    )
    const orchestrator = new Orchestrator(buildPlan(loadCohort(join(workspace, 'gate-cohort.yaml'))), {
      drivers: { mock: { command: [process.execPath, mockMain] } },
      handleSignals: false,
      replayShots: false,
    })
    const state = await orchestrator.run()
    expect(state.statusReason).toBe('gate failed: lou')
    expect(state.gate).toEqual({ passed: false, failing: ['lou'], inconclusive: [] })
    const gate = JSON.parse(readFileSync(join(orchestrator.runDir, 'gate.json'), 'utf8'))
    expect(gate.personas.gina).toMatchObject({ attempts: 2, passes: 2, passed: true })
    expect(gate.personas.lou).toMatchObject({ attempts: 2, passes: 0, passed: false })
    const log = readFileSync(join(orchestrator.runDir, 'logs', 'orchestrator.jsonl'), 'utf8')
    expect(log).toContain('hook: before gina--a1')
    expect(log).toContain('hook: after gina--a2')
    expect(log).toContain('teardown hook: teardown broke')
    // Two attempts of one persona share its account: they take turns rather than signing in at once.
    const span = async (id: string) => {
      const events = await readJsonLines<RunEvent>(join(orchestrator.runDir, 'events', `${id}.jsonl`))
      const at = (type: string) => Date.parse(events.find((event) => event.type === type)?.t ?? '')
      return { start: at('session.start'), end: at('session.end') }
    }
    const [first, second] = [await span('gina--a1'), await span('gina--a2')]
    expect(first.end <= second.start || second.end <= first.start).toBe(true)
  }, 180_000)

  it('resumes a run folder that was moved, and refuses a folder with nothing to resume', async () => {
    writeFileSync(
      join(workspace, 'short-cohort.yaml'),
      stringify({
        id: 'short',
        target: 'target.yaml',
        personas: ['personas/mo.yaml'],
        roles: {
          persona: {
            driver: 'mock',
            options: {
              mode: 'script',
              steps: [{ tool: 'finish', args: { outcome: 'completed', summary: 'done', ease: 5, trust: 5, would_use: 'yes', why: 'ok' } }],
            },
          },
        },
        budgets: { minutesPerPersona: 2, turnsPerPersona: 5 },
        schedule: { staggerSec: 0 },
        limits: { minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
      }),
    )
    const cohort = loadCohort(join(workspace, 'short-cohort.yaml'))
    const options = { drivers: { mock: { command: [process.execPath, mockMain] } }, handleSignals: false, replayShots: false }
    const first = new Orchestrator(buildPlan(cohort), options)
    expect((await first.run()).sessions.mo?.status).toBe('finished')
    const moved = join(workspace, 'kept', 'baseline')
    mkdirSync(join(workspace, 'kept'), { recursive: true })
    renameSync(first.runDir, moved)
    const plan = buildPlan(cohort, { runId: first.plan.runId })
    plan.runDir = moved
    const resumed = new Orchestrator(plan, { ...options, resume: true })
    expect(resumed.runDir).toBe(moved)
    expect((await resumed.run()).sessions.mo?.status).toBe('finished')
    expect(existsSync(first.runDir)).toBe(false)
    const empty = buildPlan(cohort, { runId: 'nothing-here' })
    await expect(new Orchestrator(empty, { ...options, resume: true }).run()).rejects.toThrow(/nothing to resume/)
  }, 120_000)

  it('pauses a session stopped while it is still being set up, and never calls it failed', async () => {
    writeFileSync(
      join(workspace, 'setup-cohort.yaml'),
      stringify({
        id: 'setup-test',
        target: 'target.yaml',
        personas: ['personas/mo.yaml'],
        roles: { persona: { driver: 'mock', options: { mode: 'monkey', seed: 1 } } },
        budgets: { minutesPerPersona: 2, turnsPerPersona: 20 },
        schedule: { staggerSec: 0 },
        limits: { minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
      }),
    )
    const orchestrator = new Orchestrator(buildPlan(loadCohort(join(workspace, 'setup-cohort.yaml'))), {
      drivers: { mock: { command: [process.execPath, mockMain] } },
      handleSignals: false,
      replayShots: false,
    })
    const running = orchestrator.run()
    const runFile = join(orchestrator.runDir, 'run.json')
    for (let i = 0; i < 200; i += 1) {
      const status = existsSync(runFile) ? JSON.parse(readFileSync(runFile, 'utf8')).sessions?.mo?.status : undefined
      if (status === 'starting' || status === 'running') break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    }
    const stoppedAt = Date.now()
    orchestrator.stop('test: stopped during setup')
    const state = await running
    expect(state.status).toBe('aborted')
    expect(state.sessions.mo?.status).toBe('paused')
    // Not the 15 s cancel grace of a driver that never heard of the session.
    expect(Date.now() - stoppedAt).toBeLessThan(12_000)
  }, 60_000)

  it('lets an outside agent play a persona through act, one action at a time', async () => {
    writeFileSync(
      join(workspace, 'external-cohort.yaml'),
      stringify({
        id: 'external-test',
        target: 'target.yaml',
        personas: ['personas/mo.yaml'],
        roles: { persona: { driver: 'external' } },
        budgets: { minutesPerPersona: 2, turnsPerPersona: 8 },
        schedule: { staggerSec: 0 },
        limits: { minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
      }),
    )
    const plan = buildPlan(loadCohort(join(workspace, 'external-cohort.yaml')))
    const orchestrator = new Orchestrator(plan, {
      drivers: { external: { command: [process.execPath, join(externalDist, 'main.js')] } },
      handleSignals: false,
      replayShots: false,
    })
    const running = orchestrator.run()
    const sessionFile = join(orchestrator.runDir, 'bridge', 'mo.json')
    for (let i = 0; i < 100 && !existsSync(sessionFile); i += 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    const { bridgeAct } = (await import(join(externalDist, 'index.js'))) as typeof import('@persona-swarm/driver-external')
    // Two actions at once are taken one after the other, not raced on the same page.
    const [first, second] = await Promise.all([bridgeAct(sessionFile, 'screenshot', {}), bridgeAct(sessionFile, 'note', { text: 'looking around' })])
    expect(first.images).toHaveLength(1)
    expect(second.text).toContain('Noted')
    const finish = await bridgeAct(sessionFile, 'finish', { outcome: 'completed', summary: 'looked', ease: 6, trust: 6, would_use: 'maybe', why: 'ok' })
    expect(finish.ended).toBe(true)
    expect((await bridgeAct(sessionFile, 'screenshot', {})).ended).toBe(true)
    const state = await running
    expect(state.sessions.mo).toMatchObject({ status: 'finished', outcome: 'completed' })
    expect(existsSync(join(orchestrator.runDir, 'run.lock'))).toBe(false)
  }, 120_000)

  it('resumes an interrupted run and briefs the persona', async () => {
    writeFileSync(
      join(workspace, 'resume-cohort.yaml'),
      stringify({
        id: 'resume-test',
        target: 'target.yaml',
        personas: ['personas/mo.yaml', 'personas/anna.yaml'],
        roles: { persona: { driver: 'mock', options: { mode: 'monkey', seed: 3 } } },
        budgets: { minutesPerPersona: 2, turnsPerPersona: 12 },
        schedule: { staggerSec: 0 },
        limits: { minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
      }),
    )
    const cohort = loadCohort(join(workspace, 'resume-cohort.yaml'))
    const plan = buildPlan(cohort, { personas: ['mo'], turns: 12 })
    const drivers = { mock: { command: [process.execPath, mockMain] } }
    const first = new Orchestrator(plan, { drivers, handleSignals: false, replayShots: false })
    const running = first.run()
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 4000))
    first.stop('test interruption')
    const stopped = await running
    expect(stopped.status).toBe('aborted')
    expect(stopped.sessions.mo?.status).toBe('paused')
    expect(stopped.overrides).toEqual({ personas: ['mo'], turns: 12 })

    // Planned again without the overrides (as from an edited cohort): only the original sessions run.
    const second = new Orchestrator(buildPlan(cohort, { runId: plan.runId }), { drivers, handleSignals: false, replayShots: false, resume: true })
    const resumed = await second.run()
    expect(resumed.status, resumed.statusReason).toBe('finished')
    expect(Object.keys(resumed.sessions)).toEqual(['mo'])
    expect(resumed.sessions.mo).toMatchObject({ status: 'finished', attempts: 2 })
    const events = await readJsonLines<RunEvent>(join(second.runDir, 'events', 'mo.jsonl'))
    const starts = events.filter((event) => event.type === 'session.start')
    expect(starts.map((event) => event.resumed)).toEqual([false, true])
    expect(new Set(events.map((event) => event.seq)).size).toBe(events.length)
  }, 180_000)
})
