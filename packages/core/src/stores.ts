import { randomBytes } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, type WriteStream } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { EventType, RunEvent } from './events.js'
import type { RunState } from './schemas/run.js'

export const nowIso = (): string => new Date().toISOString()

/** `YYYYMMDD-HHMMSS-xxxx`, UTC. Sorts by time. */
export function newRunId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

export interface RunPaths {
  root: string
  runFile: string
  eventsDir: string
  shotsDir: string
  downloadsDir: string
  diariesDir: string
  logsDir: string
  findingsFile: string
  /** The target's known issues as they were when the run started. */
  knownIssuesFile: string
  reviewFile: string
  triageFile: string
  reportFile: string
  /** A model's or an agent's grouping of the reports (see Grouping). */
  groupingFile: string
  /** The brief and answers for a grouping done by an outside agent. */
  groupingDir: string
}

export function runPaths(runsDir: string, runId: string): RunPaths {
  const root = join(runsDir, runId)
  return {
    root,
    runFile: join(root, 'run.json'),
    eventsDir: join(root, 'events'),
    shotsDir: join(root, 'shots'),
    downloadsDir: join(root, 'downloads'),
    diariesDir: join(root, 'diaries'),
    logsDir: join(root, 'logs'),
    findingsFile: join(root, 'findings.jsonl'),
    knownIssuesFile: join(root, 'known-issues.json'),
    reviewFile: join(root, 'review.json'),
    triageFile: join(root, 'triage.json'),
    reportFile: join(root, 'report.html'),
    groupingFile: join(root, 'grouping.json'),
    groupingDir: join(root, 'grouping'),
  }
}

export function ensureRunDirs(paths: RunPaths): void {
  for (const dir of [paths.root, paths.eventsDir, paths.shotsDir, paths.downloadsDir, paths.diariesDir, paths.logsDir]) mkdirSync(dir, { recursive: true })
}

/** Writes a file atomically: a reader never sees a half-written file, and a failed write leaves no temp file behind. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  try {
    await writeFile(temp, data)
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

/** Reads a JSON-lines file; malformed lines (a crash mid-write) are skipped. */
export async function readJsonLines<T>(file: string, filter?: (value: T) => boolean): Promise<T[]> {
  if (!existsSync(file)) return []
  const out: T[] = []
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as T
      if (!filter || filter(value)) out.push(value)
    } catch {
      // A torn final line after a crash; everything before it is intact.
    }
  }
  return out
}

