import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCohort } from '@persona-swarm/core'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import {
  buildPlan,
  endStatus,
  findRef,
  kickoffMessage,
  personaInstructions,
  remainingBudget,
  resumeBriefing,
  scriptedSignIn,
  usedBudget,
} from '../src/index.js'

function workspace(cohort: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-plan-'))
  mkdirSync(join(dir, 'personas'))
  writeFileSync(
    join(dir, 'target.yaml'),
    stringify({
      id: 'app',
      name: 'App',
      baseUrl: 'http://127.0.0.1:9',
      brief: 'An app for orders.',
      accounts: [
        { id: 'one', username: 'one@x.test', password: 'pw' },
        { id: 'two', username: 'two@x.test', password: 'pw' },
        { id: 'clinic', username: 'clinic@x.test', password: 'pw', shared: true },
      ],
    }),
  )
  for (const [id, device, proficiency] of [
    ['ana', 'laptop-1280', 2],
    ['ben', 'iphone-13', 4],
  ] as const)
    writeFileSync(
      join(dir, 'personas', `${id}.yaml`),
      stringify({ id, name: id.toUpperCase(), proficiency, background: 'A person.', mission: { goal: 'generic goal' }, device }),
    )
  writeFileSync(
    join(dir, 'cohort.yaml'),
    stringify({ id: 'c', target: 'target.yaml', personas: ['personas/*.yaml'], roles: { persona: { driver: 'mock' } }, ...cohort }),
  )
  return loadCohort(join(dir, 'cohort.yaml'))
}

