import { existsSync, readFileSync } from 'node:fs'
import {
  type EventStore,
  type Finding,
  type FindingLine,
  JsonLinesWriter,
  type KnownIssue,
  type KnownIssueHit,
  nowIso,
  problemSimilarity,
  readJsonLines,
  type Vote,
} from '@persona-swarm/core'
import { parse as parseYaml } from 'yaml'

/** Loads a target's known-issues file (YAML or JSON list of { id, title, description }). */
export function loadKnownIssues(file?: string): KnownIssue[] {
  if (!file || !existsSync(file)) return []
  const data = parseYaml(readFileSync(file, 'utf8')) as unknown
  const list = Array.isArray(data) ? data : ((data as { issues?: unknown[] })?.issues ?? [])
  return list
    .filter((item): item is KnownIssue => typeof item === 'object' && item !== null && 'title' in item)
    .map((item, index) => ({
      id: String(item.id ?? `K-${index + 1}`),
      title: String(item.title),
      ...(item.description ? { description: String(item.description) } : {}),
    }))
}

/**
 * Reports at least this alike are shown to the reporter before filing. Calibrated on real runs:
 * duplicates scored 0.25 to 1.0 and unrelated pairs at most 0.27, so a few distinct problems are
 * held back for a second look. That costs one call; the reporter decides.
 */
export const LIKELY_SAME_PROBLEM = 0.25

export interface SimilarProblem {
  id: string
  title: string
  score: number
  /** From the target's known-issues file, not this run. */
  known: boolean
  /** Reported earlier by the same session. */
  mine: boolean
  /** Testers who reported or confirmed it during this run. */
  testers: number
}

/** Every finding of a run, shared by all sessions so they can see and confirm each other's reports. */
export class RunFindings {
  private readonly findings = new Map<string, Finding>()
  private readonly knownHits = new Map<string, KnownIssueHit>()
  private counter = 0
  private readonly writer: JsonLinesWriter

  constructor(
    private readonly file: string,
    private readonly events: EventStore,
    private readonly knownIssues: KnownIssue[] = [],
  ) {
    this.writer = new JsonLinesWriter(file)
  }

  /** Restores findings and votes after a resume. */
  async load(): Promise<void> {
    for (const line of await readJsonLines<FindingLine>(this.file)) {
      if (line.type === 'finding') {
        const { type: _type, ...finding } = line
        this.findings.set(finding.id, finding as Finding)
        this.counter = Math.max(this.counter, Number(finding.id.replace(/\D/g, '')) || 0)
      } else {
        const { type: _type, findingId, known, title, ...vote } = line
        if (known) this.hitFor(findingId, title ?? findingId).votes.push(vote)
        else this.findings.get(findingId)?.votes.push(vote)
      }
    }
  }

  all(): Finding[] {
    return [...this.findings.values()]
  }

  get(id: string): Finding | undefined {
    return this.findings.get(id.trim().toUpperCase())
  }

  knownIssueHits(): KnownIssueHit[] {
    return [...this.knownHits.values()]
  }

  /** A report or known issue by id, as a tester would name it. */
  lookup(id: string): { id: string; title: string; known: boolean; session?: string } | undefined {
    const finding = this.get(id)
    if (finding) return { id: finding.id, title: finding.title, known: false, session: finding.session }
    const issue = this.knownIssues.find((candidate) => candidate.id.toUpperCase() === id.trim().toUpperCase())
    return issue ? { id: issue.id, title: issue.title, known: true } : undefined
  }

  /** Reports (this run's and the known issues) that may be the same problem as a draft, closest first. */
  similar(
    draft: { title: string; actual: string },
    session: string,
    options: { minScore?: number; exclude?: Set<string>; limit?: number } = {},
  ): SimilarProblem[] {
    const { minScore = LIKELY_SAME_PROBLEM, exclude, limit = 4 } = options
    const found = this.all().map((finding) => ({
      id: finding.id,
      title: finding.title,
      score: problemSimilarity(draft, finding),
      known: false,
      mine: finding.session === session,
      testers: 1 + finding.votes.length,
    }))
    const known = this.knownIssues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      score: problemSimilarity(draft, { title: issue.title, actual: issue.description ?? '' }),
      known: true,
      mine: false,
      testers: this.knownHits.get(issue.id)?.votes.length ?? 0,
    }))
    return [...found, ...known]
      .filter((item) => item.score >= minScore && !exclude?.has(item.id.toUpperCase()))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Whether a session's confirmation of a problem would count (it exists, is not its own, not yet confirmed). */
  wouldCount(id: string, session: string): boolean {
    const target = this.lookup(id)
    if (!target || target.session === session) return false
    const votes = target.known ? (this.knownHits.get(target.id)?.votes ?? []) : (this.get(target.id)?.votes ?? [])
    return !votes.some((vote) => vote.session === session)
  }

  add(draft: Omit<Finding, 'id' | 't' | 'votes'>): Finding {
    this.counter += 1
    const finding: Finding = { ...draft, id: `F-${this.counter}`, t: nowIso(), votes: [] }
    this.findings.set(finding.id, finding)
    this.writer.write({ type: 'finding', ...finding })
    this.events.append(finding.session, 'finding', { findingId: finding.id, title: finding.title, feltSeverity: finding.feltSeverity })
    return finding
  }

  /**
   * Records that a session ran into a reported problem or a known issue. Once per session and
   * problem; a session's own report needs no confirmation.
   */
  vote(id: string, session: string, evidence: Omit<Vote, 'session' | 't'>): { id: string; title: string; known: boolean; counted: boolean } | undefined {
    const target = this.lookup(id)
    if (!target) return undefined
    const votes = target.known ? this.hitFor(target.id, target.title).votes : (this.get(target.id) as Finding).votes
    if (target.session === session || votes.some((vote) => vote.session === session)) return { ...target, counted: false }
    const vote: Vote = { session, t: nowIso(), ...evidence }
    votes.push(vote)
    this.writer.write({ type: 'vote', findingId: target.id, ...(target.known ? { known: true, title: target.title } : {}), ...vote })
    this.events.append(session, 'vote', { findingId: target.id, note: vote.note, ...(target.known ? { known: true } : {}) })
    return { ...target, counted: true }
  }

  private hitFor(id: string, title: string): KnownIssueHit {
    let hit = this.knownHits.get(id)
    if (!hit) {
      hit = { id, title, votes: [] }
      this.knownHits.set(id, hit)
    }
    return hit
  }

  async close(): Promise<void> {
    await this.writer.close()
  }
}
