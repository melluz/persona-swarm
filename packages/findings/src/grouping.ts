import { basename, dirname } from 'node:path'
import { type Finding, Grouping, type GroupingGroup, readJsonFile, routePattern, runPaths, writeFileAtomic } from '@persona-swarm/core'
import type { LoadedRun } from './load.js'
import { withJudgements } from './review.js'

/**
 * Model-assisted grouping. Wording finds only some duplicates: testers describe one fault in
 * different words, from different screens and devices. A model or an agent reads every report and
 * the known issues and says which belong together. Its answer is stored in the run folder
 * (`grouping.json`) and triage adds it to what testers said and to wording; a tester's "not the
 * same" always wins. Nothing here calls a model: the CLI runs the model, a command or an agent.
 */

/** A problem as the grouper sees it: one of this run's reports, or a known issue. */
export interface GroupingItem {
  id: string
  title: string
  /** What happened (a report) or the description (a known issue), shortened to fit. */
  text: string
  expected?: string
  /** The page, with ids replaced (`/cases/:id`). */
  page?: string
  tester?: string
}

export interface GroupingRequest {
  runId: string
  runDir: string
  reports: GroupingItem[]
  knownIssues: GroupingItem[]
  /** Pairs a tester looked at and said are different problems: never grouped. */
  apart: [string, string][]
  /** How much of each report fits in one request. */
  detail: 'full' | 'short' | 'titles'
}

/** The tool a model answers with. */
export const GROUP_TOOL = {
  name: 'group_problems',
  description: 'Say which reports describe the same problem, and which known issue each group is, if any. Call it once, with every group.',
  inputSchema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        description: 'One entry per problem reported more than once or matching a known issue. Empty when nothing belongs together.',
        items: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, description: 'Report ids (F-…) and at most one known issue id (K-…).' },
            reason: { type: 'string', description: 'What the reports have in common, in one short sentence a reviewer can check.' },
          },
          required: ['ids', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['groups'],
    additionalProperties: false,
  },
} as const

export const GROUPING_INSTRUCTIONS = `You are sorting the problem reports from a test of an app. Several testers used the app and each reported what went wrong. Some reports describe the same problem in different words, and some describe a problem the team already knows about (the known issues, with ids starting K-).

Find the reports that describe the same problem: the same fault in the same place or flow, which one fix would solve. When a known issue describes it, put the known issue in the group too.

- Group only when you are confident. A shared topic or screen is not enough: two different faults on one screen stay apart, while one fault reported from two screens or devices, or in different words, belongs together.
- A report that mentions several problems goes with the one its title is about.
- Never group a pair listed under "Kept apart": a tester looked at both and said they differ.
- Leave out reports that have no duplicate and match no known issue.
- At most one known issue per group.
- Give each group a short reason a reviewer can check: what the reports have in common.`

const LIMITS = {
  full: { text: 500, expected: 200, known: 300 },
  short: { text: 160, expected: 0, known: 120 },
  titles: { text: 0, expected: 0, known: 0 },
} as const

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

function reportItem(finding: Finding): GroupingItem {
  return {
    id: finding.id,
    title: finding.title,
    text: finding.actual,
    ...(finding.expected ? { expected: finding.expected } : {}),
    ...(finding.url ? { page: routePattern(finding.url) } : {}),
    tester: finding.session,
  }
}

/** The reports and known issues, written out at one level of detail. */
export function groupingListing(request: GroupingRequest, detail: GroupingRequest['detail'] = request.detail): string {
  const limit = LIMITS[detail]
  const lines: string[] = [`## Reports from this run (${request.reports.length})`, '']
  for (const report of request.reports) {
    const where = [report.page && `page ${report.page}`, report.tester && `tester ${report.tester}`].filter(Boolean).join(', ')
    lines.push(`${report.id}${where ? ` (${where})` : ''}: ${clip(report.title, 200)}`)
    if (limit.text && report.text) lines.push(`  Happened: ${clip(report.text, limit.text)}`)
    if (limit.expected && report.expected) lines.push(`  Expected: ${clip(report.expected, limit.expected)}`)
  }
  if (request.knownIssues.length) {
    lines.push('', `## Known issues (${request.knownIssues.length})`, '')
    for (const issue of request.knownIssues)
      lines.push(`${issue.id}: ${clip(issue.title, 200)}${limit.known && issue.text ? ` (${clip(issue.text, limit.known)})` : ''}`)
  }
  if (request.apart.length) {
    lines.push('', '## Kept apart', '', 'A tester looked at each of these pairs and said they are different problems:')
    for (const [a, b] of request.apart) lines.push(`- ${a} and ${b}`)
  }
  return lines.join('\n')
}

/**
 * What a grouper needs from a run. The most detailed listing that fits `maxChars` is used (about
 * 30,000 tokens by default): every report and known issue is always in the one request, since
 * splitting would hide duplicates from each other.
 */
