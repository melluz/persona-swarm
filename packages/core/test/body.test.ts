import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  aim,
  asPasted,
  bodyOf,
  describeDevice,
  interruptionDue,
  isNeutralBody,
  layoutViewport,
  loadPersona,
  resolveDeviceProfile,
  seededRandom,
  seedFrom,
  slipsIntoDouble,
  Traits,
  thinkingMs,
  visionOverrides,
  withTypos,
} from '../src/index.js'

const LIBRARY = join(__dirname, '../../../personas')

describe('persona traits', () => {
  it('loads every persona in the library', () => {
    const files = readdirSync(LIBRARY).filter((name) => name.endsWith('.yaml'))
    expect(files.length).toBeGreaterThanOrEqual(13)
    for (const file of files) expect(() => loadPersona(join(LIBRARY, file)), file).not.toThrow()
  })

  it('rejects unknown traits and out-of-range levels', () => {
    expect(() => Traits.parse({ patienc: 2 })).toThrow()
    expect(() => Traits.parse({ precision: 6 })).toThrow()
    expect(() => Traits.parse({ language: { native: 'es' } })).toThrow()
    expect(Traits.parse({ vision: { zoom: 1.5, deficiency: 'tritanopia' } }).vision).toEqual({ zoom: 1.5, deficiency: 'tritanopia' })
  })

  it('turns vision into device settings, which a persona can still override', () => {
    expect(visionOverrides('low')).toEqual({ zoom: 2, contrast: 'more' })
    expect(visionOverrides('deuteranopia')).toEqual({ visionDeficiency: 'deuteranopia' })
    expect(visionOverrides('high-contrast')).toEqual({ forcedColors: 'active', contrast: 'more' })
    expect(visionOverrides({ zoom: 1.5, highContrast: true })).toEqual({ zoom: 1.5, forcedColors: 'active', contrast: 'more' })
    expect(visionOverrides('normal')).toEqual({})
    const profile = resolveDeviceProfile('desktop-1440', { ...visionOverrides('low'), zoom: 1.5 }, { maxDeviceScaleFactor: 1 })
    expect(profile.zoom).toBe(1.5)
    expect(layoutViewport(profile)).toEqual({ width: 960, height: 600 })
    expect(describeDevice(profile)).toContain('zoomed to 150 %')
    expect(describeDevice(resolveDeviceProfile('laptop-1280', visionOverrides('protanopia'), { maxDeviceScaleFactor: 1 }))).toContain('protanopia')
  })

  it('fills in a neutral body for traits that are left out', () => {
    expect(isNeutralBody(bodyOf(undefined))).toBe(true)
    expect(bodyOf({ precision: 2, multitab: true })).toMatchObject({ precision: 2, multitab: true, pace: 'normal', typing: 'careful' })
    expect(isNeutralBody(bodyOf({ pace: 'slow' }))).toBe(false)
  })
})

describe('body slips', () => {
  const viewport = { width: 800, height: 600 }

  it('is the same for the same seed', () => {
    const one = seededRandom(seedFrom('run/ana'))
    const two = seededRandom(seedFrom('run/ana'))
    expect([one(), one(), one()]).toEqual([two(), two(), two()])
    expect(seedFrom('run/ana')).not.toBe(seedFrom('run/ben'))
  })

  it('lands a steady hand on target and a shaky one near it, on the screen', () => {
    const random = seededRandom(1)
    expect(aim({ x: 100, y: 100 }, 5, random, viewport)).toEqual({ x: 100, y: 100, dx: 0, dy: 0 })
    const misses = Array.from({ length: 200 }, () => aim({ x: 400, y: 300 }, 1, random, viewport))
    expect(misses.some((miss) => miss.dx || miss.dy)).toBe(true)
    expect(Math.max(...misses.map((miss) => Math.abs(miss.dx)))).toBeLessThanOrEqual(42)
    const corner = Array.from({ length: 50 }, () => aim({ x: 0, y: 599 }, 1, random, viewport))
    for (const point of corner) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThan(600)
    }
  })

  it('double-clicks by accident only with unsteady hands', () => {
    const random = seededRandom(2)
    const count = (precision: number) => Array.from({ length: 1000 }, () => slipsIntoDouble(precision, random)).filter(Boolean).length
    expect(count(5)).toBe(0)
    expect(count(3)).toBe(0)
    expect(count(1)).toBeGreaterThan(60)
  })

  it('misspells some words and says which', () => {
    const random = seededRandom(3)
    const text = 'Please deliver the large ceramic order to the warehouse tomorrow morning before lunchtime'
    let slips = 0
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const typed = withTypos(text, random)
      slips += typed.slips.length
      expect(typed.text === text).toBe(typed.slips.length === 0)
    }
    expect(slips).toBeGreaterThan(5)
    expect(withTypos('42 1.5', random)).toEqual({ text: '42 1.5', slips: [] })
  })

  it('pastes with typographic quotes and stray spaces', () => {
    const random = seededRandom(4)
    const pasted = Array.from({ length: 30 }, () => asPasted(`O'Brien said "yes"`, random))
    expect(pasted.every((each) => each.text.includes('O’Brien') && each.text.includes('“yes”'))).toBe(true)
    expect(pasted.some((each) => each.text.endsWith(' '))).toBe(true)
  })

  it('thinks only when slow, and is interrupted only after a few actions and a gap', () => {
    const random = seededRandom(5)
    expect(thinkingMs('normal', random)).toBe(0)
    expect(thinkingMs('slow', random)).toBeGreaterThanOrEqual(2_500)
    expect(interruptionDue('none', 50, 50, () => 0)).toBe(false)
    expect(interruptionDue('many', 2, 50, () => 0)).toBe(false)
    expect(interruptionDue('many', 20, 2, () => 0)).toBe(false)
    expect(interruptionDue('many', 20, 10, () => 0)).toBe(true)
    expect(interruptionDue('some', 20, 10, () => 0.5)).toBe(false)
  })
})
