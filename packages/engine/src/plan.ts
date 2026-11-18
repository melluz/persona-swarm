import {
  type Account,
  bodyOf,
  type DeviceProfile,
  deriveToolProfile,
  describeDevice,
  Limits,
  type LoadedCohort,
  loadMedia,
  type MediaItem,
  MemoryPolicy,
  newRunId,
  type Persona,
  type RunOverrides,
  resolveDeviceProfile,
  type SessionBudget,
  seededRandom,
  seedFrom,
  selectMedia,
  sessionBudget,
  type ToolProfile,
  visionOverrides,
} from '@persona-swarm/core'
import { isWarm } from '@persona-swarm/dep-proxy'

export interface SessionPlan {
  id: string
  persona: Persona
  personaFile?: string
  profile: DeviceProfile
  deviceLabel: string
  toolProfile: ToolProfile
  role: { driver: string; model: string; options: Record<string, unknown> }
  account?: Account
  /** Gate mode: which attempt this is (1-based). */
  attempt: number
  /** Coverage mode: the matrix cell (device, locale). */
  variant?: string
  /** This session's own minutes and actions, and how they came about. */
  budget: SessionBudget
  /** The files on this persona's computer: what it can upload. */
  media: MediaItem[]
}

export interface RunPlan {
  runId: string
  source: LoadedCohort
  mode: LoadedCohort['cohort']['mode']
  sessions: SessionPlan[]
  limits: Limits
  budgets: { minutesPerPersona: number; turnsPerPersona: number; usdPerRun?: number }
  memory: MemoryPolicy
  schedule: { waveSize: number; waveIntervalSec: number; staggerSec: number }
  runsDir: string
  /** The run folder itself, when it is not `<runsDir>/<runId>` (a resume of a moved or renamed folder). */
  runDir?: string
  /** The overrides this plan was built with (without the run id), kept with the run for a resume. */
  overrides: RunOverrides
  /** Every file the target offers. */
  media: MediaItem[]
  /** Things worth knowing before the run starts (a persona left with no files, a long file list). */
  warnings: string[]
}

export interface PlanOverrides extends RunOverrides {
  runId?: string
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-|-$/g, '')

export class PlanError extends Error {}