describe('buildPlan', () => {
  it('assigns distinct accounts, missions and tool profiles', () => {
    const plan = buildPlan(workspace({ missions: { '*': 'Create an order.', ben: 'Find an order on the phone.' } }))
    expect(plan.sessions.map((session) => [session.id, session.account?.id, session.toolProfile])).toEqual([
      ['ana', 'one', 'sight'],
      ['ben', 'two', 'sight'],
    ])
    expect(plan.sessions[0]?.persona.mission.goal).toBe('Create an order.')
    expect(plan.sessions[1]?.persona.mission.goal).toBe('Find an order on the phone.')
  })

  it('expands coverage matrices and gate attempts', () => {
    const coverage = buildPlan(workspace({ mode: 'coverage', matrix: { devices: ['desktop-1440', 'pixel-7'], locales: ['en-GB', 'ja-JP'] } }))
    expect(coverage.sessions).toHaveLength(8)
    expect(coverage.sessions.map((session) => session.id)).toContain('ben--pixel-7-ja-jp')
    expect(coverage.sessions.find((session) => session.id === 'ana--pixel-7-ja-jp')?.profile).toMatchObject({ hasTouch: true, locale: 'ja-JP' })
    const gate = buildPlan(workspace({ mode: 'gate', gate: { attempts: 3, mustPass: 2 } }))
    expect(gate.sessions.map((session) => session.id)).toEqual(['ana--a1', 'ana--a2', 'ana--a3', 'ben--a1', 'ben--a2', 'ben--a3'])
  })

  it('merges limits and role overrides without resetting what they do not name', () => {
    const source = workspace({
      limits: { maxAgents: 3 },
      roles: { persona: { driver: 'ai-sdk', model: 'openai:gpt-5-mini', options: { temperature: 0 } } },
      assign: { ana: { options: { seed: 1 } } },
    })
    writeFileSync(join(source.workspace.dir, 'persona-swarm.yaml'), stringify({ limits: { maxBrowsers: 2, minFreeMemoryPercent: 40 } }))
    const plan = buildPlan(loadCohort(source.file))
    expect(plan.limits).toMatchObject({ maxBrowsers: 2, maxAgents: 3, minFreeMemoryPercent: 40, stopBelowFreeMemoryPercent: 15 })
    expect(plan.sessions.find((session) => session.id === 'ana')?.role).toEqual({ driver: 'ai-sdk', model: 'openai:gpt-5-mini', options: { seed: 1 } })
    expect(plan.sessions.find((session) => session.id === 'ben')?.role.options).toEqual({ temperature: 0 })
  })

  it('filters personas and applies overrides', () => {
    const plan = buildPlan(workspace({}), { personas: ['ben'], driver: 'ai-sdk', model: 'openai:gpt-5', minutes: 3, maxBrowsers: 1 })
    expect(plan.sessions.map((session) => session.id)).toEqual(['ben'])
    expect(plan.sessions[0]?.role).toMatchObject({ driver: 'ai-sdk', model: 'openai:gpt-5' })
    expect(plan.budgets.minutesPerPersona).toBe(3)
    expect(plan.limits.maxBrowsers).toBe(1)
    expect(() => buildPlan(workspace({}), { personas: ['nobody'] })).toThrow(/no sessions/)
  })

  it('writes provider-neutral briefs and resume briefings', () => {
    const plan = buildPlan(workspace({}))
    const session = plan.sessions[0]
    if (!session) throw new Error('no session')
    const text = personaInstructions(session, plan.source.target.target, 20, 100)
    expect(text).toContain('You act on what you see')
    // Credentials travel in the first message, not in the system prompt.
    expect(text).not.toContain('one@x.test')
    expect(kickoffMessage(session, 'http://127.0.0.1:9/')).toContain('one@x.test / password pw')
    expect(text).toContain('about 20 minutes and 100 actions')
    expect(kickoffMessage(session, 'http://127.0.0.1:9/')).toContain('http://127.0.0.1:9/')
    const briefing = resumeBriefing([
      { t: '', seq: 1, session: 'ana', type: 'note', text: 'Looking for the save button' },
      { t: '', seq: 2, session: 'ana', type: 'finding', findingId: 'F-1', title: 'Save does nothing' },
    ])
    expect(briefing).toContain('interrupted')
    expect(briefing).toContain('F-1')
  })

  it('sets up the device for a vision trait and describes every trait in the brief', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-traits-'))
    writeFileSync(join(dir, 'target.yaml'), stringify({ id: 'app', name: 'App', baseUrl: 'http://127.0.0.1:9' }))
    writeFileSync(
      join(dir, 'zoomed.yaml'),
      stringify({
        id: 'zoomed',
        name: 'Zoe',
        proficiency: 3,
        traits: {
          vision: 'low',
          domain: 1,
          risk: 'cautious',
          focus: 'wanders',
          priorTools: 'Excel',
          language: { native: 'es', fluency: 2 },
          helpSeeking: 'support',
          vocal: 'stoic',
          precision: 1,
          pace: 'slow',
          typing: 'typos',
          interruptions: 'many',
          multitab: true,
          recovery: 'asks',
        },
        background: 'A person.',
        mission: { goal: 'goal' },
        device: 'desktop-1440',
        // The persona's own settings win over its vision trait's.
        deviceOverrides: { zoom: 1.5 },
      }),
    )
    writeFileSync(
      join(dir, 'cohort.yaml'),
      stringify({
        id: 'c',
        target: 'target.yaml',
        personas: ['zoomed.yaml', join(__dirname, '../../../personas/methodical-auditor.yaml')],
        roles: { persona: { driver: 'mock' } },
      }),
    )
    const plan = buildPlan(loadCohort(join(dir, 'cohort.yaml')))
    const [zoomed, auditor] = plan.sessions
    if (!zoomed || !auditor) throw new Error('no sessions')
    expect(zoomed.profile).toMatchObject({ zoom: 1.5, contrast: 'more' })
    expect(zoomed.deviceLabel).toContain('zoomed to 150 %')
    expect(auditor.profile.visionDeficiency).toBe('deuteranopia')
    const brief = personaInstructions(zoomed, plan.source.target.target, 10, 50)
    for (const words of [
      'zoomed to 150 %',
      'know nothing about this product',
      'You are cautious',
      'You get curious',
      'used to Excel',
      'first language is Spanish',
      'contact support',
      'rarely complain',
      'hands are not steady',
      'take your time',
      'make typos',
      'often interrupted',
      'several browser tabs',
      'someone or something to ask',
    ])
      expect(brief).toContain(words)
    expect(personaInstructions(auditor, plan.source.target.target, 10, 50)).toContain('colour-blind')
  })

  it('gives each persona its own budget, and refuses budgets for personas the cohort does not run', () => {
    const plan = buildPlan(workspace({ budgets: { minutesPerPersona: 10, turnsPerPersona: 100, personas: { ben: { minutes: 4 } } } }))
    // ana is proficiency 2: scaled. ben has fixed minutes from the cohort.
    expect(plan.sessions.map((session) => [session.id, session.budget.minutes, session.budget.turns])).toEqual([
      ['ana', 13, 130],
      ['ben', 4, 100],
    ])
    expect(buildPlan(workspace({ budgets: { minutesPerPersona: 10 } }), { minutes: 2 }).sessions[0]?.budget.minutes).toBe(2.5)
    expect(() => buildPlan(workspace({ budgets: { personas: { nobody: { scale: 2 } } } }))).toThrow(/nobody/)
  })

  it('gives each session its own files from the target, spread across sessions and kept for a resume', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-media-plan-'))
    mkdirSync(join(dir, 'files'))
    for (const name of ['one.png', 'two.png', 'three.png', 'oops.pdf']) writeFileSync(join(dir, 'files', name), 'x')
    writeFileSync(join(dir, 'files.yaml'), stringify({ files: [{ name: 'oops.pdf', tags: ['wrong-kind'] }] }))
    writeFileSync(
      join(dir, 'target.yaml'),
      stringify({
        id: 'app',
        name: 'App',
        baseUrl: 'http://127.0.0.1:9',
        media: [{ dir: 'files', manifest: 'files.yaml', tags: ['photo'] }],
        dependencies: [
          { id: 'ml', listen: { port: 0 }, upstream: 'http://127.0.0.1:9', mode: 'cached', cache: { dir: 'cache', key: { multipartField: 'image' } } },
        ],
      }),
    )
    for (const id of ['ana', 'ben', 'cy'])
      writeFileSync(join(dir, `${id}.yaml`), stringify({ id, name: id, proficiency: 4, background: 'x', mission: { goal: 'y' }, device: 'laptop-1280' }))
    const cohort = (media: Record<string, unknown>) => {
      writeFileSync(
        join(dir, 'cohort.yaml'),
        stringify({ id: 'c', target: 'target.yaml', personas: ['ana.yaml', 'ben.yaml', 'cy.yaml'], roles: { persona: { driver: 'mock' } }, media }),
      )
      return loadCohort(join(dir, 'cohort.yaml'))
    }
    const plan = buildPlan(cohort({ '*': { exclude: ['wrong-kind'], count: 1 }, cy: { tags: ['wrong-kind'] } }), { runId: 'r1' })
    const [ana, ben, cy] = plan.sessions.map((session) => session.media.map((item) => item.name))
    expect(ana).toHaveLength(1)
    expect(ben).toHaveLength(1)
    expect(ana).not.toEqual(ben)
    expect(cy).toEqual(['oops.pdf'])
    expect(plan.media).toHaveLength(4)
    // The same run id picks the same files.
    expect(buildPlan(cohort({ '*': { exclude: ['wrong-kind'], count: 1 }, cy: { tags: ['wrong-kind'] } }), { runId: 'r1' }).sessions[0]?.media[0]?.name).toBe(
      ana?.[0],
    )
    // Nothing cached yet: a selection of cached files leaves the persona without files, and says so.
    expect(buildPlan(cohort({ ana: { cached: 'ml' } })).warnings.join()).toMatch(/ana has no files/)
    expect(() => buildPlan(cohort({ ana: { cached: 'nope' } }))).toThrow(/nope/)
    expect(() => buildPlan(cohort({ zed: { count: 1 } }))).toThrow(/zed/)
  })

  it('names how a session ended, whatever came after a finish', () => {
    expect(endStatus('governor', false, true)).toBe('finished')
    expect(endStatus('budget', false, false, 'cancelled')).toBe('finished')
    expect(endStatus('governor', false, false, 'cancelled')).toBe('paused')
    expect(endStatus('stalled', false, false, 'cancelled')).toBe('paused')
    expect(endStatus('test stop', true, false, 'cancelled')).toBe('paused')
    expect(endStatus('stopped by the operator', false, false, 'cancelled')).toBe('cancelled')
    expect(endStatus('', false, false, 'error')).toBe('failed')
    expect(endStatus('', false, false, 'model_stopped')).toBe('finished')
  })

  it('gives a resumed persona only the budget its earlier attempts left', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 10, minute)).toISOString()
    const events = [
      { t: at(0), seq: 1, session: 'ana', type: 'session.start' as const },
      ...Array.from({ length: 30 }, (_, i) => ({ t: at(1 + (i % 5)), seq: 2 + i, session: 'ana', type: 'tool.call' as const })),
      { t: at(6), seq: 40, session: 'ana', type: 'note' as const },
      // Interrupted; the second attempt ran four more minutes.
      { t: at(30), seq: 41, session: 'ana', type: 'session.start' as const },
      { t: at(34), seq: 42, session: 'ana', type: 'tool.call' as const },
    ]
    expect(usedBudget(events)).toEqual({ ms: 10 * 60_000, actions: 0 })
    // Actions are steps in the app: looking, notes and refused calls are free.
    const results = [
      ...Array.from({ length: 30 }, (_, i) => ({ t: at(2), seq: 100 + i, session: 'ana', type: 'tool.result' as const, tool: 'click_at', ok: true })),
      { t: at(2), seq: 140, session: 'ana', type: 'tool.result' as const, tool: 'screenshot', ok: true },
      { t: at(2), seq: 141, session: 'ana', type: 'tool.result' as const, tool: 'note', ok: true },
      {
        t: at(2),
        seq: 142,
        session: 'ana',
        type: 'tool.result' as const,
        tool: 'press',
        ok: false,
        harnessError: true,
        message: 'No actions left in this session.',
      },
    ]
    // In time order: the results belong to the first attempt.
    const withResults = [...events.slice(0, 31), ...results, ...events.slice(31)]
    expect(usedBudget(withResults)).toEqual({ ms: 10 * 60_000, actions: 30 })
    expect(remainingBudget({ minutes: 18, turns: 90 }, usedBudget(withResults))).toEqual({ minutes: 8, turns: 60 })
    // Never less than enough to look around and finish.
    expect(remainingBudget({ minutes: 18, turns: 90 }, { ms: 40 * 60_000, actions: 200 })).toEqual({ minutes: 2, turns: 10 })
    expect(remainingBudget({ minutes: 18, turns: 90 }, usedBudget([]))).toEqual({ minutes: 18, turns: 90 })
  })

  it('signs in by exact names first, and notices a sign-in that did not get anywhere', async () => {
    const outline = '- button "Sign in with Google" [ref=e1]\n- textbox "Email" [ref=e2]\n- button "Sign in" [ref=e3]'
    expect(findRef(outline, 'Sign in', ['button'])).toBe('e3')
    expect(findRef(outline, 'google', ['button'])).toBe('e1')
    const status = { url: 'http://app/sign-in', title: '', tab: { index: 0, count: 1 }, viewport: { width: 1, height: 1 }, notices: [], online: true }
    const clicked: string[] = []
    const device = {
      outline: async () => ({ text: outline, truncated: false, refs: 3 }),
      status: async () => status,
      perform: async (action: { type: string; target?: { ref?: string } }) => {
        if (action.type === 'click') clicked.push(String(action.target?.ref))
        // A wrong password: the text that proves the sign-in worked never shows.
        return { ok: true, message: '', status, ...(action.type === 'wait' ? { matched: false } : {}) }
      },
    }
    const target = { signIn: { steps: [{ fill: 'Email', value: '{{username}}' }, { click: 'Sign in' }, { waitFor: 'New order' }] } }
    await expect(scriptedSignIn(device as never, target as never, { username: 'pat@x.test', password: 'pw' })).rejects.toThrow(/did not reach "New order"/)
    expect(clicked).toEqual(['e3'])
  })
})