export function groupingRequest(run: LoadedRun, options: { maxChars?: number } = {}): GroupingRequest {
  const maxChars = options.maxChars ?? 120_000
  const reports = run.findings.map(reportItem)
  const knownIssues = run.knownIssues.map((issue) => ({ id: issue.id, title: issue.title, text: issue.description ?? '' }))
  const ids = new Map([...reports, ...knownIssues].map((item) => [item.id.toUpperCase(), item.id]))
  const apart: [string, string][] = []
  const seen = new Set<string>()
  for (const finding of run.findings.map((each) => withJudgements(each, run.reviews[each.id])))
    for (const raw of finding.notSameAs ?? []) {
      const other = ids.get(raw.trim().toUpperCase())
      const key = [finding.id, other].sort().join(' ')
      if (other && other !== finding.id && !seen.has(key)) {
        seen.add(key)
        apart.push([finding.id, other])
      }
    }
  const request: GroupingRequest = { runId: run.state.runId, runDir: run.dir, reports, knownIssues, apart, detail: 'full' }
  for (const detail of ['full', 'short', 'titles'] as const) {
    const size = groupingListing(request, detail).length
    if (size <= maxChars) return { ...request, detail }
    if (detail === 'titles')
      throw new Error(
        `${reports.length} reports and ${knownIssues.length} known issues do not fit one grouping request even as titles (${size} characters, the limit is ${maxChars})`,
      )
  }
  return request
}

export type AnswerFormat =
  | { kind: 'tool' }
  | { kind: 'json' }
  /** An outside agent writes its answer to `file` and hands it back with `command`. */
  | { kind: 'file'; file: string; command: string }

const ANSWER_SHAPE = '{"groups": [{"ids": ["<report id>", "<report or known issue id>"], "reason": "<what they have in common>"}]}'

export function answerFormat(format: AnswerFormat): string {
  switch (format.kind) {
    case 'tool':
      return `Answer by calling ${GROUP_TOOL.name} once, with every group. If nothing belongs together, call it with an empty list.`
    case 'json':
      return `Answer with only a JSON object, no other text:\n${ANSWER_SHAPE}\nIf nothing belongs together, answer {"groups": []}.`
    case 'file':
      return `Write your answer as JSON to ${format.file}:\n\n    ${ANSWER_SHAPE}\n\nIf nothing belongs together, write {"groups": []}. Then hand it back by running:\n\n    ${format.command}\n\nThe command checks the answer and says anything it could not use; fix the file and run it again if needed.`
  }
}

/** The whole task as one text: for an agent's file, or a command's stdin. */
export function groupingBrief(request: GroupingRequest, format: AnswerFormat): string {
  return `# Group the problem reports of run ${request.runId}\n\n${GROUPING_INSTRUCTIONS}\n\n${groupingListing(request)}\n\n## How to answer\n\n${answerFormat(format)}\n`
}

const squash = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * Checks an answer against the request. Lenient in what it reads (`{groups: [{ids, reason}]}`, a
 * bare list of groups, or lists of ids; `f5` for `F-5`) and strict in what it keeps: ids must exist,
 * a group needs one of this run's reports and keeps at most one known issue. `problems` says what
 * was dropped, in words an agent can act on.
 */
export interface CheckedAnswer {
  groups: GroupingGroup[]
  /** What could not be used, in words an agent can act on. */
  problems: string[]
  /** Groups the answer listed: -1 when it had no list at all. */
  listed: number
  /** Listed groups that held one report and nothing else (as an agent writes "no duplicates" report by report). */
  alone: number
}

