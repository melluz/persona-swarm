import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCohort, readJsonLines } from '@persona-swarm/core'
import { buildPlan, Orchestrator } from '@persona-swarm/engine'
import { type FixtureApp, startFixtureApp } from '@persona-swarm/fixture-app'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { estimateTokens, modelCapabilities, pruneImages, resolveModel, summaryCut } from '../src/index.js'
import { type FakeModel, startFakeModel } from './fake-openai.js'

const here = dirname(fileURLToPath(import.meta.url))
const driverMain = resolve(here, '../dist/main.js')
let app: FixtureApp
let model: FakeModel

beforeAll(async () => {
  app = await startFixtureApp()
  model = await startFakeModel([
    { name: 'screenshot', args: {}, say: 'Let me look at the screen.' },
    { name: 'note', args: { text: 'A sign-in page. I will look at the outline.' } },
    // Arguments that are not JSON: the SDK answers this call itself, and the driver must not answer it again.
    { name: 'note', args: {}, rawArgs: '{"text": "half a thought' },
    { name: 'outline', args: {} },
    {
      name: 'report_problem',
      args: {
        title: 'Sign-in page has no help link',
        what_i_did: 'Looked for help',
        what_i_expected: 'A help link',
        what_happened: 'None',
        how_bad: 'minor',
        sure: false,
      },
    },
    { name: 'finish', args: { outcome: 'completed', summary: 'Looked around.', ease: 7, trust: 6, would_use: 'maybe', why: 'Simple.' } },
  ])
})
afterAll(async () => {
  await model?.close()
  await app?.close()
})

describe('model resolution', () => {
  it('resolves built-in and workspace providers and infers capabilities', () => {
    expect(resolveModel('anthropic:claude-sonnet-4-5', {}).type).toBe('anthropic')
    expect(modelCapabilities(resolveModel('ollama:qwen2.5vl:7b', {})).imageInput).toBe(true)
    expect(modelCapabilities(resolveModel('ollama:llama3.1:8b', {})).imageInput).toBe(false)
    const local = resolveModel('lab:my-model', { providers: { lab: { type: 'openai-compatible', baseURL: 'http://x/v1', vision: true, contextWindow: 8192 } } })
    expect(modelCapabilities(local)).toMatchObject({ imageInput: true, contextWindow: 8192 })
    expect(() => resolveModel('gpt-5', {})).toThrow(/provider:model/)
  })

  it('prunes old screenshots and never cuts between a tool call and its result', () => {
    const image = () => ({ role: 'user' as const, content: [{ type: 'image' as const, image: 'aGk=', mediaType: 'image/jpeg' }] })
    const messages = [image(), image(), image(), image()]
    expect(pruneImages(messages, 2)).toBe(2)
    expect(estimateTokens(messages)).toBeLessThan(4000)
    const convo = [
      { role: 'user' as const, content: 'start' },
      { role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: '1', toolName: 'a', input: {} }] },
      { role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: '1', toolName: 'a', output: { type: 'text' as const, value: 'x' } }] },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'more' },
    ]
    const cut = summaryCut(convo, 2)
    expect(convo[cut]?.role).toBe('assistant')
  })
})

describe('the ai-sdk driver against an OpenAI-compatible endpoint', () => {
  it('plays a persona through the orchestrator', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ps-aisdk-'))
    mkdirSync(join(workspace, 'personas'))
    writeFileSync(
      join(workspace, 'persona-swarm.yaml'),
      stringify({ providers: { fake: { type: 'openai-compatible', baseURL: model.url, vision: true, contextWindow: 64000 } } }),
    )
    writeFileSync(join(workspace, 'target.yaml'), stringify({ id: 'kiln', name: 'Kiln Orders', baseUrl: app.url, signIn: { url: '/sign-in' } }))
    writeFileSync(
      join(workspace, 'personas', 'rita.yaml'),
      stringify({ id: 'rita', name: 'Rita', proficiency: 3, background: 'A shop owner.', mission: { goal: 'Sign in.' }, device: 'laptop-1280' }),
    )
    writeFileSync(
      join(workspace, 'cohort.yaml'),
      stringify({
        id: 'ai-sdk-test',
        target: 'target.yaml',
        personas: ['personas/rita.yaml'],
        roles: { persona: { driver: 'ai-sdk', model: 'fake:scripted' } },
        budgets: { minutesPerPersona: 2, turnsPerPersona: 10 },
        limits: { minFreeMemoryPercent: 5, stopBelowFreeMemoryPercent: 2 },
        schedule: { staggerSec: 0 },
      }),
    )
    const orchestrator = new Orchestrator(buildPlan(loadCohort(join(workspace, 'cohort.yaml'))), {
      drivers: { 'ai-sdk': { command: [process.execPath, driverMain] } },
      handleSignals: false,
    })
    const state = await orchestrator.run()
    expect(state.status, state.statusReason).toBe('finished')
    const session = state.sessions.rita
    expect(session?.status, session?.error).toBe('finished')
    expect(session?.outcome).toBe('completed')
    expect(session?.usage.inputTokens).toBeGreaterThan(4000)

    // The tool list reached the model, and the screenshot followed as an image in a user message.
    const first = model.requests[0]
    expect(first?.tools?.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['screenshot', 'outline', 'report_problem', 'finish']))
    const second = model.requests[1]
    const imageMessage = second?.messages.find(
      (message) => message.role === 'user' && Array.isArray(message.content) && JSON.stringify(message.content).includes('data:image/jpeg;base64'),
    )
    expect(imageMessage).toBeTruthy()
    // One answer for the call with broken arguments, whichever side wrote it: two would be refused by providers.
    const history = model.requests.at(-1)?.messages as { role: string; tool_call_id?: string }[]
    expect(history.filter((message) => message.role === 'tool' && message.tool_call_id === 'call_3')).toHaveLength(1)
    const findings = await readJsonLines<{ type: string; confidence: string }>(join(orchestrator.runDir, 'findings.jsonl'))
    expect(findings.find((line) => line.type === 'finding')?.confidence).toBe('unsure')
  }, 120_000)
})
