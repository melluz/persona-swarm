import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyUsage, type RunState } from '@persona-swarm/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiServer, startApiServer } from '../src/index.js'

const runsDir = mkdtempSync(join(tmpdir(), 'ps-server-'))
const runId = '20261017-120000-beef'
let server: ApiServer

/** A raw request, so paths and headers are sent exactly as written (fetch would normalise them). */
function raw(url: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<number> {
  const { hostname, port } = new URL(url)
  return new Promise((resolveRequest, reject) => {
    request({ hostname, port, path, method: options.method ?? 'GET', headers: options.headers ?? {} }, (res) => {
      res.resume()
      resolveRequest(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end(options.body)
  })
}
const rawGet = (url: string, path: string) => raw(url, path)
const post = (path: string, body: unknown = {}) =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  const dir = join(runsDir, runId)
  mkdirSync(join(dir, 'shots', 's1'), { recursive: true })
  writeFileSync(join(runsDir, 'secret.txt'), 'outside the run')
  writeFileSync(join(dir, 'shots', 's1', 'a0001.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
  mkdirSync(join(dir, 'bridge'))
  writeFileSync(join(dir, 'bridge', 's1.json'), '{"mcp":{"headers":{"Authorization":"Bearer secret"}}}')
  writeFileSync(join(dir, 'report.html'), '<!doctype html><title>report</title>')
  const state: RunState = {
    runId,
    version: 1,
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T12:05:00.000Z',
    status: 'finished',
    mode: 'explore',
    cohort: { id: 'c', file: '/nowhere/cohort.yaml' },
    target: { id: 't', name: 'Shop', baseUrl: 'http://app' },
    host: { platform: 'test', node: 'v22', tool: 'persona-swarm', pid: 1 },
    governor: { level: 'ok', freePercent: 50, samples: 1 },
    budgets: { minutesPerPersona: 10, turnsPerPersona: 50 },
    limits: { maxBrowsers: 1, maxAgents: 1, minFreeMemoryPercent: 10, stopBelowFreeMemoryPercent: 5 },
    sessions: {},
    totals: { ...emptyUsage(), findings: 1 },
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify(state))
  writeFileSync(
    join(dir, 'findings.jsonl'),
    `${JSON.stringify({ type: 'finding', id: 'F-1', session: 's1', t: '2026-10-17T12:01:00.000Z', title: 'Save does nothing', whatIDid: 'x', expected: 'y', actual: 'z', feltSeverity: 'annoying', confidence: 'sure', kind: 'bug', url: '', evidence: { eventSeqs: [], signals: [] }, votes: [], source: 'persona' })}\n`,
  )
  server = await startApiServer({ runsDir })
})
afterAll(async () => {
  await server?.close()
})

describe('API server', () => {
  it('lists runs and serves the UI', async () => {
    const runs = (await (await fetch(`${server.url}/api/runs`)).json()) as { runId: string; findings: number }[]
    expect(runs).toMatchObject([{ runId, findings: 1 }])
    const page = await fetch(`${server.url}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('persona<span>·</span>swarm')
    expect((await fetch(`${server.url}/ui/app.js`)).status).toBe(200)
  })

  it('records a review and returns it with the findings', async () => {
    const posted = await post(`/api/runs/${runId}/findings/F-1/review`, { status: 'approved', severity: 'major', note: 'confirmed' })
    expect(posted.status).toBe(200)
    const data = (await (await fetch(`${server.url}/api/runs/${runId}/findings`)).json()) as { reviews: Record<string, { status: string; severity: string }> }
    expect(data.reviews['F-1']).toMatchObject({ status: 'approved', severity: 'major' })
    const bad = await post(`/api/runs/${runId}/findings/F-1/review`, { status: 'maybe' })
    expect(bad.status).toBe(400)
  })

  it('serves only the files the UI shows, as inert data', async () => {
    const shot = await fetch(`${server.url}/api/runs/${runId}/files/shots/s1/a0001.jpg`)
    expect(shot.headers.get('content-type')).toBe('image/jpeg')
    expect(shot.headers.get('x-content-type-options')).toBe('nosniff')
    const report = await fetch(`${server.url}/api/runs/${runId}/files/report.html`)
    expect(report.headers.get('content-security-policy')).toMatch(/^sandbox/)
    // Bridge files hold endpoint tokens; logs and briefs are not for the browser either.
    expect(await rawGet(server.url, `/api/runs/${runId}/files/bridge/s1.json`)).toBe(404)
    expect(await rawGet(server.url, `/api/runs/${runId}/files/run.json`)).toBe(404)
    expect(await rawGet(server.url, `/api/runs/${runId}/files/../secret.txt`)).toBe(404)
    expect(await rawGet(server.url, `/api/runs/${runId}/files/%2e%2e/secret.txt`)).toBe(404)
    expect(await rawGet(server.url, '/api/runs/..%2f/findings')).not.toBe(200)
    // An encoded slash inside one segment must not pass the allow-list as a path.
    expect(await rawGet(server.url, `/api/runs/${runId}/files/downloads/%2e%2e%2frun.json`)).toBe(404)
    expect(await rawGet(server.url, `/api/runs/${runId}/files/downloads/x/..%5C..%5Cbridge%5Cs1.json`)).toBe(404)
    expect(await rawGet(server.url, '/api/runs/../findings')).not.toBe(200)
  })

  it('answers only its own pages: no other host names, no cross-site writes', async () => {
    const { port } = new URL(server.url)
    expect((await fetch(`${server.url}/`)).headers.get('content-security-policy')).toContain("script-src 'self'")
    // A DNS-rebinding page reaches the server under its own name.
    expect(await raw(server.url, '/api/runs', { headers: { host: `evil.example:${port}` } })).toBe(403)
    expect(await raw(server.url, '/api/runs', { headers: { host: `localhost:${port}` } })).toBe(200)
    // Through an SSH tunnel that forwards another local port, the name is still this machine's.
    expect(await raw(server.url, '/api/runs', { headers: { host: 'localhost:8080' } })).toBe(200)
    const review = `/api/runs/${runId}/findings/F-1/review`
    const body = JSON.stringify({ status: 'rejected' })
    expect(await raw(server.url, review, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).toBe(403)
    expect(await raw(server.url, review, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body })).toBe(403)
    expect(await raw(server.url, review, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body })).toBe(403)
  })

  it("splits a group on a reviewer's word, and refuses ids the run does not have", async () => {
    const dir = join(runsDir, runId)
    const twin = {
      type: 'finding',
      id: 'F-2',
      session: 's2',
      t: '2026-10-17T12:02:00.000Z',
      title: 'Save does nothing at all',
      whatIDid: 'x',
      expected: 'y',
      actual: 'z',
      feltSeverity: 'annoying',
      confidence: 'sure',
      kind: 'bug',
      url: '',
      evidence: { eventSeqs: [], signals: [] },
      votes: [],
      source: 'persona',
    }
    writeFileSync(join(dir, 'findings.jsonl'), `${readFileSync(join(dir, 'findings.jsonl'), 'utf8')}${JSON.stringify(twin)}\n`)
    expect((await (await post(`/api/runs/${runId}/triage`)).json()).totals.clusters).toBe(1)
    const split = await post(`/api/runs/${runId}/findings/F-2/apart`, { from: 'F-1' })
    expect(await split.json()).toEqual({ clusters: 2 })
    const data = (await (await fetch(`${server.url}/api/runs/${runId}/findings`)).json()) as { reviews: Record<string, { apartFrom?: string[] }> }
    expect(data.reviews['F-1']?.apartFrom).toEqual(['F-2'])
    expect((await post(`/api/runs/${runId}/findings/F-2/apart`, { from: 'F-77' })).status).toBe(400)
  })

  it('reports a port in use instead of crashing the process', async () => {
    const { port } = new URL(server.url)
    await expect(startApiServer({ runsDir, port: Number(port) })).rejects.toThrow(/EADDRINUSE/)
  })

  it('refuses to stop a run that is not live in this process', async () => {
    expect((await post(`/api/runs/${runId}/stop`)).status).toBe(409)
  })
})
