import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREE_TOOLS, withFileLock } from '@persona-swarm/core'
import { connectPersonaTools, type DriverDefinition, type PersonaTool, type SessionContext, type SessionSpec } from '@persona-swarm/driver-kit'

export interface BridgeSession {
  sessionId: string
  runDir: string
  mcp: { url: string; headers: Record<string, string> }
  instructions: string
  kickoff: string
  deadline: string
  maxTurns: number
  tools: PersonaTool[]
}

export function bridgeDir(runDir: string): string {
  return join(runDir, 'bridge')
}

export function bridgeFiles(runDir: string, sessionId: string) {
  const dir = bridgeDir(runDir)
  return {
    session: join(dir, `${sessionId}.json`),
    brief: join(dir, `${sessionId}.md`),
    calls: join(dir, `${sessionId}.calls`),
    done: join(dir, `${sessionId}.done`),
    /** Messages from the test (a time warning, no actions left), shown with the agent's next action. */
    notices: join(dir, `${sessionId}.notices`),
    images: dir,
  }
}

interface ArgSchema {
  type?: string
  enum?: string[]
  minimum?: number
  maximum?: number
  items?: { type?: string }
  description?: string
}

/** One argument as an agent needs to know it: its type or choices, and its limits. */
function describeArg(name: string, schema: ArgSchema, required: boolean): string {
  let type = schema.enum ? schema.enum.join('|') : schema.type === 'array' ? `${schema.items?.type ?? 'value'}[]` : (schema.type ?? 'value')
  if (schema.minimum !== undefined && schema.maximum !== undefined) type += ` ${schema.minimum}–${schema.maximum}`
  else if (schema.minimum !== undefined) type += ` ≥ ${schema.minimum}`
  else if (schema.maximum !== undefined) type += ` ≤ ${schema.maximum}`
  return `${name}${required ? '' : '?'}: ${type}`
}

function describeArgs(tool: PersonaTool): string {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, ArgSchema>
  const required = new Set((tool.inputSchema.required as string[] | undefined) ?? [])
  const args = Object.entries(properties).map(([name, schema]) => describeArg(name, schema, required.has(name)))
  return args.length ? `{ ${args.join(', ')} }` : '{}'
}

/** The brief an external agent (or a person) reads before playing the persona. */
export function renderBrief(session: BridgeSession, cli: string): string {
  const file = bridgeFiles(session.runDir, session.sessionId).session
  return `${session.instructions}

---

${session.kickoff}

## How you act

You act only through this command (run it from any directory):

    ${cli} act ${file} <tool> '<JSON arguments>'

For example: \`${cli} act ${file} screenshot '{}'\`. Each call prints what happened and where you are. A
screenshot is saved as an image file whose path is printed: open (read) that file to see the screen.
Every step in the app is one action; looking (screenshot, outline, find_text), notes, reports and finish
are free. Each reply carries a status line that counts down your time and your actions. Your session ends when you call
finish; it also ends when your time runs out (at ${session.deadline} UTC at the latest), and two minutes
after your last action is spent (enough to report what you found and finish).

## Your tools

${session.tools.map((tool) => `- **${tool.name}** ${describeArgs(tool)}: ${tool.description}`).join('\n')}
`
}

/**
 * A driver that hands the session to an agent outside the framework: any agent that can run a shell
 * command (or a person) plays the persona through `persona-swarm act`. Identity, tool profiles and
 * logging are enforced by the same per-session MCP endpoint as for every other driver.
 */
