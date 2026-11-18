import type { Traits, VisionTrait } from './schemas/config.js'
import type { DeviceOverrides } from './schemas/device.js'

/**
 * Body traits as the harness enforces them. The functions here are device-neutral: they change what a
 * persona's action does (where a click lands, what gets typed), so any device gets the same person.
 */

/** Deterministic pseudo-random numbers (mulberry32): a session's slips can be replayed from its seed. */
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

/** A stable seed from text (a session id): the same session slips the same way every time. */
export function seedFrom(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return hash >>> 0
}

/** The device settings a vision trait stands for. A persona's own deviceOverrides win over these. */
export function visionOverrides(vision: VisionTrait | undefined): DeviceOverrides {
  if (!vision || vision === 'normal') return {}
  if (typeof vision === 'string')
    switch (vision) {
      case 'low':
        return { zoom: 2, contrast: 'more' }
      case 'blurred':
        return { visionDeficiency: 'blurredVision' }
      case 'high-contrast':
        return { forcedColors: 'active', contrast: 'more' }
      default:
        return { visionDeficiency: vision }
    }
  return {
    ...(vision.zoom && vision.zoom > 1 ? { zoom: vision.zoom } : {}),
    ...(vision.deficiency && vision.deficiency !== 'none' ? { visionDeficiency: vision.deficiency } : {}),
    ...(vision.highContrast ? { forcedColors: 'active' as const, contrast: 'more' as const } : {}),
  }
}

/** The body traits the tool server acts on, with their neutral values filled in. */
export interface Body {
  precision: number
  pace: 'rushes' | 'normal' | 'slow'
  typing: 'careful' | 'typos' | 'pastes'
  interruptions: 'none' | 'some' | 'many'
  multitab: boolean
}

export function bodyOf(traits: Traits | undefined): Body {
  return {
    precision: traits?.precision ?? 5,
    pace: traits?.pace ?? 'normal',
    typing: traits?.typing ?? 'careful',
    interruptions: traits?.interruptions ?? 'none',
    multitab: traits?.multitab ?? false,
  }
}

/** Whether a body changes anything at all (a default body is left out of the logs). */
export function isNeutralBody(body: Body): boolean {
  return body.precision === 5 && body.pace === 'normal' && body.typing === 'careful' && body.interruptions === 'none' && !body.multitab
}

/** Typical miss, in CSS pixels, by precision: a steady hand at 5, a tremor at 1. */
const AIM_SPREAD: Record<number, number> = { 1: 14, 2: 8, 3: 4, 4: 2, 5: 0 }
/** The chance a single click or tap comes out as two, by precision. */
const DOUBLE_CHANCE: Record<number, number> = { 1: 0.12, 2: 0.06 }

/** A standard normal number (Box–Muller). */
function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

/**
 * Where a pointer aimed at `point` lands for a hand of this precision, kept on the screen. Misses are
 * normally distributed around the aim and capped at three spreads.
 */
export function aim(
  point: { x: number; y: number },
  precision: number,
  random: () => number,
  viewport: { width: number; height: number },
): { x: number; y: number; dx: number; dy: number } {
  const spread = AIM_SPREAD[precision] ?? 0
  if (!spread) return { ...point, dx: 0, dy: 0 }
  const offset = () => Math.round(Math.max(-3 * spread, Math.min(3 * spread, gaussian(random) * spread)))
  const x = Math.max(0, Math.min(viewport.width - 1, point.x + offset()))
  const y = Math.max(0, Math.min(viewport.height - 1, point.y + offset()))
  return { x, y, dx: x - point.x, dy: y - point.y }
}

/** Whether this single click or tap slips into a double one. */
export function slipsIntoDouble(precision: number, random: () => number): boolean {
  return random() < (DOUBLE_CHANCE[precision] ?? 0)
}

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm']

