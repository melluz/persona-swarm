import type { ModelMessage } from 'ai'

export interface MemoryPolicy {
  keepImages: number
  summarizeAfterTokens: number
  maxToolTextChars: number
}

const IMAGE_TOKENS = 1600

type Part = { type: string; text?: string; image?: unknown; data?: unknown; output?: { type: string; value?: unknown } }

/** A rough token estimate: 4 characters per token, a fixed cost per image. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  let images = 0
  const visit = (value: unknown): void => {
    if (typeof value === 'string') chars += value.length
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      const part = value as Part
      if (part.type === 'image' || (part.type === 'file' && typeof part.data === 'object')) {
        images += 1
        return
      }
      for (const [key, inner] of Object.entries(value)) if (key !== 'providerOptions') visit(inner)
    }
  }
  visit(messages)
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS
}

export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`
}

/**
 * Keeps only the most recent `keep` images, replacing older ones with a short text, in place.
 * Screenshots dominate the context; an agent rarely needs to look back more than a few screens.
 * Returns how many images were removed.
 */
export function pruneImages(messages: ModelMessage[], keep: number): number {
  let seen = 0
  let removed = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as ModelMessage
    if (message.role === 'user' && Array.isArray(message.content)) {
      const content = message.content as Part[]
      for (let j = content.length - 1; j >= 0; j -= 1) {
        if (content[j]?.type !== 'image') continue
        seen += 1
        if (seen > keep) {
          content[j] = { type: 'text', text: '[an earlier screenshot was removed to save memory]' }
          removed += 1
        }
      }
    } else if (message.role === 'tool') {
      for (const part of message.content as unknown as Part[]) {
        const output = part.output
        if (output?.type !== 'content' || !Array.isArray(output.value)) continue
        const value = output.value as Part[]
        for (let j = value.length - 1; j >= 0; j -= 1) {
          if (value[j]?.type !== 'file') continue
          seen += 1
          if (seen > keep) {
            value[j] = { type: 'text', text: '[an earlier screenshot was removed to save memory]' }
            removed += 1
          }
        }
      }
    }
  }
  return removed
}

/**
 * Where the history can be cut so the kept tail starts cleanly: at an assistant message, never
 * between a tool call and its result. Keeps at least `keepTail` messages.
 */
export function summaryCut(messages: ModelMessage[], keepTail = 8): number {
  for (let index = Math.max(1, messages.length - keepTail); index > 0; index -= 1) if (messages[index]?.role === 'assistant') return index
  return 0
}

export function transcriptForSummary(messages: ModelMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : (message.content as Part[]).map((part) => part.text ?? '').join(' ')
      if (text.trim()) lines.push(`[instruction or notice] ${text.slice(0, 800)}`)
    } else if (message.role === 'assistant') {
      const parts =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : (message.content as unknown as (Part & { toolName?: string; input?: unknown })[])
      for (const part of parts) {
        if (part.type === 'text' && part.text?.trim()) lines.push(`[you said] ${part.text.slice(0, 600)}`)
        if (part.type === 'tool-call') lines.push(`[you used] ${part.toolName} ${JSON.stringify(part.input).slice(0, 200)}`)
      }
    } else if (message.role === 'tool') {
      for (const part of message.content as unknown as (Part & { toolName?: string })[]) {
        const output = part.output
        const text =
          output?.type === 'text' || output?.type === 'error-text'
            ? String(output.value)
            : output?.type === 'content'
              ? (output.value as Part[]).map((item) => item.text ?? '').join(' ')
              : ''
        lines.push(`[result of ${part.toolName}] ${text.slice(0, 300)}`)
      }
    }
  }
  return lines.join('\n')
}
