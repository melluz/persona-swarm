import { z } from 'zod'

export const PROTOCOL_VERSION = 1

export const JsonRpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
})
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>

export const JsonRpcNotification = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
})
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>

export const JsonRpcError = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() })

export const JsonRpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: JsonRpcError.optional(),
})
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  SessionFailed: -32001,
} as const

export const InitializeParams = z.object({
  protocolVersion: z.number().int(),
  host: z.object({ name: z.string(), version: z.string() }),
})
export const InitializeResult = z.object({
  protocolVersion: z.number().int(),
  driver: z.object({ name: z.string(), version: z.string() }),
})
export type InitializeResult = z.infer<typeof InitializeResult>

export const ModelCapabilities = z.object({
  imageInput: z.boolean(),
  contextWindow: z.number().int().positive(),
  toolCalling: z.boolean(),
  /** Whether sessions spend model tokens on the run's account (mock and external drivers do not). */
  usesModel: z.boolean().default(true),
  /** Whether the driver reports cost in money itself; otherwise the workspace's prices are needed. */
  reportsCost: z.boolean().default(false),
  notes: z.string().optional(),
})
export type ModelCapabilities = z.infer<typeof ModelCapabilities>
/** What a driver returns: the optional fields fall back to their defaults. */
export type ModelCapabilitiesInput = z.input<typeof ModelCapabilities>

export const SessionSpec = z.object({
  sessionId: z.string(),
  model: z.string(),
  instructions: z.string(),
  kickoff: z.string(),
  mcp: z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).default({}) }),
  budget: z.object({
    maxTurns: z.number().int().positive(),
    maxSeconds: z.number().positive(),
    maxOutputTokensPerTurn: z.number().int().positive().optional(),
    /** What is left of the run's spend cap when the session starts, for drivers that can enforce it themselves. */
    maxUsd: z.number().positive().optional(),
  }),
  memory: z
    .object({
      keepImages: z.number().int().min(0).default(3),
      summarizeAfterTokens: z.number().int().positive().default(60_000),
      maxToolTextChars: z.number().int().positive().default(12_000),
    })
    .default({ keepImages: 3, summarizeAfterTokens: 60_000, maxToolTextChars: 12_000 }),
  options: z.record(z.string(), z.unknown()).default({}),
})
export type SessionSpec = z.infer<typeof SessionSpec>
export type SessionSpecInput = z.input<typeof SessionSpec>

export const StopReason = z.enum(['finished', 'budget', 'cancelled', 'error', 'model_stopped'])
export type StopReason = z.infer<typeof StopReason>

/**
 * Token usage. `inputTokens` are the input tokens not read from a prompt cache; `cachedInputTokens`
 * those that were (priced apart, at the cache price). `costUsd`, when a driver knows it, wins over
 * any price the host would apply.
 */
export const UsageReport = z.object({
  inputTokens: z.number().min(0).default(0),
  outputTokens: z.number().min(0).default(0),
  cachedInputTokens: z.number().min(0).default(0),
  costUsd: z.number().min(0).optional(),
})
export type UsageReport = z.infer<typeof UsageReport>

export const SessionResult = z.object({
  stopReason: StopReason,
  finalMessage: z.string().default(''),
  turns: z.number().int().min(0).default(0),
  usage: UsageReport.default({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
  error: z.string().optional(),
})
export type SessionResult = z.infer<typeof SessionResult>
export type SessionResultInput = z.input<typeof SessionResult>

export const SessionEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assistant'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), name: z.string(), input: z.unknown(), callId: z.string() }),
  z.object({ type: z.literal('tool_result'), name: z.string(), callId: z.string(), ok: z.boolean(), summary: z.string() }),
  // Usage as it happens (see UsageReport for the fields): only these count toward cost and the spend cap.
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().default(0),
    outputTokens: z.number().default(0),
    cachedInputTokens: z.number().default(0),
    costUsd: z.number().optional(),
  }),
  z.object({ type: z.literal('turn'), n: z.number().int() }),
  z.object({ type: z.literal('memory'), action: z.string(), detail: z.string() }),
  z.object({ type: z.literal('log'), level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string() }),
])
export type SessionEvent = z.infer<typeof SessionEvent>

export const SessionEventParams = z.object({ sessionId: z.string(), event: SessionEvent })
export const SessionNoticeParams = z.object({ sessionId: z.string(), text: z.string() })
export const SessionCancelParams = z.object({ sessionId: z.string(), reason: z.string().default('cancelled') })
export const CapabilitiesParams = z.object({ model: z.string(), options: z.record(z.string(), z.unknown()).default({}) })

export const Methods = {
  initialize: 'initialize',
  capabilities: 'capabilities',
  run: 'session.run',
  event: 'session.event',
  notice: 'session.notice',
  cancel: 'session.cancel',
  shutdown: 'shutdown',
} as const
