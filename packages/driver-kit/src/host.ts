import { type ChildProcess, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { LineWriter, onLines } from './lines.js'
import {
  InitializeResult,
  JsonRpcNotification,
  JsonRpcResponse,
  Methods,
  ModelCapabilities,
  PROTOCOL_VERSION,
  type SessionEvent,
  SessionEventParams,
  SessionResult,
  type SessionSpecInput,
} from './protocol.js'

export class DriverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DriverError'
  }
}

export interface DriverStartOptions {
  command: string[]
  cwd?: string
  env?: Record<string, string>
  /** Driver stderr goes here (and the last lines into error messages). */
  logFile?: string
  initializeTimeoutMs?: number
  host?: { name: string; version: string }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

/** A driver process seen from the host: spawned in its own process group, spoken to over stdio. */
export class DriverProcess {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, (event: SessionEvent) => void>()
  private nextId = 1
  private readonly writer: LineWriter
  private readonly stderrTail: string[] = []
  private readonly log?: WriteStream
  private logBroken = false
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null }
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  info?: InitializeResult['driver']

  private constructor(
    readonly child: ChildProcess,
    readonly label: string,
    logFile?: string,
  ) {
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true })
      const log = createWriteStream(logFile, { flags: 'a' })
      // A log that cannot be written (a full disk) is given up on; it never takes the run down.
      log.on('error', (error) => {
        if (this.logBroken) return
        this.logBroken = true
        process.stderr.write(`[persona-swarm] driver log ${logFile}: ${error.message}\n`)
      })
      this.log = log
    }
    if (!child.stdin || !child.stdout || !child.stderr) throw new DriverError('driver process has no stdio')
    this.writer = new LineWriter(child.stdin)
    child.stdin.on('error', () => {
      // The driver went away; the exit handler reports it.
    })
    onLines(child.stdout, (line) => this.onLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.writeLog(chunk)
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > 30) this.stderrTail.shift()
      }
    })
    this.exited = new Promise((resolveExit) => {
      child.on('exit', (code, signal) => {
        this.exitInfo = { code, signal }
        const reason = new DriverError(
          `driver ${this.label} exited (${signal ?? code})${this.stderrTail.length ? `: ${this.stderrTail.slice(-5).join(' | ')}` : ''}`,
        )
        for (const pending of this.pending.values()) {
          if (pending.timer) clearTimeout(pending.timer)
          pending.reject(reason)
        }
        this.pending.clear()
        // Whatever the driver started and left behind (an agent CLI) goes with it.
        this.signalGroup('SIGTERM')
        setTimeout(() => this.signalGroup('SIGKILL'), 3_000).unref()
        resolveExit({ code, signal })
      })
      // Its output may still be arriving after the exit: the log closes once the pipes have.
      child.on('close', () => this.log?.end())
      child.on('error', (error) => {
        for (const pending of this.pending.values()) pending.reject(new DriverError(`driver ${this.label}: ${error.message}`))
        this.pending.clear()
      })
    })
  }

  static async start(options: DriverStartOptions): Promise<DriverProcess> {
    const [command, ...args] = options.command
    if (!command) throw new DriverError('empty driver command')
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the whole tree can be stopped at once.
      detached: process.platform !== 'win32',
    })
    const driver = new DriverProcess(child, options.command.join(' '), options.logFile)
    try {
      const result = InitializeResult.parse(
        await driver.request(
          Methods.initialize,
          { protocolVersion: PROTOCOL_VERSION, host: options.host ?? { name: 'persona-swarm', version: '0' } },
          options.initializeTimeoutMs ?? 20_000,
        ),
      )
      driver.info = result.driver
      return driver
    } catch (error) {
      driver.kill()
      throw error
    }
  }

  get alive(): boolean {
    return this.exitInfo === undefined
  }

  private writeLog(text: string): void {
    if (this.log && !this.logBroken && !this.log.writableEnded) this.log.write(text)
  }

  /** Signals the driver's process group, whether or not the driver itself is still alive. */
  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal)
      else if (this.alive) this.child.kill(signal)
    } catch {
      // Nothing left in the group.
    }
  }

  private onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.writeLog(`[stdout, not JSON] ${line}\n`)
      return
    }
    const response = JsonRpcResponse.safeParse(message)
    if (response.success && response.data.id !== null && ('result' in (message as object) || response.data.error)) {
      const pending = this.pending.get(Number(response.data.id))
      if (!pending) return
      this.pending.delete(Number(response.data.id))
      if (pending.timer) clearTimeout(pending.timer)
      if (response.data.error) pending.reject(new DriverError(response.data.error.message))
      else pending.resolve(response.data.result)
      return
    }
    const notification = JsonRpcNotification.safeParse(message)
    if (notification.success && notification.data.method === Methods.event) {
      const parsed = SessionEventParams.safeParse(notification.data.params)
      if (parsed.success) this.listeners.get(parsed.data.sessionId)?.(parsed.data.event)
      else this.writeLog(`[invalid event] ${line.slice(0, 500)}\n`)
    }
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.alive) return Promise.reject(new DriverError(`driver ${this.label} is not running`))
    const id = this.nextId++
    return new Promise((resolveRequest, reject) => {
      const pending: Pending = { resolve: resolveRequest, reject }
      if (timeoutMs !== undefined)
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new DriverError(`driver ${this.label} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
      this.pending.set(id, pending)
      this.writer.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.alive) this.writer.send({ jsonrpc: '2.0', method, params })
  }

  async capabilities(model: string, options: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<ModelCapabilities> {
    return ModelCapabilities.parse(await this.request(Methods.capabilities, { model, options }, timeoutMs))
  }

  /**
   * Runs one session to its end. Aborting `signal` sends `session.cancel`; a driver that has not
   * ended the session `graceMs` later is killed.
   */
  async runSession(
    spec: SessionSpecInput,
    options: { onEvent?: (event: SessionEvent) => void; signal?: AbortSignal; graceMs?: number; hardTimeoutMs?: number } = {},
  ): Promise<SessionResult> {
    // Cancelled before it started: the driver never hears of it (it would drop a cancel for a session it does not know).
    if (options.signal?.aborted) return SessionResult.parse({ stopReason: 'cancelled', finalMessage: String(options.signal.reason ?? '') })
    if (options.onEvent) this.listeners.set(spec.sessionId, options.onEvent)
    let killTimer: NodeJS.Timeout | undefined
    const onAbort = () => {
      this.notify(Methods.cancel, { sessionId: spec.sessionId, reason: String(options.signal?.reason ?? 'cancelled') })
      killTimer = setTimeout(() => this.kill(), options.graceMs ?? 15_000)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return SessionResult.parse(await this.request(Methods.run, spec, options.hardTimeoutMs))
    } finally {
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      this.listeners.delete(spec.sessionId)
    }
  }

  notice(sessionId: string, text: string): void {
    this.notify(Methods.notice, { sessionId, text })
  }

  /** Asks the driver to exit; kills it if it does not within `timeoutMs`. */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (!this.alive) return
    try {
      await this.request(Methods.shutdown, {}, timeoutMs)
    } catch {
      // Killed below either way.
    }
    const timer = setTimeout(() => this.kill(), timeoutMs)
    try {
      this.child.stdin?.end()
    } catch {
      // Already closed.
    }
    await this.exited
    clearTimeout(timer)
  }

  /** Stops the driver's whole process group, including what is left of it after the driver exited. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.signalGroup(signal)
    setTimeout(() => this.signalGroup('SIGKILL'), 3_000).unref()
  }
}
