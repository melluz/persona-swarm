import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type Grouping, type GroupingConfig, type ModelPrice, readJsonFile, runCommand, writeFileAtomic } from '@persona-swarm/core'
import {
  answerFormat,
  extractJson,
  GROUP_TOOL,
  GROUPING_INSTRUCTIONS,
  type GroupingRequest,
  groupingBrief,
  groupingListing,
  groupingRequest,
  loadRun,
  parseGroupingAnswer,
  saveGrouping,
} from '@persona-swarm/findings'

export interface GroupingContext {
  /** The workspace's providers, for `provider:model` names it defines. */
  providers?: Record<string, unknown>
  /** USD per million tokens, by model. */
  prices?: Record<string, ModelPrice>
  signal?: AbortSignal
}

export interface GroupingOutcome {
  grouping: Grouping
  /** What the grouper said that could not be used. */
  problems: string[]
}

/** The run's request, or why there is nothing to group. */
async function requestFor(runDir: string): Promise<GroupingRequest | string> {
  const run = await loadRun(runDir)
  if (!run.findings.length) return 'no reports to group'
  if (run.findings.length === 1 && !run.knownIssues.length) return 'one report and no known issues: nothing to group'
  return groupingRequest(run)
}

/**
 * Checks and stores an answer. One that cannot be used (no list of groups, or not one usable group)
 * is refused and the run's earlier grouping stays as it was; an empty list means "no duplicates".
 */
async function finish(runDir: string, request: GroupingRequest, raw: unknown, by: string, extra: Partial<Grouping> = {}): Promise<GroupingOutcome> {
  const { groups, problems, listed, alone } = parseGroupingAnswer(raw, request)
  if (listed < 0) throw new Error(`${by}'s answer has no list of groups (expected {"groups": [...]})`)
  // Every report on its own (an agent listing each one) means what an empty list means: no duplicates.
  if (listed > 0 && !groups.length && alone < listed)
    throw new Error(`none of the ${listed} group(s) in ${by}'s answer could be used: ${problems.join('; ') || 'no group has two reports'}`)
  const grouping: Grouping = { version: 1, by, t: new Date().toISOString(), covered: request.reports.map((report) => report.id), groups, ...extra }
  await saveGrouping(runDir, grouping)
  return { grouping, problems }
}

/** A short name for a command: its program and first argument (`claude -p`). */
const commandName = (command: string[]) => [basename(command[0] ?? 'command'), ...command.slice(1, 2)].join(' ')

/**
 * Groups a run's reports with a model (through the AI SDK, any provider) or an agent's command line
 * (the task on its stdin, the answer on its stdout), and stores the result for triage.
 */
export async function groupRun(runDir: string, config: GroupingConfig, context: GroupingContext = {}): Promise<GroupingOutcome | { skipped: string }> {
  const request = await requestFor(runDir)
  if (typeof request === 'string') return { skipped: request }
  if (config.model) {
    const timeout = AbortSignal.timeout(config.timeoutSec * 1000)
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
    // Loaded only when a model groups: the AI SDK is heavy for the CLI's other commands.
    const { answerWithTool } = await import('@persona-swarm/driver-ai-sdk')
    const price = context.prices?.[config.model]
    const answer = await answerWithTool({
      model: config.model,
      options: { ...(context.providers ? { providers: context.providers } : {}), ...(price ? { price } : {}) },
      instructions: GROUPING_INSTRUCTIONS,
      prompt: `${groupingListing(request)}\n\n${answerFormat({ kind: 'tool' })}`,
      tool: { name: GROUP_TOOL.name, description: GROUP_TOOL.description, inputSchema: GROUP_TOOL.inputSchema as unknown as Record<string, unknown> },
      signal,
    })
    const raw = answer.input ?? extractJson(answer.text)
    if (raw === undefined) throw new Error(`${config.model} answered without groups: ${answer.text.slice(0, 200) || '(no text)'}`)
    return finish(runDir, request, raw, config.model, { usage: answer.usage, ...(answer.costUsd !== undefined ? { costUsd: answer.costUsd } : {}) })
  }
  const command = config.command as string[]
  // runCommand keeps its own time limit (and says it timed out); only a stop is passed on.
  const result = await runCommand(command, groupingBrief(request, { kind: 'json' }), {
    timeoutMs: config.timeoutSec * 1000,
    cwd: runDir,
    ...(context.signal ? { signal: context.signal } : {}),
  })
  if (result.code !== 0)
    throw new Error(
      `${commandName(command)} failed (${result.timedOut ? 'timed out' : `exit ${result.code}`}): ${result.err.trim().slice(0, 300) || '(no output)'}`,
    )
  const raw = extractJson(result.out)
  if (raw === undefined) throw new Error(`${commandName(command)} printed no JSON answer: ${result.out.trim().slice(0, 200) || '(nothing)'}`)
  return finish(runDir, request, raw, commandName(command))
}

/**
 * Writes the task for an outside agent (`grouping/brief.md` in the run folder). The agent writes its
 * answer to `grouping/answer.json` and hands it back with `answerCommand`.
 */
export async function writeGroupingBrief(
  runDir: string,
  answerCommand: (answerFile: string) => string,
): Promise<{ file: string; answerFile: string; reports: number; knownIssues: number } | { skipped: string }> {
  const request = await requestFor(runDir)
  if (typeof request === 'string') return { skipped: request }
  const dir = join(runDir, 'grouping')
  const answerFile = join(dir, 'answer.json')
  const file = join(dir, 'brief.md')
  // The answer is checked against what the agent was shown, not against reports filed since.
  await writeFileAtomic(join(dir, 'request.json'), JSON.stringify(request))
  await writeFileAtomic(file, groupingBrief(request, { kind: 'file', file: answerFile, command: answerCommand(answerFile) }))
  return { file, answerFile, reports: request.reports.length, knownIssues: request.knownIssues.length }
}

/** Applies an outside agent's answer (a JSON file, or text with the JSON in it). */
export async function applyGroupingAnswer(runDir: string, answerFile: string, by: string): Promise<GroupingOutcome | { skipped: string }> {
  const request = (await readJsonFile<GroupingRequest | undefined>(join(runDir, 'grouping', 'request.json'), undefined)) ?? (await requestFor(runDir))
  if (typeof request === 'string') return { skipped: request }
  const text = await readFile(answerFile, 'utf8')
  const raw = extractJson(text)
  if (raw === undefined) throw new Error(`${answerFile} holds no JSON answer (expected {"groups": [...]})`)
  return finish(runDir, request, raw, by)
}
