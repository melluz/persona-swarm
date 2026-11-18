export type EventType =
  | 'session.start'
  | 'session.end'
  | 'tool.call'
  | 'tool.result'
  | 'device.signal'
  | 'agent.text'
  | 'agent.usage'
  | 'agent.memory'
  | 'agent.log'
  | 'note'
  | 'finding'
  | 'vote'
  | 'diary'
  | 'governor'
  | 'dependency'
  | 'notice'
  /** Something outside the app got in the persona's way (an interruptions or multitab trait). */
  | 'interruption'
  | 'check'
  | 'error'

export interface RunEvent {
  /** ISO 8601 UTC. */
  t: string
  /** Monotonic within one events file. */
  seq: number
  /** Session id, or "_run" for run-level events. */
  session: string
  type: EventType
  [key: string]: unknown
}

export interface ToolCallEvent extends RunEvent {
  type: 'tool.call'
  tool: string
  input: Record<string, unknown>
  callId: string
}

export interface ToolResultEvent extends RunEvent {
  type: 'tool.result'
  tool: string
  callId: string
  ok: boolean
  /** The failure came from the harness (bad arguments, unknown ref), not the app. */
  harnessError?: boolean
  ms: number
  message: string
  url?: string
  screenshot?: string
}

export const RUN_SESSION = '_run'
