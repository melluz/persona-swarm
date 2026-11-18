import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  type Finding,
  type FindingLine,
  type KnownIssue,
  type KnownIssueHit,
  type Review,
  type RunEvent,
  type RunState,
  readJsonFile,
  readJsonLines,
  runPaths,
} from '@persona-swarm/core'

export interface LoadedRun {
  dir: string
  state: RunState
  findings: Finding[]
  /** Known issues that testers confirmed during the run. */
  knownHits: KnownIssueHit[]
  /** The target's known issues when the run started. */
  knownIssues: KnownIssue[]
  reviews: Record<string, Review>
  events: (session: string) => Promise<RunEvent[]>
  sessions: string[]
}

/** Findings with their votes merged in (in report order), and the confirmed known issues. */
export async function readFindingsFile(file: string): Promise<{ findings: Finding[]; knownHits: KnownIssueHit[] }> {
  const map = new Map<string, Finding>()
  const known = new Map<string, KnownIssueHit>()
  for (const line of await readJsonLines<FindingLine>(file)) {
    if (line.type === 'finding') {
      const { type: _type, ...finding } = line
      map.set(finding.id, { ...(finding as Finding), votes: [...(finding.votes ?? [])] })
      continue
    }
    const { type: _type, findingId, known: isKnown, title, ...vote } = line
    if (!isKnown) {
      map.get(findingId)?.votes.push(vote)
      continue
    }
    const hit = known.get(findingId) ?? { id: findingId, title: title ?? findingId, votes: [] }
    hit.votes.push(vote)
    known.set(findingId, hit)
  }
  return { findings: [...map.values()], knownHits: [...known.values()] }
}

export async function readFindings(file: string): Promise<Finding[]> {
  return (await readFindingsFile(file)).findings
}

export async function loadRun(runDir: string): Promise<LoadedRun> {
  const paths = runPaths(join(runDir, '..'), basename(runDir))
  const state = await readJsonFile<RunState | undefined>(paths.runFile, undefined)
  if (!state) throw new Error(`${runDir} is not a run folder (no run.json)`)
  const cache = new Map<string, Promise<RunEvent[]>>()
  const sessions = existsSync(paths.eventsDir)
    ? readdirSync(paths.eventsDir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.slice(0, -'.jsonl'.length))
    : []
  const { findings, knownHits } = await readFindingsFile(paths.findingsFile)
  return {
    dir: paths.root,
    state,
    findings,
    knownHits,
    knownIssues: await readJsonFile<KnownIssue[]>(paths.knownIssuesFile, []),
    reviews: await readJsonFile<Record<string, Review>>(paths.reviewFile, {}),
    sessions,
    events: (session) => {
      let promise = cache.get(session)
      if (!promise) {
        promise = readJsonLines<RunEvent>(join(paths.eventsDir, `${session}.jsonl`))
        cache.set(session, promise)
      }
      return promise
    },
  }
}
