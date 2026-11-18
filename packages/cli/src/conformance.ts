import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Finding, loadCohort, readJsonFile, type Workspace, writeFileAtomic } from '@persona-swarm/core'
import { buildPlan, type DriverRegistry, Orchestrator } from '@persona-swarm/engine'
import { readFindings } from '@persona-swarm/findings'
import { matchPlantedBug, PLANTED_BUGS, SPOT, startFixtureApp } from '@persona-swarm/fixture-app'
import { stringify } from 'yaml'

export interface ConformanceResult {
  driver: string
  model: string
  t: string
  runDir: string
  passed: boolean
  checks: { name: string; passed: boolean; detail: string }[]
  plantedBugsFound: string[]
  recall: number
  costUsd: number
  minutes: number
}

/**
 * Qualifies a driver-and-model pair on the fixture app: can it sign in, act on what it sees, hit a
 * spot by coordinates, report a problem and finish? Also measures how many planted bugs it finds.
 */
export async function runConformance(options: {
  driver: string
  model: string
  registry: DriverRegistry
  minutes: number
  device: string
  registryFile: string
  runsDir: string
  log: (line: string) => void
  driverOptions?: Record<string, unknown>
  providers?: Record<string, unknown>
  /** The workspace's settings: its browser (local or remote), limits and prices apply to the qualifying run too. */
  workspace?: Workspace
}): Promise<ConformanceResult> {
  const app = await startFixtureApp()
  const workspace = mkdtempSync(join(tmpdir(), 'persona-swarm-conformance-'))
  try {
    mkdirSync(options.runsDir, { recursive: true })
    const settings = options.workspace
    writeFileSync(
      join(workspace, 'persona-swarm.yaml'),
      stringify({
        runsDir: options.runsDir,
        ...(options.providers ? { providers: options.providers } : {}),
        // The workspace's browser, but never a remote one: the fixture app listens on this machine's 127.0.0.1 only.
        ...(settings ? { browser: { ...settings.browser, connect: undefined }, limits: settings.limits, prices: settings.prices } : {}),
      }),
    )
    writeFileSync(
      join(workspace, 'target.yaml'),
      stringify({
        id: 'kiln',
        name: 'Kiln Orders',
        baseUrl: app.url,
        brief: 'Kiln Orders is a small web app for tracking customer orders: a list of orders, a form to add one, and a page per order.',
        signIn: { url: '/sign-in' },
        accounts: [{ id: 'tester', username: 'tester@fixture.test', password: 'conformance' }],
      }),
    )
    writeFileSync(
      join(workspace, 'cohort.yaml'),
      stringify({
        id: 'conformance',
        target: 'target.yaml',
        personas: [
          {
            id: 'tester',
            name: 'Casey Conformance',
            proficiency: 4,
            background: 'A shop assistant trying out a new order system.',
            mission: {
              goal: 'Get to know the order system by doing these things, then look around for anything that does not work properly and report it.',
              kind: 'scripted',
              steps: [
                'Sign in with your account.',
                'Create an order for the customer "Conformance Test" with quantity 2.',
                "On that order's page, mark the delivery spot: click (or tap) exactly on the red circle on the map.",
                'Explore: try searching, other settings and odd inputs. Report every problem you find.',
                'Finish with your honest account.',
              ],
            },
            device: options.device,
            account: 'tester',
          },
        ],
        roles: { persona: { driver: options.driver, model: options.model, options: options.driverOptions ?? {} } },
        budgets: { minutesPerPersona: options.minutes, turnsPerPersona: 150 },
        schedule: { staggerSec: 0 },
        limits: { maxBrowsers: 1, maxAgents: 1 },
      }),
    )
    const orchestrator = new Orchestrator(buildPlan(loadCohort(join(workspace, 'cohort.yaml'))), {
      drivers: options.registry,
      log: options.log,
      ...(settings ? { prices: settings.prices } : {}),
    })
    const started = Date.now()
    const state = await orchestrator.run()
    const events = app.events()
    const findings: Finding[] = await readFindings(join(orchestrator.runDir, 'findings.jsonl'))
    const found = new Set<string>()
    for (const finding of findings) {
      const bug = matchPlantedBug(`${finding.title} ${finding.actual} ${finding.whatIDid}`)
      if (bug) found.add(bug.id)
    }
    const spots = events.filter((event) => event.type === 'spot')
    const session = state.sessions.tester
    const checks = [
      { name: 'signed in', passed: events.some((event) => event.type === 'sign-in'), detail: '' },
      {
        name: 'created the order',
        passed: events.some((event) => event.type === 'order-created' && /conformance test/i.test(String(event.detail.customer))),
        detail: '',
      },
      {
        name: 'hit the spot by coordinates',
        passed: spots.some((event) => event.detail.hit === true),
        detail: spots.length
          ? `closest ${Math.min(...spots.map((event) => Number(event.detail.distance)))} px from the centre (radius ${SPOT.radius})`
          : 'never clicked the map',
      },
      { name: 'reported a problem', passed: findings.length > 0, detail: `${findings.length} report(s)` },
      { name: 'finished the session', passed: Boolean(session?.outcome), detail: session?.outcome ?? session?.stopReason ?? '' },
    ]
    const result: ConformanceResult = {
      driver: options.driver,
      model: options.model,
      t: new Date().toISOString(),
      runDir: orchestrator.runDir,
      passed: checks.slice(0, 4).every((check) => check.passed),
      checks,
      plantedBugsFound: [...found],
      recall: Math.round((found.size / PLANTED_BUGS.length) * 100) / 100,
      costUsd: Math.round(state.totals.costUsd * 10_000) / 10_000,
      minutes: Math.round(((Date.now() - started) / 60_000) * 10) / 10,
    }
    const registry = await readJsonFile<Record<string, ConformanceResult>>(options.registryFile, {})
    registry[`${options.driver}|${options.model}`] = result
    await writeFileAtomic(options.registryFile, `${JSON.stringify(registry, null, 2)}\n`)
    return result
  } finally {
    await app.close()
  }
}
