import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DriverDefinition, onLines, type SessionContext, type SessionSpec } from '@persona-swarm/driver-kit'

const SERVER = 'persona'
const PREFIX = `mcp__${SERVER}__`
const NUDGE = 'Keep going as yourself: use the tools to continue what you came to do, or call finish if you are done.'

interface StreamMessage {
  type: string
  subtype?: string
  message?: {
    id?: string
    content?: { type: string; text?: string; name?: string; input?: unknown; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  }
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
  total_cost_usd?: number
  result?: string
  is_error?: boolean
}

/**
 * The argv for one headless, sandboxed persona session. The MCP config (it holds the session's
 * bearer token) is a file in the session's private folder, never an argument other users could see.
 */
export function claudeArgs(spec: SessionSpec, mcpConfigFile: string): string[] {
  const model = String(spec.options.model ?? spec.model)
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // No built-in tools at all: no shell, no files, no web. Only the persona's own MCP tools.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigFile,
    '--allowedTools',
    `mcp__${SERVER}`,
    '--setting-sources',
    'project',
    '--disable-slash-commands',
    '--no-session-persistence',
    // The system prompt carries no secrets: account details arrive in the first message, over stdin.
    '--system-prompt',
    spec.instructions,
    ...(spec.budget.maxUsd ? ['--max-budget-usd', String(spec.budget.maxUsd)] : []),
    ...(model && model !== 'default' ? ['--model', model] : []),
    ...(spec.options.effort ? ['--effort', String(spec.options.effort)] : []),
  ]
}

/** Writes the session's MCP config where only this user can read it. */
export function writeMcpConfig(dir: string, spec: SessionSpec): string {
  const file = join(dir, 'mcp.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: spec.mcp.url, headers: spec.mcp.headers } } }), { mode: 0o600 })
  return file
}

/**
 * The environment for the CLI. Started from a terminal or CI, it is passed through as is (including a
 * CLAUDE_CODE_OAUTH_TOKEN login). Started inside another Claude Code or Agent SDK session, that
 * session's variables (bare mode, host-managed auth, a host proxy URL) would make the child CLI use
 * credentials it cannot refresh, so they are dropped. `options.inheritEnv: true` keeps everything.
 */
export function cleanEnvironment(env: NodeJS.ProcessEnv, inherit = false): NodeJS.ProcessEnv {
  const nested = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH)
  if (inherit || !nested) return { ...env }
  const keep = new Set(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'])
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (keep.has(key)) out[key] = value
    else if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|USE_LOCAL_OAUTH$|USE_STAGING_OAUTH$)/.test(key)) continue
    else if (key === 'ANTHROPIC_BASE_URL') continue
    else out[key] = value
  }
  return out
}

/** API errors the CLI reports for a missing or expired login; checked on error results only, never on what the persona says. */
const AUTH_FAILURE = /API Error: 401|authentication_failed|OAuth access token has expired|Invalid API key|Please run \/login/i
const AUTH_HINT = 'Claude Code is not signed in or its login expired. Run `claude` in a terminal, sign in with /login, then retry.'

const userLine = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
/** Asks the CLI to stop the turn it is in; it then reports the turn's result (and its cost) before exiting. */
const interruptLine = () => `${JSON.stringify({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`

/** Session folders (each holds an MCP config with its bearer token): removed however the driver ends. */
const folders = new Set<string>()

