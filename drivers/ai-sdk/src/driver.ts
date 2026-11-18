import { connectPersonaTools, type DriverDefinition, type SessionContext, type SessionSpec, type ToolCallResult } from '@persona-swarm/driver-kit'
import { generateText, jsonSchema, type LanguageModel, type ModelMessage, tool } from 'ai'
import { estimateTokens, pruneImages, summaryCut, transcriptForSummary, truncateText } from './memory.js'
import { imagesInToolResults, languageModel, modelCapabilities, resolveModel } from './models.js'

type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number }

/**
 * The protocol's usage: input tokens read from a prompt cache are counted apart from the others (the
 * AI SDK counts them in inputTokens too), so they are priced once, at the cache price.
 */
function usageOf(usage: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  inputTokenDetails?: { cacheReadTokens?: number | undefined }
}): Usage {
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0
  return { inputTokens: Math.max(0, (usage.inputTokens ?? 0) - cached), outputTokens: usage.outputTokens ?? 0, cachedInputTokens: cached }
}

const NUDGE = 'Keep going as yourself: use the tools to continue what you came to do, or call finish if you are done.'

async function summarize(model: LanguageModel, instructions: string, messages: ModelMessage[], signal: AbortSignal): Promise<{ text: string; usage: Usage }> {
  const result = await generateText({
    model,
    instructions,
    messages: [
      {
        role: 'user',
        content: `Here is what has happened in your session so far:\n\n${transcriptForSummary(messages)}\n\nWrite, in the first person and in character, a summary of at most 300 words: what you did, what you learned about the app, the problems you reported (with their ids), and what you were about to do next.`,
      },
    ],
    abortSignal: signal,
    maxRetries: 3,
  })
  return { text: result.text, usage: usageOf(result.usage) }
}

