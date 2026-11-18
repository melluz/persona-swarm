#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ConfigError,
  DEVICE_PRESETS,
  formatBudget,
  formatSize,
  type GroupingConfig,
  type LoadedWorkspace,
  loadCohort,
  loadExporters,
  loadGroupingConfig,
  loadMedia,
  loadPersona,
  loadTarget,
  loadWorkspace,
  type MediaItem,
  ReviewStatus,
  RunLock,
  type RunState,
  readJsonFile,
  readYamlFile,
  Severity,
  sampleMemory,
  TOOL_VERSION,
} from '@persona-swarm/core'
import { DependencyProxy, warmCache } from '@persona-swarm/dep-proxy'
import { bridgeAct } from '@persona-swarm/driver-external'
import { buildPlan, describePersona, Orchestrator, type PlanOverrides, traitLines } from '@persona-swarm/engine'
import { exportRun, setApart, setReview, type Triage, triageRun, writeReport } from '@persona-swarm/findings'
import { startFixtureApp } from '@persona-swarm/fixture-app'
import { startApiServer } from '@persona-swarm/server'
import { runConformance } from './conformance.js'
import { driverRegistry } from './drivers.js'
import { applyGroupingAnswer, type GroupingOutcome, groupRun, writeGroupingBrief } from './grouping.js'
import { scaffold } from './init.js'

const HELP = `persona-swarm ${TOOL_VERSION}: simulated users test your app and report what goes wrong.

Usage: persona-swarm <command> [options]

  run <cohort.yaml>        Run a cohort. Opens a live UI unless --no-ui.
      --personas a,b         only these personas        --driver d --model m   override the persona role
      --minutes n --turns n  per-persona budget          --usd n                spend cap for the run
      --max-browsers n --max-agents n                     --port n               live UI port (default 4400)
      --detach               run in the background       --no-replay            no per-action screenshots
  resume <run>             Continue an interrupted run (same id, same folder).
  status [run]             List runs, or show one run's sessions.
  stop <run>               Stop a running run (its sessions stay resumable).
  ui [--port n]            Browse runs: live monitor, replay, findings review.
  triage <run>             Re-run the findings pipeline and the report.
  group <run> [--model m]  Group reports of the same problem with a model (or the cohort's grouping
                           setting). Without either, writes a brief for any agent to answer.
      --from file [--by name]  apply an agent's answer
  report <run> [--open]    Write (and open) the HTML report.
  review <run> <finding> <new|approved|rejected|duplicate|needs-info> [--severity s] [--note text]
  split <run> <finding> <other>  A reviewer's "not the same": never group the two again.
  export <run> [--dry-run] Send approved findings to the cohort's exporters.
      --retry-unsure         also send findings an interrupted export may already have filed
  conformance --driver d --model m [--device preset] [--minutes n]
                           Qualify a driver and model on the built-in fixture app.
  doctor                   Check Node, the browser, memory, drivers and keys.
  init [dir]               Scaffold a workspace (target, personas, cohort).
  deps serve <target.yaml> | deps warm <target.yaml> <dependency> [files...] [--tags a,b]
                           Warm a dependency's cache (no files: the target's media, or those tags).
  media <target.yaml|cohort.yaml> [--tags a,b]
                           List a target's files, or the files each persona of a cohort gets.
  fixture [--port n]       Start the fixture app (a small app with planted bugs).
  presets                  List device presets.
  persona <persona.yaml>   Check a persona: its device, tool profile, body and how its traits read in
                           the brief (docs/personas.md documents every field).
  act <session-file> <tool> ['<json>']
                           Act as a persona of an external-driver session (for any agent or a person).

<run> is a run id (in the workspace's runs folder) or a path to a run folder.`

/** A run in progress keeps going when nobody reads its output any more (a pager quit, the terminal closed). */
let keepRunningWithoutOutput = false
let outputGone = false
const out = (line = ''): void => {
  if (!outputGone) process.stdout.write(`${line}\n`)
}
const fail = (message: string): never => {
  if (!outputGone) process.stderr.write(`persona-swarm: ${message}\n`)
  process.exit(1)
}

/** A numeric flag: a positive number (whole if asked). A flag given without a value is an error, never 1. */
function numberFlag(values: Record<string, unknown>, name: string, integer = false): number | undefined {
  const raw = values[name]
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return fail(`--${name} needs a value`)
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value)))
    return fail(`--${name} must be a positive ${integer ? 'whole ' : ''}number (got "${raw}")`)
  return value
}

/** A text flag, or a failure when it was given without a value. */
function textFlag(values: Record<string, unknown>, name: string): string | undefined {
  const raw = values[name]
  if (raw === undefined) return undefined
  return typeof raw === 'string' && raw.trim() ? raw : fail(`--${name} needs a value`)
}

