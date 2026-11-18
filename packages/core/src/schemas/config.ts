import { z } from 'zod'
import { DeviceOverrides, DeviceProfile, ToolProfile, VisionDeficiency } from './device.js'

const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'use lower-case letters, digits, dot, dash or underscore')

/** A shell-free command: argv form, run without a shell. */
const Command = z.strictObject({
  run: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Polled until it answers 2xx; the command is then considered up. */
  readyUrl: z.string().url().optional(),
  timeoutSec: z.number().positive().default(120),
  /** Keep running in the background for the whole run (servers); otherwise wait for exit. */
  background: z.boolean().default(false),
})
export type Command = z.infer<typeof Command>

const SignInStep = z.union([
  z.strictObject({ goto: z.string() }),
  z.strictObject({ fill: z.string(), value: z.string() }),
  z.strictObject({ click: z.string() }),
  z.strictObject({ waitFor: z.string() }),
])

export const Account = z.strictObject({
  id: Slug,
  username: z.string(),
  password: z.string().default(''),
  name: z.string().optional(),
  /** Several sessions may share an account (a clinic's shared login), on purpose. */
  shared: z.boolean().default(false),
})
export type Account = z.infer<typeof Account>

/**
 * A folder of files personas can upload (images to annotate, documents, wrong files a user might pick).
 * Files can be described one by one in a manifest; what personas see is the description, never the
 * ground truth or the notes. See docs/media.md.
 */
export const MediaSource = z.strictObject({
  /** Names the source in listings; defaults to the folder's name. */
  id: Slug.optional(),
  dir: z.string(),
  /** Regular expression for file names, e.g. "^cks2ip8f[a-z0-9]+\\.png$". */
  pattern: z.string().default('^[^.].*$'),
  /** What every file here is, in the words a user would use, unless the manifest says otherwise. */
  description: z.string().optional(),
  /** Older name for description. */
  label: z.string().optional(),
  /** Tags for every file here: personas and cohorts choose files by tag. */
  tags: z.array(z.string()).default([]),
  /** MIME type of every file here (otherwise from each file's extension). */
  type: z.string().optional(),
  /** A YAML file describing files one by one (relative to the target). */
  manifest: z.string().optional(),
})
export type MediaSource = z.infer<typeof MediaSource>
/** The older name of a media source. */
export const FixtureSource = MediaSource
export type FixtureSource = MediaSource

/** One file in a media manifest. */
export const MediaEntry = z.strictObject({
  /** The file's name in the source folder. */
  name: z.string(),
  /** What it is, in a user's words: shown to personas. */
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  type: z.string().optional(),
  /** Reference results for this file (expected annotations, values), relative to the manifest. Never shown to personas. */
  truth: z.string().optional(),
  /** For reviewers and hooks only. */
  notes: z.string().optional(),
})
export type MediaEntry = z.infer<typeof MediaEntry>

export const MediaManifest = z.union([z.array(MediaEntry), z.strictObject({ files: z.array(MediaEntry) })])

/**
 * Which files a persona has on its computer. Left out, it has every file of the target. Tags match
 * any of those given; `count` takes that many, spread across the run's sessions so they cover
 * different files.
 */
export const MediaSelection = z.strictObject({
  /** Files with any of these tags. */
  tags: z.array(z.string()).optional(),
  /** Never files with any of these tags. */
  exclude: z.array(z.string()).optional(),
  /** These files by name, whatever their tags. */
  files: z.array(z.string()).optional(),
  /** How many of the matching files, at most. */
  count: z.number().int().min(1).optional(),
  /** Spread choices across the run's sessions (least used first); false picks at random for each. */
  spread: z.boolean().default(true),
  /** Only files this dependency's cache already holds an answer for (warm it with `deps warm`). */
  cached: z.string().optional(),
})
export type MediaSelection = z.infer<typeof MediaSelection>

export const CacheKey = z.union([z.literal('body'), z.strictObject({ multipartField: z.string() }), z.strictObject({ jsonField: z.string() })])
export type CacheKey = z.infer<typeof CacheKey>

