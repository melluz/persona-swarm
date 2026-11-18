import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionContext, SessionEvent } from '@persona-swarm/driver-kit'
import { describe, expect, it } from 'vitest'
import { claudeArgs, cleanEnvironment, runSession, writeMcpConfig } from '../src/index.js'

const spec = {
  sessionId: 's',
  model: 'sonnet',
  instructions: 'You are Pat.',
  kickoff: 'Begin. Your account: pat@x.test / password hunter2.',
  mcp: { url: 'http://127.0.0.1:9/mcp/s', headers: { Authorization: 'Bearer t0ken' } },
  budget: { maxTurns: 10, maxSeconds: 60 },
  memory: { keepImages: 3, summarizeAfterTokens: 1000, maxToolTextChars: 1000 },
  options: {},
}

/**
 * A stand-in for the claude CLI that answers each user message with a scripted turn, as the real one
 * does in stream-json mode: assistant lines (one per content block, same id), tool results, a result.
 */
function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ps-fake-claude-'))
  const file = join(dir, 'claude')
  writeFileSync(
    file,
    `#!/usr/bin/env node
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const mode = process.env.FAKE_MODE ?? ''
let calls = 0
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line)
  if (input.type === 'control_request' && input.request?.subtype === 'interrupt') {
    say({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', total_cost_usd: 0.02, usage: { input_tokens: 300, output_tokens: 40 } })
    return
  }
  if (mode === 'auth') {
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' }] } })
    say({ type: 'result', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' })
    return
  }
  calls += 1
  const id = 'msg_' + calls
  if (mode === 'slow') {
    // A long turn: one model call, then it keeps working until interrupted.
    say({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'Let me look around for a while.' }], usage: { input_tokens: 300, output_tokens: 40 } } })
    return
  }
  if (mode === 'budget') {
    say({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'Looking.' }], usage: { input_tokens: 100, output_tokens: 20 } } })
    say({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, result: 'Budget exceeded', total_cost_usd: 0.05 })
    return
  }
  // One model call, sent as one line per content block with the same id and usage.
  say({ type: 'assistant', message: { id, content: [{ type: 'text', text: "I'm not logged in yet, so I sign in first." }], usage: { input_tokens: 100, output_tokens: 20 } } })
  say({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: 't' + calls, name: 'mcp__persona__finish', input: {} }], usage: { input_tokens: 100, output_tokens: 20 } } })
  // The first finish is refused (a score out of range) when asked: the session is not over yet.
  const refused = mode === 'finish-refused' && calls === 1
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + calls, is_error: refused, content: [{ type: 'text', text: refused ? 'ease must be 1 to 10' : 'Thank you.' }] }] } })
  say({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.01 * calls, usage: { input_tokens: 100, output_tokens: 20 } })
})
`,
    { mode: 0o755 },
  )
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}')
  return file
}

/** Runs a session against the fake CLI in one of its modes. */
async function play(mode: string, options: Record<string, unknown> = {}, ctx = context()) {
  process.env.FAKE_MODE = mode
  try {
    return { result: await runSession({ ...spec, options: { binary: fakeClaude(), ...options } }, ctx), ctx }
  } finally {
    delete process.env.FAKE_MODE
  }
}

function context(): SessionContext & { events: SessionEvent[]; logs: string[] } {
  const events: SessionEvent[] = []
  const logs: string[] = []
  return { events, logs, emit: (event) => events.push(event), signal: new AbortController().signal, takeNotices: () => [], log: (line) => logs.push(line) }
}

describe('claude-code driver', () => {
  it('disables every built-in tool, allows only the persona server, and keeps the token off argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-claude-'))
    const file = writeMcpConfig(dir, spec)
    const args = claudeArgs(spec, file)
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__persona')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('You are Pat.')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(file)
    expect(args.join(' ')).not.toContain('t0ken')
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.persona.headers.Authorization).toBe('Bearer t0ken')
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('drops the variables of an enclosing Claude Code session, and only then', () => {
    const env = cleanEnvironment({
      PATH: '/bin',
      HOME: '/home/x',
      CLAUDECODE: '1',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      CLAUDE_CODE_USE_BEDROCK: '1',
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/x', CLAUDE_CODE_USE_BEDROCK: '1' })
    // From a terminal or CI, the user's own login (a token from `claude setup-token`) passes through.
    expect(cleanEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://proxy' })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://proxy',
    })
  })

  it('plays a session, counting tokens per model call, without mistaking narration for a login error', async () => {
    const ctx = context()
    const result = await runSession({ ...spec, options: { binary: fakeClaude() } }, ctx)
    expect(result).toMatchObject({ stopReason: 'finished', turns: 1 })
    expect(result.usage.costUsd).toBeCloseTo(0.01)
    // Counted once for the call, costed at 0 until the CLI's own figure arrives with the result.
    expect(ctx.events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, costUsd: 0 },
      { type: 'usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.01 },
    ])
    expect(ctx.events.filter((event) => event.type === 'tool_call')).toHaveLength(1)
  })

  it('costs each call when the run knows the price, and adds only the difference at the end', async () => {
    const ctx = context()
    // $3 and $15 per million tokens: 100 in and 20 out cost $0.0006.
    await runSession({ ...spec, options: { binary: fakeClaude(), price: { input: 3, output: 15 } } }, ctx)
    const costs = ctx.events.filter((event) => event.type === 'usage').map((event) => (event as { costUsd?: number }).costUsd ?? 0)
    expect(costs[0]).toBeCloseTo(0.0006)
    expect(costs.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(0.01)
  })

  it('reports an expired login with a hint instead of crashing', async () => {
    const { result } = await play('auth')
    expect(result).toMatchObject({ stopReason: 'error', error: expect.stringContaining('/login') })
  })

  it('goes on after a finish the tool refused, and ends on the one that succeeds', async () => {
    const { result, ctx } = await play('finish-refused')
    expect(result).toMatchObject({ stopReason: 'finished', turns: 2 })
    expect(ctx.events.filter((event) => event.type === 'tool_call')).toHaveLength(2)
  })

  it('stops as out of budget when the CLI reaches its own spend cap', async () => {
    const { result } = await play('budget')
    expect(result.stopReason).toBe('budget')
    expect(result.usage.costUsd).toBeCloseTo(0.05)
  })

  it('interrupts a turn it has to stop and still counts what the turn cost', async () => {
    const controller = new AbortController()
    const ctx = { ...context(), signal: controller.signal }
    const running = play('slow', {}, ctx)
    // Stopped mid-turn (a pause, the operator): the CLI is asked to interrupt and reports the turn's cost.
    await new Promise((resolveLater) => setTimeout(resolveLater, 500))
    controller.abort('governor')
    const { result } = await running
    expect(result.stopReason).toBe('cancelled')
    expect(result.usage.costUsd).toBeCloseTo(0.02)
    expect(ctx.events.filter((event) => event.type === 'usage').reduce((sum, event) => sum + ((event as { costUsd?: number }).costUsd ?? 0), 0)).toBeCloseTo(
      0.02,
    )
  })
})
