import { mkdirSync, readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ActionOutcome, Body, Device, DeviceAction, DeviceStatus, EventStore, Finding, InputMode, ToolProfile } from '@persona-swarm/core'
import {
  aim,
  asPasted,
  bodyOf,
  FREE_TOOLS,
  interruptionDue,
  layoutViewport,
  newId,
  normalizeText,
  pickInterruption,
  seededRandom,
  seedFrom,
  slipsIntoDouble,
  thinkingMs,
  withTypos,
} from '@persona-swarm/core'
import { z } from 'zod'
import type { RunFindings, SimilarProblem } from './findings-sink.js'

export interface Diary {
  outcome: 'completed' | 'gave_up' | 'blocked'
  summary: string
  ease: number
  trust: number
  wouldUse: 'yes' | 'no' | 'maybe'
  why: string
  t: string
}

export interface PersonaSession {
  sessionId: string
  personaName: string
  device: Device
  profile: ToolProfile
  input: InputMode
  files: { name: string; size: string; label?: string }[]
  /** Absolute directory for this session's screenshots, and its path relative to the run folder. */
  shotsDir: string
  shotsRel: string
  events: EventStore
  findings: RunFindings
  baseUrl: string
  /** Epoch ms when the session's time runs out (shown in every status line). */
  deadline?: number
  /** Tool calls this session may make; finish is always allowed. Enforced here, the same for every driver. */
  maxActions?: number
  /** Store a small screenshot after every action for replay. */
  replayShots: boolean
  /** Whether the persona's flaky network can be toggled (`wifi` tool). */
  networkToggle: boolean
  /**
   * Body traits the harness enforces, the same for every driver: where clicks and taps land, what gets
   * typed, thinking time, interruptions and a second tab. Left out, the persona has a steady hand and
   * types carefully.
   */
  body?: Body
  /** Seed for the body's slips (default: from the session id), so a session slips the same way again. */
  seed?: number
  hooks: {
    onAction?(result: { tool: string; ok: boolean; harnessError: boolean }): void
    onScreenshot?(path: string): void
    onNote?(text: string): void
    onFinding?(finding: Finding): void
    onFinish?(diary: Diary): void
    /** The persona has just spent its last action: it may still look, note, report and finish. */
    onActionsSpent?(): void
  }
}

type Content = CallToolResult['content']
const text = (value: string) => ({ type: 'text' as const, text: value })

function pathOf(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url)
    return parsed.origin === new URL(baseUrl).origin ? `${parsed.pathname}${parsed.search}` : url
  } catch {
    return url
  }
}

export function statusLine(status: DeviceStatus, baseUrl: string, budget: { deadline?: number | undefined; actionsLeft?: number | undefined } = {}): string {
  const parts = [`[Screen] "${status.title || 'untitled'}" at ${pathOf(status.url, baseUrl)}`]
  if (status.tab.count > 1) parts.push(`tab ${status.tab.index + 1} of ${status.tab.count}`)
  if (status.notices.length) parts.push(`on screen: ${status.notices.map((notice) => `"${notice}"`).join(' | ')}`)
  if (status.dialog) parts.push(`a browser dialog asks: "${status.dialog.message}" (use answer_dialog)`)
  if (status.filePicker) parts.push('a file picker is open (choose a file with pick_file)')
  if (!status.online) parts.push('no internet connection')
  if (budget.deadline !== undefined) {
    const seconds = Math.round((budget.deadline - Date.now()) / 1000)
    parts.push(
      seconds <= 0 ? 'your time is up: call finish now' : seconds < 60 ? 'under a minute left: call finish now' : `about ${Math.ceil(seconds / 60)} min left`,
    )
  }
  if (budget.actionsLeft !== undefined)
    parts.push(budget.actionsLeft <= 0 ? 'no actions left: call finish now' : `${budget.actionsLeft} action${budget.actionsLeft === 1 ? '' : 's'} left`)
  return parts.join(' · ')
}

/**
 * Counters belong to the session, not to a connection: some drivers connect once per action.
 * Screenshot numbers continue after the shots already on disk (a resumed run).
 */
interface SessionCounters {
  shots: number
  actions: number
  /** Recent device signals (console and network errors), kept for the evidence of the next report. */
  signals: { at: number; text: string }[]
  /** The last report held back for a second look (its normalized title). */
  held?: string
  /** The last action has been spent: the session is told once it has run (onActionsSpent). */
  spent?: 'pending' | 'told'
  /** The body's random numbers, shared by every connection of the session. */
  random: () => number
  /** Actions since the last interruption. */
  sinceInterruption: number
  /** A multitab persona has opened its second tab. */
  secondTab?: boolean
  /** Files the persona has uploaded, in order (evidence for its reports). */
  uploaded: string[]
}

