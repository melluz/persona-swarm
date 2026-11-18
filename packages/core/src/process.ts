import { type ChildProcess, spawn } from 'node:child_process'

export interface CommandResult {
  /** The exit code; null when the command was killed, -1 when it could not start. */
  code: number | null
  out: string
  err: string
  timedOut: boolean
}

export interface RunCommandOptions {
  timeoutMs: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Output kept per stream; the rest is dropped (a runaway command must not fill memory). */
  maxOutputChars?: number
}

/** Commands still running: their process groups are killed if this process exits or is signalled first. */
const running = new Set<ChildProcess>()
let exitHook = false
/** SIGHUP only with a terminal: under nohup the hang-up stays ignored, as nohup intends. */
const SIGNALS = [...(['SIGINT', 'SIGTERM'] as const), ...(process.stdin.isTTY || process.stdout.isTTY ? (['SIGHUP'] as const) : [])]

/**
 * A command in its own process group does not get the terminal's Ctrl-C. While commands run, a signal
 * kills their groups first; then, if nothing else handles it (a run does), this process ends as the
 * signal would have ended it.
 */
function onSignal(signal: NodeJS.Signals): void {
  for (const child of running) killGroup(child, 'SIGKILL')
  if (process.listenerCount(signal) > 1) return
  unwatchSignals()
  process.kill(process.pid, signal)
}

function watchSignals(): void {
  if (process.platform === 'win32') return
  for (const signal of SIGNALS) if (!process.listeners(signal).includes(onSignal)) process.on(signal, onSignal)
}

function unwatchSignals(): void {
  for (const signal of SIGNALS) process.off(signal, onSignal)
}

/** Signals a command's whole process group: whatever it started (an agent CLI's own children) goes with it. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

/**
 * Runs a command (an argv array, never a shell) with `input` on its stdin and collects its output.
 * The command runs in its own process group. It is killed, with everything it started, after
 * `timeoutMs`, when `signal` aborts, or when this process exits. Once it has exited, output still in
 * the pipes is read for a moment; a child it left behind holding them open is killed, never waited for.
 */
export function runCommand(command: string[], input: string, options: RunCommandOptions): Promise<CommandResult> {
  const limit = options.maxOutputChars ?? 4_000_000
  return new Promise((resolveRun) => {
    if (!command.length) {
      resolveRun({ code: -1, out: '', err: 'the command is empty', timedOut: false })
      return
    }
    if (options.signal?.aborted) {
      resolveRun({ code: null, out: '', err: `stopped before it started (${String(options.signal.reason ?? 'aborted')})`, timedOut: false })
      return
    }
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    })
    running.add(child)
    watchSignals()
    if (!exitHook) {
      exitHook = true
      process.on('exit', () => {
        for (const leftover of running) killGroup(leftover, 'SIGKILL')
      })
    }
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    let grace: NodeJS.Timeout | undefined
    const kill = () => killGroup(child, 'SIGKILL')
    const timer = setTimeout(() => {
      timedOut = true
      err += `timed out after ${Math.round(options.timeoutMs / 1000)} s`
      kill()
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', kill, { once: true })
    const done = (code: number | null, failure?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      options.signal?.removeEventListener('abort', kill)
      running.delete(child)
      if (!running.size) unwatchSignals()
      kill()
      child.stdout.destroy()
      child.stderr.destroy()
      resolveRun({ code, out, err: failure ?? err, timedOut })
    }
    // Decoded as a stream: a character split between two chunks stays whole.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (out.length < limit) out += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (err.length < limit) err += chunk
    })
    child.on('exit', (code) => {
      grace = setTimeout(() => done(code), 1_000)
    })
    child.on('close', (code) => done(code))
    child.on('error', (error) => done(-1, error.message))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
