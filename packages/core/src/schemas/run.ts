import { z } from 'zod'

export const FeltSeverity = z.enum(['blocking', 'annoying', 'minor', 'cosmetic'])
export type FeltSeverity = z.infer<typeof FeltSeverity>

export const FindingKind = z.enum(['bug', 'confusing', 'layout', 'accessibility', 'copy', 'data', 'performance'])
export type FindingKind = z.infer<typeof FindingKind>

/** Another tester ran into the same problem: their note, and where and what they saw. */
export const Vote = z.object({
  session: z.string(),
  t: z.string(),
  note: z.string().default(''),
  url: z.string().optional(),
  screenshot: z.string().optional(),
})
export type Vote = z.infer<typeof Vote>

export const Finding = z.object({
  id: z.string(),
  session: z.string(),
  t: z.string(),
  title: z.string(),
  whatIDid: z.string(),
  expected: z.string(),
  actual: z.string(),
  feltSeverity: FeltSeverity,
  confidence: z.enum(['sure', 'unsure']).default('sure'),
  kind: FindingKind.default('bug'),
  url: z.string().default(''),
  evidence: z
    .object({
      eventSeqs: z.array(z.number()).default([]),
      screenshot: z.string().optional(),
      signals: z.array(z.string()).default([]),
      /** Files the reporter had uploaded in its session before reporting, latest last (see media.json for truth). */
      media: z.array(z.string()).optional(),
    })
    .default({ eventSeqs: [], signals: [] }),
  votes: z.array(Vote).default([]),
  source: z.enum(['persona', 'monkey', 'check']).default('persona'),
  /** Similar reports the reporter looked at and judged to be a different problem. */
  notSameAs: z.array(z.string()).optional(),
})
export type Finding = z.infer<typeof Finding>

/** One line of a run's findings.jsonl: a report, or a confirmation of a report or a known issue. */
export type FindingLine = ({ type: 'finding' } & Finding) | ({ type: 'vote'; findingId: string; known?: boolean; title?: string } & Vote)

/** An issue the team already knows about, from the target's known-issues file. */
export interface KnownIssue {
  id: string
  title: string
  description?: string
}

/** A known issue (from the target's known-issues file) that testers ran into during a run. */
export interface KnownIssueHit {
  id: string
  title: string
  votes: Vote[]
}

/** Reports of this run (F-…) that describe one problem, and the known issue (K-…) it is, if any. */
export const GroupingGroup = z.object({
  ids: z.array(z.string()),
  reason: z.string().default(''),
})
export type GroupingGroup = z.infer<typeof GroupingGroup>

/**
 * A model's or an agent's judgment of which reports describe the same problem (`grouping.json` in a
 * run folder). Triage adds it to what testers said and to wording, and never overrides a tester's
 * "not the same".
 */
export const Grouping = z.object({
  version: z.literal(1).default(1),
  /** Who grouped: a model (`openai:gpt-5`), a command, or an agent's name. */
  by: z.string(),
  t: z.string(),
  /** The reports the grouper saw: reports filed later are not covered until it runs again. */
  covered: z.array(z.string()).default([]),
  groups: z.array(GroupingGroup).default([]),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  costUsd: z.number().optional(),
})
export type Grouping = z.infer<typeof Grouping>

export const ReviewStatus = z.enum(['new', 'approved', 'rejected', 'duplicate', 'needs-info'])
export type ReviewStatus = z.infer<typeof ReviewStatus>

export const Severity = z.enum(['blocker', 'major', 'minor', 'cosmetic'])
export type Severity = z.infer<typeof Severity>

export const Review = z.object({
  status: ReviewStatus,
  severity: Severity.optional(),
  note: z.string().default(''),
  duplicateOf: z.string().optional(),
  t: z.string(),
  by: z.string().default('human'),
  /** External ids per exporter, so nothing is filed twice. */
  exported: z.record(z.string(), z.string()).default({}),
  /** Reports or known issues a reviewer judged a different problem: never grouped with this one. */
  apartFrom: z.array(z.string()).optional(),
})
export type Review = z.infer<typeof Review>

export const SessionStatus = z.enum(['pending', 'starting', 'running', 'finished', 'failed', 'cancelled', 'paused', 'skipped'])
export type SessionStatus = z.infer<typeof SessionStatus>

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 })

export interface SessionState {
  id: string
  personaId: string
  name: string
  proficiency: number
  device: string
  input: string
  toolProfile: string
  driver: string
  model: string
  account?: string
  /** The files on this persona's computer (details in the run's media.json). */
  media?: string[]
  /** This session's own minutes and actions (the run's budgets are the baseline). */
  budget?: { minutes: number; turns: number }
  status: SessionStatus
  attempts: number
  startedAt?: string
  endedAt?: string
  stopReason?: string
  error?: string
  turns: number
  toolCalls: number
  toolErrors: number
  harnessErrors: number
  findings: number
  usage: Usage
  lastScreenshot?: string
  lastNote?: string
  lastActionAt?: string
  outcome?: 'completed' | 'gave_up' | 'blocked' | 'ran_out_of_time'
}

export type RunStatus = 'planned' | 'starting' | 'running' | 'stopping' | 'finished' | 'aborted' | 'failed'

/** Command-line overrides a run was started with; a resume applies them again. */
export interface RunOverrides {
  /** Only these persona ids (or session ids). */
  personas?: string[]
  driver?: string
  model?: string
  driverOptions?: Record<string, unknown>
  maxBrowsers?: number
  maxAgents?: number
  minutes?: number
  turns?: number
  usd?: number
}

export interface RunState {
  runId: string
  version: 1
  createdAt: string
  updatedAt: string
  status: RunStatus
  statusReason?: string
  mode: 'explore' | 'gate' | 'research' | 'coverage'
  cohort: { id: string; file: string; description?: string }
  overrides?: RunOverrides
  target: { id: string; name: string; baseUrl: string }
  host: { platform: string; node: string; tool: string; pid: number }
  api?: { url: string }
  governor: { level: 'ok' | 'tight' | 'critical'; freePercent: number; samples: number }
  /** The baseline per persona; each session's own is in its `budget`. */
  budgets: { minutesPerPersona: number; turnsPerPersona: number; usdPerRun?: number }
  limits: { maxBrowsers: number; maxAgents: number; minFreeMemoryPercent: number; stopBelowFreeMemoryPercent: number }
  sessions: Record<string, SessionState>
  totals: Usage & { findings: number }
  /** Gate mode: the verdict (details in gate.json). Inconclusive: attempts that could decide it did not run. */
  gate?: { passed: boolean; failing: string[]; inconclusive?: string[] }
}
