import { describe, expect, it } from 'vitest'
import { formatBudget, PersonaBudget, sessionBudget, Traits } from '../src/index.js'

const base = { minutes: 10, turns: 100 }
const persona = (proficiency: number, traits: Record<string, unknown> = {}, budget?: Record<string, unknown>) => ({
  proficiency,
  traits: Traits.parse(traits),
  ...(budget ? { budget: PersonaBudget.parse(budget) } : {}),
})

describe('sessionBudget', () => {
  it('keeps the baseline for a confident persona with no traits that cost time', () => {
    expect(sessionBudget(persona(4), { base })).toMatchObject({ minutes: 10, turns: 100 })
  })

  it('gives novices more of both, interruptions more minutes and slow thinkers their thinking time', () => {
    expect(sessionBudget(persona(1), { base })).toMatchObject({ minutes: 15, turns: 150 })
    expect(sessionBudget(persona(2), { base })).toMatchObject({ minutes: 13, turns: 130 })
    expect(sessionBudget(persona(4, { interruptions: 'many' }), { base })).toMatchObject({ minutes: 12.5, turns: 100 })
    // 100 actions × 4.75 s of thinking ≈ 8 min on top.
    const slow = sessionBudget(persona(4, { pace: 'slow' }), { base })
    expect(slow).toMatchObject({ minutes: 18, turns: 100 })
    expect(slow.why).toContain('+8 min thinking (slow pace)')
  })

  it('can leave the traits out of it', () => {
    expect(sessionBudget(persona(1, { pace: 'slow' }), { base, scaleByTraits: false })).toMatchObject({ minutes: 10, turns: 100 })
  })

  it('applies the persona file and then the cohort', () => {
    expect(sessionBudget(persona(4, {}, { scale: 2 }), { base })).toMatchObject({ minutes: 20, turns: 200 })
    expect(sessionBudget(persona(2, {}, { minutes: 25 }), { base })).toMatchObject({ minutes: 25, turns: 130 })
    // The cohort's absolute values win over the persona's, and its scale multiplies.
    expect(sessionBudget(persona(2, {}, { minutes: 25 }), { base, cohort: { minutes: 40 } })).toMatchObject({ minutes: 40 })
    expect(sessionBudget(persona(4, {}, { scale: 2 }), { base, cohort: { scale: 0.5 } })).toMatchObject({ minutes: 10, turns: 100 })
    // Fixed minutes are not topped up with thinking time.
    expect(sessionBudget(persona(4, { pace: 'slow' }), { base, cohort: { minutes: 12 } }).minutes).toBe(12)
  })

  it('lets the command line replace the baseline and every absolute value, keeping the scales', () => {
    const budget = sessionBudget(persona(2, {}, { minutes: 25, turns: 300 }), { base, run: { minutes: 4, turns: 20 }, cohort: { minutes: 40 } })
    expect(budget).toMatchObject({ minutes: 5, turns: 26 })
    expect(budget.why[0]).toBe('4 min from the command line')
    expect(formatBudget(budget)).toBe('5 min · 26 actions')
  })
})
