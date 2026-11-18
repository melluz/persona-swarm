import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelCapabilitiesInput as ModelCapabilities } from '@persona-swarm/driver-kit'
import type { LanguageModel } from 'ai'

export interface ProviderSettings {
  type: 'openai' | 'anthropic' | 'google' | 'openai-compatible'
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  imagesInToolResults?: boolean
  /** Declared capabilities for models behind this provider (local models cannot be looked up). */
  vision?: boolean
  contextWindow?: number
}

export interface ResolvedModel {
  provider: string
  type: ProviderSettings['type']
  modelId: string
  settings: ProviderSettings
}

export class ModelError extends Error {}

const BUILT_IN: Record<string, ProviderSettings> = {
  openai: { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
  anthropic: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', imagesInToolResults: true },
  google: { type: 'google', apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  openrouter: { type: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  ollama: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1' },
}

/**
 * `provider:model`, e.g. `openai:gpt-5`, `anthropic:claude-sonnet-5-5`, `google:gemini-2.5-pro`,
 * `openrouter:qwen/qwen2.5-vl-72b-instruct`, `ollama:qwen2.5vl`, or a provider named in the
 * workspace's `providers` (passed in `options.providers`).
 */
export function resolveModel(spec: string, options: Record<string, unknown>): ResolvedModel {
  const separator = spec.indexOf(':')
  if (separator <= 0) throw new ModelError(`model "${spec}" must look like provider:model (for example openai:gpt-5)`)
  const provider = spec.slice(0, separator)
  const modelId = spec.slice(separator + 1)
  const custom = (options.providers as Record<string, ProviderSettings> | undefined)?.[provider]
  const settings = custom ?? BUILT_IN[provider]
  if (!settings)
    throw new ModelError(`unknown provider "${provider}"; use ${Object.keys(BUILT_IN).join(', ')} or define it under providers in persona-swarm.yaml`)
  if (settings.type === 'openai-compatible' && !settings.baseURL) throw new ModelError(`provider ${provider} needs a baseURL`)
  return { provider, type: settings.type, modelId, settings: { ...settings, ...((options.provider as ProviderSettings | undefined) ?? {}) } }
}

function apiKey(settings: ProviderSettings): string | undefined {
  if (!settings.apiKeyEnv) return undefined
  const value = process.env[settings.apiKeyEnv]
  if (!value) throw new ModelError(`environment variable ${settings.apiKeyEnv} is not set`)
  return value
}

export function languageModel(resolved: ResolvedModel): LanguageModel {
  const { settings, modelId } = resolved
  const key = apiKey(settings)
  const common = {
    ...(key ? { apiKey: key } : {}),
    ...(settings.headers ? { headers: settings.headers } : {}),
    ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
  }
  switch (resolved.type) {
    case 'openai':
      return createOpenAI(common)(modelId)
    case 'anthropic':
      return createAnthropic(common)(modelId)
    case 'google':
      return createGoogleGenerativeAI(common)(modelId)
    case 'openai-compatible':
      return createOpenAICompatible({
        name: resolved.provider,
        baseURL: settings.baseURL as string,
        ...(key ? { apiKey: key } : {}),
        ...(settings.headers ? { headers: settings.headers } : {}),
      }).chatModel(modelId)
  }
}

const VISION_HINT =
  /(vision|vl\b|vl-|-vl|llava|pixtral|gemma-?3|qwen2\.5vl|qwen2\.5-vl|qwen3-vl|minicpm-v|moondream|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|llama-?4|llama3\.2-vision|grok-.*vision|mistral-(small|medium)-3)/i

/** What a model can do, from its provider and name, unless the provider settings declare it. */
export function modelCapabilities(resolved: ResolvedModel): ModelCapabilities {
  const { settings, modelId, type } = resolved
  const declared = settings.vision !== undefined || settings.contextWindow !== undefined
  const id = modelId.toLowerCase()
  if (type === 'anthropic') return { imageInput: settings.vision ?? true, contextWindow: settings.contextWindow ?? 200_000, toolCalling: true }
  if (type === 'google') return { imageInput: settings.vision ?? true, contextWindow: settings.contextWindow ?? 1_000_000, toolCalling: true }
  if (type === 'openai') {
    const text = /^(o1-mini|o3-mini|gpt-3\.5)/.test(id)
    return {
      imageInput: settings.vision ?? !text,
      contextWindow: settings.contextWindow ?? (/^gpt-5|^gpt-4\.1/.test(id) ? 400_000 : 128_000),
      toolCalling: true,
    }
  }
  return {
    imageInput: settings.vision ?? VISION_HINT.test(id),
    contextWindow: settings.contextWindow ?? 32_000,
    toolCalling: true,
    ...(declared ? {} : { notes: 'inferred from the model name; declare vision and contextWindow on the provider to be sure' }),
  }
}

/** Whether screenshots can travel inside tool results, or must follow as a user message. */
export function imagesInToolResults(resolved: ResolvedModel): boolean {
  return resolved.settings.imagesInToolResults ?? resolved.type === 'anthropic'
}