/** Turns a loaded cohort into concrete sessions: devices resolved, accounts assigned, roles bound. */
export function buildPlan(source: LoadedCohort, overrides: PlanOverrides = {}): RunPlan {
  const { cohort, target, workspace } = source
  const limits = Limits.parse({
    ...workspace.config.limits,
    ...cohort.limits,
    ...(overrides.maxBrowsers ? { maxBrowsers: overrides.maxBrowsers } : {}),
    ...(overrides.maxAgents ? { maxAgents: overrides.maxAgents } : {}),
  })
  const accounts = target.target.accounts
  const used = new Set<string>()
  const pickAccount = (persona: Persona): Account | undefined => {
    if (persona.account) {
      const account = accounts.find((candidate) => candidate.id === persona.account)
      if (!account) throw new PlanError(`persona ${persona.id} asks for account "${persona.account}", which target ${target.target.id} does not define`)
      used.add(account.id)
      return account
    }
    const free = accounts.find((candidate) => !candidate.shared && !used.has(candidate.id))
    if (free) used.add(free.id)
    return free
  }

  const known = new Set(source.personas.map((loaded) => loaded.persona.id))
  for (const [setting, ids] of [
    ['budgets.personas', Object.keys(cohort.budgets.personas)],
    ['media', Object.keys(cohort.media).filter((id) => id !== '*')],
  ] as const) {
    const strays = ids.filter((id) => !known.has(id))
    if (strays.length) throw new PlanError(`${setting} names ${strays.join(', ')}, which this cohort does not run`)
  }
  const budgetOf = (persona: Persona): SessionBudget =>
    sessionBudget(persona, {
      base: { minutes: cohort.budgets.minutesPerPersona, turns: cohort.budgets.turnsPerPersona },
      run: { minutes: overrides.minutes, turns: overrides.turns },
      cohort: cohort.budgets.personas[persona.id],
      scaleByTraits: cohort.budgets.scaleByTraits,
    })

  const sessions: SessionPlan[] = []
  const ids = new Map<string, number>()
  const uniqueId = (base: string) => {
    const count = (ids.get(base) ?? 0) + 1
    ids.set(base, count)
    return count === 1 ? base : `${base}-${count}`
  }

  for (const loaded of source.personas) {
    const { file } = loaded
    const goal = cohort.missions[loaded.persona.id] ?? cohort.missions['*']
    const persona = goal ? { ...loaded.persona, mission: { ...loaded.persona.mission, goal } } : loaded.persona
    const binding = { ...cohort.roles.persona, ...(cohort.assign[persona.id] ?? {}) }
    const role = {
      driver: overrides.driver ?? binding.driver,
      model: overrides.model ?? binding.model ?? 'default',
      options: { ...(binding.options ?? {}), ...(overrides.driverOptions ?? {}) },
    }
    const variants: { device: Persona['device']; overrides: Persona['deviceOverrides']; label?: string }[] = []
    if (cohort.mode === 'coverage' && cohort.matrix && (cohort.matrix.devices.length || cohort.matrix.locales.length)) {
      const devices = cohort.matrix.devices.length ? cohort.matrix.devices : [persona.device]
      const locales = cohort.matrix.locales.length ? cohort.matrix.locales : [undefined]
      for (const device of devices)
        for (const locale of locales)
          variants.push({
            device,
            overrides: { ...(persona.deviceOverrides ?? {}), ...(locale ? { locale } : {}) },
            label: [typeof device === 'string' ? device : (device.label ?? 'custom'), locale].filter(Boolean).join('@'),
          })
    } else variants.push({ device: persona.device, overrides: persona.deviceOverrides })

    const attempts = cohort.mode === 'gate' ? (cohort.gate?.attempts ?? 3) : 1
    for (const variant of variants)
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        // A vision trait sets up the device; the persona's own deviceOverrides win over it.
        const profile = resolveDeviceProfile(variant.device, { ...visionOverrides(persona.traits.vision), ...(variant.overrides ?? {}) }, limits)
        if (target.target.throttleUrls && !profile.throttleUrls) profile.throttleUrls = target.target.throttleUrls
        const base = [persona.id, variant.label ? slug(variant.label) : '', attempts > 1 ? `a${attempt}` : ''].filter(Boolean).join('--')
        const account = pickAccount(persona)
        sessions.push({
          id: uniqueId(base),
          persona,
          ...(file ? { personaFile: file } : {}),
          profile,
          deviceLabel: describeDevice(profile),
          toolProfile: deriveToolProfile(persona, profile),
          role,
          ...(account ? { account } : {}),
          attempt,
          ...(variant.label ? { variant: variant.label } : {}),
          budget: budgetOf(persona),
          media: [],
        })
      }
  }

  const selected = overrides.personas?.length
    ? sessions.filter((session) => overrides.personas?.some((wanted) => session.id === wanted || session.persona.id === wanted))
    : sessions
  if (!selected.length) throw new PlanError('no sessions to run (check --personas)')

  // Files per session, in order, from one seeded source: a resume of this run picks the same files.
  const runId = overrides.runId ?? newRunId()
  const media = loadMedia(target.target.media)
  const usage = new Map<string, number>()
  const random = seededRandom(seedFrom(`${runId}/media`))
  const warnings: string[] = []
  const warm = new Map<string, boolean>()
  for (const session of selected) {
    const selection = cohort.media[session.persona.id] ?? cohort.media['*'] ?? session.persona.media
    let keep: ((item: MediaItem) => boolean) | undefined
    if (selection?.cached) {
      const dependency = target.target.dependencies.find((candidate) => candidate.id === selection.cached)
      if (!dependency)
        throw new PlanError(`${session.persona.id}'s media asks for files cached by "${selection.cached}", which target ${target.target.id} does not define`)
      keep = (item) => {
        const key = `${dependency.id}\n${item.file}`
        if (!warm.has(key)) warm.set(key, isWarm(dependency, item.file))
        return warm.get(key) ?? false
      }
    }
    session.media = selectMedia(media, selection, { random, usage, ...(keep ? { keep } : {}) })
    if (selection && !session.media.length) warnings.push(`${session.id} has no files: nothing matches its media selection`)
    if (session.media.length > 50)
      warnings.push(`${session.id} has ${session.media.length} files, all listed in its tools: give it a count (media: { count: 10 })`)
  }

  return {
    runId,
    source,
    mode: cohort.mode,
    sessions: selected,
    limits,
    budgets: {
      minutesPerPersona: overrides.minutes ?? cohort.budgets.minutesPerPersona,
      turnsPerPersona: overrides.turns ?? cohort.budgets.turnsPerPersona,
      ...((overrides.usd ?? cohort.budgets.usdPerRun) !== undefined ? { usdPerRun: overrides.usd ?? cohort.budgets.usdPerRun } : {}),
    },
    memory: MemoryPolicy.parse(cohort.memory),
    schedule: {
      waveSize: cohort.schedule.waveSize ?? selected.length,
      waveIntervalSec: cohort.schedule.waveIntervalSec,
      staggerSec: cohort.schedule.staggerSec,
    },
    runsDir: workspace.runsDir,
    overrides: Object.fromEntries(Object.entries(overrides).filter(([key, value]) => key !== 'runId' && value !== undefined)) as RunOverrides,
    media,
    warnings,
  }
}

/**
 * How a persona resolves on its own, without a cohort: its device, tool profile, the device settings its
 * vision trait adds, what its body does and its budget against a baseline (the default cohort's unless
 * given). For checking a persona file (`persona-swarm persona`).
 */
export function describePersona(
  persona: Persona,
  limits: { maxDeviceScaleFactor: number } = { maxDeviceScaleFactor: 1 },
  base: { minutes: number; turns: number } = { minutes: 30, turns: 200 },
) {
  const fromVision = visionOverrides(persona.traits.vision)
  const profile = resolveDeviceProfile(persona.device, { ...fromVision, ...(persona.deviceOverrides ?? {}) }, limits)
  return {
    profile,
    deviceLabel: describeDevice(profile),
    toolProfile: deriveToolProfile(persona, profile),
    fromVision,
    body: bodyOf(persona.traits),
    budget: sessionBudget(persona, { base }),
  }
}
