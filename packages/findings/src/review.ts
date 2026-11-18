import { join } from 'node:path'
import { type Finding, type Review, ReviewStatus, readJsonFile, type Severity, withFileLock, writeFileAtomic } from '@persona-swarm/core'
import { loadRun } from './load.js'

let queue: Promise<unknown> = Promise.resolve()

/**
 * Records a review decision. Serialised in this process and locked across processes (the run, the UI
 * server, the CLI), so concurrent reviews never lose an update.
 */
export function setReview(
  runDir: string,
  findingId: string,
  /** A decision without a severity keeps the reviewer's earlier one; `severity: null` clears it. */
  decision: { status: ReviewStatus; severity?: Severity | null; note?: string; duplicateOf?: string; by?: string },
): Promise<Review> {
  const file = join(runDir, 'review.json')
  const next = queue.then(() =>
    withFileLock(file, async () => {
      const reviews = await readJsonFile<Record<string, Review>>(file, {})
      const previous = reviews[findingId]
      const review: Review = {
        status: ReviewStatus.parse(decision.status),
        ...(decision.severity === null
          ? {}
          : decision.severity || previous?.severity
            ? { severity: (decision.severity ?? previous?.severity) as Severity }
            : {}),
        note: decision.note ?? previous?.note ?? '',
        ...(decision.duplicateOf ? { duplicateOf: decision.duplicateOf } : {}),
        t: new Date().toISOString(),
        by: decision.by ?? 'human',
        exported: previous?.exported ?? {},
        ...(previous?.apartFrom?.length ? { apartFrom: previous.apartFrom } : {}),
      }
      reviews[findingId] = review
      await writeFileAtomic(file, `${JSON.stringify(reviews, null, 2)}\n`)
      return review
    }),
  )
  queue = next.catch(() => {})
  return next
}

/**
 * Records a reviewer's "these are different problems" for two reports (or a report and a known issue):
 * triage never groups them again, whoever joined them (wording, a grouping model or agent). Both
 * reports keep the judgement; a report without a review yet gets one, still `new`.
 */
export async function setApart(runDir: string, a: string, b: string, by = 'human'): Promise<Record<string, Review>> {
  const file = join(runDir, 'review.json')
  const [first, second] = [a.trim().toUpperCase(), b.trim().toUpperCase()]
  const run = await loadRun(runDir)
  const known = (id: string) => run.findings.some((finding) => finding.id === id) || run.knownIssues.some((issue) => issue.id.toUpperCase() === id)
  if (!run.findings.some((finding) => finding.id === first)) throw new Error(`${first} is not a report of this run`)
  if (first === second || !known(second)) throw new Error(`${second} is not another report or a known issue of this run`)
  const next = queue.then(() =>
    withFileLock(file, async () => {
      const reviews = await readJsonFile<Record<string, Review>>(file, {})
      for (const [id, other] of [
        [first, second],
        [second, first],
      ] as const) {
        // A known issue (K-…) has no review of its own: the report carries the judgement.
        if (id.startsWith('K-')) continue
        const review: Review = reviews[id] ?? { status: 'new', note: '', t: new Date().toISOString(), by, exported: {} }
        review.apartFrom = [...new Set([...(review.apartFrom ?? []), other])]
        reviews[id] = review
      }
      await writeFileAtomic(file, `${JSON.stringify(reviews, null, 2)}\n`)
      return reviews
    }),
  )
  queue = next.catch(() => {})
  return next
}

/** A report with what its tester and its reviewers judged different merged: the pairs triage keeps apart. */
export function withJudgements(finding: Finding, review: Review | undefined): Finding {
  if (!review?.apartFrom?.length) return finding
  return { ...finding, notSameAs: [...new Set([...(finding.notSameAs ?? []), ...review.apartFrom])] }
}
