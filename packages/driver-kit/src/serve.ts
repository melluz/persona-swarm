import { LineWriter, onLines } from './lines.js'
import {
  CapabilitiesParams,
  ErrorCode,
  InitializeParams,
  JsonRpcNotification,
  JsonRpcRequest,
  Methods,
  type ModelCapabilitiesInput,
  PROTOCOL_VERSION,
  SessionCancelParams,
  type SessionEvent,
  SessionNoticeParams,
  type SessionResultInput,
  SessionSpec,
} from './protocol.js'

export interface SessionContext {
  /** Sends an event to the host (assistant text, tool calls, usage...). */
  emit(event: SessionEvent): void
  /** Aborted when the host cancels the session or shuts the driver down. */
  signal: AbortSignal
  /** Returns and clears notices the host sent (budget warnings), to add as a user message. */
  takeNotices(): string[]
  /** Writes a diagnostic line to stderr (the host stores it in the driver log). */
  log(message: string): void
}

export interface DriverDefinition {
  name: string
  version: string
  capabilities?(model: string, options: Record<string, unknown>): Promise<ModelCapabilitiesInput> | ModelCapabilitiesInput
  runSession(spec: SessionSpec, context: SessionContext): Promise<SessionResultInput>
}

interface ActiveSession {
  controller: AbortController
  notices: string[]
}

/**
 * Serves a driver over stdin/stdout. Call it once from the driver's entry point; it keeps the process
 * alive until the host sends `shutdown` or closes stdin.
 */
export function serveDriver(definition: DriverDefinition, io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const input = (io.input ?? process.stdin) as import('node:stream').Readable
  const output = new LineWriter((io.output ?? process.stdout) as import('node:stream').Writable)
  const sessions = new Map<string, ActiveSession>()
  const log = (message: string) => process.stderr.write(`[${definition.name}] ${message}\n`)

  const respond = (id: string | number, result: unknown) => output.send({ jsonrpc: '2.0', id, result })
  const fail = (id: string | number | null, code: number, message: string) => output.send({ jsonrpc: '2.0', id, error: { code, message } })

  return new Promise<void>((resolveServe) => {
    const finish = () => {
      for (const session of sessions.values()) session.controller.abort(new Error('driver shutting down'))
      resolveServe()
    }

    async function handleRequest(request: JsonRpcRequest): Promise<void> {
      const { id, method, params } = request
      try {
        switch (method) {
          case Methods.initialize: {
            const parsed = InitializeParams.parse(params)
            if (parsed.protocolVersion !== PROTOCOL_VERSION)
              return fail(id, ErrorCode.InvalidParams, `protocol ${parsed.protocolVersion} is not supported (driver speaks ${PROTOCOL_VERSION})`)
            return respond(id, {
              protocolVersion: PROTOCOL_VERSION,
              driver: { name: definition.name, version: definition.version },
            })
          }
          case Methods.capabilities: {
            const { model, options } = CapabilitiesParams.parse(params)
            const capabilities = definition.capabilities
              ? await definition.capabilities(model, options)
              : { imageInput: true, contextWindow: 128_000, toolCalling: true, notes: 'not declared by the driver' }
            return respond(id, capabilities)
          }
          case Methods.run: {
            const spec = SessionSpec.parse(params)
            if (sessions.has(spec.sessionId)) return fail(id, ErrorCode.InvalidParams, `session ${spec.sessionId} is already running`)
            const active: ActiveSession = { controller: new AbortController(), notices: [] }
            sessions.set(spec.sessionId, active)
            const context: SessionContext = {
              emit: (event) => output.send({ jsonrpc: '2.0', method: Methods.event, params: { sessionId: spec.sessionId, event } }),
              signal: active.controller.signal,
              takeNotices: () => active.notices.splice(0),
              log,
            }
            try {
              const result = await definition.runSession(spec, context)
              respond(id, result)
            } catch (error) {
              const aborted = active.controller.signal.aborted
              respond(id, {
                stopReason: aborted ? 'cancelled' : 'error',
                finalMessage: '',
                turns: 0,
                error: (error as Error)?.message ?? String(error),
              })
            } finally {
              sessions.delete(spec.sessionId)
            }
            return
          }
          case Methods.shutdown:
            respond(id, {})
            return finish()
          default:
            return fail(id, ErrorCode.MethodNotFound, `unknown method ${method}`)
        }
      } catch (error) {
        fail(id, ErrorCode.InvalidParams, (error as Error).message)
      }
    }

    function handleNotification(notification: JsonRpcNotification): void {
      if (notification.method === Methods.cancel) {
        const parsed = SessionCancelParams.safeParse(notification.params)
        if (parsed.success) sessions.get(parsed.data.sessionId)?.controller.abort(new Error(parsed.data.reason))
      } else if (notification.method === Methods.notice) {
        const parsed = SessionNoticeParams.safeParse(notification.params)
        if (parsed.success) sessions.get(parsed.data.sessionId)?.notices.push(parsed.data.text)
      }
    }

    onLines(input, (line) => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return fail(null, ErrorCode.ParseError, 'invalid JSON')
      }
      const request = JsonRpcRequest.safeParse(message)
      if (request.success) {
        void handleRequest(request.data)
        return
      }
      const notification = JsonRpcNotification.safeParse(message)
      if (notification.success) handleNotification(notification.data)
    })
    input.on('end', finish)
    input.on('close', finish)
  })
}
