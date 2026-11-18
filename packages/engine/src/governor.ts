import { type MemorySample, sampleMemory } from '@persona-swarm/core'

export type GovernorLevel = 'ok' | 'tight' | 'critical'

export interface GovernorLimits {
  minFreeMemoryPercent: number
  stopBelowFreeMemoryPercent: number
}

/**
 * Watches free memory and tells the scheduler what it may do. It never lets a run take the machine
 * down: below the start threshold nothing new starts; below the stop threshold sessions are paused.
 */
export class Governor {
  level: GovernorLevel = 'ok'
  freePercent = 100
  samples = 0
  private timer?: NodeJS.Timeout
  private sampling = false

  constructor(
    private readonly limits: GovernorLimits,
    private readonly onChange: (level: GovernorLevel, sample: MemorySample) => void,
    private readonly sampler: () => Promise<MemorySample> = sampleMemory,
    /** Every sample, for live views (the level callback fires only on changes and when critical). */
    private readonly onSample?: (sample: MemorySample, level: GovernorLevel) => void,
  ) {}

  async sample(): Promise<MemorySample> {
    const sample = await this.sampler()
    this.samples += 1
    this.freePercent = Math.round(sample.freePercent * 10) / 10
    const next: GovernorLevel =
      sample.freePercent < this.limits.stopBelowFreeMemoryPercent ? 'critical' : sample.freePercent < this.limits.minFreeMemoryPercent ? 'tight' : 'ok'
    const changed = next !== this.level
    this.level = next
    this.onSample?.(sample, next)
    if (changed || next === 'critical') this.onChange(next, sample)
    return sample
  }

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => {
      if (this.sampling) return
      this.sampling = true
      void this.sample()
        .catch(() => {})
        .finally(() => {
          this.sampling = false
        })
    }, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
