import { generateText, jsonSchema, type ModelMessage, ToolChoiceViolationError, tool } from 'ai'
import { languageModel, resolveModel } from './models.js'

export interface ToolAnswerRequest {
  /** `provider:model`, as for personas. */
  model: string
  /** Driver options: `providers` from the workspace, and `price` (USD per million tokens) when known. */
  options?: Record<string, unknown>
  instructions: string
  prompt: string
  tool: { name: string; description: string; inputSchema: Record<string, unknown> }
  signal?: AbortSignal
  maxOutputTokens?: number
}

export interface ToolAnswer {
  /** The tool call's arguments, or the JSON the model wrote instead (local models often do). */
  input: unknown
  /** The model's text, when it answered in text. */
  text: string
  usage: { inputTokens: number; outputTokens: number }
  costUsd?: number
}

/**
 * One answer from a model, as a call to a single tool: for judgments the framework needs in a fixed
 * shape (grouping reports). The tool is required; a model that writes text instead is asked once
 * more, and its text is returned for the caller to read JSON from. (Usage is not reported for a
 * reply that broke the required tool choice, so its cost is missing from the total.)
 */
export async function answerWithTool(request: ToolAnswerRequest): Promise<ToolAnswer> {
  const resolved = resolveModel(request.model, request.options ?? {})
  const model = languageModel(resolved)
  const tools = {
    [request.tool.name]: tool({ description: request.tool.description, inputSchema: jsonSchema(request.tool.inputSchema as Parameters<typeof jsonSchema>[0]) }),
  }
  const messages: ModelMessage[] = [{ role: 'user', content: request.prompt }]
  const usage = { inputTokens: 0, outputTokens: 0 }
  // Every text the model wrote: its first may hold the answer as JSON, even when the second does not.
  const texts: string[] = []
  let text = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await generateText({
        model,
        instructions: request.instructions,
        messages,
        tools,
        toolChoice: { type: 'tool', toolName: request.tool.name },
        maxRetries: 4,
        ...(request.signal ? { abortSignal: request.signal } : {}),
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      })
      usage.inputTokens += result.usage.inputTokens ?? 0
      usage.outputTokens += result.usage.outputTokens ?? 0
      const call = result.toolCalls.find((candidate) => candidate.toolName === request.tool.name)
      // A call whose arguments are not valid JSON is no answer: its text is read like any other.
      if (call && !(call as { invalid?: boolean }).invalid) return { input: call.input, text: result.text, usage, ...cost(request.options, usage) }
      text = [result.text, typeof call?.input === 'string' ? call.input : ''].filter(Boolean).join('\n')
      texts.push(text)
    } catch (error) {
      // The model wrote text instead of calling the tool (local models often do): keep its text.
      if (!ToolChoiceViolationError.isInstance(error)) throw error
      text = error.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
      texts.push(text)
    }
    messages.push({ role: 'assistant', content: text || '(no answer)' }, { role: 'user', content: `Answer by calling ${request.tool.name}.` })
  }
  return { input: undefined, text: texts.join('\n\n'), usage, ...cost(request.options, usage) }
}

function cost(options: Record<string, unknown> | undefined, usage: ToolAnswer['usage']): { costUsd?: number } {
  const price = options?.price as { input: number; output: number } | undefined
  return price ? { costUsd: (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000 } : {}
}