/** Keys next to a letter on a QWERTY keyboard (same row, and the rows above and below). */
function neighbours(letter: string): string {
  const lower = letter.toLowerCase()
  const row = KEYBOARD_ROWS.findIndex((keys) => keys.includes(lower))
  if (row < 0) return ''
  const column = KEYBOARD_ROWS[row]?.indexOf(lower) ?? 0
  let near = ''
  for (const each of [row - 1, row, row + 1]) {
    const keys = KEYBOARD_ROWS[each]
    if (!keys) continue
    for (const at of [column - 1, column, column + 1]) {
      const key = keys[at]
      if (key && key !== lower) near += key
    }
  }
  return near
}

/** The share of words of three letters or more that get one typo. */
const TYPO_RATE = 0.12

/**
 * Text as a person who makes typos types it: some words get one slip (a neighbouring key, a doubled
 * or dropped letter, two letters swapped). Slips are not corrected; the person may notice them on the
 * screen. Returns the text and a description of each slip for the log.
 */
export function withTypos(text: string, random: () => number): { text: string; slips: string[] } {
  const slips: string[] = []
  const out = text.replace(/\p{L}{3,}/gu, (word) => {
    if (random() >= TYPO_RATE) return word
    const at = 1 + Math.floor(random() * (word.length - 1))
    const kind = Math.floor(random() * 4)
    let slipped = word
    if (kind === 0) {
      const near = neighbours(word[at] ?? '')
      if (!near) return word
      const key = near[Math.floor(random() * near.length)] ?? ''
      slipped = word.slice(0, at) + (word[at] === word[at]?.toUpperCase() ? key.toUpperCase() : key) + word.slice(at + 1)
    } else if (kind === 1) slipped = word.slice(0, at) + word[at] + word.slice(at)
    else if (kind === 2) slipped = word.slice(0, at) + word.slice(at + 1)
    else slipped = word.slice(0, at - 1) + word[at] + word[at - 1] + word.slice(at + 1)
    if (slipped !== word) slips.push(`${word} → ${slipped}`)
    return slipped
  })
  return { text: out, slips }
}

/**
 * Text as it arrives when pasted from a document or an email: typographic quotes and apostrophes,
 * sometimes a non-breaking space between words, often a stray space at either end.
 */
export function asPasted(text: string, random: () => number): { text: string; slips: string[] } {
  const slips: string[] = []
  let out = text
    .replace(/(^|[\s(])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/'/g, '’')
  if (out !== text) slips.push('typographic quotes')
  if (/\S \S/.test(out) && random() < 0.2) {
    out = out.replace(/(\S) (\S)/, '$1 $2')
    slips.push('a non-breaking space')
  }
  if (random() < 0.25) {
    out = ` ${out}`
    slips.push('a leading space')
  }
  if (random() < 0.6) {
    out = `${out} `
    slips.push('a trailing space')
  }
  return { text: out, slips }
}

/** How long a person of this pace looks before acting, in ms. */
export function thinkingMs(pace: Body['pace'], random: () => number): number {
  return pace === 'slow' ? Math.round(2_500 + random() * 4_500) : 0
}

export type InterruptionKind = 'away' | 'offline' | 'reload' | 'reopen'

const INTERRUPTION_CHANCE: Record<Body['interruptions'], number> = { none: 0, some: 0.06, many: 0.15 }
const INTERRUPTION_GAP: Record<Body['interruptions'], number> = { none: Number.POSITIVE_INFINITY, some: 6, many: 4 }

/**
 * Whether the persona is interrupted before this action: never in its first few actions, never twice
 * in a row, then at random at the trait's rate.
 */
export function interruptionDue(level: Body['interruptions'], action: number, sinceLast: number, random: () => number): boolean {
  if (level === 'none' || action < 4 || sinceLast < INTERRUPTION_GAP[level]) return false
  return random() < INTERRUPTION_CHANCE[level]
}

export function pickInterruption(random: () => number): InterruptionKind {
  const kinds: InterruptionKind[] = ['away', 'offline', 'reload', 'reopen']
  return kinds[Math.floor(random() * kinds.length)] ?? 'away'
}
