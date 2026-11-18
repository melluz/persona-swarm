import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCohort } from '@persona-swarm/core'
import { buildPlan } from '@persona-swarm/engine'
import { describe, expect, it } from 'vitest'
import { scaffold } from '../src/init.js'

describe('init', () => {
  it('scaffolds a workspace whose cohorts load and plan as they are', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ps-init-')), 'workspace')
    const written = scaffold(dir)
    expect(written.length).toBeGreaterThan(10)
    const cohorts = readdirSync(join(dir, 'cohorts'))
    expect(cohorts.length).toBeGreaterThan(0)
    for (const file of cohorts) expect(buildPlan(loadCohort(join(dir, 'cohorts', file))).sessions.length).toBeGreaterThan(0)
  })

  it('treats a key with nothing after it as not set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-init-'))
    writeFileSync(join(dir, 'persona-swarm.yaml'), 'providers:\n  # local: { type: openai-compatible }\nprices:\n')
    writeFileSync(join(dir, 'target.yaml'), 'id: app\nname: App\nbaseUrl: http://localhost:1\nfixtures:\n')
    writeFileSync(join(dir, 'p.yaml'), 'id: p\nname: P\nproficiency: 3\nbackground: x\nmission: { goal: y }\ndevice: laptop-1280\n')
    writeFileSync(join(dir, 'cohort.yaml'), 'id: c\ntarget: target.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock } }\n')
    const loaded = loadCohort(join(dir, 'cohort.yaml'))
    expect(loaded.workspace.config.providers).toEqual({})
    expect(loaded.target.target.fixtures).toEqual([])
  })
})