const sessionCounters = new WeakMap<PersonaSession, SessionCounters>()

function countersOf(session: PersonaSession): SessionCounters {
  let counters = sessionCounters.get(session)
  if (!counters) {
    mkdirSync(session.shotsDir, { recursive: true })
    let shots = 0
    for (const name of readdirSync(session.shotsDir)) {
      const match = /^[a-z](\d+)\.jpg$/.exec(name)
      if (match) shots = Math.max(shots, Number(match[1]))
    }
    counters = { shots, actions: 0, signals: [], random: seededRandom(session.seed ?? seedFrom(session.sessionId)), sinceInterruption: 0, uploaded: [] }
    sessionCounters.set(session, counters)
  }
  return counters
}

const OUTLINE_PART_CHARS = 12_000

/** Splits an outline into parts of at most `size` characters, at line breaks. */
export function outlineParts(outline: string, size: number): string[] {
  const parts: string[] = []
  let current = ''
  for (const line of outline.split('\n')) {
    if (current && current.length + line.length + 1 > size) {
      parts.push(current)
      current = ''
    }
    current = current ? `${current}\n${line}` : line.slice(0, size)
  }
  if (current || !parts.length) parts.push(current)
  return parts
}

function describeSimilar(items: SimilarProblem[]): string {
  return items
    .map(
      (item) =>
        `- ${item.id} "${item.title}" (${item.mine ? 'your own earlier report' : item.known ? 'already known to the team' : `${item.testers} tester${item.testers === 1 ? '' : 's'} so far`})`,
    )
    .join('\n')
}