export async function runSession(spec: SessionSpec, context: SessionContext) {
  const resolved = resolveModel(spec.model, spec.options)
  const model = languageModel(resolved)
  const capabilities = modelCapabilities(resolved)
  const inlineImages = imagesInToolResults(resolved)
  const tools = await connectPersonaTools(spec.mcp)
  const aiTools = Object.fromEntries(
    tools.tools.map((definition) => [
      definition.name,
      // No execute: the framework runs every call itself, so it can log, budget and restrict them.
      tool({ description: definition.description, inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]) }),
    ]),
  )
  const messages: ModelMessage[] = [{ role: 'user', content: spec.kickoff }]
  const totals: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  const deadline = Date.now() + spec.budget.maxSeconds * 1000
  const summarizeAt = Math.min(spec.memory.summarizeAfterTokens, Math.floor(capabilities.contextWindow * 0.6))
  let turns = 0
  let nudges = 0
  let finished = false
  let lastText = ''
  const addUsage = (usage: Usage) => {
    totals.inputTokens += usage.inputTokens
    totals.outputTokens += usage.outputTokens
    totals.cachedInputTokens += usage.cachedInputTokens
    context.emit({ type: 'usage', ...usage })
  }
  const done = (stopReason: 'finished' | 'budget' | 'cancelled' | 'model_stopped', note = '') => ({
    stopReason,
    finalMessage: note || lastText,
    turns,
    usage: totals,
  })

  try {
    while (!finished) {
      if (context.signal.aborted) return done('cancelled')
      if (turns >= spec.budget.maxTurns) return done('budget', `stopped after ${turns} turns`)
      if (Date.now() >= deadline) return done('budget', 'time is up')
      const notices = context.takeNotices()
      if (notices.length) messages.push({ role: 'user', content: notices.join('\n') })

      const pruned = pruneImages(messages, spec.memory.keepImages)
      if (pruned) context.emit({ type: 'memory', action: 'pruned_images', detail: `${pruned} older screenshot(s) removed` })
      if (estimateTokens(messages) > summarizeAt) {
        const cut = summaryCut(messages)
        if (cut > 1) {
          const summary = await summarize(model, spec.instructions, messages.slice(0, cut), context.signal)
          addUsage(summary.usage)
          messages.splice(0, cut, { role: 'user', content: `${spec.kickoff}\n\nSummary of your session so far, in your own words:\n${summary.text}` })
          context.emit({ type: 'memory', action: 'summarized', detail: `${cut} messages summarised into ${summary.text.length} characters` })
        }
      }

      turns += 1
      context.emit({ type: 'turn', n: turns })
      const result = await generateText({
        model,
        instructions: spec.instructions,
        messages,
        tools: aiTools,
        toolChoice: 'auto',
        maxRetries: 4,
        abortSignal: context.signal,
        ...(spec.budget.maxOutputTokensPerTurn ? { maxOutputTokens: spec.budget.maxOutputTokensPerTurn } : {}),
      })
      addUsage(usageOf(result.usage))
      if (result.text.trim()) {
        lastText = result.text
        context.emit({ type: 'assistant', text: result.text })
      }
      messages.push(...result.responseMessages)
      if (!result.toolCalls.length) {
        nudges += 1
        if (nudges > 2) return done('model_stopped', lastText || 'the model stopped without calling finish')
        messages.push({ role: 'user', content: NUDGE })
        continue
      }
      nudges = 0

      const results: { type: 'tool-result'; toolCallId: string; toolName: string; output: never }[] = []
      const followUpImages: ToolCallResult['images'] = []
      for (const call of result.toolCalls) {
        // A call the SDK could not use (arguments that are not JSON, a tool that does not exist) already has
        // its error answer among responseMessages: a second answer to one call is refused by providers.
        if ((call as { invalid?: boolean }).invalid) {
          context.emit({ type: 'log', level: 'warn', message: `the model called ${call.toolName} with arguments that could not be used` })
          continue
        }
        context.emit({ type: 'tool_call', name: call.toolName, input: call.input, callId: call.toolCallId })
        let outcome: ToolCallResult
        try {
          outcome = await tools.call(call.toolName, (call.input ?? {}) as Record<string, unknown>, context.signal)
        } catch (error) {
          if (context.signal.aborted) return done('cancelled')
          outcome = { text: `The tool failed: ${(error as Error).message}`, images: [], isError: true }
        }
        context.emit({ type: 'tool_result', name: call.toolName, callId: call.toolCallId, ok: !outcome.isError, summary: outcome.text.slice(0, 300) })
        const text = truncateText(outcome.isError ? `Error: ${outcome.text}` : outcome.text, spec.memory.maxToolTextChars)
        let output: unknown
        if (outcome.images.length && inlineImages && capabilities.imageInput) {
          output = {
            type: 'content',
            value: [
              { type: 'text', text },
              ...outcome.images.map((image) => ({ type: 'file', data: { type: 'data', data: image.data }, mediaType: image.mimeType })),
            ],
          }
        } else {
          output = { type: 'text', value: outcome.images.length && capabilities.imageInput ? `${text}\n[The screenshot follows in the next message.]` : text }
          if (capabilities.imageInput) followUpImages.push(...outcome.images)
        }
        results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: output as never })
        if (call.toolName === 'finish' && !outcome.isError) finished = true
      }
      // One tool message per turn, in call order: the SDK may already have answered calls it could not
      // use in a tool message of its own, and some providers count one answer part per call.
      const previous = messages.at(-1)
      if (previous?.role === 'tool' && Array.isArray(previous.content)) {
        const order = new Map(result.toolCalls.map((call, index) => [call.toolCallId, index]))
        const parts = [...previous.content, ...results] as { toolCallId?: string }[]
        previous.content = parts.sort((a, b) => (order.get(a.toolCallId ?? '') ?? 0) - (order.get(b.toolCallId ?? '') ?? 0)) as typeof previous.content
      } else if (results.length) messages.push({ role: 'tool', content: results })
      if (followUpImages.length)
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: followUpImages.length === 1 ? 'The screenshot:' : 'The screenshots:' },
            ...followUpImages.map((image) => ({ type: 'image' as const, image: image.data, mediaType: image.mimeType })),
          ],
        })
    }
    return done('finished')
  } finally {
    await tools.close().catch(() => {})
  }
}

export const aiSdkDriver: DriverDefinition = {
  name: 'ai-sdk',
  version: '0.1.0',
  capabilities: (model, options) => modelCapabilities(resolveModel(model, options)),
  runSession,
}
