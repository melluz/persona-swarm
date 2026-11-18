import type { Device } from './device.js'
import type { RunEvent } from './events.js'
import type { MediaItem } from './media.js'
import type { Account, Persona, Target } from './schemas/config.js'
import type { Finding, Review, Severity } from './schemas/run.js'

/**
 * Tools that do not spend a persona's action budget: looking (screenshot, outline, find_text) and
 * speaking up (note, report_problem, confirm_problem, finish). Actions are steps in the app.
 */
export const FREE_TOOLS: ReadonlySet<string> = new Set(['screenshot', 'outline', 'find_text', 'note', 'report_problem', 'confirm_problem', 'finish'])

export interface HookContext {
  runId: string
  runDir: string
  target: Target
  log: (message: string) => void
  /** Aborts when the run stops: a hook that waits on something (polling the app) should give up then. */
  signal: AbortSignal
  /** Every file the target offers, with ground truth and notes (seed the app with them in setup). */
  media: MediaItem[]
}

export interface SessionHookContext extends HookContext {
  session: string
  persona: Persona
  /** The files this session's persona has (and may have uploaded: see the events), with ground truth. */
  sessionMedia: MediaItem[]
  account?: Account
  device: Device
}

export interface CheckResult {
  passed: boolean
  details: string
}

/**
 * Optional code a target can provide (`hooks: ./hooks.mjs`). Every hook is optional and may be a plain
 * or an async function. A hook that throws fails only its own step: `setup` the run, `beforeSession`
 * its session, `check` its journey; `afterSession` and `teardown` are logged. A hook that has not
 * finished after the target's `hookTimeoutSec` is given up on, and so are setup, beforeSession and
 * check when the run stops.
 */
export interface TargetHooks {
  setup?(context: HookContext): Promise<void> | void
  teardown?(context: HookContext): Promise<void> | void
  /** Runs after the device exists and before the agent starts (seed data, sign in, open a page). */
  beforeSession?(context: SessionHookContext): Promise<void> | void
  afterSession?(context: SessionHookContext & { events: RunEvent[] }): Promise<void> | void
  /** Judges whether a journey's checks passed for a finished session (in every mode; gate verdicts use them). */
  check?(context: SessionHookContext & { journey: string; events: RunEvent[] }): Promise<CheckResult> | CheckResult
}

export interface ExportItem {
  finding: Finding
  review?: Review
  severity: Severity
  votes: number
  flags: string[]
  /** Absolute path of the evidence screenshot, if any. */
  screenshotFile?: string
  runId: string
  targetName: string
}

export interface ExportOutcome {
  findingId: string
  ok: boolean
  externalId?: string
  url?: string
  error?: string
}

export interface ExportContext {
  runId: string
  runDir: string
  /** The cohort's folder: relative paths in exporter settings (a file, a command) are resolved against it. */
  baseDir: string
  /** Read a secret by environment variable name; throws a clear error when missing. */
  secret: (envName: string) => string
  log: (message: string) => void
  dryRun: boolean
}

/**
 * A destination for findings (tracker, chat, file). Built-ins live in `@persona-swarm/findings`.
 * Items are passed one at a time, and each success is recorded before the next is sent, so an
 * interrupted export never files anything twice; a `batch` exporter gets them all in one call.
 */
export interface Exporter {
  readonly type: string
  readonly batch?: boolean
  export(items: ExportItem[], context: ExportContext): Promise<ExportOutcome[]>
}

/** A module that provides an exporter: `export default (settings) => Exporter`. */
export type ExporterFactory = (settings: Record<string, unknown>) => Exporter
