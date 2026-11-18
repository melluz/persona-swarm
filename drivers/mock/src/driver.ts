import { connectPersonaTools, type DriverDefinition, type PersonaTools, type SessionContext, type SessionSpec } from '@persona-swarm/driver-kit'

/** Deterministic pseudo-random numbers (mulberry32), so a monkey run can be replayed with its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CRASH =
  /Internal Server Error|Unexpected Application Error|Something went wrong|TypeError|ReferenceError|Cannot read propert|Traceback|stack trace|Application error|has crashed|Hey developer/i

const ODD_INPUTS = [
  '',
  'a',
  '0',
  '-1',
  '9'.repeat(30),
  'x'.repeat(120),
  '😀🦷 José Ñandú',
  "O'Brien-Søndergaard",
  '<b>bold</b>',
  '2026-02-30',
  '   ',
  '田中 花子',
]

const CLICKABLE = /^\s*- (link|button|checkbox|menuitem|tab|radio|option|switch)\b[^\n]*\[ref=([^\]]+)\]/
const TYPABLE = /^\s*- (textbox|searchbox|spinbutton|combobox)\b[^\n]*\[ref=([^\]]+)\]/

interface Step {
  tool: string
  args?: Record<string, unknown>
  /** Text the result must contain; a mismatch is logged as a warning. */
  expect?: string
}

async function call(tools: PersonaTools, context: SessionContext, name: string, args: Record<string, unknown>, counter: { n: number }) {
  counter.n += 1
  const callId = `call-${counter.n}`
  context.emit({ type: 'tool_call', name, input: args, callId })
  const result = await tools.call(name, args, context.signal)
  context.emit({ type: 'tool_result', name, callId, ok: !result.isError, summary: result.text.slice(0, 300) })
  return result
}

/**
 * Resolves `$ref(text)` arguments against the latest outline: the ref of the first line containing
 * `text`. Lets deterministic scripts survive refs that change between page loads.
 */
export function resolveRefs(args: Record<string, unknown>, outline: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    const wanted = typeof value === 'string' ? /^\$ref\((.+)\)$/.exec(value)?.[1] : undefined
    if (!wanted) {
      out[key] = value
      continue
    }
    const line = outline.split('\n').find((candidate) => candidate.includes(wanted) && /\[ref=/.test(candidate))
    const ref = line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : undefined
    if (!ref) throw new Error(`no element matching ${wanted} in the latest outline`)
    out[key] = ref
  }
  return out
}

async function runScript(spec: SessionSpec, context: SessionContext, tools: PersonaTools) {
  const steps = (spec.options.steps as Step[] | undefined) ?? []
  const counter = { n: 0 }
  const misses: string[] = []
  let outline = ''
  for (const [index, step] of steps.entries()) {
    if (context.signal.aborted) return { stopReason: 'cancelled' as const, finalMessage: `stopped at step ${index + 1}`, turns: index }
    context.emit({ type: 'turn', n: index + 1 })
    let args: Record<string, unknown>
    try {
      args = resolveRefs(step.args ?? {}, outline)
    } catch (error) {
      misses.push(`step ${index + 1} (${step.tool}): ${(error as Error).message}`)
      context.emit({ type: 'log', level: 'warn', message: `step ${index + 1}: ${(error as Error).message}` })
      continue
    }
    const result = await call(tools, context, step.tool, args, counter)
    if (step.tool === 'outline' || step.tool === 'find_text') outline = result.text
    if (step.expect && !result.text.includes(step.expect)) {
      misses.push(`step ${index + 1} (${step.tool}) lacked "${step.expect}"`)
      context.emit({ type: 'log', level: 'warn', message: `step ${index + 1}: expected "${step.expect}", got: ${result.text.slice(0, 200)}` })
    }
  }
  return {
    stopReason: 'finished' as const,
    finalMessage: misses.length ? `script done with ${misses.length} mismatch(es): ${misses.join('; ')}` : 'script done',
    turns: steps.length,
  }
}

