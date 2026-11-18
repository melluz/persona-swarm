import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ExportContext,
  type Exporter,
  type ExporterConfig,
  type ExporterFactory,
  type ExportItem,
  type ExportOutcome,
  readJsonFile,
  runCommand,
  type Severity,
  withFileLock,
  writeFileAtomic,
} from '@persona-swarm/core'
import { loadRun } from './load.js'
import { currentTriage } from './triage.js'

/** The issue body every tracker exporter uses (Markdown). */
export function issueBody(item: ExportItem): string {
  const { finding } = item
  const lines = [
    `**Reported by** ${finding.session} (${finding.source}) · **Severity** ${item.severity} · **Votes** ${item.votes}`,
    '',
    '### What they did',
    finding.whatIDid,
    '',
    '### Expected',
    finding.expected,
    '',
    '### What happened',
    finding.actual,
    '',
    `**Page:** ${finding.url || 'n/a'}`,
  ]
  if (finding.evidence.signals.length) lines.push('', '### Signals', ...finding.evidence.signals.map((signal) => `- \`${signal.slice(0, 300)}\``))
  if (item.flags.length) lines.push('', `**Triage flags:** ${item.flags.join(', ')}`)
  if (item.review?.note) lines.push('', `**Reviewer note:** ${item.review.note}`)
  lines.push('', `_From persona-swarm run ${item.runId}, finding ${finding.id}${item.screenshotFile ? `; screenshot: ${item.screenshotFile}` : ''}._`)
  return lines.join('\n')
}

const settingString = (settings: Record<string, unknown>, key: string, fallback?: string): string => {
  const value = settings[key] ?? fallback
  if (typeof value !== 'string' || !value) throw new Error(`exporter setting "${key}" is required`)
  return value
}

/** Where a request went, without its path or query: webhook URLs are often secrets themselves. */
const where = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return 'the endpoint'
  }
}

/** Errors before a connection was made: the request never left, so it can be sent again. */
const NEVER_SENT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_INVALID_URL|certificate|bad port/i

/**
 * POSTs JSON. Any 2xx is success; the answer is parsed only when it says it is JSON. A request that
 * may have arrived without an answer coming back (a timeout, a dropped connection) says so in its
 * error ("may have arrived"), so the export does not send it again.
 */
async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    // fetch says only "fetch failed": the reason is in its cause.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const reason = [(error as Error).message, cause?.code, cause?.message].filter(Boolean).join(': ')
    if (NEVER_SENT.test(reason)) throw new Error(`${where(url)} could not be reached (${reason})`)
    throw new Error(`no answer from ${where(url)}: it may have arrived (${reason})`)
  }
  const text = await response.text()
  // A gateway that gave up waiting (408, 504, 524) may have passed the request on.
  if (!response.ok)
    throw new Error(
      `${where(url)} answered ${response.status}${[408, 504, 524].includes(response.status) ? ' (it may have arrived)' : ''}: ${text.slice(0, 300)}`,
    )
  let data: Record<string, unknown> = {}
  if (text && /json/i.test(response.headers.get('content-type') ?? ''))
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      // A 2xx with a broken body still delivered the finding.
    }
  return { status: response.status, data }
}

/** Where a file exporter writes: `with.file` relative to the cohort's folder, else a file in the run folder. */
const exportFile = (settings: Record<string, unknown>, context: ExportContext, fallback: string): string =>
  settings.file ? resolveIn(context.baseDir, String(settings.file)) : join(context.runDir, fallback)