/** An append-only JSON-lines writer with ordered, buffered writes. */
/** Whether a file exists, is not empty and its last byte is not a newline. */
function endsWithoutNewline(file: string): boolean {
  try {
    const { size } = statSync(file)
    if (size === 0) return false
    const fd = openSync(file, 'r')
    try {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      return last[0] !== 0x0a
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/**
 * An append-only JSON-lines writer with ordered, buffered writes. A write that fails (a full disk) is
 * not lost: the file is reopened with backoff and the lines kept meanwhile (up to `maxPending`) are
 * written then, in order.
 */
export class JsonLinesWriter {
  private stream?: WriteStream
  private closed = false
  private pending: string[] = []
  private retry?: NodeJS.Timeout
  private failures = 0
  private dropped = 0

  constructor(
    readonly file: string,
    private readonly options: { retryMs?: number; maxPending?: number } = {},
  ) {}

  write(value: unknown): void {
    if (this.closed) return
    this.send(`${JSON.stringify(value)}\n`)
  }

  private open(): WriteStream | undefined {
    if (this.stream) return this.stream
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch (error) {
      this.fail(undefined, error as Error)
      return undefined
    }
    // A line torn by a crash would swallow the next record: start on a fresh line.
    const torn = endsWithoutNewline(this.file)
    const stream = createWriteStream(this.file, { flags: 'a' })
    stream.on('error', (error) => this.fail(stream, error))
    if (torn) stream.write('\n')
    this.stream = stream
    return stream
  }

  private send(line: string): void {
    // While a retry is due, later lines wait behind the earlier ones.
    const stream = this.retry ? undefined : this.open()
    if (!stream) {
      this.hold(line)
      return
    }
    stream.write(line, (error) => {
      if (error) this.hold(line)
      else this.failures = 0
    })
  }

  private hold(line: string): void {
    if (this.pending.length < (this.options.maxPending ?? 20_000)) this.pending.push(line)
    else this.dropped += 1
  }

  private fail(stream: WriteStream | undefined, error: Error): void {
    if (stream && this.stream === stream) this.stream = undefined
    stream?.destroy()
    this.failures += 1
    if (this.failures === 1 || this.failures % 20 === 0) process.stderr.write(`[persona-swarm] cannot write ${this.file}: ${error.message} (retrying)\n`)
    if (this.retry || this.closed) return
    const base = this.options.retryMs ?? 500
    this.retry = setTimeout(
      () => {
        this.retry = undefined
        for (const line of this.pending.splice(0)) this.send(line)
      },
      Math.min(30_000, base * 2 ** Math.min(this.failures, 6)),
    )
    this.retry.unref()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = undefined
    }
    // One last try for what is still waiting.
    const waiting = this.pending.splice(0)
    const stream = waiting.length ? this.open() : this.stream
    if (!stream) {
      this.dropped += waiting.length
    } else {
      for (const line of waiting) stream.write(line)
      await new Promise<void>((resolveClose) => {
        stream.once('error', () => resolveClose())
        stream.end(resolveClose)
      })
    }
    if (this.dropped) process.stderr.write(`[persona-swarm] ${this.dropped} record(s) could not be written to ${this.file}\n`)
  }
}

export type EventListener = (event: RunEvent) => void

/** Per-session event files plus an in-process fan-out for live views. */
export class EventStore {
  private readonly writers = new Map<string, JsonLinesWriter>()
  private readonly seqs = new Map<string, number>()
  private readonly listeners = new Set<EventListener>()

  constructor(readonly eventsDir: string) {}

  /** Continues numbering after a resume. */
  async primeFromDisk(session: string): Promise<void> {
    const events = await readJsonLines<RunEvent>(join(this.eventsDir, `${session}.jsonl`))
    const last = events.at(-1)
    if (last) this.seqs.set(session, last.seq)
  }

  append(session: string, type: EventType, payload: Record<string, unknown> = {}): RunEvent {
    const seq = (this.seqs.get(session) ?? 0) + 1
    this.seqs.set(session, seq)
    const event: RunEvent = { ...payload, t: nowIso(), seq, session, type }
    let writer = this.writers.get(session)
    if (!writer) {
      writer = new JsonLinesWriter(join(this.eventsDir, `${session}.jsonl`))
      this.writers.set(session, writer)
    }
    writer.write(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken live view never stops the run.
      }
    }
    return event
  }

  lastSeq(session: string): number {
    return this.seqs.get(session) ?? 0
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    await Promise.all([...this.writers.values()].map((writer) => writer.close()))
    this.writers.clear()
  }
}

export async function readEvents(eventsDir: string, session: string, options: { afterSeq?: number; types?: EventType[] } = {}): Promise<RunEvent[]> {
  const types = options.types ? new Set(options.types) : undefined
  return readJsonLines<RunEvent>(join(eventsDir, `${session}.jsonl`), (event) => event.seq > (options.afterSeq ?? 0) && (!types || types.has(event.type)))
}

export type StateListener = (state: RunState) => void

/**
 * Holds the run's state and persists it atomically. Writes are coalesced: many updates in a burst
 * become one write, and writes never overlap.
 */
export class RunStore {
  private writing?: Promise<void>
  private dirty = false
  private timer?: NodeJS.Timeout
  private readonly listeners = new Set<StateListener>()

  constructor(
    readonly file: string,
    public state: RunState,
  ) {}

  /** A store for a new run: its first flush writes run.json. */
  static create(file: string, state: RunState): RunStore {
    const store = new RunStore(file, state)
    store.dirty = true
    return store
  }

  static async load(file: string): Promise<RunStore | undefined> {
    const state = await readJsonFile<RunState | undefined>(file, undefined)
    return state ? new RunStore(file, state) : undefined
  }

  update(mutate: (state: RunState) => void): void {
    mutate(this.state)
    this.state.updatedAt = nowIso()
    for (const listener of this.listeners) {
      try {
        listener(this.state)
      } catch {
        // Live views never break the run.
      }
    }
    this.schedule()
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private failures = 0
  /** After a failed write, no retry before this time, however often the state changes meanwhile. */
  private retryAt = 0

  private schedule(delayMs = 150): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        // A write failed after this timer was set: wait out the backoff rather than retrying now.
        if (this.retryAt > Date.now()) return this.schedule(this.retryAt - Date.now())
        // A failed write (disk full, folder gone) is retried with backoff; it never ends the run.
        this.flush().catch((error: Error) => {
          this.failures += 1
          if (this.failures === 1 || this.failures % 20 === 0) process.stderr.write(`[persona-swarm] cannot write ${this.file}: ${error.message}\n`)
          const backoff = Math.min(30_000, 500 * 2 ** Math.min(this.failures, 6))
          this.retryAt = Date.now() + backoff
          this.schedule(backoff)
        })
      },
      Math.max(delayMs, this.retryAt - Date.now()),
    )
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.writing) await this.writing.catch(() => {})
    if (!this.dirty) return
    this.dirty = false
    this.writing = writeFileAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`)
      .then(() => {
        this.failures = 0
        this.retryAt = 0
      })
      .catch((error: Error) => {
        // Still to be written.
        this.dirty = true
        throw error
      })
      .finally(() => {
        this.writing = undefined
      })
    await this.writing
  }
}