export const Dependency = z.strictObject({
  id: Slug,
  description: z.string().optional(),
  listen: z.strictObject({ host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).describe('0 picks a free port') }),
  upstream: z.string().url(),
  mode: z.enum(['real', 'cached', 'stub', 'record']).default('real'),
  /** Requests that go through the queue and cache. Everything else is passed straight through. */
  match: z.strictObject({ methods: z.array(z.string()).optional(), pathPrefix: z.string().optional() }).default({}),
  cache: z
    .strictObject({
      dir: z.string(),
      key: CacheKey.default('body'),
      statuses: z.array(z.number().int()).default([200]),
      /** Request headers that change the answer (e.g. authorization for per-user data): part of the key. */
      vary: z.array(z.string()).default([]),
    })
    .optional(),
  latencyMs: z.strictObject({ min: z.number().min(0), max: z.number().min(0) }).optional(),
  concurrency: z.number().int().min(1).default(1),
  /** A queued request that waited longer than this is refused with 503 instead of computed for nobody. */
  maxWaitMs: z.number().int().positive().optional(),
  coalesce: z.boolean().default(true),
  /** An upstream call that takes longer is abandoned with 504 (and flagged as an environment problem). */
  upstreamTimeoutMs: z.number().int().positive().default(600_000),
  stub: z
    .strictObject({
      status: z.number().int().default(200),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.string().optional(),
      bodyFile: z.string().optional(),
    })
    .optional(),
})
export type Dependency = z.infer<typeof Dependency>

export const Journey = z.strictObject({
  id: Slug,
  name: z.string(),
  description: z.string().optional(),
  /** Plain-language checks a check hook verifies at the end of a session. */
  checks: z.array(z.string()).default([]),
})
export type Journey = z.infer<typeof Journey>

export const Target = z.strictObject({
  id: Slug,
  name: z.string(),
  baseUrl: z.url({ protocol: /^https?$/, error: 'baseUrl must be an http(s) address, like http://localhost:3000' }),
  /** What a user could know before using the product (marketing site, welcome email). */
  brief: z.string().default(''),
  /** Domain vocabulary for reviewers and future roles; never shown to personas. */
  glossary: z.string().optional(),
  health: z.strictObject({ url: z.string().url(), timeoutSec: z.number().positive().default(5) }).optional(),
  lifecycle: z
    .strictObject({
      up: z.array(Command).optional(),
      down: z.array(Command).optional(),
      reset: z.array(Command).optional(),
    })
    .default({}),
  accounts: z.array(Account).default([]),
  signIn: z
    .strictObject({
      mode: z.enum(['persona', 'scripted']).default('persona'),
      url: z.string().optional(),
      steps: z.array(SignInStep).default([]),
    })
    .default({ mode: 'persona', steps: [] }),
  /** Files personas can upload. `fixtures` is the older name; both are read. */
  media: z.array(MediaSource).default([]),
  fixtures: z.array(MediaSource).default([]),
  dependencies: z.array(Dependency).default([]),
  journeys: z.array(Journey).default([]),
  knownIssues: z.string().optional(),
  /** Module with optional hooks (setup, teardown, beforeSession, afterSession, check). */
  hooks: z.string().optional(),
  /** How long one hook call may take before it is given up on. */
  hookTimeoutSec: z.number().positive().default(300),
  /** URL patterns throttled by personas with a network profile; default: every request. */
  throttleUrls: z.array(z.string()).optional(),
  /** Other origins personas may open, such as a sign-in provider (the target's own is always allowed). */
  extraOrigins: z.array(z.string().url()).default([]),
})
export type Target = z.infer<typeof Target>

const Level = z.number().int().min(1).max(5)

/**
 * How the persona sees. A shorthand (`low`, `deuteranopia`, `high-contrast`...) or the parts: browser
 * zoom, a colour deficiency or blur Chromium renders the page with, and Windows high-contrast mode.
 * The harness makes it true: the device is set up that way, so screenshots show what the person sees.
 */
export const VisionTrait = z.union([
  z.enum(['normal', 'low', 'blurred', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'high-contrast']),
  z.strictObject({
    zoom: z.number().min(1).max(4).optional(),
    deficiency: VisionDeficiency.optional(),
    highContrast: z.boolean().optional(),
  }),
])
export type VisionTrait = z.infer<typeof VisionTrait>

/**
 * Who the person is beyond proficiency. Mind traits shape the persona's brief; body traits are also
 * enforced by the harness (the device and the tool server), whatever the model does with the brief.
 * Every trait is optional; one that is left out has no effect. See docs/personas.md.
 */