export function parseGroupingAnswer(raw: unknown, request: GroupingRequest): CheckedAnswer {
  const problems: string[] = []
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { groups?: unknown }).groups)
      ? (raw as { groups: unknown[] }).groups
      : undefined
  if (!list) return { groups: [], problems: ['the answer has no list of groups (expected {"groups": [...]})'], listed: -1, alone: 0 }
  const reportIds = new Set(request.reports.map((item) => item.id))
  const exact = new Map([...request.reports, ...request.knownIssues].map((item) => [item.id.toUpperCase(), item.id]))
  const loose = new Map([...request.reports, ...request.knownIssues].map((item) => [squash(item.id), item.id]))
  const resolve = (value: unknown) => {
    const text = String(value).trim()
    return exact.get(text.toUpperCase()) ?? loose.get(squash(text))
  }
  const groups: GroupingGroup[] = []
  /** Each kept group's number in the answer: messages name groups as the answer numbered them. */
  const numbers: number[] = []
  let alone = 0
  for (const [index, entry] of list.entries()) {
    const name = `group ${index + 1}`
    const values = Array.isArray(entry) ? entry : entry && typeof entry === 'object' ? (entry as { ids?: unknown }).ids : undefined
    if (!Array.isArray(values)) {
      problems.push(`${name} has no ids`)
      continue
    }
    const reason = entry && typeof entry === 'object' && !Array.isArray(entry) ? String((entry as { reason?: unknown }).reason ?? '').trim() : ''
    const ids: string[] = []
    for (const value of values) {
      const id = resolve(value)
      if (!id) problems.push(`${name}: "${String(value)}" is not a report or known issue of this run`)
      else if (!ids.includes(id)) ids.push(id)
    }
    const reports = ids.filter((id) => reportIds.has(id))
    const known = ids.filter((id) => !reportIds.has(id))
    if (!reports.length) {
      if (ids.length) problems.push(`${name} has none of this run's reports (${ids.join(', ')})`)
      continue
    }
    if (known.length > 1) problems.push(`${name} names ${known.length} known issues (${known.join(', ')}); kept ${known[0]}`)
    const kept = [...reports, ...known.slice(0, 1)]
    if (kept.length < 2) {
      if (ids.length === 1) alone += 1
      problems.push(`${name} has only ${kept[0]}: a group needs two reports, or a report and a known issue`)
      continue
    }
    groups.push({ ids: kept, reason })
    numbers.push(index + 1)
  }
  for (const [a, b] of request.apart)
    if (groups.some((group) => group.ids.includes(a) && group.ids.includes(b)))
      problems.push(`${a} and ${b} share a group, but a tester said they differ: they stay apart`)
  const seen = new Map<string, number>()
  for (const [index, group] of groups.entries())
    for (const id of group.ids.filter((each) => reportIds.has(each))) {
      const first = seen.get(id)
      if (first !== undefined) problems.push(`${id} is in group ${first} and group ${numbers[index]}: they are joined into one`)
      else seen.set(id, numbers[index] as number)
    }
  return { groups, problems, listed: list.length, alone }
}

/** The end of a balanced JSON object or array starting at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i += 1
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** An answer's shape: an object with a groups list, or a non-empty list whose entries are id lists or { ids }. */
function isAnswer(value: unknown): boolean {
  if (Array.isArray(value))
    return value.length > 0 && value.every((entry) => Array.isArray(entry) || (Boolean(entry) && typeof entry === 'object' && 'ids' in entry))
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { groups?: unknown }).groups)
}

/**
 * The JSON answer inside an agent's or a model's text: the whole text, a fenced block, or an object
 * or list in the text that has the answer's shape (a stray list of ids in the prose is not one). An
 * agent CLI's envelope (`{"result": "…"}`, as `claude -p --output-format json` prints) is opened.
 */
export function extractJson(text: string): unknown {
  const candidates: string[] = [text.trim()]
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1] ?? '')
  let starts = 0
  for (let i = 0; i < text.length && starts < 2_000; i += 1) {
    if (text[i] !== '{' && text[i] !== '[') continue
    starts += 1
    const end = balancedEnd(text, i)
    if (end > i) candidates.push(text.slice(i, end + 1))
  }
  const parsed: unknown[] = []
  for (const candidate of candidates) {
    try {
      parsed.push(JSON.parse(candidate))
    } catch {
      // Not JSON.
    }
  }
  const answer = parsed.find(isAnswer)
  if (answer !== undefined) return answer
  for (const value of parsed)
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const key of ['result', 'text', 'content', 'output', 'response']) {
        const inner = (value as Record<string, unknown>)[key]
        if (typeof inner === 'string') {
          const found = extractJson(inner)
          if (isAnswer(found)) return found
        }
      }
  // The whole text is JSON, but not an answer ([] means "no groups"): the caller says what is wrong with it.
  try {
    return JSON.parse(text.trim())
  } catch {
    return undefined
  }
}

/** Stores a grouping in the run folder; triage reads it from there. */
export async function saveGrouping(runDir: string, grouping: Grouping): Promise<string> {
  const file = runPaths(dirname(runDir), basename(runDir)).groupingFile
  await writeFileAtomic(file, `${JSON.stringify(Grouping.parse(grouping), null, 2)}\n`)
  return file
}

/** The run's grouping, if any. A file that does not parse is reported, never fatal: triage goes on without it. */
export async function readGrouping(runDir: string): Promise<{ grouping?: Grouping; error?: string }> {
  const file = runPaths(dirname(runDir), basename(runDir)).groupingFile
  let raw: unknown
  try {
    raw = await readJsonFile<unknown>(file, undefined)
  } catch (error) {
    return { error: `grouping.json is not valid JSON: ${(error as Error).message}` }
  }
  if (raw === undefined) return {}
  const parsed = Grouping.safeParse(raw)
  return parsed.success ? { grouping: parsed.data } : { error: `grouping.json does not look like a grouping: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
}
