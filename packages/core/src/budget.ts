import type { Persona, PersonaBudget } from './schemas/config.js'

/** Seconds a slow persona thinks before an action, on average (see `thinkingMs`). */
const SLOW_THINKING_SEC = 4.75

/** More minutes and actions for people who take more wrong turns, by proficiency. */
const PROFICIENCY_SCALE: Record<number, number> = { 1: 1.5, 2: 1.3 }

/** More minutes for time spent away, by interruptions. */
const INTERRUPTION_SCALE: Record<string, number> = { some: 1.1, many: 1.25 }

export interface SessionBudget {
  minutes: number
  turns: number
  /** How the budget came about, in a few words each ("10 min baseline", "×1.3 proficiency 2"). */
  why: string[]
}

export interface BudgetInputs {
  /** The cohort's minutesPerPersona and turnsPerPersona. */
  base: { minutes: number; turns: number }
  /** From the command line: replaces the baseline and every file's absolute values. */
  run?: { minutes?: number | undefined; turns?: number | undefined }
  /** The cohort's `budgets.personas` entry for this persona. */
  cohort?: PersonaBudget | undefined
  /** Scale by proficiency, pace and interruptions (the cohort's `budgets.scaleByTraits`, default true). */
  scaleByTraits?: boolean
}

const roundMinutes = (value: number) => Math.max(0.5, Math.round(value * 2) / 2)

/**
 * A persona's own budget. Absolute values (the cohort's per-persona entry first, then the persona file's
 * `budget`) are used as they are. Otherwise the baseline is scaled: by the persona's traits (proficiency
 * 1–2 more of both, interruptions more minutes), by the persona file's and the cohort's `scale`, and a
 * slow persona gets the minutes its thinking takes on top. The command line's minutes and turns replace
 * the baseline and every absolute value, so a quick run stays quick; scales still apply.
 */
export function sessionBudget(persona: Pick<Persona, 'proficiency' | 'traits' | 'budget'>, inputs: BudgetInputs): SessionBudget {
  const scaleTraits = inputs.scaleByTraits ?? true
  const own = persona.budget
  const factors: { value: number; label: string; minutesOnly?: boolean }[] = []
  if (scaleTraits) {
    const byProficiency = PROFICIENCY_SCALE[persona.proficiency]
    if (byProficiency) factors.push({ value: byProficiency, label: `proficiency ${persona.proficiency}` })
    const byInterruptions = INTERRUPTION_SCALE[persona.traits.interruptions ?? 'none']
    if (byInterruptions) factors.push({ value: byInterruptions, label: `interruptions ${persona.traits.interruptions}`, minutesOnly: true })
  }
  if (own?.scale && own.scale !== 1) factors.push({ value: own.scale, label: 'persona scale' })
  if (inputs.cohort?.scale && inputs.cohort.scale !== 1) factors.push({ value: inputs.cohort.scale, label: 'cohort scale' })

  const resolve = (kind: 'minutes' | 'turns'): { value: number; why: string[] } => {
    const unit = kind === 'minutes' ? 'min' : 'actions'
    const fromRun = inputs.run?.[kind]
    const fixed = fromRun === undefined ? (inputs.cohort?.[kind] ?? own?.[kind]) : undefined
    if (fixed !== undefined) return { value: fixed, why: [`${fixed} ${unit} set by the ${inputs.cohort?.[kind] !== undefined ? 'cohort' : 'persona'}`] }
    let value = fromRun ?? inputs.base[kind]
    const reasons = [`${value} ${unit} ${fromRun === undefined ? 'baseline' : 'from the command line'}`]
    for (const factor of factors) {
      if (factor.minutesOnly && kind === 'turns') continue
      value *= factor.value
      reasons.push(`×${factor.value} ${factor.label}`)
    }
    return { value: kind === 'minutes' ? value : Math.max(1, Math.round(value)), why: reasons }
  }

  const turns = resolve('turns')
  const minutes = resolve('minutes')
  // Thinking uses the session's time: a slow persona gets it on top, unless its minutes were fixed.
  const fixedMinutes = inputs.run?.minutes === undefined && (inputs.cohort?.minutes ?? own?.minutes) !== undefined
  if (scaleTraits && persona.traits.pace === 'slow' && !fixedMinutes) {
    const thinking = (turns.value * SLOW_THINKING_SEC) / 60
    minutes.value += thinking
    minutes.why.push(`+${roundMinutes(thinking)} min thinking (slow pace)`)
  }
  return { minutes: roundMinutes(minutes.value), turns: turns.value, why: [...minutes.why, ...turns.why] }
}

/** "14 min · 120 actions", for plans and status lines. */
export function formatBudget(budget: Pick<SessionBudget, 'minutes' | 'turns'>): string {
  return `${budget.minutes} min · ${budget.turns} actions`
}