/** The runs in a runs folder, oldest first: folders with a run.json (a stray file is not a run). */
function listRuns(runsDir: string): string[] {
  if (!existsSync(runsDir)) return []
  return readdirSync(runsDir)
    .filter((name) => existsSync(join(runsDir, name, 'run.json')))
    .sort()
}

function resolveRun(arg: string | undefined, workspace: LoadedWorkspace): string {
  if (!arg) {
    const runs = listRuns(workspace.runsDir)
    const last = runs.at(-1)
    if (!last) fail('no runs yet')
    return join(workspace.runsDir, last as string)
  }
  const direct = resolve(arg)
  if (existsSync(join(direct, 'run.json'))) return direct
  const inWorkspace = join(workspace.runsDir, arg)
  if (existsSync(join(inWorkspace, 'run.json'))) return inWorkspace
  return fail(`no run "${arg}" (looked in ${workspace.runsDir})`)
}

function openInBrowser(target: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(command, [target], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
}

/** The cohort's grouping, run by the orchestrator once the run has finished. */
function groupHook(config: GroupingConfig, workspace: LoadedWorkspace) {
  return async (runDir: string, signal: AbortSignal): Promise<string> => {
    const outcome = await groupRun(runDir, config, { providers: workspace.config.providers, prices: workspace.config.prices, signal })
    if ('skipped' in outcome) return `grouping: ${outcome.skipped}`
    const { grouping, problems } = outcome
    return `grouping: ${grouping.groups.length} group(s) by ${grouping.by}${grouping.costUsd !== undefined ? ` ($${grouping.costUsd.toFixed(3)})` : ''}${problems.length ? `; ${problems.length} part(s) of the answer not used` : ''}`
  }
}

async function commandRun(positionals: string[], values: Record<string, unknown>, resume = false): Promise<void> {
  let cohortFile = positionals[0]
  let runId = values['run-id'] as string | undefined
  let original: PlanOverrides = {}
  let runDir: string | undefined
  if (resume) {
    const workspace = loadWorkspace(process.cwd(), { resolveEnv: false })
    runDir = resolveRun(positionals[0], workspace)
    const state = await readJsonFile<RunState | undefined>(join(runDir, 'run.json'), undefined)
    if (!state) fail(`${runDir} has no run.json`)
    cohortFile = state?.cohort.file
    runId = state?.runId
    // The run continues as it was started; flags given now win.
    original = state?.overrides ?? {}
  }
  if (!cohortFile) fail('run needs a cohort file: persona-swarm run cohort.yaml')
  const cohort = loadCohort(cohortFile as string)
  // A cap that does not parse must stop the run, not silently disable itself.
  const numbers = {
    minutes: numberFlag(values, 'minutes'),
    turns: numberFlag(values, 'turns', true),
    usd: numberFlag(values, 'usd'),
    maxBrowsers: numberFlag(values, 'max-browsers', true),
    maxAgents: numberFlag(values, 'max-agents', true),
  }
  const port = numberFlag(values, 'port', true) ?? 4400
  const personas = textFlag(values, 'personas')
  const driver = textFlag(values, 'driver')
  const model = textFlag(values, 'model')
  const overrides: PlanOverrides = {
    ...original,
    ...(runId ? { runId } : {}),
    ...(personas
      ? {
          personas: personas
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        }
      : {}),
    ...(driver ? { driver } : {}),
    ...(model ? { model } : {}),
    ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
  }
  const plan = buildPlan(cohort, overrides)
  // A resumed run continues in its own folder, wherever it was found and whatever it is called.
  if (runDir) {
    plan.runsDir = dirname(runDir)
    plan.runDir = runDir
  }
  const runFolder = runDir ?? join(plan.runsDir, plan.runId)
  // How later commands name this run: its id, or its folder when that is called something else.
  const runRef = basename(runFolder) === plan.runId ? plan.runId : runFolder

  if (values.detach) {
    // A resume names the run folder itself: it may live outside the cohort's runs folder.
    const args = [process.argv[1] as string, resume ? 'resume' : 'run', resume ? (runDir as string) : (cohortFile as string), '--run-id', plan.runId]
    for (const [key, value] of Object.entries(values))
      if (!['detach', 'run-id'].includes(key) && value !== undefined && value !== false) args.push(`--${key}`, ...(value === true ? [] : [String(value)]))
    const logsDir = join(runFolder, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const log = openSync(join(logsDir, 'cli.log'), 'a')
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], cwd: process.cwd() })
    child.unref()
    closeSync(log)
    out(`Run ${plan.runId} started in the background (pid ${child.pid}).`)
    // Only this child's own live view counts (an earlier execution's address may still be in run.json);
    // with --no-ui there is none to wait for.
    for (let i = 0; i < (values['no-ui'] ? 0 : 40); i += 1) {
      const state = await readJsonFile<RunState | undefined>(join(runFolder, 'run.json'), undefined).catch(() => undefined)
      if (state && child.pid !== undefined && state.host.pid === child.pid && state.api?.url) {
        out(`Live view: ${state.api.url}/#/run/${basename(runFolder)}`)
        break
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
    out(`Follow it with: persona-swarm status ${runRef}  (its log: ${join(runFolder, 'logs', 'cli.log')})`)
    return
  }

  out(`persona-swarm ${TOOL_VERSION} · ${plan.mode} run ${plan.runId}`)
  out(
    `target ${cohort.target.target.name} (${cohort.target.target.baseUrl}) · ${plan.sessions.length} session(s) · up to ${Math.min(plan.limits.maxAgents, plan.limits.maxBrowsers)} at once`,
  )
  for (const session of plan.sessions)
    out(
      `  ${session.id.padEnd(22)} prof ${session.persona.proficiency} · ${session.deviceLabel} · ${session.toolProfile} · ${session.role.driver}/${session.role.model} · ${formatBudget(session.budget)}${plan.media.length ? ` · ${session.media.length} file${session.media.length === 1 ? '' : 's'}` : ''}`,
    )
  for (const warning of plan.warnings) out(`  note: ${warning}`)
  let closeUi: (() => Promise<void>) | undefined
  const orchestrator = new Orchestrator(plan, {
    drivers: driverRegistry(cohort.workspace),
    resume,
    replayShots: values['no-replay'] !== true,
    prices: cohort.workspace.config.prices,
    registryFile: cohort.workspace.registryFile,
    ...(cohort.cohort.grouping ? { group: groupHook(cohort.cohort.grouping, cohort.workspace) } : {}),
    log: (line) => out(line),
    onReady: async (live) => {
      if (values['no-ui']) return
      try {
        const server = await startApiServer({
          runsDir: plan.runsDir,
          port,
          registryFile: cohort.workspace.registryFile,
          live: {
            // The API names runs by their folder (a resumed run may live in a folder renamed since).
            runId: basename(live.runDir),
            getState: () => live.store.state,
            onState: (listener) => live.store.subscribe(listener),
            onEvent: (listener) => live.events.subscribe(listener),
            stop: live.control.stop,
            stopSession: live.control.stopSession,
          },
        })
        closeUi = server.close
        live.store.update((state) => (state.api = { url: server.url }))
        out(`Live view: ${server.url}/#/run/${basename(live.runDir)}`)
      } catch (error) {
        out(`(live view unavailable: ${(error as Error).message}; use --port or --no-ui)`)
      }
    },
  })
  // Nobody reading the output any more is no reason to stop a run: it keeps its own log.
  keepRunningWithoutOutput = true
  const state = await orchestrator.run().catch((error: Error) => fail(error.message))
  await closeUi?.()
  out()
  out(`Run ${state.status}${state.statusReason ? ` (${state.statusReason})` : ''}. ${state.totals.findings} report(s), $${state.totals.costUsd.toFixed(2)}.`)
  for (const session of Object.values(state.sessions))
    out(
      `  ${session.id.padEnd(22)} ${session.status.padEnd(9)} ${String(session.outcome ?? session.stopReason ?? '').padEnd(16)} ${session.toolCalls} actions · ${session.findings} reports${session.error ? ` · ${session.error.slice(0, 100)}` : ''}`,
    )
  out(`Report: ${join(orchestrator.runDir, 'report.html')}`)
  out(`Review: persona-swarm ui  (then open run ${basename(orchestrator.runDir)})`)
  // Exit codes for scripts and CI: 1 the run failed or was stopped, 3 a gate failed.
  if (state.status === 'failed' || state.status === 'aborted') process.exitCode = 1
  else if (state.gate?.failing.length) process.exitCode = 3
  // Inconclusive: the harness, not the product, kept the gate from deciding.
  else if (state.gate && !state.gate.passed) process.exitCode = 1
  // The run is over: a handle left open somewhere (a slow upstream, a timer) must not keep CI waiting.
  setTimeout(() => process.exit(), 2_000).unref()
}

/** A path as a shell reads it. */
const shellQuote = (text: string) => (/^[\w./@:=+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`)

function printGrouping(outcome: GroupingOutcome, triage: Triage): void {
  const { grouping, problems } = outcome
  const cost = grouping.costUsd !== undefined ? ` ($${grouping.costUsd.toFixed(3)})` : ''
  out(`Grouped by ${grouping.by}${cost}: ${grouping.groups.length} group(s).`)
  for (const group of grouping.groups) out(`  ${group.ids.join(' + ')}${group.reason ? `: ${group.reason}` : ''}`)
  for (const problem of problems) out(`  not used: ${problem}`)
  for (const link of triage.grouping?.keptApart ?? []) out(`  kept apart: ${link.a} and ${link.b} (a tester or a reviewer said they differ)`)
  const known = Object.values(triage.findings).filter((finding) => finding.knownIssue).length
  out(`${triage.totals.findings} report(s) in ${triage.totals.clusters} cluster(s); ${known} matched to known issues.`)
}

async function commandGroup(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const ws = loadWorkspace(process.cwd(), { resolveEnv: false })
  const dir = resolveRun(positionals[0], ws)
  const state = await readJsonFile<RunState | undefined>(join(dir, 'run.json'), undefined)
  let outcome: GroupingOutcome | { skipped: string }
  const from = textFlag(values, 'from')
  if (from) outcome = await applyGroupingAnswer(dir, resolve(from), textFlag(values, 'by') ?? 'agent')
  else {
    const cohortFile = state?.cohort.file
    const model = textFlag(values, 'model')
    const config: GroupingConfig | undefined = model
      ? { model, timeoutSec: 300 }
      : cohortFile && existsSync(cohortFile)
        ? loadGroupingConfig(cohortFile)
        : undefined
    if (!config) {
      const brief = await writeGroupingBrief(
        dir,
        (answerFile) => `cd ${shellQuote(ws.dir)} && persona-swarm group ${shellQuote(dir)} --from ${shellQuote(answerFile)} --by '<your name>'`,
      )
      if ('skipped' in brief) return out(`Nothing to group: ${brief.skipped}.`)
      out(`Wrote ${brief.file} (${brief.reports} reports, ${brief.knownIssues} known issues).`)
      out('Give it to any agent, or follow it yourself. The answer comes back with:')
      out(`  persona-swarm group ${state?.runId ?? dir} --from ${shellQuote(brief.answerFile)}`)
      out('To let a model do it instead: persona-swarm group <run> --model provider:model')
      return
    }
    // Providers may name secrets: only with a model to call is the workspace read in full.
    const full = config.model ? loadWorkspace(process.cwd()) : ws
    outcome = await groupRun(dir, config, { providers: full.config.providers, prices: full.config.prices })
  }
  if ('skipped' in outcome) return out(`Nothing to group: ${outcome.skipped}.`)
  const triage = await triageRun(dir, { registryFile: ws.registryFile })
  await writeReport(dir, { registryFile: ws.registryFile })
  printGrouping(outcome, triage)
}

async function commandStatus(positionals: string[]): Promise<void> {
  const workspace = loadWorkspace(process.cwd(), { resolveEnv: false })
  if (!positionals[0]) {
    const runs = listRuns(workspace.runsDir).reverse()
    if (!runs.length) return out('No runs yet.')
    for (const id of runs.slice(0, 20)) {
      const state = await readJsonFile<RunState | undefined>(join(workspace.runsDir, id, 'run.json'), undefined).catch(() => undefined)
      if (state)
        out(
          `${id}  ${state.status.padEnd(9)} ${state.target.name} · ${state.cohort.id} · ${Object.keys(state.sessions).length} sessions · ${state.totals.findings} reports · $${state.totals.costUsd.toFixed(2)}`,
        )
    }
    return
  }
  const runDir = resolveRun(positionals[0], workspace)
  const state = await readJsonFile<RunState | undefined>(join(runDir, 'run.json'), undefined)
  if (!state) return fail('no run.json')
  out(
    `${state.runId} · ${state.status}${state.statusReason ? ` (${state.statusReason})` : ''} · memory ${state.governor.freePercent}% free (${state.governor.level})${state.api ? ` · ${state.api.url}` : ''}`,
  )
  for (const session of Object.values(state.sessions))
    out(
      `  ${session.id.padEnd(22)} ${session.status.padEnd(9)} turns ${String(session.turns).padStart(3)} · actions ${String(session.toolCalls).padStart(4)} · reports ${session.findings}${session.lastNote ? ` · “${session.lastNote.slice(0, 70)}”` : ''}`,
    )
}

async function commandStop(positionals: string[]): Promise<void> {
  const workspace = loadWorkspace(process.cwd(), { resolveEnv: false })
  const runDir = resolveRun(positionals[0], workspace)
  const state = await readJsonFile<RunState | undefined>(join(runDir, 'run.json'), undefined)
  if (!state) return fail('no run.json')
  // Only the process that holds the run's lock is executing it: never signal a pid that may have been reused.
  const holder = RunLock.holder(runDir)
  if (!holder) return out(`Run ${state.runId} is not executing (${state.status}).`)
  if (!holder.local)
    return out(
      `Run ${state.runId} is executing on ${holder.host} (process ${holder.pid}): stop it there. If nothing runs it any more, delete ${join(runDir, 'run.lock')}.`,
    )
  const pid = holder.pid
  if (state.api?.url) {
    try {
      const response = await fetch(`${state.api.url}/api/runs/${state.runId}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (response.ok) return out(`Asked run ${state.runId} to stop.`)
    } catch {
      // Fall back to the signal.
    }
  }
  process.kill(pid, 'SIGTERM')
  out(`Sent SIGTERM to the run's process (${pid}).`)
}

