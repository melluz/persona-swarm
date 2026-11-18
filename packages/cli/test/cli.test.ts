import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const main = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/main.js')
const cli = (args: string[], cwd?: string) => spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', ...(cwd ? { cwd } : {}), timeout: 30_000 })

describe('the persona-swarm command', () => {
  it('refuses a number flag given without a value, rather than taking it as 1', () => {
    const result = cli(['fixture', '--port'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--port needs a value')
  })

  it('lists runs past stray files in the runs folder', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ps-cli-'))
    const runId = '20261018-100000-abcd'
    mkdirSync(join(workspace, 'runs', runId), { recursive: true })
    // Opening the folder in Finder leaves a file there; it is not a run.
    writeFileSync(join(workspace, 'runs', '.DS_Store'), 'x')
    writeFileSync(join(workspace, 'runs', 'notes.txt'), 'x')
    writeFileSync(
      join(workspace, 'runs', runId, 'run.json'),
      JSON.stringify({
        runId,
        status: 'finished',
        target: { name: 'Shop' },
        cohort: { id: 'c' },
        sessions: {},
        totals: { findings: 2, costUsd: 0 },
        governor: { level: 'ok', freePercent: 50, samples: 1 },
      }),
    )
    const result = cli(['status'], workspace)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`${runId}  finished`)
    expect(cli(['status', runId], workspace).status).toBe(0)
  })
})