/** Builds the MCP server for one connection of one persona session. */
export function buildPersonaServer(session: PersonaSession): McpServer {
  const server = new McpServer({ name: 'persona-swarm', version: '0.1.0' }, { capabilities: { tools: {} } })
  const { device, profile, input } = session
  const body = session.body ?? bodyOf(undefined)
  // The profile wins over the hardware: a keyboard-only persona on a laptop still has no pointer.
  const pointer = (input === 'mouse' || input === 'touch') && profile !== 'keyboard' && profile !== 'screenreader'
  const touch = input === 'touch'
  const hasOutline = profile === 'reader' || profile === 'power' || profile === 'screenreader'
  const hasSearch = profile === 'power' || profile === 'screenreader'
  const byRef = hasOutline
  const counters = countersOf(session)
  const actionsLeft = () => (session.maxActions === undefined ? undefined : session.maxActions - counters.actions)
  const budget = () => ({ deadline: session.deadline, actionsLeft: actionsLeft() })

  const storeShot = async (data: Buffer, prefix: string): Promise<string> => {
    counters.shots += 1
    const name = `${prefix}${String(counters.shots).padStart(4, '0')}.jpg`
    await writeFile(join(session.shotsDir, name), data)
    const rel = `${session.shotsRel}/${name}`
    session.hooks.onScreenshot?.(rel)
    return rel
  }

  const logSignals = () => {
    for (const signal of device.drainSignals()) {
      session.events.append(session.sessionId, 'device.signal', { ...signal })
      if (signal.kind === 'console.warning') continue
      counters.signals.push({ at: Date.parse(signal.t) || Date.now(), text: `${signal.kind}: ${signal.text}`.slice(0, 400) })
      if (counters.signals.length > 50) counters.signals.shift()
    }
  }
  /** Errors from the last few minutes: what went wrong around the moment a persona reports. */
  const recentSignals = (withinMs = 3 * 60_000) =>
    counters.signals
      .filter((signal) => Date.now() - signal.at <= withinMs)
      .slice(-10)
      .map((signal) => signal.text)

  /** Spends one action, or refuses the call (logged like any other) when none are left. */
  const spend = (tool: string, inputValue: Record<string, unknown>): CallToolResult | undefined => {
    // A held report can be sent again as it was, but only before the persona moves on.
    if (!['report_problem', 'note', 'screenshot', 'outline', 'find_text'].includes(tool)) counters.held = undefined
    const left = actionsLeft()
    // Looking and speaking up are free: a persona never has to choose between reporting and acting.
    if (FREE_TOOLS.has(tool)) return undefined
    if (left === undefined || left > 0) {
      counters.actions += 1
      if (left === 1) counters.spent = 'pending'
      return undefined
    }
    const callId = newId('call')
    const message = 'No actions left in this session. Report anything you have not reported yet, then call finish with your honest account.'
    // Logged as refused: neither an action, nor a harness error, nor an app error.
    session.events.append(session.sessionId, 'tool.call', { tool, input: inputValue, callId })
    session.events.append(session.sessionId, 'tool.result', { tool, callId, ok: false, refused: true, ms: 0, message })
    return { content: [text(message)], isError: true }
  }

  /** After the last action has run (not before: a long wait would eat the time to report), the session is told. */
  const afterAction = () => {
    if (counters.spent !== 'pending') return
    counters.spent = 'told'
    session.hooks.onActionsSpent?.()
  }

  /**
   * Something outside the app gets in the way before this action (an interruptions trait). Returns what
   * the persona noticed, and for a dropped connection the step that brings it back after the action.
   */
  const interrupt = async (): Promise<{ notice: string; after?: () => Promise<void> } | undefined> => {
    counters.sinceInterruption += 1
    if (!interruptionDue(body.interruptions, counters.actions, counters.sinceInterruption, counters.random)) return undefined
    counters.sinceInterruption = 0
    const status = await device.status()
    let kind = pickInterruption(counters.random)
    const inApp = status.url.startsWith('http')
    if ((kind === 'offline' && (!device.capabilities().network || !status.online)) || (kind === 'reopen' && !inApp)) kind = 'away'
    const log = (detail: Record<string, unknown>) => session.events.append(session.sessionId, 'interruption', { kind, ...detail })
    switch (kind) {
      case 'away': {
        const seconds = Math.round(30 + counters.random() * 60)
        await device.perform({ type: 'wait', seconds })
        log({ seconds })
        return { notice: `You were called away for about ${seconds} seconds and are back at the screen now.` }
      }
      case 'offline':
        await device.perform({ type: 'set_network', state: 'offline' })
        log({})
        return {
          notice: 'Your internet connection dropped just as you did this; it came back a few seconds later.',
          after: async () => {
            await new Promise((resolveLater) => setTimeout(resolveLater, 3_000))
            await device.perform({ type: 'set_network', state: 'online' })
          },
        }
      case 'reload':
        await device.perform({ type: 'reload' })
        log({ url: status.url })
        return { notice: 'Your browser reloaded the page while you were looking away (it had gone to sleep), before you did this.' }
      case 'reopen': {
        const old = status.tab.index
        await device.perform({ type: 'new_tab', url: status.url })
        await device.perform({ type: 'switch_tab', index: old })
        await device.perform({ type: 'close_tab' })
        log({ url: status.url })
        return { notice: 'You closed the tab by accident and opened the page again from your history, before you did this.' }
      }
    }
  }

  /** The action as this person's hands do it: where it lands, how it is typed. Returns what slipped, for the log. */
  const embody = (action: DeviceAction): { action: DeviceAction; slips: string[] } => {
    const slips: string[] = []
    const viewport = layoutViewport(device.profile)
    const land = (point: { x: number; y: number }) => {
      const landed = aim(point, body.precision, counters.random, viewport)
      if (landed.dx || landed.dy) slips.push(`landed ${landed.dx}, ${landed.dy} px off`)
      return { x: landed.x, y: landed.y }
    }
    const onPoint = <T extends { ref: string } | { x: number; y: number }>(target: T): T => ('ref' in target ? target : (land(target) as T))
    switch (action.type) {
      case 'click': {
        const slipped = input === 'mouse' && (action.count ?? 1) === 1 && action.button !== 'right' && slipsIntoDouble(body.precision, counters.random)
        if (slipped) slips.push('clicked twice')
        return { action: { ...action, target: onPoint(action.target), ...(slipped ? { count: 2 as const } : {}) }, slips }
      }
      case 'tap':
      case 'long_press':
        return { action: { ...action, target: onPoint(action.target) }, slips }
      case 'drag':
      case 'swipe':
        return { action: { ...action, from: land(action.from), to: land(action.to) }, slips }
      case 'pick_file':
      case 'drop_file':
        return { action: { ...action, target: action.target === 'focused' ? action.target : onPoint(action.target) } as DeviceAction, slips }
      case 'type':
      case 'fill': {
        if (body.typing === 'careful') return { action, slips }
        const typed = body.typing === 'typos' ? withTypos(action.text, counters.random) : asPasted(action.text, counters.random)
        slips.push(...typed.slips)
        return { action: { ...action, text: typed.text, ...(action.type === 'type' && body.typing === 'pastes' ? { paste: true } : {}) }, slips }
      }
      default:
        return { action, slips }
    }
  }

  /** A multitab persona opens the page it is on in a second tab once it is a few actions in, as it would by habit. */
  const secondTab = async (): Promise<string | undefined> => {
    if (!body.multitab || counters.secondTab || counters.actions < 5) return undefined
    const status = await device.status()
    if (!status.url.startsWith('http') || status.tab.count > 1) return undefined
    counters.secondTab = true
    await device.perform({ type: 'new_tab', url: status.url })
    session.events.append(session.sessionId, 'interruption', { kind: 'second-tab', url: status.url })
    return 'Out of habit you opened this page in a second tab as well and are in the new tab now (use tabs to switch).'
  }

  /** Runs a device action with logging, a status line and an optional replay thumbnail. */
  const act = async (tool: string, inputValue: Record<string, unknown>, intended: DeviceAction): Promise<CallToolResult> => {
    const refused = spend(tool, inputValue)
    if (refused) return refused
    const callId = newId('call')
    session.events.append(session.sessionId, 'tool.call', { tool, input: inputValue, callId })
    const started = performance.now()
    const notices: string[] = []
    let restore: (() => Promise<void>) | undefined
    const interruption = await interrupt().catch(() => undefined)
    if (interruption) {
      notices.push(interruption.notice)
      restore = interruption.after
    }
    const opened = await secondTab().catch(() => undefined)
    if (opened) notices.push(opened)
    const think = thinkingMs(body.pace, counters.random)
    if (think) await new Promise((resolveLater) => setTimeout(resolveLater, think))
    const { action, slips } = embody(intended)
    let outcome: ActionOutcome
    try {
      outcome = await device.perform(action)
    } finally {
      await restore?.().catch(() => {})
    }
    let screenshot: string | undefined
    if (session.replayShots && !outcome.harnessError) {
      try {
        screenshot = await storeShot((await device.screenshot()).data, 'a')
      } catch {
        // A replay frame is a convenience; never fail the action for it.
      }
    }
    logSignals()
    session.events.append(session.sessionId, 'tool.result', {
      tool,
      callId,
      ok: outcome.ok,
      harnessError: Boolean(outcome.harnessError),
      ms: Math.round(performance.now() - started),
      message: outcome.message,
      url: outcome.status.url,
      ...(screenshot ? { screenshot } : {}),
      ...(outcome.files ? { files: outcome.files } : {}),
      // What the body did differently from what the persona asked: evidence for whoever reviews a report.
      ...(slips.length ? { body: slips } : {}),
      ...(think ? { thinkMs: think } : {}),
    })
    if (outcome.ok && (action.type === 'pick_file' || action.type === 'drop_file')) {
      counters.uploaded = [...counters.uploaded.filter((name) => name !== action.file), action.file]
    }
    session.hooks.onAction?.({ tool, ok: outcome.ok, harnessError: Boolean(outcome.harnessError) })
    afterAction()
    const lines = [...notices, outcome.message]
    if (outcome.files?.length) lines.push(`Downloaded: ${outcome.files.map((file) => file.split('/').pop()).join(', ')}`)
    lines.push(statusLine(outcome.status, session.baseUrl, budget()))
    return { content: [text(lines.join('\n'))], ...(outcome.ok ? {} : { isError: true }) }
  }

  /** Logs a non-device tool (look, note, report) the same way. */
  const record = async (tool: string, inputValue: Record<string, unknown>, run: () => Promise<{ content: Content; ok?: boolean; message: string }>) => {
    const refused = spend(tool, inputValue)
    if (refused) return refused
    const callId = newId('call')
    session.events.append(session.sessionId, 'tool.call', { tool, input: inputValue, callId })
    const started = performance.now()
    try {
      const result = await run()
      session.events.append(session.sessionId, 'tool.result', {
        tool,
        callId,
        ok: result.ok ?? true,
        ms: Math.round(performance.now() - started),
        message: result.message,
      })
      session.hooks.onAction?.({ tool, ok: result.ok ?? true, harnessError: false })
      return { content: result.content, ...(result.ok === false ? { isError: true } : {}) }
    } catch (error) {
      const message = (error as Error).message
      // A crashed, closed or hanging page is the app's (or the browser's) doing, not a wrong request.
      const harnessError = !/crash|closed|disconnected|Timeout \d+ms exceeded/i.test(message)
      session.events.append(session.sessionId, 'tool.result', {
        tool,
        callId,
        ok: false,
        harnessError,
        ms: Math.round(performance.now() - started),
        message,
      })
      session.hooks.onAction?.({ tool, ok: false, harnessError })
      afterAction()
      // Where the persona is, even after a failure (a dialog that blocks the screenshot shows here).
      const status = await device
        .status()
        .then((now) => `\n${statusLine(now, session.baseUrl, budget())}`)
        .catch(() => '')
      return { content: [text(`That did not work: ${message.split('\n')[0]}${status}`)], isError: true }
    }
  }

  const coord = z.coerce.number().describe('CSS pixels on the latest screenshot')
  const target = (args: { ref?: string | undefined; x?: number | undefined; y?: number | undefined }) =>
    args.ref ? { ref: args.ref } : { x: Number(args.x), y: Number(args.y) }

  // Seeing the screen.
  if (profile !== 'screenreader')
    server.registerTool(
      'screenshot',
      {
        description:
          'Look at the screen. Returns a picture of what is visible right now. Set grid to true to overlay a coordinate grid when you need to click or tap a precise spot.',
        inputSchema: { grid: z.boolean().optional().describe('overlay a 100 px coordinate grid') },
      },
      async ({ grid }) =>
        record('screenshot', { grid }, async () => {
          const shot = await device.screenshot({ grid: Boolean(grid) })
          // The persona sees the picture even when it cannot be kept (a full disk).
          const path = await storeShot(shot.data, grid ? 'g' : 's').catch(() => undefined)
          const status = await device.status()
          logSignals()
          return {
            message: `screenshot ${path ?? '(not saved)'}`,
            content: [
              { type: 'image' as const, data: shot.data.toString('base64'), mimeType: shot.mimeType },
              text(`${statusLine(status, session.baseUrl, budget())}\nThe screen is ${shot.width}×${shot.height} pixels; coordinates use these pixels.`),
            ],
          }
        }),
    )

  if (hasOutline)
    server.registerTool(
      'outline',
      {
        description:
          'Read the page as an outline of its elements (headings, text, links, buttons, fields), each with a ref like e42 that other tools accept. A long page comes in parts: ask for the next with part.',
        inputSchema: { part: z.coerce.number().int().min(1).optional().describe('which part of a long outline (default 1)') },
      },
      async ({ part }) =>
        record('outline', { ...(part ? { part } : {}) }, async () => {
          const outline = await device.outline({ maxChars: 1_000_000 })
          const parts = outlineParts(outline.text, OUTLINE_PART_CHARS)
          const index = Math.min(parts.length, part ?? 1)
          const footer =
            parts.length > 1 ? `\n(part ${index} of ${parts.length}${index < parts.length ? `: call outline with part ${index + 1} for more` : ''})` : ''
          const status = await device.status()
          return {
            message: `outline (${outline.refs} refs${parts.length > 1 ? `, part ${index} of ${parts.length}` : ''})`,
            content: [text(`${statusLine(status, session.baseUrl, budget())}\n${parts[index - 1] ?? ''}${footer}`)],
          }
        }),
    )

  if (hasSearch)
    server.registerTool(
      'find_text',
      {
        description: 'Search the page outline for words and return the matching lines with their refs.',
        inputSchema: { text: z.string().min(1) },
      },
      async ({ text: query }) =>
        record('find_text', { text: query }, async () => {
          const outline = await device.outline({ query })
          return { message: `find "${query}"`, content: [text(`${outline.text}\n${statusLine(await device.status(), session.baseUrl, budget())}`)] }
        }),
    )

  // Pointing.
  if (pointer) {
    if (touch) {
      server.registerTool(
        'tap_at',
        { description: 'Tap the screen with a finger at x, y (pixels on the screenshot).', inputSchema: { x: coord, y: coord } },
        async ({ x, y }) => act('tap_at', { x, y }, { type: 'tap', target: { x, y } }),
      )
      server.registerTool('long_press_at', { description: 'Press and hold a finger at x, y.', inputSchema: { x: coord, y: coord } }, async ({ x, y }) =>
        act('long_press_at', { x, y }, { type: 'long_press', target: { x, y } }),
      )
      server.registerTool(
        'swipe',
        {
          description: 'Drag a finger from one point to another (move things, scroll a list, pan an image).',
          inputSchema: { from_x: coord, from_y: coord, to_x: coord, to_y: coord },
        },
        async (args) => act('swipe', args, { type: 'swipe', from: { x: args.from_x, y: args.from_y }, to: { x: args.to_x, y: args.to_y } }),
      )
      server.registerTool(
        'pinch',
        {
          description: 'Pinch with two fingers around x, y. scale above 1 zooms in, below 1 zooms out.',
          inputSchema: { x: coord, y: coord, scale: z.coerce.number().min(0.2).max(5) },
        },
        async ({ x, y, scale }) => act('pinch', { x, y, scale }, { type: 'pinch', at: { x, y }, scale }),
      )
    } else {
      server.registerTool(
        'click_at',
        {
          description: 'Click with the mouse at x, y (pixels on the screenshot). Set double for a double-click, right for the right button.',
          inputSchema: { x: coord, y: coord, double: z.boolean().optional(), right: z.boolean().optional() },
        },
        async ({ x, y, double, right }) =>
          act('click_at', { x, y, double, right }, { type: 'click', target: { x, y }, count: double ? 2 : 1, ...(right ? { button: 'right' as const } : {}) }),
      )
      server.registerTool(
        'drag',
        {
          description: 'Press the mouse at one point, move it and release at another.',
          inputSchema: { from_x: coord, from_y: coord, to_x: coord, to_y: coord },
        },
        async (args) => act('drag', args, { type: 'drag', from: { x: args.from_x, y: args.from_y }, to: { x: args.to_x, y: args.to_y } }),
      )
    }
    server.registerTool(
      'scroll',
      {
        description: 'Scroll the page (or the panel under x, y) by roughly one screen per amount.',
        inputSchema: {
          direction: z.enum(['up', 'down', 'left', 'right']),
          amount: z.coerce.number().min(0.2).max(10).optional(),
          x: coord.optional(),
          y: coord.optional(),
        },
      },
      async ({ direction, amount, x, y }) =>
        act(
          'scroll',
          { direction, amount, x, y },
          {
            type: 'scroll',
            direction,
            ...(amount ? { amount } : {}),
            ...(x !== undefined && y !== undefined ? { at: { x, y } } : {}),
          },
        ),
    )
    if (byRef)
      server.registerTool(
        touch ? 'tap' : 'click',
        {
          description: `${touch ? 'Tap' : 'Click'} an element by its ref from the outline.${touch ? '' : ' Set double for a double-click.'}`,
          inputSchema: { ref: z.string(), ...(touch ? {} : { double: z.boolean().optional() }) },
        },
        async (args: { ref: string; double?: boolean | undefined }) =>
          act(
            touch ? 'tap' : 'click',
            args,
            touch ? { type: 'tap', target: { ref: args.ref } } : { type: 'click', target: { ref: args.ref }, count: args.double ? 2 : 1 },
          ),
      )
  }

  // A phone or tablet turns, whatever the persona uses to drive it.
  if (device.capabilities().rotate)
    server.registerTool('rotate', { description: 'Turn the device between portrait and landscape.', inputSchema: {} }, async () =>
      act('rotate', {}, { type: 'rotate' }),
    )

  // Keyboard.
  server.registerTool(
    'type',
    { description: 'Type text with the keyboard into whatever has focus.', inputSchema: { text: z.string() } },
    async ({ text: value }) => act('type', { text: value }, { type: 'type', text: value }),
  )
  server.registerTool(
    'press',
    {
      description:
        'Press keys. One key or chord (Enter, Tab, Shift+Tab, Escape, ArrowDown, Control+a, Meta+z), or several separated by spaces ("Tab Tab Enter").',
      inputSchema: { keys: z.string().min(1) },
    },
    async ({ keys }) => act('press', { keys }, { type: 'press', keys }),
  )
  if (hasOutline) {
    server.registerTool(
      'fill',
      { description: 'Replace the text of a field, by its ref from the outline.', inputSchema: { ref: z.string(), text: z.string() } },
      async ({ ref, text: value }) => act('fill', { ref, text: value }, { type: 'fill', ref, text: value }),
    )
    server.registerTool(
      'select',
      { description: 'Choose an option of a drop-down list, by its ref.', inputSchema: { ref: z.string(), option: z.string() } },
      async ({ ref, option }) => act('select', { ref, option }, { type: 'select', ref, option }),
    )
  }

  // Navigation.
  server.registerTool('back', { description: "Press the browser's Back button.", inputSchema: {} }, async () => act('back', {}, { type: 'back' }))
  server.registerTool('forward', { description: "Press the browser's Forward button.", inputSchema: {} }, async () => act('forward', {}, { type: 'forward' }))
  server.registerTool('reload', { description: 'Reload the page.', inputSchema: {} }, async () => act('reload', {}, { type: 'reload' }))
  server.registerTool(
    'go_to',
    { description: "Type an address into the browser's address bar (only this app's pages open).", inputSchema: { address: z.string() } },
    async ({ address }) => act('go_to', { address }, { type: 'open', url: address }),
  )
  if (profile === 'power' || body.multitab)
    server.registerTool(
      'tabs',
      {
        description: 'Browser tabs: open a new one (optionally at an address), switch to one by number, or close the current one.',
        inputSchema: { action: z.enum(['new', 'switch', 'close']), number: z.coerce.number().int().min(1).optional(), address: z.string().optional() },
      },
      async ({ action, number, address }) =>
        act(
          'tabs',
          { action, number, address },
          action === 'new'
            ? { type: 'new_tab', ...(address ? { url: address } : {}) }
            : action === 'switch'
              ? { type: 'switch_tab', index: (number ?? 1) - 1 }
              : { type: 'close_tab' },
        ),
    )

  // Files.
  // Each file with what the persona knows of it: its size and, from the manifest, what it is.
  const fileList = session.files.length ? session.files.map((file) => `${file.name} (${file.size}${file.label ? `, ${file.label}` : ''})`).join('; ') : 'none'
  const pickShape: Record<string, z.ZodType> = { file: z.string() }
  if (pointer || hasOutline) pickShape.ref = z.string().optional().describe('the control, by ref')
  if (pointer) {
    pickShape.x = coord.optional()
    pickShape.y = coord.optional()
  }
  server.registerTool(
    'pick_file',
    {
      description: `Choose a file from this computer. If a file picker is already open, give just the file. Otherwise say which control opens the picker${pointer ? ' (ref, or x and y)' : hasOutline ? ' (ref)' : ''}, or leave it out to use the control that has focus. Files on this computer: ${fileList}.`,
      inputSchema: pickShape,
    },
    async (raw) => {
      const args = raw as { file: string; ref?: string; x?: number; y?: number }
      return act('pick_file', args, {
        type: 'pick_file',
        file: args.file,
        target: args.ref || (args.x !== undefined && args.y !== undefined) ? target(args) : 'focused',
      })
    },
  )
  if (input === 'mouse' && pointer)
    server.registerTool(
      'drop_file',
      {
        description: `Drag a file from the desktop onto the page at x, y (or an element ref). Files: ${fileList}.`,
        inputSchema: { file: z.string(), ref: z.string().optional(), x: coord.optional(), y: coord.optional() },
      },
      async (args) => act('drop_file', args, { type: 'drop_file', file: args.file, target: target(args) }),
    )

  // Waiting and interruptions.
  server.registerTool(
    'answer_dialog',
    { description: 'Answer a browser dialog (OK or Cancel).', inputSchema: { answer: z.enum(['ok', 'cancel']), text: z.string().optional() } },
    async ({ answer, text: value }) =>
      act('answer_dialog', { answer, text: value }, { type: 'dialog', answer: answer === 'ok' ? 'accept' : 'dismiss', ...(value ? { text: value } : {}) }),
  )
  server.registerTool(
    'wait',
    {
      description: 'Wait a while (up to 120 s), or until some text appears on screen.',
      inputSchema: { seconds: z.coerce.number().min(0).max(120), for_text: z.string().optional() },
    },
    async ({ seconds, for_text }) => act('wait', { seconds, for_text }, { type: 'wait', seconds, ...(for_text ? { forText: for_text } : {}) }),
  )
  if (session.networkToggle)
    server.registerTool(
      'wifi',
      { description: "Lose or regain this device's network connection, as an unreliable Wi-Fi does.", inputSchema: { on: z.boolean() } },
      async ({ on }) => act('wifi', { on }, { type: 'set_network', state: on ? 'online' : 'offline' }),
    )

  // Speaking up.
  server.registerTool(
    'note',
    {
      description: 'Think aloud: say what you are trying, what you expect, what confuses or annoys you, in your own words. Use it often.',
      inputSchema: { text: z.string().min(1) },
    },
    async ({ text: value }) =>
      record('note', { text: value }, async () => {
        session.events.append(session.sessionId, 'note', { text: value })
        session.hooks.onNote?.(value)
        return { message: 'noted', content: [text(`Noted.\n${statusLine(await device.status(), session.baseUrl, budget())}`)] }
      }),
  )

  server.registerTool(
    'report_problem',
    {
      description:
        'Report something that went wrong or did not work the way you expected, in your own words. If it may already be reported, it is not filed straight away: you see the similar reports and either confirm one (confirm_problem) or report again with not_same_as.',
      inputSchema: {
        title: z.string().min(4).describe('one sentence: what is wrong'),
        what_i_did: z.string().describe('the steps you took'),
        what_i_expected: z.string(),
        what_happened: z.string(),
        how_bad: z.enum(['blocking', 'annoying', 'minor', 'cosmetic']).describe('blocking: you cannot do what you came for'),
        sure: z.boolean().describe('false if you might be misunderstanding the app'),
        kind: z.enum(['bug', 'confusing', 'layout', 'accessibility', 'copy', 'data', 'performance']).optional(),
        not_same_as: z.array(z.string()).optional().describe('ids of similar reports you were shown that are a different problem'),
      },
    },
    async (args) =>
      record('report_problem', { title: args.title, ...(args.not_same_as?.length ? { not_same_as: args.not_same_as } : {}) }, async () => {
        const draft = { title: args.title, actual: args.what_happened }
        const checked = new Set((args.not_same_as ?? []).map((id) => id.trim().toUpperCase()))
        const unchecked = session.findings.similar(draft, session.sessionId, { exclude: checked })
        // Only judgements about reports that really look alike are kept: models carry stale ids along.
        const notSameAs = session.findings
          .similar(draft, session.sessionId, { limit: 50 })
          .map((item) => item.id)
          .filter((id) => checked.has(id.toUpperCase()))
        // Sending the same report again after a hold means "file it": better than a loop that eats the budget.
        const title = normalizeText(args.title)
        const insisted = counters.held === title
        counters.held = unchecked.length && !insisted ? title : undefined
        if (unchecked.length && !insisted)
          return {
            message: `held: may be ${unchecked.map((item) => item.id).join(', ')}`,
            content: [
              text(
                `Not filed yet: this may already be reported.\n${describeSimilar(unchecked)}\nIf it is the same problem, call confirm_problem with its id and a short note on what you saw (your own report needs nothing more). If it is a different problem, call report_problem again with the same details and not_same_as: ${JSON.stringify(unchecked.map((item) => item.id))}.`,
              ),
            ],
          }
        let shotPath: string | undefined
        try {
          shotPath = await storeShot((await device.screenshot()).data, 'r')
        } catch {
          // Evidence without a picture is still evidence.
        }
        const status = await device.status()
        logSignals()
        const last = session.events.lastSeq(session.sessionId)
        const finding = session.findings.add({
          session: session.sessionId,
          title: args.title,
          whatIDid: args.what_i_did,
          expected: args.what_i_expected,
          actual: args.what_happened,
          feltSeverity: args.how_bad,
          confidence: args.sure ? 'sure' : 'unsure',
          kind: args.kind ?? 'bug',
          url: status.url,
          evidence: {
            eventSeqs: Array.from({ length: Math.min(last, 20) }, (_, index) => last - index).reverse(),
            ...(shotPath ? { screenshot: shotPath } : {}),
            signals: recentSignals(),
            ...(counters.uploaded.length ? { media: [...counters.uploaded] } : {}),
          },
          source: 'persona',
          ...(notSameAs.length ? { notSameAs } : {}),
        })
        session.hooks.onFinding?.(finding)
        return {
          message: `${finding.id} ${finding.title}`,
          content: [text(`Reported as ${finding.id}. Thank you.\n${statusLine(status, session.baseUrl, budget())}`)],
        }
      }),
  )

  server.registerTool(
    'confirm_problem',
    {
      description: 'Say that you ran into a problem that was already reported (by its id, like F-3 or K-2), with a short note on what you saw.',
      inputSchema: { id: z.string(), note: z.string().optional() },
    },
    async ({ id, note }) =>
      record('confirm_problem', { id, note }, async () => {
        const problem = session.findings.lookup(id)
        const where = async () => `\n${statusLine(await device.status(), session.baseUrl, budget())}`
        if (!problem) return { ok: false, message: `no ${id}`, content: [text(`There is no problem ${id}.${await where()}`)] }
        if (problem.session === session.sessionId)
          return { message: `own ${problem.id}`, content: [text(`${problem.id} is your own report; it already counts.${await where()}`)] }
        if (!session.findings.wouldCount(problem.id, session.sessionId))
          return { message: `already confirmed ${problem.id}`, content: [text(`You already confirmed ${problem.id}.${await where()}`)] }
        let screenshot: string | undefined
        try {
          screenshot = await storeShot((await device.screenshot()).data, 'v')
        } catch {
          // The confirmation counts without a picture.
        }
        const status = await device.status()
        const voted = session.findings.vote(problem.id, session.sessionId, { note: note ?? '', url: status.url, ...(screenshot ? { screenshot } : {}) })
        return {
          message: `confirmed ${voted?.id ?? problem.id}`,
          content: [text(`Confirmed ${problem.id} "${problem.title}".\n${statusLine(status, session.baseUrl, budget())}`)],
        }
      }),
  )

  server.registerTool(
    'finish',
    {
      description: 'End your session when you are done, have given up, or your time is up. Give an honest account and scores from 1 (worst) to 10 (best).',
      inputSchema: {
        outcome: z.enum(['completed', 'gave_up', 'blocked']),
        summary: z.string().describe('what you did, what you managed and what you did not'),
        ease: z.coerce.number().int().min(1).max(10).describe('how easy the app was to use'),
        trust: z.coerce.number().int().min(1).max(10).describe('how much you trust what it produced'),
        would_use: z.enum(['yes', 'no', 'maybe']),
        why: z.string().describe('why you would or would not use it'),
      },
    },
    async (args) =>
      record('finish', { outcome: args.outcome }, async () => {
        const diary: Diary = {
          outcome: args.outcome,
          summary: args.summary,
          ease: args.ease,
          trust: args.trust,
          wouldUse: args.would_use,
          why: args.why,
          t: new Date().toISOString(),
        }
        session.events.append(session.sessionId, 'diary', { ...diary })
        session.hooks.onFinish?.(diary)
        return { message: `finish: ${args.outcome}`, content: [text('Thank you. Your session is over; you can stop now.')] }
      }),
  )

  return server
}