export const Traits = z.strictObject({
  // Mind: in the brief.
  /** 1 gives up at once and clicks again when nothing happens; 5 keeps trying other ways. */
  patience: Level.optional(),
  reading: z.enum(['skims', 'reads', 'studies']).optional(),
  /** What they do first when something goes wrong. */
  recovery: z.enum(['back', 'reload', 'retry', 'asks']).optional(),
  /** Knowledge of the product's field (not of computers): 1 knows none of its words, 5 is an expert in it. */
  domain: Level.optional(),
  /** How readily they press buttons that change or delete things, pay or send. */
  risk: z.enum(['cautious', 'normal', 'bold']).optional(),
  /** Straight to the goal, or poking at menus and settings on the way. */
  focus: z.enum(['task', 'wanders']).optional(),
  /** What they are used to, in plain words ("Excel", "the paper forms", "the old version"): what they expect to find. */
  priorTools: z.string().optional(),
  /** Their first language (a BCP 47 tag like es or pt-BR) and how well they read the app's language, 1 to 5. */
  language: z.strictObject({ native: z.string().min(2), fluency: Level }).optional(),
  /** Where they look for help. */
  helpSeeking: z.enum(['never', 'tooltips', 'docs', 'support']).optional(),
  /** How readily they speak up and report: a stoic persona's report means more. */
  vocal: z.enum(['stoic', 'normal', 'vocal']).optional(),

  // Body: in the brief and enforced by the harness.
  vision: VisionTrait.optional(),
  /** Pointer accuracy: below 5, clicks and taps at coordinates land off target, and at 1–2 some become double clicks. */
  precision: Level.optional(),
  /** `rushes` acts before the page settles; `slow` pauses to think before every action. */
  pace: z.enum(['rushes', 'normal', 'slow']).optional(),
  /** `typos` misspells some words it types; `pastes` pastes text, with stray spaces and typographic quotes. */
  typing: z.enum(['careful', 'typos', 'pastes']).optional(),
  /** Being interrupted mid-task: stepping away, the connection dropping, the tab reloading or reopening. */
  interruptions: z.enum(['none', 'some', 'many']).optional(),
  /** Works in several tabs: gets the tabs tool whatever the proficiency, and opens the same page twice. */
  multitab: z.boolean().optional(),
})
export type Traits = z.infer<typeof Traits>

/**
 * A persona's own time and actions. `minutes` and `turns` are used as they are; `scale` multiplies the
 * cohort's baseline (after the trait scaling). See docs/personas.md, "Budget".
 */
export const PersonaBudget = z.strictObject({
  minutes: z.number().positive().optional(),
  turns: z.number().int().positive().optional(),
  scale: z.number().min(0.1).max(10).optional(),
})
export type PersonaBudget = z.infer<typeof PersonaBudget>

export const Persona = z.strictObject({
  id: Slug,
  name: z.string(),
  proficiency: Level,
  traits: Traits.default({}),
  background: z.string(),
  mission: z.strictObject({
    goal: z.string(),
    kind: z.enum(['open', 'scripted']).default('open'),
    steps: z.array(z.string()).default([]),
    success: z.array(z.string()).default([]),
  }),
  /** A preset name (see presets) or a full profile. */
  device: z.union([z.string(), DeviceProfile]),
  deviceOverrides: DeviceOverrides.optional(),
  account: z.string().optional(),
  /** Which of the target's files this person has (by tag, by name, how many). The cohort's `media` wins. */
  media: MediaSelection.optional(),
  /** More or less time and actions than the cohort's baseline: this person is just slow, or quick. */
  budget: PersonaBudget.optional(),
  requires: z.strictObject({ vision: z.boolean().optional(), minContext: z.number().int().positive().optional() }).default({}),
  toolProfile: ToolProfile.optional(),
  /** Extra instructions appended to the persona brief. */
  notes: z.string().optional(),
})
export type Persona = z.infer<typeof Persona>

// Each settings object has a variant for overrides: the same fields, all optional and without
// defaults. (In zod 4, `.partial()` keeps inner defaults, so a partial override would silently reset
// every field it does not name.)