/** Keeps every finding exported to the file so far, replacing earlier versions of the same one. */
const jsonExporter: ExporterFactory = (settings) => ({
  type: 'json',
  async export(items, context) {
    const file = exportFile(settings, context, 'export.json')
    if (!context.dryRun)
      // One file may collect several runs (exported at the same time from different processes): a finding is its run id and its own id.
      await withFileLock(file, async () => {
        const earlier = await readJsonFile<ExportItem[]>(file, [])
        const key = (item: ExportItem) => `${item.runId}/${item.finding?.id}`
        const replaced = new Set(items.map(key))
        await writeFileAtomic(file, `${JSON.stringify([...earlier.filter((item) => !replaced.has(key(item))), ...items], null, 2)}\n`)
      })
    return items.map((item) => ({ findingId: item.finding.id, ok: true, externalId: `${basename(file)}#${item.finding.id}` }))
  },
})

/** Appends each exported finding to one Markdown file. */
const markdownExporter: ExporterFactory = (settings) => ({
  type: 'markdown',
  async export(items, context) {
    const file = exportFile(settings, context, 'export.md')
    if (!context.dryRun) {
      const head = existsSync(file) ? '' : `# Findings from run ${items[0]?.runId ?? ''}\n\n`
      const body = items.map((item) => `## ${item.finding.id}: ${item.finding.title}\n\n${issueBody(item)}\n\n---\n\n`).join('')
      await appendFile(file, `${head}${body}`)
    }
    return items.map((item) => ({ findingId: item.finding.id, ok: true, externalId: `${basename(file)}#${item.finding.id}` }))
  },
})

/** The URL comes from `url`, or from the environment variable named by `urlEnv` (keeps a secret URL out of files). */
const webhookExporter: ExporterFactory = (settings) => ({
  type: 'webhook',
  batch: Boolean(settings.batch),
  async export(items, context) {
    const url = settings.urlEnv ? context.secret(String(settings.urlEnv)) : settingString(settings, 'url')
    const headers: Record<string, string> = {}
    for (const [name, env] of Object.entries((settings.headerEnv as Record<string, string>) ?? {})) headers[name] = context.secret(env)
    if (settings.batch) {
      try {
        if (!context.dryRun) await postJson(url, { runId: items[0]?.runId, findings: items }, headers)
        return items.map((item) => ({ findingId: item.finding.id, ok: true, externalId: 'batch' }))
      } catch (error) {
        return items.map((item) => ({ findingId: item.finding.id, ok: false, error: (error as Error).message }))
      }
    }
    const outcomes: ExportOutcome[] = []
    for (const item of items) {
      try {
        const { status, data } = context.dryRun ? { status: 0, data: {} as Record<string, unknown> } : await postJson(url, item, headers)
        const link = typeof data.url === 'string' ? data.url : undefined
        // Never the webhook URL itself: it is often the secret.
        outcomes.push({ findingId: item.finding.id, ok: true, externalId: String(data.id ?? link ?? `sent (${status})`), ...(link ? { url: link } : {}) })
      } catch (error) {
        outcomes.push({ findingId: item.finding.id, ok: false, error: (error as Error).message })
      }
    }
    return outcomes
  },
})

const commandExporter: ExporterFactory = (settings) => ({
  type: 'command',
  async export(items, context) {
    const command = settings.command as string[] | undefined
    const timeoutMs = Number(settings.timeoutSec ?? 120) * 1000
    if (!Array.isArray(command) || !command.length) throw new Error('exporter setting "command" must be an argv array')
    const outcomes: ExportOutcome[] = []
    for (const item of items) {
      if (context.dryRun) {
        outcomes.push({ findingId: item.finding.id, ok: true, externalId: 'dry-run' })
        continue
      }
      // A command that hangs must not hold the export (and its lock) for the rest of the process.
      const result = await runCommand(command, JSON.stringify(item), { timeoutMs, cwd: context.baseDir })
      outcomes.push(
        result.code === 0
          ? { findingId: item.finding.id, ok: true, externalId: result.out.trim().split('\n')[0] || 'ok' }
          : {
              findingId: item.finding.id,
              ok: false,
              // A command stopped by its timeout may have filed the finding already.
              error: result.timedOut ? `timed out after ${timeoutMs / 1000} s: it may have arrived` : result.err.trim().slice(0, 300) || `exit ${result.code}`,
            },
      )
    }
    return outcomes
  },
})

