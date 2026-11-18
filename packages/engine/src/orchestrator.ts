import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  bodyOf,
  EventStore,
  emptyUsage,
  ensureRunDirs,
  formatSize,
  JsonLinesWriter,
  type KnownIssue,
  type MediaItem,
  type ModelPrice,
  nowIso,
  priceOf,
  profileNeedsVision,
  RunLock,
  type RunPaths,
  type RunState,
  RunStore,
  readEvents,
  readJsonFile,
  runPaths,
  type SessionState,
  seedFrom,
  type TargetHooks,
  TOOL_VERSION,
  writeFileAtomic,
} from '@persona-swarm/core'
import { DependencyProxy } from '@persona-swarm/dep-proxy'
import { WebDeviceFarm, type WebFarmOptions } from '@persona-swarm/device-web'
import { DriverProcess, type ModelCapabilities, type SessionEvent } from '@persona-swarm/driver-kit'
import { triageRun, writeReport } from '@persona-swarm/findings'
import { type Diary, loadKnownIssues, RunFindings, ToolServer } from '@persona-swarm/tool-server'
import { kickoffMessage, personaInstructions, remainingBudget, resumeBriefing, usedBudget } from './briefing.js'
import { Governor } from './governor.js'
import { isHealthy, killProcessGroup, runCommands, scriptedSignIn, stopProcess } from './lifecycle.js'
import type { RunPlan, SessionPlan } from './plan.js'

export interface DriverRegistry {
  [name: string]: { command: string[]; env?: Record<string, string> }
}

export interface LiveContext {
  runId: string
  runDir: string
  store: RunStore
  events: EventStore
  control: { stop(reason: string): void; stopSession(id: string, reason?: string): void }
}

export interface OrchestratorOptions {
  drivers: DriverRegistry
  farm?: WebFarmOptions
  log?: (line: string) => void
  /** Called once the run folder, state and events exist (start a live API here). */
  onReady?: (live: LiveContext) => void | Promise<void>
  /** Store a small screenshot after every action, for replay. */
  replayShots?: boolean
  /** Continue an interrupted run (same run id). */
  resume?: boolean
  /** Cancel a session that has not acted for this long. */
  stallSeconds?: number
  handleSignals?: boolean
  prices?: Record<string, ModelPrice>
  registryFile?: string
  /**
   * Groups the reports of a finished run with a model or an agent, before triage (the CLI passes it
   * when the cohort asks for grouping). Returns a line for the log; a failure never fails the run.
   */
  group?: (runDir: string, signal: AbortSignal) => Promise<string | undefined>
}

const TERMINAL = new Set(['finished', 'failed', 'skipped'])

/**
 * A closed terminal (SIGHUP) winds the run down like Ctrl-C (SIGINT) or a kill (SIGTERM), when there is
 * a terminal: a run started with nohup (output redirected) keeps the hang-up ignored, as nohup intends.
 */
const SIGNALS = [...(['SIGINT', 'SIGTERM'] as const), ...(process.stdin.isTTY || process.stdout.isTTY ? (['SIGHUP'] as const) : [])]

/** A hook given up on because the run stopped (not because it failed or ran out of time). */
class HookStopped extends Error {}

/** After its last action, a persona has this long to report what it found and finish. */
const ACTIONS_GRACE_MS = 120_000

/** A session stopped (paused, cancelled) before its driver started. */
class SessionAborted extends Error {}

/**
 * How a session ended. A persona that called finish is finished, whatever came after; running out of
 * time or actions completes a session; a pause (memory, a stall, the run stopping) is resumable; an
 * operator's stop is a cancel; a driver error is a failure.
 */
export function endStatus(reason: string, stopping: boolean, finished: boolean, driverStop?: string): SessionState['status'] {
  if (finished) return 'finished'
  if (reason === 'budget' || driverStop === 'budget') return 'finished'
  if (reason === 'governor' || reason === 'stalled' || stopping) return 'paused'
  if (driverStop === 'error') return 'failed'
  if (reason || driverStop === 'cancelled') return 'cancelled'
  return 'finished'
}