/** Every `name` on PATH, in the order a shell would try them. */
function allOnPath(name: string): string[] {
  const found: string[] = []
  for (const folder of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const file = folder && join(folder, name)
    try {
      if (file && statSync(file).isFile() && !found.includes(file)) found.push(file)
    } catch {
      // Not here.
    }
  }
  return found
}

/**
 * The Claude Code CLI the driver starts (PERSONA_SWARM_CLAUDE_BIN, else the first `claude` on PATH),
 * any other install (each keeps its own version, and a sign-in made with one may not reach another),
 * and what it says about its sign-in. An expired session shows only at the first real call.
 */
async function doctorClaude(line: (ok: boolean, text: string) => void): Promise<void> {
  const installs = allOnPath(process.platform === 'win32' ? 'claude.exe' : 'claude')
  const chosen = process.env.PERSONA_SWARM_CLAUDE_BIN ?? installs[0]
  if (!chosen) return line(false, 'Claude Code CLI not found (driver claude-code unavailable)')
  const versionOf = (binary: string) => spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout?.trim() || '?'
  line(true, `Claude Code CLI ${versionOf(chosen)} at ${chosen} (driver claude-code)`)
  for (const other of installs.filter((each) => each !== chosen))
    out(`· another claude on PATH: ${other} (${versionOf(other)}); the driver uses the one above (PERSONA_SWARM_CLAUDE_BIN chooses)`)
  const { cleanEnvironment } = await import('@persona-swarm/driver-claude-code')
  const status = spawnSync(chosen, ['auth', 'status'], { encoding: 'utf8', timeout: 15_000, env: cleanEnvironment(process.env) })
  try {
    const parsed = JSON.parse(status.stdout) as { loggedIn?: boolean; authMethod?: string }
    line(
      parsed.loggedIn === true,
      parsed.loggedIn
        ? `  says it is signed in (${parsed.authMethod ?? 'unknown'}); an expired session shows only at a real call: claude -p "Say OK"`
        : '  not signed in: run `claude`, then /login, with the CLI above',
    )
  } catch {
    out('· its sign-in could not be read (claude auth status)')
  }
}