async function runMonkey(spec: SessionSpec, context: SessionContext, tools: PersonaTools) {
  const random = seededRandom(Number(spec.options.seed ?? 1))
  const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)]
  const has = (name: string) => tools.tools.some((tool) => tool.name === name)
  const touch = has('tap_at')
  const deadline = Date.now() + spec.budget.maxSeconds * 1000
  const counter = { n: 0 }
  const reported = new Set<string>()
  let turns = 0
  let viewport = { width: 1280, height: 800 }

  const examine = async (text: string, after: string) => {
    const crash = CRASH.exec(text)
    if (!crash) return
    const key = `${crash[0]}|${after}`
    if (reported.has(key)) return
    reported.add(key)
    const report = {
      title: `The app showed "${crash[0]}" after ${after}`,
      what_i_did: after,
      what_i_expected: 'The app to keep working or explain what went wrong',
      what_happened: text.slice(0, 600),
      how_bad: 'blocking',
      sure: true,
      kind: 'bug',
    }
    const reply = await call(tools, context, 'report_problem', report, counter)
    if (!reply.text.startsWith('Not filed yet')) return
    // Held as maybe already reported: the same crash after the same step is confirmed, anything else is filed as different.
    // Titles hold quotes of their own: a listed title runs to the last '" (' of its line.
    const listed = [...reply.text.matchAll(/^- ([FK]-\d+) "(.*)" \(/gm)].map((match) => ({ id: String(match[1]), title: String(match[2]) }))
    const same = listed.find((item) => item.title === report.title)
    if (same) await call(tools, context, 'confirm_problem', { id: same.id, note: `The same "${crash[0]}" after ${after}.` }, counter)
    else await call(tools, context, 'report_problem', { ...report, not_same_as: listed.map((item) => item.id) }, counter)
  }

  if (has('note')) await call(tools, context, 'note', { text: 'Monkey session: I press things at random and report anything that breaks.' }, counter)
  while (turns < spec.budget.maxTurns && Date.now() < deadline && !context.signal.aborted) {
    turns += 1
    context.emit({ type: 'turn', n: turns })
    const view = has('outline') ? await call(tools, context, 'outline', {}, counter) : await call(tools, context, 'screenshot', {}, counter)
    const size = /The screen is (\d+)×(\d+)/.exec(view.text)
    if (size) viewport = { width: Number(size[1]), height: Number(size[2]) }
    await examine(view.text, 'looking at the page')
    // A dialog shows in the status line, or as the reason a screenshot could not be taken.
    if (/a browser dialog asks|A browser dialog is open/.test(view.text)) {
      await call(tools, context, 'answer_dialog', { answer: random() < 0.5 ? 'ok' : 'cancel' }, counter)
      continue
    }
    const lines = view.text.split('\n')
    const clickable = lines.map((line) => CLICKABLE.exec(line)).filter((match): match is RegExpExecArray => Boolean(match))
    const typable = lines.map((line) => TYPABLE.exec(line)).filter((match): match is RegExpExecArray => Boolean(match))
    const roll = random()
    let action: { name: string; args: Record<string, unknown>; label: string }
    if (roll < 0.5 && clickable.length && (has('click') || has('tap'))) {
      const match = pick(clickable) as RegExpExecArray
      const name = has('click') ? 'click' : 'tap'
      action = {
        name,
        args: { ref: match[2], ...(name === 'click' && random() < 0.1 ? { double: true } : {}) },
        label: `pressing ${match[0].trim().slice(0, 80)}`,
      }
    } else if (roll < 0.75 && typable.length && has('fill')) {
      const match = pick(typable) as RegExpExecArray
      const value = pick(ODD_INPUTS) ?? 'x'
      action = { name: 'fill', args: { ref: match[2], text: value }, label: `typing "${value.slice(0, 20)}" into ${match[0].trim().slice(0, 60)}` }
    } else if (roll < 0.85 && (has('click_at') || has('tap_at'))) {
      const x = Math.round(random() * (viewport.width - 1))
      const y = Math.round(random() * (viewport.height - 1))
      action = { name: touch ? 'tap_at' : 'click_at', args: { x, y }, label: `${touch ? 'tapping' : 'clicking'} at ${x},${y}` }
    } else if (roll < 0.92) {
      const keys = pick(['Tab', 'Enter', 'Escape', 'Tab Tab Enter', 'ArrowDown', 'Shift+Tab']) ?? 'Tab'
      action = { name: 'press', args: { keys }, label: `pressing ${keys}` }
    } else if (roll < 0.96) {
      action = { name: 'back', args: {}, label: 'going back' }
    } else {
      action = has('scroll')
        ? { name: 'scroll', args: { direction: random() < 0.7 ? 'down' : 'up' }, label: 'scrolling' }
        : { name: 'reload', args: {}, label: 'reloading' }
    }
    const result = await call(tools, context, action.name, action.args, counter)
    await examine(result.text, action.label)
  }
  const stopReason = context.signal.aborted ? ('cancelled' as const) : ('budget' as const)
  if (!context.signal.aborted && has('finish'))
    await call(
      tools,
      context,
      'finish',
      {
        outcome: 'completed',
        summary: `Pressed things at random for ${turns} turns; reported ${reported.size} problem(s).`,
        ease: 5,
        trust: 5,
        would_use: 'maybe',
        why: 'I am a monkey.',
      },
      counter,
    )
  return { stopReason, finalMessage: `monkey: ${turns} turns, ${reported.size} problem(s) reported`, turns }
}

export const mockDriver: DriverDefinition = {
  name: 'mock',
  version: '0.1.0',
  capabilities: () => ({
    imageInput: true,
    contextWindow: 1_000_000,
    toolCalling: true,
    usesModel: false,
    notes: 'model-free (script or monkey): accepts screenshots and ignores them',
  }),
  async runSession(spec, context) {
    const tools = await connectPersonaTools(spec.mcp)
    try {
      const mode = String(spec.options.mode ?? (spec.options.steps ? 'script' : 'monkey'))
      if (mode === 'script') return await runScript(spec, context, tools)
      if (mode === 'monkey') return await runMonkey(spec, context, tools)
      throw new Error(`unknown mock mode "${mode}" (script or monkey)`)
    } finally {
      await tools.close().catch(() => {})
    }
  },
}