/** Waits, or less if the signal aborts. The listener is removed either way: the scheduler sleeps every second. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolveSleep) => {
    if (signal?.aborted) return resolveSleep()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolveSleep()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

export class Orchestrator {
  readonly paths: RunPaths
  private store!: RunStore
  private events!: EventStore
  private findings!: RunFindings
  private governor!: Governor
  private farm?: WebDeviceFarm
  private farmStarting?: Promise<WebDeviceFarm>
  private tools?: ToolServer
  private readonly deps: DependencyProxy[] = []
  private background: ChildProcess[] = []
  private hooks: TargetHooks = {}
  private readonly controllers = new Map<string, { controller: AbortController; startedAt: number; finished?: boolean }>()
  private readonly capabilities = new Map<string, ModelCapabilities>()
  private stopping = false
  private stopReason?: string
  private readonly runStop = new AbortController()
  /** Cuts the wrap-up short (a stop or a signal after the sessions are over): grouping can take minutes. */
  private readonly wrapUp = new AbortController()
  /** Signals from the operator: a second one exits at once, whatever else is stopping the run. */
  private signals = 0
  private logWriter?: JsonLinesWriter
  private startedTarget = false
  private runLock?: RunLock
  /** Driver processes alive now: killed with the run, even on a hard exit. */
  private readonly liveDrivers = new Set<DriverProcess>()

  constructor(
    readonly plan: RunPlan,
    private readonly options: OrchestratorOptions,
  ) {
    // A resume works in the folder it was given, whatever it is called now (a run folder can be moved or renamed).
    this.paths = plan.runDir ? runPaths(dirname(plan.runDir), basename(plan.runDir)) : runPaths(plan.runsDir, plan.runId)
  }

  get runDir(): string {
    return this.paths.root
  }

  private log(message: string): void {
    const line = `[${nowIso()}] ${message}`
    this.logWriter?.write({ t: nowIso(), message })
    this.options.log?.(line)
  }

  stop(reason: string): void {
    if (['finished', 'failed', 'aborted'].includes(this.store?.state.status ?? '')) {
      // The sessions are over: a stop now cuts the wrap-up short.
      if (!this.wrapUp.signal.aborted) {
        this.log(`stopping the wrap-up: ${reason}`)
        this.wrapUp.abort(reason)
      }
      return
    }
    if (this.stopping) return
    this.stopping = true
    this.stopReason = reason
    this.log(`stopping: ${reason}`)
    this.store?.update((state) => {
      state.status = 'stopping'
      state.statusReason = reason
    })
    this.runStop.abort(reason)
    for (const { controller } of this.controllers.values()) controller.abort(reason)
  }

  stopSession(id: string, reason = 'stopped by the operator'): void {
    this.controllers.get(id)?.controller.abort(reason)
  }

  private initialState(): RunState {
    const { plan } = this
    const sessions: Record<string, SessionState> = {}
    for (const session of plan.sessions)
      sessions[session.id] = {
        id: session.id,
        personaId: session.persona.id,
        name: session.persona.name,
        proficiency: session.persona.proficiency,
        device: session.deviceLabel,
        input: session.profile.input,
        toolProfile: session.toolProfile,
        driver: session.role.driver,
        model: session.role.model,
        ...(session.account ? { account: session.account.id } : {}),
        budget: { minutes: session.budget.minutes, turns: session.budget.turns },
        ...(session.media.length ? { media: session.media.map((item) => item.name) } : {}),
        status: 'pending',
        attempts: 0,
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        harnessErrors: 0,
        findings: 0,
        usage: emptyUsage(),
      }
    const now = nowIso()
    return {
      runId: plan.runId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      status: 'starting',
      mode: plan.mode,
      cohort: { id: plan.source.cohort.id, file: plan.source.file, ...(plan.source.cohort.description ? { description: plan.source.cohort.description } : {}) },
      ...(Object.keys(plan.overrides).length ? { overrides: plan.overrides } : {}),
      target: { id: plan.source.target.target.id, name: plan.source.target.target.name, baseUrl: plan.source.target.target.baseUrl },
      host: { platform: `${process.platform}-${process.arch}`, node: process.version, tool: `persona-swarm ${TOOL_VERSION}`, pid: process.pid },
      governor: { level: 'ok', freePercent: 100, samples: 0 },
      budgets: plan.budgets,
      limits: {
        maxBrowsers: plan.limits.maxBrowsers,
        maxAgents: plan.limits.maxAgents,
        minFreeMemoryPercent: plan.limits.minFreeMemoryPercent,
        stopBelowFreeMemoryPercent: plan.limits.stopBelowFreeMemoryPercent,
      },
      sessions,
      totals: { ...emptyUsage(), findings: 0 },
    }
  }

  private async prepare(): Promise<void> {
    ensureRunDirs(this.paths)
    // One process per run folder: resuming a run that is still executing would run its sessions twice.
    const lock = RunLock.acquire(this.paths.root)
    if (!(lock instanceof RunLock))
      throw new Error(
        lock.local
          ? `run ${this.plan.runId} is still executing in process ${lock.heldBy}; stop it first (persona-swarm stop ${this.plan.runId})`
          : `run.lock says process ${lock.heldBy} on ${lock.host} is executing run ${this.plan.runId}. If nothing runs it there any more, delete ${join(this.paths.root, 'run.lock')} and try again.`,
      )
    this.runLock = lock
    this.logWriter = new JsonLinesWriter(join(this.paths.logsDir, 'orchestrator.jsonl'))
    this.events = new EventStore(this.paths.eventsDir)
    const existing = this.options.resume ? await RunStore.load(this.paths.runFile) : undefined
    if (this.options.resume && !existing) throw new Error(`${this.paths.root} has no run.json: there is nothing to resume there`)
    // Each session's files, with their truth and notes, for hooks, reviewers and the report. A resume
    // keeps the files each session was given, even if the cohort or the folder changed since.
    const mediaFile = join(this.paths.root, 'media.json')
    const recorded = existing ? await readJsonFile<{ sessions?: Record<string, MediaItem[]> } | undefined>(mediaFile, undefined) : undefined
    if (recorded?.sessions) for (const session of this.plan.sessions) session.media = recorded.sessions[session.id] ?? session.media
    else
      await writeFileAtomic(
        mediaFile,
        `${JSON.stringify({ sessions: Object.fromEntries(this.plan.sessions.map((session) => [session.id, session.media])) }, null, 2)}\n`,
      )
    if (existing) {
      this.store = existing
      // A resume runs sessions of the original run only, even if the cohort file changed since.
      // Sessions left out this time (a narrower --personas) stay resumable.
      const planned = new Set(this.plan.sessions.map((session) => session.id))
      const added = this.plan.sessions.filter((session) => !existing.state.sessions[session.id]).map((session) => session.id)
      if (added.length) this.log(`not part of the original run, not started on resume: ${added.join(', ')}`)
      this.plan.sessions = this.plan.sessions.filter((session) => existing.state.sessions[session.id])
      this.store.update((state) => {
        state.status = 'starting'
        delete state.statusReason
        delete state.gate
        // The address of an earlier execution's live view: this one gets its own (or none).
        delete state.api
        state.host.pid = process.pid
        for (const session of Object.values(state.sessions)) {
          if (TERMINAL.has(session.status)) continue
          if (planned.has(session.id)) session.status = 'pending'
          else if (session.status === 'running' || session.status === 'starting') session.status = 'paused'
        }
      })
      for (const id of Object.keys(this.store.state.sessions)) await this.events.primeFromDisk(id)
      await this.events.primeFromDisk('_run')
      this.log(`resuming run ${this.plan.runId}`)
    } else {
      this.store = RunStore.create(this.paths.runFile, this.initialState())
      await this.store.flush()
    }
    // Known issues are snapshotted with the run, so triage and a resume see the same list.
    const target = this.plan.source.target.target
    let knownIssues = await readJsonFile<KnownIssue[] | undefined>(this.paths.knownIssuesFile, undefined)
    if (!knownIssues) {
      knownIssues = loadKnownIssues(target.knownIssues)
      if (knownIssues.length) await writeFileAtomic(this.paths.knownIssuesFile, `${JSON.stringify(knownIssues, null, 2)}\n`)
    }
    this.findings = new RunFindings(this.paths.findingsFile, this.events, knownIssues)
    await this.findings.load()
    this.governor = new Governor(
      this.plan.limits,
      (level, sample) => {
        this.store.update((state) => {
          state.governor = { level, freePercent: Math.round(sample.freePercent * 10) / 10, samples: this.governor.samples }
        })
        this.events.append('_run', 'governor', { level, freePercent: sample.freePercent, source: sample.source })
        if (level === 'critical') this.onCritical()
      },
      undefined,
      (sample, level) => {
        if (level !== 'critical') this.criticalStreak = 0
        const freePercent = Math.round(sample.freePercent * 10) / 10
        if (this.store.state.governor.freePercent !== freePercent)
          this.store.update((state) => {
            state.governor = { level, freePercent, samples: this.governor.samples }
          })
      },
    )
  }

  private criticalStreak = 0

  private onCritical(): void {
    const running = [...this.controllers.entries()]
      .filter(([, entry]) => !entry.controller.signal.aborted && !entry.finished)
      .sort((a, b) => b[1].startedAt - a[1].startedAt)
    const newest = running[0]
    if (newest) {
      this.criticalStreak = 0
      this.log(`memory critical (${this.governor.freePercent}% free): pausing ${newest[0]}`)
      newest[1].controller.abort('governor')
      return
    }
    this.criticalStreak += 1
    if (this.criticalStreak >= 2) this.stop(`free memory stayed below ${this.plan.limits.stopBelowFreeMemoryPercent}%`)
  }

  private async startDependencies(): Promise<void> {
    for (const dependency of this.plan.source.target.target.dependencies) {
      const proxy = new DependencyProxy(dependency, (event) => this.events.append('_run', 'dependency', { ...event }))
      await proxy.start()
      this.deps.push(proxy)
      this.log(`dependency ${dependency.id} (${dependency.mode}) on ${proxy.address} → ${dependency.upstream}`)
    }
  }

  private async startTarget(): Promise<void> {
    const target = this.plan.source.target.target
    const health = target.health?.url ?? target.baseUrl
    if (await isHealthy(health, target.health?.timeoutSec)) return
    if (!target.lifecycle.up?.length) throw new Error(`${target.name} is not answering at ${health}. Start it, or give the target lifecycle.up commands.`)
    // Marked before the commands run: whatever they started is stopped (and lifecycle.down run) even if they fail.
    this.startedTarget = true
    await runCommands(target.lifecycle.up, {
      logsDir: this.paths.logsDir,
      label: 'target-up',
      log: (message) => this.log(message),
      signal: this.runStop.signal,
      track: (child) => this.background.push(child),
    })
    if (!(await isHealthy(health, 10))) throw new Error(`${target.name} still does not answer at ${health} after lifecycle.up`)
  }

  private async loadHooks(): Promise<void> {
    const file = this.plan.source.target.target.hooks
    if (!file) return
    if (!existsSync(file)) throw new Error(`target hooks module ${file} not found`)
    const loaded = (await import(pathToFileURL(file).href)) as { default?: TargetHooks } & TargetHooks
    this.hooks = loaded.default ?? loaded
  }

  /** What every hook gets; `signal` is the one the hook is given up on (see callHook). */
  private hookContext(signal: AbortSignal = this.runStop.signal) {
    return {
      runId: this.plan.runId,
      runDir: this.paths.root,
      target: this.plan.source.target.target,
      media: this.plan.media,
      log: (message: string) => this.log(`hook: ${message}`),
      signal,
    }
  }

  /**
   * Calls a target hook, a plain or an async function, with the signal it is given up on: after the
   * target's hookTimeoutSec, or when `stop` aborts (clean-up hooks get no `stop`: only their time limit
   * ends them). One that throws or rejects fails only its own step.
   */
  private async callHook<T>(name: string, call: (signal: AbortSignal) => T | Promise<T>, stop?: AbortSignal): Promise<T> {
    const timeoutMs = this.plan.source.target.target.hookTimeoutSec * 1000
    const givenUpOn = new AbortController()
    const timer = setTimeout(() => givenUpOn.abort(new Error(`the ${name} hook did not finish within ${timeoutMs / 1000} s`)), timeoutMs)
    const onStop = () => givenUpOn.abort(new HookStopped(`the ${name} hook was stopped (${String(stop?.reason ?? 'the run stopped')})`))
    if (stop?.aborted) onStop()
    else stop?.addEventListener('abort', onStop, { once: true })
    const givenUp = new Promise<never>((_, reject) => {
      if (givenUpOn.signal.aborted) reject(givenUpOn.signal.reason)
      else givenUpOn.signal.addEventListener('abort', () => reject(givenUpOn.signal.reason), { once: true })
    })
    givenUp.catch(() => {})
    try {
      return await Promise.race([Promise.resolve().then(() => call(givenUpOn.signal)), givenUp])
    } finally {
      clearTimeout(timer)
      stop?.removeEventListener('abort', onStop)
    }
  }

  private driverCommand(name: string) {
    const entry = this.options.drivers[name]
    if (!entry) throw new Error(`unknown driver "${name}"; known drivers: ${Object.keys(this.options.drivers).join(', ')}`)
    return entry
  }

  private async startDriver(name: string, logFile: string, session?: string): Promise<DriverProcess> {
    const entry = this.driverCommand(name)
    const driver = await DriverProcess.start({
      command: entry.command,
      // Drivers may keep artefacts with the run (the external bridge writes its session files there).
      env: { ...(entry.env ?? {}), PERSONA_SWARM_RUN_DIR: this.paths.root, ...(session ? { PERSONA_SWARM_SESSION: session } : {}) },
      logFile,
      host: { name: 'persona-swarm', version: TOOL_VERSION },
    })
    this.liveDrivers.add(driver)
    void driver.exited.then(() => this.liveDrivers.delete(driver))
    return driver
  }

  /** The remaining spend cap divided among the sessions that may still run at the same time. */
  private sessionSpendCap(cap: number): number {
    const open = Object.values(this.store.state.sessions).filter((session) => !TERMINAL.has(session.status)).length
    const atOnce = Math.max(1, Math.min(this.plan.limits.maxAgents, this.plan.limits.maxBrowsers, open))
    return Math.max(0.01, Math.round(((cap - this.store.state.totals.costUsd) / atOnce) * 100) / 100)
  }

  /** Last resort on a hard exit (a second Ctrl-C): nothing this run started may outlive it. */
  private killChildrenNow(): void {
    for (const driver of this.liveDrivers) driver.kill('SIGKILL')
    for (const child of this.background) killProcessGroup(child, 'SIGTERM')
  }

  /** Asks each driver what each model can do, and skips sessions a model cannot play. */
  private async probeCapabilities(): Promise<void> {
    const pairs = new Map<string, { driver: string; model: string; options: Record<string, unknown> }>()
    for (const session of this.plan.sessions) pairs.set(`${session.role.driver}|${session.role.model}`, session.role)
    for (const [key, { driver, model, options }] of pairs) {
      const process = await this.startDriver(driver, join(this.paths.logsDir, `driver-probe-${driver}.log`))
      try {
        this.capabilities.set(key, await process.capabilities(model, this.driverOptions(options)))
      } finally {
        await process.shutdown(3000)
      }
    }
    // A spend cap the run cannot measure is worse than none: refuse it before anything runs.
    const cap = this.plan.budgets.usdPerRun
    if (cap)
      for (const [key, caps] of this.capabilities) {
        const [driver, model] = key.split('|') as [string, string]
        if (caps.usesModel && !caps.reportsCost && !this.options.prices?.[model])
          throw new Error(
            `the run's spend cap ($${cap}) cannot be enforced for ${driver}/${model}: the driver reports no cost and persona-swarm.yaml has no price for "${model}". Add prices: { "${model}": { input: …, output: … } } (USD per million tokens), or remove usdPerRun.`,
          )
      }
    for (const session of this.plan.sessions) {
      const caps = this.capabilities.get(`${session.role.driver}|${session.role.model}`)
      if (!caps || TERMINAL.has(this.store.state.sessions[session.id]?.status ?? '')) continue
      // A persona's own requirement wins over its profile's (true or false); by default, screenshots need sight.
      const needsVision = session.persona.requires.vision ?? profileNeedsVision(session.toolProfile)
      const reason = !caps.toolCalling
        ? `model ${session.role.model} cannot call tools`
        : needsVision && !caps.imageInput
          ? `model ${session.role.model} cannot see screenshots, which the "${session.toolProfile}" profile needs (use a vision model, or toolProfile: screenreader)`
          : session.persona.requires.minContext && caps.contextWindow < session.persona.requires.minContext
            ? `model ${session.role.model} has a ${caps.contextWindow}-token context; ${session.persona.id} needs ${session.persona.requires.minContext}`
            : undefined
      if (reason) {
        this.log(`skipping ${session.id}: ${reason}`)
        this.store.update((state) => {
          const record = state.sessions[session.id]
          if (record) {
            record.status = 'skipped'
            record.error = reason
          }
        })
      }
    }
  }

  /** Role options plus the workspace's named providers, so drivers can resolve "local:model" ids. */
  private driverOptions(options: Record<string, unknown>): Record<string, unknown> {
    const providers = this.plan.source.workspace.config.providers
    return Object.keys(providers).length && !('providers' in options) ? { ...options, providers } : options
  }

  private async ensureFarm(): Promise<WebDeviceFarm> {
    if (this.farm) return this.farm
    const browser = this.plan.source.workspace.config.browser
    const target = this.plan.source.target.target
    const options: WebFarmOptions = {
      ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
      ...(browser.headless !== undefined ? { headless: browser.headless } : {}),
      ...(browser.connect ? { connect: browser.connect } : {}),
      ...(browser.screenshotQuality ? { screenshotQuality: browser.screenshotQuality } : {}),
      ...(browser.settleMs !== undefined ? { settleMs: browser.settleMs } : {}),
      ...(target.extraOrigins.length ? { extraOrigins: target.extraOrigins } : {}),
      ...this.options.farm,
    }
    this.farmStarting ??= WebDeviceFarm.launch(options).then((farm) => {
      this.farm = farm
      return farm
    })
    return this.farmStarting
  }

  private updateSession(id: string, mutate: (session: SessionState, state: RunState) => void): void {
    this.store.update((state) => {
      const session = state.sessions[id]
      if (session) mutate(session, state)
    })
  }

  private priceOf(model: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }): number {
    return priceOf(this.options.prices?.[model], usage)
  }

  private async runSession(plan: SessionPlan): Promise<void> {
    const target = this.plan.source.target.target
    const id = plan.id
    const controller = new AbortController()
    const entry: { controller: AbortController; startedAt: number; finished?: boolean } = { controller, startedAt: Date.now() }
    this.controllers.set(id, entry)
    const previous = this.options.resume ? await readEvents(this.paths.eventsDir, id) : []
    // The budget is per persona: a resumed session gets what its earlier attempts left.
    const { minutes, turns } = remainingBudget({ minutes: plan.budget.minutes, turns: plan.budget.turns }, usedBudget(previous))
    this.updateSession(id, (session) => {
      session.status = 'starting'
      session.attempts += 1
      session.startedAt ??= nowIso()
      // This attempt's own ending: nothing from an earlier attempt carries over.
      delete session.error
      delete session.outcome
      delete session.stopReason
      delete session.endedAt
    })
    let device: Awaited<ReturnType<WebDeviceFarm['createDevice']>> | undefined
    let driver: DriverProcess | undefined
    const timers: NodeJS.Timeout[] = []
    let finishedAt: number | undefined
    let lastActivity = Date.now()
    // A pause or stop can land while the session is still being set up: it must not be lost.
    const checkAbort = () => {
      if (controller.signal.aborted) throw new SessionAborted(String(controller.signal.reason ?? 'cancelled'))
    }
    try {
      const farm = await this.ensureFarm()
      checkAbort()
      device = await farm.createDevice({
        id,
        profile: plan.profile,
        baseUrl: target.baseUrl,
        downloadsDir: join(this.paths.downloadsDir, id),
        fileSources: [],
        media: plan.media.map((item) => ({ name: item.name, file: item.file, type: item.type })),
        ...(plan.profile.throttleUrls ? { throttleUrls: plan.profile.throttleUrls } : {}),
        ...(plan.persona.traits.pace === 'rushes' ? { rush: true } : {}),
        onSignal: () => {},
      })
      checkAbort()
      const startUrl = target.signIn.url ?? target.baseUrl
      await device.perform({ type: 'open', url: startUrl })
      checkAbort()
      if (target.signIn.mode === 'scripted' && plan.account) await scriptedSignIn(device, target, plan.account)
      checkAbort()
      const before = this.hooks.beforeSession
      const ready = device
      if (before)
        await this.callHook(
          'beforeSession',
          (signal) =>
            before({
              ...this.hookContext(signal),
              session: id,
              persona: plan.persona,
              sessionMedia: plan.media,
              ...(plan.account ? { account: plan.account } : {}),
              device: ready,
            }),
          controller.signal,
        )
      const deadline = Date.now() + minutes * 60_000
      const endpoint = (this.tools as ToolServer).register({
        sessionId: id,
        personaName: plan.persona.name,
        device,
        profile: plan.toolProfile,
        input: plan.profile.input,
        files: plan.media.map((item) => ({ name: item.name, size: formatSize(item.bytes), ...(item.description ? { label: item.description } : {}) })),
        shotsDir: join(this.paths.shotsDir, id),
        shotsRel: `shots/${id}`,
        events: this.events,
        findings: this.findings,
        baseUrl: target.baseUrl,
        deadline,
        maxActions: turns,
        replayShots: this.options.replayShots ?? true,
        networkToggle: plan.profile.network !== undefined || /wi-?fi|offline|network|connection/i.test(plan.persona.mission.goal),
        body: bodyOf(plan.persona.traits),
        seed: seedFrom(`${this.plan.runId}/${id}`),
        hooks: {
          onAction: ({ ok, harnessError }) => {
            lastActivity = Date.now()
            this.updateSession(id, (session) => {
              session.toolCalls += 1
              if (!ok && harnessError) session.harnessErrors += 1
              else if (!ok) session.toolErrors += 1
              session.lastActionAt = nowIso()
            })
          },
          onScreenshot: (path) => this.updateSession(id, (session) => (session.lastScreenshot = path)),
          onNote: (text) => this.updateSession(id, (session) => (session.lastNote = text.slice(0, 300))),
          onFinding: () =>
            this.updateSession(id, (session, state) => {
              session.findings += 1
              state.totals.findings += 1
            }),
          onFinish: (diary: Diary) => {
            finishedAt = Date.now()
            entry.finished = true
            this.updateSession(id, (session) => (session.outcome = diary.outcome))
            writeFileAtomic(join(this.paths.diariesDir, `${id}.json`), `${JSON.stringify(diary, null, 2)}\n`).catch((error: Error) =>
              this.log(`${id}: could not write the diary (${error.message}); it is in the events`),
            )
            timers.push(setTimeout(() => controller.abort('finished'), 45_000))
          },
          // The last action is spent: a little time to report and finish, then the session ends as out of budget.
          onActionsSpent: () => {
            this.log(`${id}: no actions left; ${ACTIONS_GRACE_MS / 1000} s to report and finish`)
            this.events.append(id, 'notice', { text: 'no actions left' })
            driver?.notice(id, 'You have used all your actions. Report anything you have not reported yet, then call finish with your honest account.')
            timers.push(setTimeout(() => controller.abort('budget'), ACTIONS_GRACE_MS))
          },
        },
      })
      checkAbort()
      driver = await this.startDriver(plan.role.driver, join(this.paths.logsDir, `driver-${id}.log`), id)
      checkAbort()
      const resume = previous.length ? resumeBriefing(previous) : undefined
      if (resume) this.log(`${id}: resuming with ${minutes} min and ${turns} actions left`)
      this.events.append(id, 'session.start', {
        persona: plan.persona.id,
        driver: plan.role.driver,
        model: plan.role.model,
        device: plan.deviceLabel,
        toolProfile: plan.toolProfile,
        attempt: this.store.state.sessions[id]?.attempts ?? 1,
        resumed: Boolean(resume),
      })
      this.updateSession(id, (session) => (session.status = 'running'))

      const noticeAt = Math.max(60_000, minutes * 60_000 * 0.8)
      timers.push(
        setTimeout(() => {
          const left = Math.max(1, Math.round((deadline - Date.now()) / 60_000))
          driver?.notice(
            id,
            `About ${left} minute${left === 1 ? '' : 's'} left in this session. Wrap up; when you are done, call finish with your honest account.`,
          )
          this.events.append(id, 'notice', { text: 'time warning', minutesLeft: left })
        }, noticeAt),
      )
      timers.push(setTimeout(() => controller.abort('budget'), minutes * 60_000))
      const stallMs = (this.options.stallSeconds ?? 300) * 1000
      timers.push(
        setInterval(() => {
          if (Date.now() - lastActivity > stallMs) controller.abort('stalled')
        }, 15_000),
      )

      const onEvent = (event: SessionEvent) => {
        lastActivity = Date.now()
        switch (event.type) {
          case 'assistant':
            if (event.text.trim()) this.events.append(id, 'agent.text', { text: event.text.slice(0, 4000) })
            break
          case 'turn':
            this.updateSession(id, (session) => (session.turns = event.n))
            break
          case 'usage': {
            const cost = event.costUsd ?? this.priceOf(plan.role.model, event)
            this.events.append(id, 'agent.usage', { ...event, costUsd: cost })
            this.updateSession(id, (session, state) => {
              session.usage.inputTokens += event.inputTokens
              session.usage.outputTokens += event.outputTokens
              session.usage.cachedInputTokens += event.cachedInputTokens
              session.usage.costUsd += cost
              state.totals.inputTokens += event.inputTokens
              state.totals.outputTokens += event.outputTokens
              state.totals.cachedInputTokens += event.cachedInputTokens
              state.totals.costUsd += cost
            })
            const cap = this.plan.budgets.usdPerRun
            if (cap && this.store.state.totals.costUsd > cap) this.stop(`the run's spend cap of $${cap} was reached`)
            break
          }
          case 'memory':
            this.events.append(id, 'agent.memory', { action: event.action, detail: event.detail })
            break
          case 'log':
            if (event.level !== 'debug') this.events.append(id, 'agent.log', { level: event.level, message: event.message.slice(0, 2000) })
            // What a driver wants the operator to see (the external driver's brief, for one).
            if (event.level === 'info') this.log(`${id}: ${event.message.slice(0, 300)}`)
            break
          default:
            break
        }
      }

      const result = await driver.runSession(
        {
          sessionId: id,
          model: plan.role.model,
          instructions: personaInstructions(plan, target, minutes, turns),
          kickoff: kickoffMessage(plan, new URL(startUrl, target.baseUrl).href, resume),
          mcp: endpoint,
          // The tool server enforces the action budget for every driver; the driver's own turn limit is a
          // backstop, with room for the free tools (looking, notes, reports) on top of the actions.
          budget: {
            maxTurns: turns * 3 + 20,
            maxSeconds: Math.round(minutes * 60),
            // What is left of the cap, shared by the sessions that can run at once.
            ...(this.plan.budgets.usdPerRun ? { maxUsd: this.sessionSpendCap(this.plan.budgets.usdPerRun) } : {}),
          },
          memory: this.plan.memory,
          // The model's price, when the workspace has one, lets a driver cost each call as it happens.
          options: {
            ...this.driverOptions(plan.role.options),
            ...(this.options.prices?.[plan.role.model] ? { price: this.options.prices[plan.role.model] } : {}),
          },
        },
        { onEvent, signal: controller.signal, graceMs: 15_000, hardTimeoutMs: (minutes * 60 + 180) * 1000 },
      )
      const reason = controller.signal.aborted ? String(controller.signal.reason ?? '') : ''
      const status = endStatus(reason, this.stopping, Boolean(finishedAt), result.stopReason)
      this.updateSession(id, (session) => {
        session.status = status
        session.stopReason = finishedAt ? 'finished' : reason || result.stopReason
        if (result.error) session.error = result.error
        if (!session.outcome && (reason === 'budget' || result.stopReason === 'budget')) session.outcome = 'ran_out_of_time'
        session.turns = Math.max(session.turns, result.turns)
        session.endedAt = nowIso()
      })
      this.events.append(id, 'session.end', {
        stopReason: result.stopReason,
        status,
        reason,
        turns: result.turns,
        ...(result.error ? { error: result.error } : {}),
      })
      this.log(`${id}: ${status} (${finishedAt ? 'finished by persona' : reason || result.stopReason})`)
    } catch (error) {
      const message = (error as Error).message
      const reason = controller.signal.aborted ? String(controller.signal.reason ?? '') : ''
      // Stopped on purpose (by the governor, the operator or the run) rather than broken.
      const status = endStatus(reason, this.stopping, Boolean(finishedAt), controller.signal.aborted ? 'cancelled' : 'error')
      this.log(`${id}: ${status === 'failed' ? `failed: ${message}` : `${status} (${reason || message})`}`)
      if (status === 'failed') this.events.append(id, 'error', { message })
      this.updateSession(id, (session) => {
        session.status = status
        if (status === 'failed') session.error = message
        else session.stopReason = finishedAt ? 'finished' : reason
        if (!session.outcome && reason === 'budget') session.outcome = 'ran_out_of_time'
        session.endedAt = nowIso()
      })
    } finally {
      // Nothing here may throw: a session's end must never take the run down.
      for (const timer of timers) clearTimeout(timer)
      this.controllers.delete(id)
      await driver?.shutdown(3000).catch(() => {})
      await Promise.resolve(this.tools?.unregister(id)).catch(() => {})
      // Journey checks judge a finished attempt; a paused or failed one is no evidence either way.
      const check = this.hooks.check
      if (device && check && target.journeys.length && this.store.state.sessions[id]?.status === 'finished') {
        const events = await readEvents(this.paths.eventsDir, id).catch(() => [])
        for (const journey of target.journeys) {
          try {
            const result = await this.callHook(
              'check',
              (signal) =>
                check({
                  ...this.hookContext(signal),
                  session: id,
                  persona: plan.persona,
                  sessionMedia: plan.media,
                  ...(plan.account ? { account: plan.account } : {}),
                  device: device as NonNullable<typeof device>,
                  journey: journey.id,
                  events,
                }),
              this.runStop.signal,
            )
            this.events.append(id, 'check', { journey: journey.id, passed: Boolean(result?.passed), details: String(result?.details ?? '') })
          } catch (error) {
            // A check the run's stop cut short did not run: it is no evidence that the journey failed.
            const stopped = error instanceof HookStopped
            this.events.append(id, 'check', {
              journey: journey.id,
              passed: false,
              ...(stopped ? { ran: false } : {}),
              details: `${stopped ? 'not run' : 'check failed'}: ${(error as Error).message}`,
            })
          }
        }
      }
      if (device) {
        const after = this.hooks.afterSession
        if (after)
          // A clean-up hook runs even when the run is stopping: only its time limit applies.
          await this.callHook('afterSession', async (signal) =>
            after({
              ...this.hookContext(signal),
              session: id,
              persona: plan.persona,
              sessionMedia: plan.media,
              ...(plan.account ? { account: plan.account } : {}),
              device: device as NonNullable<typeof device>,
              events: await readEvents(this.paths.eventsDir, id),
            }),
          ).catch((error: Error) => this.log(`afterSession hook: ${error.message}`))
        await device.close().catch(() => {})
      }
    }
  }

  private async schedule(): Promise<void> {
    const pending = this.plan.sessions.filter((session) => this.store.state.sessions[session.id]?.status === 'pending')
    const running = new Map<string, Promise<void>>()
    const accounts = new Map<string, string>()
    const cap = Math.min(this.plan.limits.maxAgents, this.plan.limits.maxBrowsers)
    const { waveSize, waveIntervalSec, staggerSec } = this.plan.schedule
    let startedInWave = 0
    let waveStartedAt = Date.now()
    let waitingSince: number | undefined
    while ((pending.length || running.size) && !this.stopping) {
      // Memory too low to start anything, and nothing running that could free it: give up after a while.
      if (pending.length && !running.size && this.governor.level !== 'ok') {
        waitingSince ??= Date.now()
        if (Date.now() - waitingSince > 10 * 60_000) {
          this.stop(`free memory stayed below ${this.plan.limits.minFreeMemoryPercent}% for 10 minutes with nothing running`)
          break
        }
      } else waitingSince = undefined
      let started = false
      // A test account that is not shared serves one session at a time (gate attempts of one persona share it).
      const busy = new Set([...running.keys()].map((id) => accounts.get(id)).filter(Boolean))
      const free = pending.findIndex((session) => !session.account || session.account.shared || !busy.has(session.account.id))
      if (free >= 0 && running.size < cap && this.governor.level === 'ok') {
        if (startedInWave >= waveSize && Date.now() - waveStartedAt >= waveIntervalSec * 1000) {
          startedInWave = 0
          waveStartedAt = Date.now()
        }
        if (startedInWave < waveSize) {
          const next = pending.splice(free, 1)[0] as SessionPlan
          startedInWave += 1
          if (startedInWave === 1) waveStartedAt = Date.now()
          this.log(`starting ${next.id} (${next.role.driver}/${next.role.model}, ${next.deviceLabel}, ${next.toolProfile})`)
          if (next.account && !next.account.shared) accounts.set(next.id, next.account.id)
          running.set(
            next.id,
            this.runSession(next)
              .catch((error: Error) => this.log(`${next.id}: ${error.message}`))
              .finally(() => {
                running.delete(next.id)
                accounts.delete(next.id)
              }),
          )
          started = true
        }
      }
      if (started && staggerSec > 0) await sleep(staggerSec * 1000, this.runStop.signal)
      else await Promise.race([...running.values(), sleep(1000, this.runStop.signal)])
    }
    await Promise.allSettled([...running.values()])
  }

  private async finish(): Promise<void> {
    const teardown = this.hooks.teardown
    if (teardown)
      await this.callHook('teardown', (signal) => teardown(this.hookContext(signal))).catch((error: Error) => this.log(`teardown hook: ${error.message}`))
    await Promise.all(this.deps.map((proxy) => proxy.stop().catch(() => {})))
    if (this.startedTarget) {
      const down = this.plan.source.target.target.lifecycle.down ?? []
      if (down.length)
        await runCommands(down, {
          logsDir: this.paths.logsDir,
          label: 'target-down',
          log: (message) => this.log(message),
          track: (child) => this.background.push(child),
        }).catch((error: Error) => this.log(error.message))
      for (const child of this.background) stopProcess(child)
    }
    await this.tools?.close().catch(() => {})
    await this.farm?.close().catch(() => {})
    this.governor?.stop()
  }

  /**
   * Gate mode: a persona passes when at least `mustPass` of its attempts finished with every journey
   * check passing (or, without checks, finished with outcome "completed"). Attempts that did not run
   * to the end (paused, cancelled, crashed) are no evidence either way: when they could have made the
   * difference, the verdict is "inconclusive" rather than a product failure. Writes gate.json.
   */
  private async gateVerdict(): Promise<{ passed: boolean; failing: string[]; inconclusive: string[] }> {
    const mustPass = this.plan.source.cohort.gate?.mustPass ?? 2
    const byPersona = new Map<string, { attempts: number; ran: number; passes: number; details: string[] }>()
    // Every attempt of the run counts, including those a narrower resume did not run this time.
    for (const state of Object.values(this.store.state.sessions)) {
      // Only the checks of the attempt that finished: an earlier, interrupted attempt is no evidence.
      const all = await readEvents(this.paths.eventsDir, state.id, { types: ['session.start', 'check'] })
      const lastStart = all.filter((event) => event.type === 'session.start').at(-1)?.seq ?? 0
      const events = all.filter((event) => event.type === 'check' && event.seq > lastStart)
      // An attempt whose checks the run's stop cut short did not run to the end either.
      const ran = state.status === 'finished' && !events.some((event) => event.ran === false)
      const checksPassed = events.length > 0 && events.every((event) => event.passed === true)
      const passed = ran && (events.length ? checksPassed : state.outcome === 'completed')
      const entry = byPersona.get(state.personaId) ?? { attempts: 0, ran: 0, passes: 0, details: [] }
      entry.attempts += 1
      if (ran) entry.ran += 1
      if (passed) entry.passes += 1
      entry.details.push(
        `${state.id}: ${passed ? 'pass' : ran ? 'fail' : 'did not run'}${events.length ? ` (${events.map((event) => `${String(event.journey)} ${event.passed ? 'ok' : 'failed'}`).join(', ')})` : ` (${state.outcome ?? state.status})`}`,
      )
      byPersona.set(state.personaId, entry)
    }
    const personas = Object.fromEntries(
      [...byPersona].map(([id, entry]) => {
        const needed = Math.min(mustPass, entry.attempts)
        const verdict = entry.passes >= needed ? 'passed' : entry.passes + (entry.attempts - entry.ran) >= needed ? 'inconclusive' : 'failed'
        return [id, { ...entry, verdict, passed: verdict === 'passed' }]
      }),
    )
    const failing = Object.entries(personas)
      .filter(([, entry]) => entry.verdict === 'failed')
      .map(([id]) => id)
    const inconclusive = Object.entries(personas)
      .filter(([, entry]) => entry.verdict === 'inconclusive')
      .map(([id]) => id)
    const verdict = { mustPass, passed: !failing.length && !inconclusive.length, failing, inconclusive, personas }
    await writeFileAtomic(join(this.paths.root, 'gate.json'), `${JSON.stringify(verdict, null, 2)}\n`)
    this.log(`gate ${verdict.passed ? 'passed' : failing.length ? `failed (${failing.join(', ')})` : `inconclusive (${inconclusive.join(', ')})`}`)
    return verdict
  }

  /** Runs the plan to the end and returns the final state. Never throws after the run folder exists. */
  /**
   * Runs the plan to the end and returns the final state. Throws only when the run cannot start (its
   * folder is held by another process, nothing to resume); run.json, when it exists, says why.
   */
  async run(): Promise<RunState> {
    try {
      await this.prepare()
    } catch (error) {
      if (this.store) {
        this.store.update((state) => {
          state.status = 'failed'
          state.statusReason = (error as Error).message
        })
        await this.store.flush().catch(() => {})
      }
      await this.events?.close().catch(() => {})
      await this.logWriter?.close()
      this.runLock?.release()
      throw error
    }
    const onSignal = (signal: NodeJS.Signals) => {
      this.signals += 1
      // Only the operator's second signal exits at once: a stop for another reason (the spend cap, memory) is not one.
      if (this.signals >= 2) {
        this.log(`second ${signal}: exiting now`)
        process.exit(130)
      }
      if (this.stopping) {
        this.log(`${signal}: the run is already stopping (${this.stopReason ?? 'stopping'}); send it again to exit at once`)
        return
      }
      this.stop(`received ${signal}`)
    }
    if (this.options.handleSignals !== false) for (const signal of SIGNALS) process.on(signal, onSignal)
    const onExit = () => this.killChildrenNow()
    process.on('exit', onExit)
    try {
      await this.options.onReady?.({
        runId: this.plan.runId,
        runDir: this.paths.root,
        store: this.store,
        events: this.events,
        control: { stop: (reason) => this.stop(reason), stopSession: (id, reason) => this.stopSession(id, reason) },
      })
      const first = await this.governor.sample()
      if (first.freePercent < this.plan.limits.minFreeMemoryPercent)
        throw new Error(`only ${Math.round(first.freePercent)}% memory is free; a run needs at least ${this.plan.limits.minFreeMemoryPercent}% to start`)
      this.governor.start()
      await this.startDependencies()
      await this.startTarget()
      await this.loadHooks()
      const setup = this.hooks.setup
      if (setup) await this.callHook('setup', (signal) => setup(this.hookContext(signal)), this.runStop.signal)
      await this.probeCapabilities()
      // A resumed run that already spent its cap starts nothing.
      const cap = this.plan.budgets.usdPerRun
      if (cap && this.store.state.totals.costUsd >= cap) this.stop(`the run's spend cap of $${cap} was already reached`)
      this.tools = await ToolServer.start()
      this.store.update((state) => (state.status = 'running'))
      this.log(`run ${this.plan.runId}: ${this.plan.sessions.length} session(s) against ${this.plan.source.target.target.baseUrl}`)
      await this.schedule()
      // Nothing left to protect: a late memory dip must not turn a finished run into a stopped one.
      this.governor.stop()
      const gate = this.plan.mode === 'gate' ? await this.gateVerdict() : undefined
      const sessions = Object.values(this.store.state.sessions)
      // A run where no session got to the end tested nothing: that is a failed run, not a finished one.
      const noneFinished = sessions.length > 0 && !sessions.some((session) => session.status === 'finished')
      this.store.update((state) => {
        state.status = this.stopping ? 'aborted' : noneFinished ? 'failed' : 'finished'
        if (gate) state.gate = { passed: gate.passed, failing: gate.failing, inconclusive: gate.inconclusive }
        if (this.stopReason) state.statusReason = this.stopReason
        else if (noneFinished)
          state.statusReason = `no session finished${sessions.find((session) => session.error) ? ` (first error: ${sessions.find((session) => session.error)?.error?.slice(0, 200)})` : ''}`
        else if (gate)
          state.statusReason = gate.passed
            ? 'gate passed'
            : gate.failing.length
              ? `gate failed: ${gate.failing.join(', ')}`
              : `gate inconclusive: ${gate.inconclusive.join(', ')} (attempts did not run to the end)`
      })
    } catch (error) {
      const message = (error as Error).message
      this.log(`run failed: ${message}`)
      this.events.append('_run', 'error', { message })
      this.store.update((state) => {
        state.status = 'failed'
        state.statusReason = message
      })
    } finally {
      await this.finish()
      await this.findings.close()
      await this.events.close()
      // The final state is retried once; failing that, the run still ends cleanly (triage, lock, handlers).
      await this.store
        .flush()
        .catch(() => new Promise((resolveRetry) => setTimeout(resolveRetry, 1_000)).then(() => this.store.flush()))
        .catch((error: Error) => this.log(`could not write run.json: ${error.message}`))
      const reports = this.findings.all().length
      if (this.options.group && this.store.state.status === 'finished' && reports > 0 && !this.wrapUp.signal.aborted)
        try {
          const line = await this.options.group(this.paths.root, this.wrapUp.signal)
          if (line) this.log(line)
        } catch (error) {
          this.log(`grouping failed: ${(error as Error).message} (group later with: persona-swarm group ${this.plan.runId})`)
        }
      try {
        await triageRun(this.paths.root, this.options.registryFile ? { registryFile: this.options.registryFile } : {})
        const report = await writeReport(this.paths.root, this.options.registryFile ? { registryFile: this.options.registryFile } : {})
        this.log(`report: ${report}`)
      } catch (error) {
        this.log(`report failed: ${(error as Error).message}`)
      }
      await this.logWriter?.close()
      process.off('exit', onExit)
      this.runLock?.release()
      if (this.options.handleSignals !== false) for (const signal of SIGNALS) process.off(signal, onSignal)
    }
    return this.store.state
  }
}
