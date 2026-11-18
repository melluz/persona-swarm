import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { freemem, platform, totalmem } from 'node:os'

export interface MemorySample {
  /** Percentage of memory available to new work (0 to 100). */
  freePercent: number
  totalBytes: number
  source: 'memory_pressure' | 'vm_stat' | 'meminfo' | 'os'
}

function run(command: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout) => (error ? reject(error) : resolveRun(stdout)))
  })
}

/** Parses `memory_pressure` output: "System-wide memory free percentage: 42%". */
export function parseMemoryPressure(output: string): number | undefined {
  const match = /free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(output)
  return match ? Number(match[1]) : undefined
}

/** Parses `vm_stat`: available = free + inactive + speculative + purgeable pages. */
export function parseVmStat(output: string, totalBytes: number): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 4096)
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(output)?.[1] ?? 0)
  const available = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize
  if (!available || !totalBytes) return undefined
  return Math.max(0, Math.min(100, (available / totalBytes) * 100))
}

/** Parses /proc/meminfo: MemAvailable / MemTotal. */
export function parseMeminfo(text: string): number | undefined {
  const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? Number.NaN)
  const available = field('MemAvailable')
  const total = field('MemTotal')
  if (!Number.isFinite(available) || !Number.isFinite(total) || total === 0) return undefined
  return (available / total) * 100
}

/**
 * Samples memory the way the operating system judges pressure. On macOS, `os.freemem()` ignores
 * reclaimable pages and reads far too low; `memory_pressure` is what the system itself reports.
 */
export async function sampleMemory(): Promise<MemorySample> {
  const totalBytes = totalmem()
  const os = platform()
  if (os === 'darwin') {
    try {
      const value = parseMemoryPressure(await run('memory_pressure', []))
      if (value !== undefined) return { freePercent: value, totalBytes, source: 'memory_pressure' }
    } catch {
      // Fall through to vm_stat.
    }
    try {
      const value = parseVmStat(await run('vm_stat', []), totalBytes)
      if (value !== undefined) return { freePercent: value, totalBytes, source: 'vm_stat' }
    } catch {
      // Fall through to os.freemem.
    }
  } else if (os === 'linux') {
    try {
      const value = parseMeminfo(await readFile('/proc/meminfo', 'utf8'))
      if (value !== undefined) return { freePercent: value, totalBytes, source: 'meminfo' }
    } catch {
      // Fall through.
    }
  }
  return { freePercent: (freemem() / totalBytes) * 100, totalBytes, source: 'os' }
}