export const externalDriver: DriverDefinition = {
  name: 'external',
  version: '0.1.0',
  capabilities: () => ({
    imageInput: true,
    contextWindow: 1_000_000,
    toolCalling: true,
    // Whatever the outside agent spends is outside this run's accounting.
    usesModel: false,
    notes: 'played by an external agent through persona-swarm act',
  }),
  async runSession(spec: SessionSpec, context: SessionContext) {
    const runDir = process.env.PERSONA_SWARM_RUN_DIR
    if (!runDir) throw new Error('PERSONA_SWARM_RUN_DIR is not set; the external driver must be started by persona-swarm')
    const files = bridgeFiles(runDir, spec.sessionId)
    mkdirSync(bridgeDir(runDir), { recursive: true })
    const tools = await connectPersonaTools(spec.mcp)
    const listed = tools.tools
    await tools.close()
    const session: BridgeSession = {
      sessionId: spec.sessionId,
      runDir,
      mcp: spec.mcp,
      instructions: spec.instructions,
      kickoff: spec.kickoff,
      deadline: new Date(Date.now() + spec.budget.maxSeconds * 1000).toISOString(),
      maxTurns: spec.budget.maxTurns,
      tools: listed,
    }
    // A resumed session starts afresh: the end marker of an earlier attempt goes, and only calls from now count.
    rmSync(files.done, { force: true })
    // Looking and speaking up are free; every step in the app is an action.
    const countCalls = () =>
      existsSync(files.calls)
        ? readFileSync(files.calls, 'utf8')
            .split('\n')
            .filter((line) => line && !FREE_TOOLS.has(line.split(' ')[1] ?? '')).length
        : 0
    const baseline = countCalls()
    // The session file carries the endpoint token and the brief the account: readable by their owner only.
    writePrivate(files.session, JSON.stringify(session, null, 2))
    writePrivate(files.brief, renderBrief(session, String(spec.options.cli ?? 'persona-swarm')))
    context.emit({ type: 'log', level: 'info', message: `waiting for an external agent: brief at ${files.brief}` })

    // Tells a late \`act\` why the session is over (finish writes its own summary).
    const over = (reason: string) => {
      if (!existsSync(files.done)) writePrivate(files.done, `Your session is over (${reason}).`)
    }
    let turns = 0
    let heard = Date.now()
    const deadline = Date.parse(session.deadline)
    rmSync(files.notices, { force: true })
    while (!context.signal.aborted) {
      if (existsSync(files.done)) return { stopReason: 'finished' as const, finalMessage: readFileSync(files.done, 'utf8'), turns }
      // What the test tells the persona (a time warning) reaches the agent with its next action.
      const notices = context.takeNotices()
      if (notices.length) appendFileSync(files.notices, `${notices.join('\n')}\n`, { mode: 0o600 })
      const calls = countCalls() - baseline
      if (calls !== turns) {
        turns = calls
        context.emit({ type: 'turn', n: turns })
      }
      if (turns >= spec.budget.maxTurns || Date.now() >= deadline) {
        over(turns >= spec.budget.maxTurns ? 'no actions left' : 'time is up')
        return { stopReason: 'budget' as const, finalMessage: '', turns }
      }
      // A person (or a slow agent) may think for minutes between actions: that is not a stall.
      if (Date.now() - heard > 30_000) {
        heard = Date.now()
        context.emit({ type: 'log', level: 'debug', message: 'waiting for the external agent' })
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
    }
    over('it was stopped')
    return { stopReason: 'cancelled' as const, finalMessage: '', turns }
  },
}

/** Creates (or replaces) a file only its owner can read: no moment where it is readable by others. */
function writePrivate(file: string, data: string): void {
  rmSync(file, { force: true })
  writeFileSync(file, data, { mode: 0o600 })
}

export interface ActResult {
  text: string
  images: string[]
  isError: boolean
  ended: boolean
}

/** One action by an external agent: calls a tool on the session's endpoint and saves any images. */
export async function bridgeAct(sessionFile: string, tool: string, args: Record<string, unknown>): Promise<ActResult> {
  const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as BridgeSession
  const files = bridgeFiles(session.runDir, session.sessionId)
  const ended = () => (existsSync(files.done) ? readFileSync(files.done, 'utf8').trim() || 'Your session is over.' : undefined)
  // One action at a time per session: a person's device does one thing at a time too.
  return withFileLock(sessionFile, () => act(session, files, tool, args, ended), { timeoutMs: 330_000, staleMs: 400_000 })
}

async function act(
  session: BridgeSession,
  files: ReturnType<typeof bridgeFiles>,
  tool: string,
  args: Record<string, unknown>,
  ended: () => string | undefined,
): Promise<ActResult> {
  const over = ended()
  if (over) return { text: over.startsWith('Your session is over') ? over : `Your session is over.`, images: [], isError: true, ended: true }
  if (Date.now() >= Date.parse(session.deadline) && tool !== 'finish')
    return { text: 'Your time is up: call finish now with your honest account.', images: [], isError: true, ended: false }
  const tools = await connectPersonaTools(session.mcp)
  try {
    appendFileSync(files.calls, `${new Date().toISOString()} ${tool}\n`)
    const result = await tools.call(tool, args)
    const images: string[] = []
    for (const [index, image] of result.images.entries()) {
      const file = join(files.images, `${session.sessionId}-${Date.now()}-${index}.${image.mimeType.includes('png') ? 'png' : 'jpg'}`)
      writeFileSync(file, Buffer.from(image.data, 'base64'))
      images.push(file)
    }
    const ended = tool === 'finish' && !result.isError
    if (ended) writeFileSync(files.done, result.text)
    // Notices waiting for the agent are shown once, after the result of this action. The file is moved
    // aside before it is read: a notice the driver adds meanwhile starts a new file, never lost.
    let notes = ''
    const taken = `${files.notices}.${process.pid}`
    try {
      renameSync(files.notices, taken)
      notes = readFileSync(taken, 'utf8').trim()
      rmSync(taken, { force: true })
    } catch {
      // No notices.
    }
    return { text: notes && !ended ? `${result.text}\n\n${notes}` : result.text, images, isError: result.isError, ended }
  } finally {
    await tools.close().catch(() => {})
  }
}