const LABELS: Record<Severity, string> = { blocker: 'severity: blocker', major: 'severity: major', minor: 'severity: minor', cosmetic: 'severity: cosmetic' }

/**
 * Text written by personas must not ping people or link issues: "@admin" would notify a real user and
 * "#3" cross-reference issue 3. A zero-width space keeps them readable and inert.
 */
export function defang(text: string): string {
  return text.replace(/@(?=[\w-])/g, '@\u200b').replace(/#(?=\d)/g, '#\u200b')
}

const githubExporter: ExporterFactory = (settings) => ({
  type: 'github',
  async export(items, context) {
    const repo = settingString(settings, 'repo')
    const token = context.secret(String(settings.tokenEnv ?? 'GITHUB_TOKEN'))
    const api = String(settings.apiUrl ?? 'https://api.github.com')
    const extra = (settings.labels as string[] | undefined) ?? ['persona-swarm']
    const outcomes: ExportOutcome[] = []
    for (const item of items) {
      try {
        const body = { title: defang(item.finding.title), body: defang(issueBody(item)), labels: [...extra, LABELS[item.severity]] }
        const answer = context.dryRun
          ? { number: 0, html_url: 'dry-run' }
          : ((await postJson(`${api}/repos/${repo}/issues`, body, { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' })).data as {
              number: number
              html_url: string
            })
        outcomes.push({ findingId: item.finding.id, ok: true, externalId: `${repo}#${answer.number}`, url: answer.html_url })
      } catch (error) {
        outcomes.push({ findingId: item.finding.id, ok: false, error: (error as Error).message })
      }
    }
    return outcomes
  },
})

const PRIORITY: Record<Severity, number> = { blocker: 1, major: 2, minor: 3, cosmetic: 4 }

const linearExporter: ExporterFactory = (settings) => ({
  type: 'linear',
  async export(items, context) {
    const teamId = settingString(settings, 'teamId')
    const key = context.secret(String(settings.tokenEnv ?? 'LINEAR_API_KEY'))
    const outcomes: ExportOutcome[] = []
    for (const item of items) {
      try {
        const query = 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }'
        const input = {
          teamId,
          title: item.finding.title,
          description: issueBody(item),
          priority: PRIORITY[item.severity],
          ...(settings.labelIds ? { labelIds: settings.labelIds } : {}),
        }
        const answer = context.dryRun
          ? { data: { issueCreate: { success: true, issue: { identifier: 'DRY-0', url: 'dry-run' } } } }
          : ((await postJson('https://api.linear.app/graphql', { query, variables: { input } }, { authorization: key })).data as {
              data?: { issueCreate?: { success: boolean; issue?: { identifier: string; url: string } } }
              errors?: { message: string }[]
            })
        if (!('data' in answer) || !answer.data?.issueCreate?.success)
          throw new Error((answer as { errors?: { message: string }[] }).errors?.map((error) => error.message).join('; ') ?? 'issueCreate failed')
        const issue = answer.data.issueCreate.issue
        outcomes.push({ findingId: item.finding.id, ok: true, externalId: issue?.identifier ?? 'created', ...(issue?.url ? { url: issue.url } : {}) })
      } catch (error) {
        outcomes.push({ findingId: item.finding.id, ok: false, error: (error as Error).message })
      }
    }
    return outcomes
  },
})

const jiraExporter: ExporterFactory = (settings) => ({
  type: 'jira',
  async export(items, context) {
    const baseUrl = settingString(settings, 'baseUrl').replace(/\/$/, '')
    const project = settingString(settings, 'project')
    const email = context.secret(String(settings.emailEnv ?? 'JIRA_EMAIL'))
    const token = context.secret(String(settings.tokenEnv ?? 'JIRA_API_TOKEN'))
    const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    const outcomes: ExportOutcome[] = []
    for (const item of items) {
      try {
        const description = {
          type: 'doc',
          version: 1,
          content: issueBody(item)
            .split('\n\n')
            .map((paragraph) => ({ type: 'paragraph', content: [{ type: 'text', text: paragraph.replace(/[*#_`]/g, '') || ' ' }] })),
        }
        const fields = {
          project: { key: project },
          summary: item.finding.title.slice(0, 250),
          issuetype: { name: String(settings.issueType ?? 'Bug') },
          description,
          labels: ['persona-swarm', `severity-${item.severity}`],
        }
        const answer = context.dryRun
          ? { key: 'DRY-0' }
          : ((await postJson(`${baseUrl}/rest/api/3/issue`, { fields }, { authorization: auth })).data as { key: string })
        outcomes.push({ findingId: item.finding.id, ok: true, externalId: answer.key, url: `${baseUrl}/browse/${answer.key}` })
      } catch (error) {
        outcomes.push({ findingId: item.finding.id, ok: false, error: (error as Error).message })
      }
    }
    return outcomes
  },
})

export const BUILT_IN_EXPORTERS: Record<string, ExporterFactory> = {
  json: jsonExporter,
  markdown: markdownExporter,
  webhook: webhookExporter,
  command: commandExporter,
  github: githubExporter,
  linear: linearExporter,
  jira: jiraExporter,
}

function resolveIn(dir: string, file: string): string {
  return isAbsolute(file) ? file : join(dir, file)
}

/** An exporter by type: a built-in, or `type: module` with `with.path` to a module exporting a factory. */
export async function createExporter(config: ExporterConfig, baseDir: string): Promise<Exporter> {
  if (config.type === 'module') {
    const path = resolve(baseDir, settingString(config.with, 'path'))
    if (!existsSync(path)) throw new Error(`exporter module ${path} not found`)
    const loaded = (await import(pathToFileURL(path).href)) as { default?: ExporterFactory }
    if (typeof loaded.default !== 'function') throw new Error(`${path} must export a default function (settings) => Exporter`)
    return loaded.default(config.with)
  }
  const factory = BUILT_IN_EXPORTERS[config.type]
  if (!factory) throw new Error(`unknown exporter "${config.type}"; built-ins: ${Object.keys(BUILT_IN_EXPORTERS).join(', ')}, or "module"`)
  return factory(config.with)
}

export interface ExportRunResult {
  exporter: string
  outcomes: ExportOutcome[]
  /** Findings that would have gone but were held back, and why (a reviewer may want to know). */
  skipped: { findingId: string; reason: string }[]
}

/**
 * Exports a run's findings through the given exporters. Approved findings by default; never a
 * finding the triage marked as a harness artefact, never one already exported by the same exporter.
 */
/** Exporter ids: an explicit `id`, else the type. Two exporters must not share one (their records would mix). */
export function exporterIds(configs: ExporterConfig[]): string[] {
  const ids = configs.map((config) => config.id ?? config.type)
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (repeated.length) throw new Error(`exporters share the id "${repeated[0]}": give each one its own id`)
  return ids
}

/** Marks a finding that was being sent when the export was interrupted: it may or may not have arrived. */
const PENDING = 'pending:'

/** A failure after the request went out (a timeout, a dropped connection): the tracker may have filed it. */
const UNSURE = /may have arrived|timeout|timed out|aborted|socket hang up|ECONNRESET|EPIPE|terminated/i

export async function exportRun(
  runDir: string,
  configs: ExporterConfig[],
  options: { dryRun?: boolean; baseDir?: string; log?: (message: string) => void; retryUnsure?: boolean } = {},
): Promise<ExportRunResult[]> {
  const ids = exporterIds(configs)
  const run = await loadRun(runDir)
  const exportsFile = join(run.dir, 'exports.json')
  // One export of a run at a time, across processes (a double click, the UI and the CLI at once).
  return withFileLock(
    exportsFile,
    async () => {
      // Flags decide what may leave: triage again unless triage.json covers every report as it is now.
      const triage = await currentTriage(run.dir, { write: false })
      const done = await readJsonFile<Record<string, Record<string, string>>>(exportsFile, {})
      const save = () => writeFileAtomic(exportsFile, `${JSON.stringify(done, null, 2)}\n`)
      /** Before sending: marked as on its way, so an interruption leaves "may be filed", never "not sent". */
      const mark = async (id: string, batch: ExportItem[]) => {
        if (options.dryRun) return
        done[id] ??= {}
        const records = done[id]
        for (const item of batch) records[item.finding.id] = `${PENDING}${new Date().toISOString()}`
        await save()
      }
      const record = async (id: string, outcomes: ExportOutcome[]) => {
        if (options.dryRun) return
        done[id] ??= {}
        const records = done[id]
        // Every success is recorded, with or without an id to show for it: it must never be sent again.
        // A failure that may still have arrived stays marked; a plain refusal can be sent again.
        for (const outcome of outcomes)
          if (outcome.ok) records[outcome.findingId] = outcome.externalId ?? 'sent'
          else if (!UNSURE.test(outcome.error ?? '')) delete records[outcome.findingId]
        await save()
      }
      const context: ExportContext = {
        runId: run.state.runId,
        runDir: run.dir,
        baseDir: options.baseDir ?? run.dir,
        dryRun: Boolean(options.dryRun),
        log: options.log ?? (() => {}),
        secret: (name) => {
          const value = process.env[name]
          if (!value) throw new Error(`environment variable ${name} is not set`)
          return value
        },
      }
      const results: ExportRunResult[] = []
      for (const [index, config] of configs.entries()) {
        const id = ids[index] as string
        const exporter = await createExporter(config, options.baseDir ?? run.dir)
        const skipped: ExportRunResult['skipped'] = []
        const items: ExportItem[] = run.findings
          .filter((finding) => {
            const review = run.reviews[finding.id]
            const flags = triage.findings[finding.id]?.flags ?? []
            const earlier = done[id]?.[finding.id]
            if (review?.status === 'rejected' || review?.status === 'duplicate') return false
            if (!(config.only === 'all' || review?.status === 'approved')) return false
            if (earlier && !earlier.startsWith(PENDING)) return false
            if (earlier && !options.retryUnsure) {
              skipped.push({
                findingId: finding.id,
                reason: 'an earlier export was interrupted while sending it: it may already be filed. Check, then export with --retry-unsure to send it again',
              })
              return false
            }
            if (flags.includes('harness-suspect')) {
              skipped.push({ findingId: finding.id, reason: 'harness-suspect: the actions just before it failed in the test harness' })
              return false
            }
            return true
          })
          .map((finding) => {
            const review = run.reviews[finding.id]
            const triaged = triage.findings[finding.id]
            const suggested = triaged?.suggestedSeverity
            const severity: Severity = review?.severity ?? (suggested && !['harness', 'environment'].includes(suggested) ? (suggested as Severity) : 'minor')
            return {
              finding,
              ...(review ? { review } : {}),
              severity,
              votes: finding.votes.length,
              flags: triaged?.flags ?? [],
              ...(finding.evidence.screenshot ? { screenshotFile: join(run.dir, finding.evidence.screenshot) } : {}),
              runId: run.state.runId,
              targetName: run.state.target.name,
            }
          })
        const outcomes: ExportOutcome[] = []
        // Each success is recorded before the next item goes out: an interrupted export resumes, never repeats.
        for (const batch of exporter.batch ? [items] : items.map((item) => [item])) {
          if (!batch.length) continue
          await mark(id, batch)
          const sent = await exporter
            .export(batch, context)
            .catch((error: Error) => batch.map((item) => ({ findingId: item.finding.id, ok: false, error: error.message })))
          outcomes.push(...sent)
          await record(id, sent)
        }
        results.push({ exporter: id, outcomes, skipped })
      }
      return results
    },
    { timeoutMs: 2_000 },
  )
}