async function commandDoctor(): Promise<void> {
  const { findCachedChromium } = await import('@persona-swarm/device-web')
  const memory = await sampleMemory()
  const major = Number(process.versions.node.split('.')[0])
  const line = (ok: boolean, text: string) => out(`${ok ? '✓' : '✗'} ${text}`)
  line(major >= 22, `Node ${process.version}${major >= 22 ? '' : ' (needs 22 or newer)'}`)
  const browser = findCachedChromium()
  line(Boolean(browser), browser ? `Chromium: ${browser}` : 'No cached Chromium; run: npx playwright-core install chromium-headless-shell')
  line(memory.freePercent >= 30, `Memory: ${Math.round(memory.freePercent)}% free (${(memory.totalBytes / 1e9).toFixed(1)} GB, ${memory.source})`)
  const registry = driverRegistry(loadWorkspace(process.cwd(), { resolveEnv: false }))
  line(true, `Drivers: ${Object.keys(registry).join(', ')}`)
  await doctorClaude(line)
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  line(python.status === 0, python.status === 0 ? `${python.stdout.trim()} (driver python-reference)` : 'python3 not found')
  // Keys are optional: each is only needed for its provider's models.
  const keys: [string, string][] = [
    ['OPENAI_API_KEY', 'openai:'],
    ['ANTHROPIC_API_KEY', 'anthropic:'],
    ['GOOGLE_GENERATIVE_AI_API_KEY', 'google:'],
    ['OPENROUTER_API_KEY', 'openrouter:'],
  ]
  for (const [key, prefix] of keys)
    out(`${process.env[key] ? '✓' : '·'} ${key} ${process.env[key] ? 'is set' : `is not set (needed only for ${prefix} models)`}`)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') return out(HELP)
  if (command === '--version' || command === 'version') return out(TOOL_VERSION)
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      personas: { type: 'string' },
      driver: { type: 'string' },
      model: { type: 'string' },
      minutes: { type: 'string' },
      turns: { type: 'string' },
      usd: { type: 'string' },
      'max-browsers': { type: 'string' },
      'max-agents': { type: 'string' },
      port: { type: 'string' },
      detach: { type: 'boolean' },
      'no-ui': { type: 'boolean' },
      'no-replay': { type: 'boolean' },
      'run-id': { type: 'string' },
      open: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      severity: { type: 'string' },
      note: { type: 'string' },
      device: { type: 'string' },
      from: { type: 'string' },
      by: { type: 'string' },
      'retry-unsure': { type: 'boolean' },
      tags: { type: 'string' },
    },
  })
  // Commands that read runs need no secrets; conformance (which runs a driver) loads the workspace in full.
  const workspace = () => loadWorkspace(process.cwd(), { resolveEnv: false })
  switch (command) {
    case 'run':
      return commandRun(positionals, values)
    case 'resume':
      return commandRun(positionals, values, true)
    case 'status':
      return commandStatus(positionals)
    case 'stop':
      return commandStop(positionals)
    case 'ui': {
      const ws = workspace()
      const port = numberFlag(values, 'port', true) ?? 4400
      const server = await startApiServer({ runsDir: ws.runsDir, port, registryFile: ws.registryFile }).catch((error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE'
          ? fail(`port ${port} is in use. If a persona-swarm UI is already running there, open http://127.0.0.1:${port}; otherwise pick another with --port.`)
          : Promise.reject(error),
      )
      out(`persona-swarm UI: ${server.url}  (runs in ${ws.runsDir}; Ctrl+C to stop)`)
      if (values.open) openInBrowser(server.url)
      return new Promise(() => {})
    }
    case 'triage': {
      const ws = workspace()
      const dir = resolveRun(positionals[0], ws)
      const triage = await triageRun(dir, { registryFile: ws.registryFile })
      await writeReport(dir, { registryFile: ws.registryFile })
      out(
        `${triage.totals.findings} report(s) in ${triage.totals.clusters} cluster(s); ${triage.totals.flaggedHarness} harness-suspect, ${triage.totals.flaggedEnvironment} environment-related.`,
      )
      return
    }
    case 'group':
      return commandGroup(positionals, values)
    case 'split': {
      const [runArg, findingId, otherId] = positionals
      if (!findingId || !otherId) return fail('usage: persona-swarm split <run> <finding> <other finding or known issue>')
      const ws = workspace()
      const dir = resolveRun(runArg, ws)
      await setApart(dir, findingId, otherId, 'cli')
      const triage = await triageRun(dir, { registryFile: ws.registryFile })
      await writeReport(dir, { registryFile: ws.registryFile })
      return out(
        `${findingId.toUpperCase()} and ${otherId.toUpperCase()} are kept apart. ${triage.totals.findings} report(s) in ${triage.totals.clusters} cluster(s).`,
      )
    }
    case 'report': {
      const ws = workspace()
      const dir = resolveRun(positionals[0], ws)
      // A triage made for the report keeps the history across runs.
      const file = await writeReport(dir, { registryFile: ws.registryFile })
      out(file)
      if (values.open) openInBrowser(file)
      return
    }
    case 'review': {
      const [runArg, findingId, status] = positionals
      if (!findingId || !status) return fail('usage: persona-swarm review <run> <finding> <status> [--severity s] [--note text]')
      const dir = resolveRun(runArg, workspace())
      const review = await setReview(dir, findingId.toUpperCase(), {
        status: ReviewStatus.parse(status),
        ...(values.severity ? { severity: Severity.parse(values.severity) } : {}),
        ...(values.note ? { note: String(values.note) } : {}),
        by: 'cli',
      })
      return out(`${findingId.toUpperCase()}: ${review.status}${review.severity ? ` (${review.severity})` : ''}`)
    }
    case 'export': {
      const dir = resolveRun(positionals[0], workspace())
      const state = await readJsonFile<RunState | undefined>(join(dir, 'run.json'), undefined)
      const cohortFile = state?.cohort.file as string
      const exporters = loadExporters(cohortFile)
      if (!exporters.length) return out('This cohort has no exporters configured.')
      const results = await exportRun(dir, exporters, {
        dryRun: Boolean(values['dry-run']),
        retryUnsure: Boolean(values['retry-unsure']),
        baseDir: dirname(cohortFile),
      })
      for (const result of results)
        for (const outcome of result.outcomes)
          out(
            `${result.exporter}: ${outcome.findingId} ${outcome.ok ? `→ ${outcome.externalId}${outcome.url ? ` ${outcome.url}` : ''}` : `failed: ${outcome.error}`}`,
          )
      for (const result of results) for (const item of result.skipped) out(`${result.exporter}: ${item.findingId} not sent (${item.reason})`)
      if (!results.some((result) => result.outcomes.length || result.skipped.length)) out('Nothing to export (approve findings first).')
      return
    }
    case 'conformance': {
      const driver = textFlag(values, 'driver')
      const model = textFlag(values, 'model')
      if (!driver || !model) return fail('usage: persona-swarm conformance --driver d --model m')
      // A qualifying run goes on when nobody reads its output any more, like any run.
      keepRunningWithoutOutput = true
      const ws = loadWorkspace(process.cwd())
      const result = await runConformance({
        driver,
        model,
        registry: driverRegistry(ws),
        minutes: numberFlag(values, 'minutes') ?? 12,
        device: textFlag(values, 'device') ?? 'desktop-1440',
        workspace: ws.config,
        registryFile: join(ws.dir, '.persona-swarm', 'conformance.json'),
        runsDir: ws.runsDir,
        log: (line) => out(line),
        ...(Object.keys(ws.config.providers).length ? { providers: ws.config.providers } : {}),
      })
      out()
      out(`${result.passed ? 'PASSED' : 'FAILED'}: ${result.driver} / ${result.model} in ${result.minutes} min, $${result.costUsd.toFixed(2)}`)
      for (const check of result.checks) out(`  ${check.passed ? '✓' : '✗'} ${check.name}${check.detail ? ` (${check.detail})` : ''}`)
      out(`  planted bugs found: ${result.plantedBugsFound.length} (${result.plantedBugsFound.join(', ') || 'none'}), recall ${result.recall}`)
      out(`  run: ${result.runDir}`)
      if (!result.passed) process.exitCode = 1
      return
    }
    case 'doctor':
      return commandDoctor()
    case 'init': {
      const dir = resolve(positionals[0] ?? '.')
      const files = scaffold(dir)
      out(`Created ${files.length} files in ${dir}:`)
      for (const file of files) out(`  ${file}`)
      out('Next: edit target.yaml (your app URL and accounts), then run: persona-swarm run cohort.yaml')
      return
    }
    case 'deps': {
      const [sub, targetFile, dependencyId, ...files] = positionals
      if (!targetFile) return fail('usage: persona-swarm deps serve <target.yaml> | deps warm <target.yaml> <dependency> [files...] [--tags a,b]')
      const target = loadTarget(targetFile).target
      if (sub === 'serve') {
        for (const dependency of target.dependencies) {
          const proxy = new DependencyProxy(dependency, (event) =>
            out(`${event.t} ${event.dependency} ${event.event}${event.id ? ` #${event.id}` : ''}${event.waitedMs ? ` waited ${event.waitedMs} ms` : ''}`),
          )
          await proxy.start()
          out(`${dependency.id} (${dependency.mode}) on ${proxy.address} → ${dependency.upstream}`)
        }
        return new Promise(() => {})
      }
      if (sub === 'warm') {
        const dependency = target.dependencies.find((candidate) => candidate.id === dependencyId)
        if (!dependency) return fail(`no dependency "${dependencyId}" in ${targetFile}`)
        // No files named: the target's own media (those with any of --tags).
        const wanted =
          textFlag(values, 'tags')
            ?.split(',')
            .map((tag) => tag.trim()) ?? []
        const chosen = files.length
          ? files.map((file) => resolve(file))
          : loadMedia(target.media)
              .filter((item) => !wanted.length || item.tags.some((tag) => wanted.includes(tag)))
              .map((item) => item.file)
        if (!chosen.length) return fail('no files to warm: name them, or give the target media (and check --tags)')
        await warmCache(dependency, chosen, {
          onProgress: (result) =>
            out(
              `${result.status.padEnd(8)} ${basename(result.file)}${result.seconds !== undefined ? ` ${result.seconds}s` : ''}${result.error ? ` ${result.error}` : ''}`,
            ),
        })
        return
      }
      return fail('deps: use serve or warm')
    }
    case 'fixture': {
      const app = await startFixtureApp({ port: numberFlag(values, 'port', true) ?? 4500 })
      out(`Fixture app (Kiln Orders, 7 planted bugs): ${app.url}  sign in as anyone@fixture.test with any password`)
      return new Promise(() => {})
    }
    case 'act': {
      const [sessionFile, tool, json] = positionals
      if (!sessionFile || !tool) return fail("usage: persona-swarm act <session-file> <tool> '<json arguments>'")
      let args: Record<string, unknown> = {}
      if (json) {
        try {
          args = JSON.parse(json) as Record<string, unknown>
        } catch {
          return fail(`arguments must be JSON, for example '{"x": 120, "y": 340}' (got ${json})`)
        }
      }
      const result = await bridgeAct(resolve(sessionFile), tool, args)
      out(result.text)
      for (const image of result.images) out(`Screenshot saved: ${image}  (open this file to see the screen)`)
      if (result.ended) out('Your session is over.')
      if (result.isError) process.exitCode = 2
      return
    }
    case 'media': {
      const file = positionals[0]
      if (!file) return fail('usage: persona-swarm media <target.yaml|cohort.yaml> [--tags a,b]')
      const wanted =
        textFlag(values, 'tags')
          ?.split(',')
          .map((tag) => tag.trim()) ?? []
      const line = (item: MediaItem) =>
        `${item.name.padEnd(28)} ${formatSize(item.bytes).padStart(8)}  ${item.type.padEnd(18)} ${item.tags.length ? `[${item.tags.join(', ')}] ` : ''}${item.description ?? ''}${item.truth ? `\n${' '.repeat(30)}truth: ${item.truth}` : ''}`
      const raw = readYamlFile(resolve(file), { resolveEnv: false }) as Record<string, unknown> | undefined
      // A cohort names a target and personas: show what each session gets.
      if (raw && 'target' in raw && 'personas' in raw) {
        const only = textFlag(values, 'personas')
          ?.split(',')
          .map((id) => id.trim())
          .filter(Boolean)
        const plan = buildPlan(loadCohort(resolve(file)), only?.length ? { personas: only } : {})
        out(`${plan.media.length} file(s) in ${plan.source.target.target.name}; each session gets:`)
        for (const session of plan.sessions) {
          out(`\n${session.id} (${session.media.length})`)
          for (const item of session.media.filter((each) => !wanted.length || each.tags.some((tag) => wanted.includes(tag)))) out(`  ${line(item)}`)
        }
        for (const warning of plan.warnings) out(`note: ${warning}`)
        return
      }
      const items = loadMedia(loadTarget(resolve(file)).target.media).filter((item) => !wanted.length || item.tags.some((tag) => wanted.includes(tag)))
      if (!items.length) return out('No files (add media to the target: see docs/media.md).')
      for (const item of items) out(line(item))
      const tags = [...new Set(items.flatMap((item) => item.tags))].sort()
      out(
        `\n${items.length} file(s)${tags.length ? `; tags: ${tags.map((tag) => `${tag} (${items.filter((item) => item.tags.includes(tag)).length})`).join(', ')}` : ''}`,
      )
      return
    }
    case 'persona': {
      if (!positionals[0]) return fail('usage: persona-swarm persona <persona.yaml>')
      const { persona } = loadPersona(resolve(positionals[0]))
      const described = describePersona(persona, { maxDeviceScaleFactor: workspace().config.limits.maxDeviceScaleFactor ?? 1 })
      const { body } = described
      out(`${persona.name} (${persona.id}): proficiency ${persona.proficiency}`)
      out(`device        ${described.deviceLabel}`)
      out(`tool profile  ${described.toolProfile}`)
      out(`budget        ${formatBudget(described.budget)} against a 30 min · 200 actions baseline (a cohort sets its own)`)
      out(`              ${described.budget.why.join(' · ')}`)
      if (Object.keys(described.fromVision).length) out(`from vision   ${JSON.stringify(described.fromVision)}`)
      out(
        `body          precision ${body.precision} · pace ${body.pace} · typing ${body.typing} · interruptions ${body.interruptions}${body.multitab ? ' · multitab' : ''}`,
      )
      const lines = traitLines({ persona, profile: described.profile })
      out(lines.length ? `\nIn the brief:\n${lines.map((line) => `- ${line}`).join('\n')}` : '\nNo traits in the brief.')
      return
    }
    case 'presets':
      for (const [name, preset] of Object.entries(DEVICE_PRESETS))
        out(
          `${name.padEnd(24)} ${preset.label ?? ''} · ${preset.viewport.width}×${preset.viewport.height}${preset.input && preset.input !== 'mouse' ? ` · ${preset.input}` : ''}`,
        )
      return
    default:
      return fail(`unknown command "${command}". Run persona-swarm help.`)
  }
}

// Piping into head or a pager that exits early is normal, not an error; so is a closed terminal (EIO).
// A run in progress goes on without its output; any other command just ends.
for (const stream of [process.stdout, process.stderr])
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE' && error.code !== 'EIO') throw error
    outputGone = true
    if (!keepRunningWithoutOutput) process.exit(0)
  })

main().catch((error) => {
  if (error instanceof ConfigError) fail(error.message)
  fail((error as Error)?.stack ?? String(error))
})