const roleFields = { driver: z.string(), model: z.string(), options: z.record(z.string(), z.unknown()) }
export const RoleBinding = z.strictObject({
  driver: roleFields.driver,
  model: roleFields.model.default('default'),
  options: roleFields.options.default({}),
})
export type RoleBinding = z.infer<typeof RoleBinding>
export const RoleOverrides = z.strictObject(roleFields).partial()

const limitFields = {
  maxBrowsers: z.number().int().min(1),
  maxAgents: z.number().int().min(1),
  minFreeMemoryPercent: z.number().min(0).max(100),
  stopBelowFreeMemoryPercent: z.number().min(0).max(100),
  /** Clamp for every device's scale factor: canvas memory grows with its square. */
  maxDeviceScaleFactor: z.number().positive(),
}
export const Limits = z.strictObject({
  maxBrowsers: limitFields.maxBrowsers.default(4),
  maxAgents: limitFields.maxAgents.default(4),
  minFreeMemoryPercent: limitFields.minFreeMemoryPercent.default(30),
  stopBelowFreeMemoryPercent: limitFields.stopBelowFreeMemoryPercent.default(15),
  maxDeviceScaleFactor: limitFields.maxDeviceScaleFactor.default(1),
})
export type Limits = z.infer<typeof Limits>
export const LimitsOverrides = z.strictObject(limitFields).partial()

const memoryFields = {
  keepImages: z.number().int().min(0),
  summarizeAfterTokens: z.number().int().positive(),
  maxToolTextChars: z.number().int().positive(),
}
export const MemoryPolicy = z.strictObject({
  keepImages: memoryFields.keepImages.default(3),
  summarizeAfterTokens: memoryFields.summarizeAfterTokens.default(60_000),
  maxToolTextChars: memoryFields.maxToolTextChars.default(12_000),
})
export type MemoryPolicy = z.infer<typeof MemoryPolicy>
export const MemoryOverrides = z.strictObject(memoryFields).partial()

/** Built-in exporter types (the implementations live in `@persona-swarm/findings`), plus your own module. */
export const EXPORTER_TYPES = ['json', 'markdown', 'webhook', 'command', 'github', 'linear', 'jira', 'module'] as const

export const ExporterConfig = z.strictObject({
  type: z.enum(EXPORTER_TYPES),
  id: z.string().optional(),
  /** Exporter-specific settings; secrets are named by environment variable (e.g. tokenEnv). */
  with: z.record(z.string(), z.unknown()).default({}),
  /** Export only approved findings (default) or everything that passed triage. */
  only: z.enum(['approved', 'all']).default('approved'),
})
export type ExporterConfig = z.infer<typeof ExporterConfig>

export const GroupingConfig = z
  .strictObject({
    model: z.string().optional(),
    command: z.array(z.string()).min(1).optional(),
    timeoutSec: z.number().positive().default(300),
  })
  .refine((grouping) => Boolean(grouping.model) !== Boolean(grouping.command), { message: 'grouping needs a model or a command (one of them)' })
export type GroupingConfig = z.infer<typeof GroupingConfig>

const PersonaRef = z.union([z.string(), Persona])

