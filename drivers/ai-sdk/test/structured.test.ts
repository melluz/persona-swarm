import { afterEach, describe, expect, it } from 'vitest'
import { answerWithTool } from '../src/index.js'
import { type FakeModel, startFakeModel } from './fake-openai.js'

const TOOL = {
  name: 'group_problems',
  description: 'Say which reports describe the same problem.',
  inputSchema: { type: 'object', properties: { groups: { type: 'array', items: { type: 'object' } } }, required: ['groups'] },
}

let model: FakeModel | undefined
afterEach(async () => {
  await model?.close()
  model = undefined
})

const ask = (url: string) =>
  answerWithTool({
    model: 'fake:grouper',
    options: { providers: { fake: { type: 'openai-compatible', baseURL: url } }, price: { input: 2, output: 10 } },
    instructions: 'Sort the reports.',
    prompt: 'F-1: labels overlap\nF-2: names pile up',
    tool: TOOL,
  })

describe('one structured answer from a model', () => {
  it('returns the tool call, its usage and its cost', async () => {
    model = await startFakeModel([{ name: 'group_problems', args: { groups: [{ ids: ['F-1', 'F-2'], reason: 'same overlap' }] } }])
    const answer = await ask(model.url)
    expect(answer.input).toEqual({ groups: [{ ids: ['F-1', 'F-2'], reason: 'same overlap' }] })
    expect(answer.usage).toEqual({ inputTokens: 1000, outputTokens: 20 })
    expect(answer.costUsd).toBeCloseTo((1000 * 2 + 20 * 10) / 1_000_000)
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(['group_problems'])
  })

  it('treats a call with broken JSON as no answer, and takes the one that follows', async () => {
    model = await startFakeModel([
      { name: 'group_problems', args: {}, rawArgs: '{"groups": [{"ids": ["F-1", "F-2"],' },
      { name: 'group_problems', args: { groups: [{ ids: ['F-1', 'F-2'], reason: 'same overlap' }] } },
    ])
    const answer = await ask(model.url)
    expect(answer.input).toEqual({ groups: [{ ids: ['F-1', 'F-2'], reason: 'same overlap' }] })
    expect(model.requests).toHaveLength(2)
  })

  it('asks once more when the model answers in text, then returns the text', async () => {
    model = await startFakeModel([])
    const answer = await ask(model.url)
    expect(answer.input).toBeUndefined()
    // Both answers are kept: the first may hold the JSON even when the second does not.
    expect(answer.text).toBe('I am done.\n\nI am done.')
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(model.requests[1]?.messages.at(-1))).toContain('Answer by calling group_problems')
  })
})