export async function runSession(spec: SessionSpec, context: SessionContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'persona-swarm-claude-'))
  folders.add(cwd)
  const binary = String(spec.options.binary ?? process.env.PERSONA_SWARM_CLAUDE_BIN ?? 'claude')
  // In the driver's own process group: whoever stops the driver stops the CLI with it.
  const child = spawn(binary, claudeArgs(spec, writeMcpConfig(cwd, spec)), {
    cwd,
    env: { ...cleanEnvironment(process.env, spec.options.inheritEnv === true), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  running.add(child)
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }
  // USD per million tokens, when the run knows this model's price: each call is costed as it happens.
  const price = spec.options.price as { input: number; output: number; cachedInput?: number } | undefined
  // The CLI may send one line per content block of a model call, all with the same id and usage.
  const counted = new Set<string>()
  let lastCost = 0
  let costedThisTurn = 0
  let turns = 0
  let nudges = 0
  let finished = false
  let ended = false
  let lastText = ''
  let budgetHit = false
  let authError: string | undefined
  let toolCalls = 0
  /** The id of the finish call: the session is finished only once that call succeeded. */
  let finishCall: string | undefined
  let resultSeen = false
  const pendingTools = new Map<string, string>()

  // A closed pipe (the CLI exited) must not crash the driver.
  child.stdin.on('error', () => {})
  const send = (text: string) => {
    if (!ended && child.stdin.writable) child.stdin.write(userLine(text))
  }
  const end = () => {
    if (ended) return
    ended = true
    try {
      child.stdin.end()
    } catch {
      // Already closed.
    }
  }
  const kill = () => stopChild(child)
  /**
   * Ends the session mid-turn without losing the turn's cost: the CLI is asked to interrupt the turn and
   * report its result, and is killed only if it has not done so within a few seconds.
   */
  const stopTurn = () => {
    if (!ended && child.stdin.writable) child.stdin.write(interruptLine())
    end()
    const waitedFor = setTimeout(kill, 5_000)
    waitedFor.unref()
    child.once('exit', () => clearTimeout(waitedFor))
  }
  const onAbort = () => stopTurn()
  context.signal.addEventListener('abort', onAbort, { once: true })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => context.log(chunk.trim().slice(0, 500)))

  onLines(child.stdout, (line) => {
    if (ended && !line.includes('"result"')) return
    let message: StreamMessage
    try {
      message = JSON.parse(line) as StreamMessage
    } catch {
      return
    }
    if (message.type === 'assistant') {
      const callId = message.message?.id
      const firstLine = !callId || !counted.has(callId)
      if (callId) counted.add(callId)
      if (firstLine) {
        turns += 1
        context.emit({ type: 'turn', n: turns })
        // Tokens as each model call happens, so the run's spend is visible (and capped) during long turns.
        const usage = message.message?.usage
        if (usage) {
          const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
          const outputTokens = usage.output_tokens ?? 0
          const cachedInputTokens = usage.cache_read_input_tokens ?? 0
          // Without a price the call costs 0 here (not "unknown", which the run would price again); the CLI's
          // own cost for the turn arrives with its result, which an interrupted turn still reports.
          const costUsd = price
            ? (inputTokens * price.input + cachedInputTokens * (price.cachedInput ?? price.input) + outputTokens * price.output) / 1_000_000
            : 0
          costedThisTurn += costUsd
          context.emit({ type: 'usage', inputTokens, outputTokens, cachedInputTokens, costUsd })
        }
      }
      if (ended) return
      for (const part of message.message?.content ?? []) {
        if (part.type === 'text' && part.text?.trim()) {
          lastText = part.text
          context.emit({ type: 'assistant', text: part.text })
        } else if (part.type === 'tool_use') {
          const name = (part.name ?? '').replace(PREFIX, '')
          pendingTools.set(part.id ?? '', name)
          toolCalls += 1
          // A persona that acts is going on: only turns ended in a row without acting use up the nudges.
          nudges = 0
          context.emit({ type: 'tool_call', name, input: part.input, callId: part.id ?? '' })
          if (name === 'finish') finishCall = part.id ?? ''
        }
      }
      if (turns >= spec.budget.maxTurns) {
        budgetHit = true
        stopTurn()
      }
    } else if (message.type === 'user') {
      for (const part of message.message?.content ?? [])
        if (part.type === 'tool_result') {
          const summary = Array.isArray(part.content)
            ? (part.content as { type: string; text?: string }[]).map((item) => item.text ?? `[${item.type}]`).join(' ')
            : String(part.content ?? '')
          context.emit({
            type: 'tool_result',
            name: pendingTools.get(part.tool_use_id ?? '') ?? 'tool',
            callId: part.tool_use_id ?? '',
            ok: !part.is_error,
            summary: summary.slice(0, 300),
          })
          // A finish call the tool refused (arguments out of range) did not end the session.
          if (finishCall !== undefined && part.tool_use_id === finishCall && !part.is_error) finished = true
        }
    } else if (message.type === 'result') {
      resultSeen = true
      // Tokens were counted per model call; the result adds the cost the CLI computed for them.
      const cost = Math.max(0, (message.total_cost_usd ?? lastCost) - lastCost)
      lastCost = message.total_cost_usd ?? lastCost
      totals.inputTokens += message.usage?.input_tokens ?? 0
      totals.outputTokens += message.usage?.output_tokens ?? 0
      totals.cachedInputTokens += message.usage?.cache_read_input_tokens ?? 0
      totals.costUsd += cost
      // The CLI's exact figure replaces this turn's estimate, up or down (an estimate prices cache reads at
      // the full input price unless the workspace gives a cache price).
      const correction = cost - costedThisTurn
      costedThisTurn = 0
      if (Math.abs(correction) > 1e-9) context.emit({ type: 'usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: correction })
      // A login failure comes before the persona has done anything; later, quoting an app's message is not one.
      if (message.is_error && (AUTH_FAILURE.test(message.result ?? '') || (!toolCalls && AUTH_FAILURE.test(lastText)))) {
        authError = AUTH_HINT
        context.log(authError)
        end()
        kill()
        return
      }
      // The CLI's own spend cap (--max-budget-usd): the session is out of budget, not stuck.
      if (message.subtype === 'error_max_budget_usd') {
        budgetHit = true
        return end()
      }
      if (ended || finished || context.signal.aborted || nudges >= 2) return end()
      const notices = context.takeNotices()
      nudges += 1
      send(notices.length ? `${notices.join('\n')}\n${NUDGE}` : NUDGE)
    }
    // Budget warnings and other notices go in between turns.
    if (message.type === 'user' && !ended) {
      const notices = context.takeNotices()
      if (notices.length) send(notices.join('\n'))
    }
  })

  send(spec.kickoff)
  // Closed, not just exited: the last lines (an interrupted turn's result) are read before the session ends.
  const code = await new Promise<number | null>((resolveExit) => {
    child.on('close', (exitCode) => resolveExit(exitCode))
    child.on('error', (error) => {
      context.log(`cannot start ${binary}: ${error.message}`)
      resolveExit(-1)
    })
  })
  running.delete(child)
  context.signal.removeEventListener('abort', onAbort)
  rmSync(cwd, { recursive: true, force: true })
  folders.delete(cwd)
  if (!resultSeen && turns > 0 && !price)
    context.log('the CLI ended before reporting the cost of its last turn; give this model a price in persona-swarm.yaml to count it anyway')
  const usage = { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, cachedInputTokens: totals.cachedInputTokens, costUsd: totals.costUsd }
  if (authError) return { stopReason: 'error' as const, finalMessage: '', turns, usage, error: authError }
  if (context.signal.aborted) return { stopReason: 'cancelled' as const, finalMessage: lastText, turns, usage }
  if (budgetHit) return { stopReason: 'budget' as const, finalMessage: `stopped after ${turns} turns`, turns, usage }
  if (finished) return { stopReason: 'finished' as const, finalMessage: lastText, turns, usage }
  if (code !== 0) return { stopReason: 'error' as const, finalMessage: lastText, turns, usage, error: `${binary} exited with ${code}` }
  return { stopReason: 'model_stopped' as const, finalMessage: lastText, turns, usage }
}

/** CLI processes alive now: stopped when the driver is stopped. */
const running = new Set<ChildProcess>()

/** SIGTERM, then SIGKILL if the CLI is still there 3 s later. */
function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 3_000).unref()
}

/**
 * Stops every CLI this driver started and removes their session folders (on SIGTERM or SIGINT to the
 * driver): synchronous, so it is done before the driver exits. Whatever outlives the driver is killed
 * by the host with the driver's process group.
 */
export function stopAll(): void {
  for (const child of running) stopChild(child)
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
  folders.clear()
}

export const claudeCodeDriver: DriverDefinition = {
  name: 'claude-code',
  version: '0.1.0',
  capabilities: () => ({
    imageInput: true,
    contextWindow: 200_000,
    toolCalling: true,
    reportsCost: true,
    notes: "runs the local Claude Code CLI under its user's login, with every built-in tool disabled",
  }),
  runSession,
}