export const Cohort = z.strictObject({
  id: Slug,
  description: z.string().optional(),
  target: z.string(),
  mode: z.enum(['explore', 'gate', 'research', 'coverage']).default('explore'),
  personas: z.array(PersonaRef).min(1),
  /** Who plays the personas. Further roles (an observer, a verifier) are planned, not built. */
  roles: z.strictObject({ persona: RoleBinding }),
  /** Mission goals for this cohort, by persona id or "*" for all: reuse library personas on any app. */
  missions: z.record(z.string(), z.string()).default({}),
  /** Which files each persona has, by persona id or "*" for all (replacing the persona's own `media`). */
  media: z.record(z.string(), MediaSelection).default({}),
  assign: z.record(z.string(), RoleOverrides).default({}),
  schedule: z
    .strictObject({
      waveSize: z.number().int().min(1).optional(),
      waveIntervalSec: z.number().min(0).default(0),
      staggerSec: z.number().min(0).default(5),
    })
    .default({ waveIntervalSec: 0, staggerSec: 5 }),
  budgets: z
    .strictObject({
      /** The baseline per persona, before each persona's own scaling (see docs/personas.md, "Budget"). */
      minutesPerPersona: z.number().positive().default(30),
      turnsPerPersona: z.number().int().positive().default(200),
      usdPerRun: z.number().positive().optional(),
      /** Scale each persona's budget by its proficiency, pace and interruptions. */
      scaleByTraits: z.boolean().default(true),
      /** Per persona id: absolute minutes and turns for this mission in this app, or a scale. Wins over the persona file. */
      personas: z.record(z.string(), PersonaBudget).default({}),
    })
    .default({ minutesPerPersona: 30, turnsPerPersona: 200, scaleByTraits: true, personas: {} }),
  limits: LimitsOverrides.default({}),
  memory: MemoryOverrides.default({}),
  exporters: z
    .array(ExporterConfig)
    .default([])
    .refine((list) => new Set(list.map((exporter) => exporter.id ?? exporter.type)).size === list.length, {
      message: 'exporters of the same type need an id each',
    }),
  /**
   * After a finished run, a model or an agent groups reports of the same problem (see `persona-swarm
   * group`): `model` is called through the AI SDK (any provider); `command` is any agent's command
   * line, which reads the task on stdin and prints its answer.
   */
  grouping: GroupingConfig.optional(),
  /** Gate mode: how many attempts per persona and how many must succeed. */
  gate: z.strictObject({ attempts: z.number().int().min(1).default(3), mustPass: z.number().int().min(1).default(2) }).optional(),
  /** Coverage mode: expand each persona across these device presets and locales. */
  matrix: z.strictObject({ devices: z.array(z.string()).default([]), locales: z.array(z.string()).default([]) }).optional(),
})
export type Cohort = z.infer<typeof Cohort>

export const DriverCommand = z.strictObject({
  command: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()).default({}),
})

export const ProviderConfig = z.strictObject({
  type: z.enum(['openai', 'anthropic', 'google', 'openai-compatible']),
  baseURL: z.string().url().optional(),
  /** Name of the environment variable that holds the key; never the key itself. */
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  /** How screenshots reach this provider's models: inside tool results, or as a follow-up user message. */
  imagesInToolResults: z.boolean().optional(),
  /** Declared model capabilities; local and self-hosted models cannot be looked up by name. */
  vision: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
})
export type ProviderConfig = z.infer<typeof ProviderConfig>

/** Where the run's browser comes from: launched here (default), or a remote one (a VM, a cloud browser service). */
export const BrowserConfig = z.strictObject({
  executablePath: z.string().optional(),
  headless: z.boolean().optional(),
  connect: z
    .strictObject({
      /** A Playwright server (ws://…, from launchServer) or a Chrome DevTools endpoint (ws:// or http://). */
      url: z.string(),
      protocol: z.enum(['cdp', 'playwright']).default('cdp'),
      headers: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  /** JPEG quality of screenshots, 1 to 100. */
  screenshotQuality: z.number().int().min(1).max(100).optional(),
  /** Pause after each action so the page can react, in ms. */
  settleMs: z.number().int().min(0).optional(),
})
export type BrowserConfig = z.infer<typeof BrowserConfig>

export const Workspace = z.strictObject({
  runsDir: z.string().default('runs'),
  drivers: z.record(z.string(), DriverCommand).default({}),
  providers: z.record(z.string(), ProviderConfig).default({}),
  /**
   * USD per million tokens, by model id as written in roles. Input tokens read from a prompt cache cost
   * `cachedInput` when given, else the full input price (an overestimate keeps a spend cap safe).
   */
  prices: z.record(z.string(), z.strictObject({ input: z.number().min(0), output: z.number().min(0), cachedInput: z.number().min(0).optional() })).default({}),
  limits: LimitsOverrides.default({}),
  /** Registry of findings across runs (fingerprints, statuses). */
  registry: z.string().default('.persona-swarm/registry.json'),
  browser: BrowserConfig.default({}),
})
export type Workspace = z.infer<typeof Workspace>
export type ModelPrice = Workspace['prices'][string]

/** USD for a model call: uncached input, input read from a prompt cache, and output tokens. */
export function priceOf(price: ModelPrice | undefined, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): number {
  if (!price) return 0
  const cached = usage.cachedInputTokens ?? 0
  return (usage.inputTokens * price.input + cached * (price.cachedInput ?? price.input) + usage.outputTokens * price.output) / 1_000_000
}
