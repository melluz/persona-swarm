import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { type CacheKey, type Dependency, writeFileAtomic } from '@persona-swarm/core'

export interface DependencyEvent {
  t: string
  dependency: string
  event:
    | 'listening'
    | 'queued'
    | 'dispatched'
    | 'done'
    | 'cache-hit'
    | 'coalesced'
    | 'stubbed'
    | 'refused-waited-too-long'
    | 'dropped-caller-left'
    | 'upstream-error'
    | 'upstream-timeout'
    | 'cache-write-failed'
  id?: number
  status?: number
  waitedMs?: number
  ms?: number
  key?: string
  queued?: number
  active?: number
}

class UpstreamTimeout extends Error {}

type Headers = Record<string, string | string[]>

interface CachedAnswer {
  status: number
  headers: Headers
  body: string
}

interface Job {
  id: number
  key: string
  req: IncomingMessage
  body: Buffer
  callers: ServerResponse[]
  arrivedAt: number
  dispatchedAt?: number
  done?: boolean
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'content-length',
  'host',
])

function cleanHeaders(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>): Headers {
  const out: Headers = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    // Each Set-Cookie stays its own header: joined, the browser would keep only the first cookie.
    out[name] = Array.isArray(value) ? (name.toLowerCase() === 'set-cookie' ? value.map(String) : value.join(', ')) : String(value)
  }
  return out
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/** The bytes of the body that decide the answer: a multipart field, a JSON field, or the whole body (hashed). */
export function bodyDigest(body: Buffer, contentType: string | undefined, key: CacheKey): string {
  if (key !== 'body' && 'multipartField' in key) {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? '')
    if (boundary) {
      const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
      const wanted = `name="${key.multipartField}"`
      let start = body.indexOf(marker)
      while (start >= 0) {
        const next = body.indexOf(marker, start + marker.length)
        const part = body.subarray(start + marker.length, next < 0 ? body.length : next)
        const headerEnd = part.indexOf('\r\n\r\n')
        if (headerEnd > 0 && part.subarray(0, headerEnd).toString('latin1').includes(wanted)) return sha256(part.subarray(headerEnd + 4, part.length - 2))
        start = next
      }
    }
  }
  if (key !== 'body' && 'jsonField' in key) {
    try {
      const value = key.jsonField
        .split('.')
        .reduce<unknown>((current, field) => (current as Record<string, unknown>)?.[field], JSON.parse(body.toString('utf8')))
      // A field that is not there would give every request the same key: use the whole body instead.
      if (value !== undefined) return sha256(JSON.stringify(value))
    } catch {
      // Not JSON: fall back to the whole body.
    }
  }
  return sha256(body)
}

/** The request line of the upstream call: the path and query only (the host always comes from the config). */
export function requestPath(url: string | undefined): string {
  const raw = url ?? '/'
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw)
    return `${parsed.pathname}${parsed.search}`
  }
  return raw.startsWith('/') ? raw : `/${raw}`
}

/** What identifies an answer: method, path and query, the headers that vary it, and the body's digest. */
export function cacheKey(request: { method: string; path: string; headers?: IncomingHttpHeaders }, digest: string, vary: string[] = []): string {
  const varying = vary.map((name) => `${name.toLowerCase()}=${String(request.headers?.[name.toLowerCase()] ?? '')}`).join('\n')
  return sha256(`${request.method.toUpperCase()} ${request.path}\n${varying}\n${digest}`)
}

/**
 * A proxy in front of one slow or costly dependency. In `real` mode it only queues: requests run with
 * limited concurrency, identical requests share one upstream call, a caller that left is dropped
 * before its request is computed, and a request that waited too long is refused with 503. `cached`
 * answers from disk (with realistic latency) and computes misses; `record` always computes and
 * stores; `stub` answers a fixed response.
 */
export class DependencyProxy {
  private server?: Server
  private readonly queue: Job[] = []
  private readonly running = new Map<string, Job>()
  private active = 0
  private stopped = false
  private seq = 0
  private sweep?: NodeJS.Timeout
  private readonly inFlight = new Set<ClientRequest>()
  private readonly delays = new Set<NodeJS.Timeout>()
  readonly stats = { requests: 0, cacheHits: 0, coalesced: 0, refused: 0, dropped: 0, upstream: 0, stubbed: 0 }

  constructor(
    readonly config: Dependency,
    private readonly onEvent: (event: DependencyEvent) => void = () => {},
  ) {
    if (config.cache) mkdirSync(config.cache.dir, { recursive: true })
  }

  get address(): string {
    const address = this.server?.address() as AddressInfo | undefined
    return address ? `http://${this.config.listen.host}:${address.port}` : ''
  }

  private emit(event: Omit<DependencyEvent, 't' | 'dependency'>): void {
    this.onEvent({ t: new Date().toISOString(), dependency: this.config.id, queued: this.queue.length, active: this.active, ...event })
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent)
          res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: `dependency proxy: ${(error as Error).message}` }))
      })
    })
    await new Promise<void>((resolveListen, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.config.listen.port, this.config.listen.host, () => resolveListen())
    })
    if (this.config.maxWaitMs) this.sweep = setInterval(() => this.refuseLate(), 1000)
    this.emit({ event: 'listening' })
  }

  async stop(): Promise<void> {
    // Nothing queued may reach the upstream once the run is over: the queue is answered, not sent.
    this.stopped = true
    for (const job of this.queue.splice(0))
      for (const caller of job.callers)
        if (!caller.destroyed && !caller.headersSent)
          caller.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'dependency proxy stopped' }))
    if (this.sweep) clearInterval(this.sweep)
    // Nothing of this proxy may keep the process alive after the run: calls in flight and replay delays end now.
    for (const outgoing of this.inFlight) outgoing.destroy(new Error('the run is over'))
    this.inFlight.clear()
    for (const timer of this.delays) clearTimeout(timer)
    this.delays.clear()
    const server = this.server
    if (!server) return
    await new Promise<void>((resolveClose) => {
      server.closeAllConnections()
      server.close(() => resolveClose())
    })
  }

  private matches(req: IncomingMessage): boolean {
    const { methods, pathPrefix } = this.config.match
    if (methods?.length && !methods.map((method) => method.toUpperCase()).includes(req.method ?? 'GET')) return false
    if (pathPrefix && !requestPath(req.url).startsWith(pathPrefix)) return false
    return true
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    if (this.stopped) {
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'dependency proxy stopped' }))
      return
    }
    if (!this.matches(req)) return this.passThrough(req, body, res)
    this.stats.requests += 1

    if (this.config.mode === 'stub') {
      this.stats.stubbed += 1
      this.emit({ event: 'stubbed' })
      await this.delay()
      return this.replyStub(res)
    }

    const key = cacheKey(
      { method: req.method ?? 'GET', path: requestPath(req.url), headers: req.headers },
      bodyDigest(body, req.headers['content-type'], this.config.cache?.key ?? 'body'),
      this.config.cache?.vary ?? [],
    )
    if (this.config.mode === 'cached') {
      const cached = await this.readCache(key)
      if (cached) {
        this.stats.cacheHits += 1
        this.emit({ event: 'cache-hit', key: key.slice(0, 12) })
        await this.delay()
        if (!res.destroyed) res.writeHead(cached.status, cached.headers).end(Buffer.from(cached.body, 'base64'))
        return
      }
    }

    if (this.config.coalesce) {
      const same = this.running.get(key) ?? this.queue.find((job) => job.key === key)
      if (same) {
        same.callers.push(res)
        this.stats.coalesced += 1
        this.emit({ event: 'coalesced', id: same.id, key: key.slice(0, 12) })
        this.watchCaller(same, res)
        return
      }
    }
    const job: Job = { id: ++this.seq, key, req, body, callers: [res], arrivedAt: Date.now() }
    this.watchCaller(job, res)
    this.queue.push(job)
    this.emit({ event: 'queued', id: job.id, key: key.slice(0, 12) })
    this.pump()
  }

  /** A queued job whose callers have all left is dropped before it costs anything. */
  private watchCaller(job: Job, res: ServerResponse): void {
    res.on('close', () => {
      if (job.dispatchedAt || job.done) return
      if (job.callers.some((caller) => !caller.destroyed && !caller.writableEnded)) return
      const index = this.queue.indexOf(job)
      if (index < 0) return
      this.queue.splice(index, 1)
      this.stats.dropped += 1
      this.emit({ event: 'dropped-caller-left', id: job.id, waitedMs: Date.now() - job.arrivedAt })
    })
  }

  private refuseLate(): void {
    const limit = this.config.maxWaitMs
    if (!limit) return
    for (const job of [...this.queue]) {
      if (Date.now() - job.arrivedAt <= limit) continue
      this.queue.splice(this.queue.indexOf(job), 1)
      this.stats.refused += 1
      this.emit({ event: 'refused-waited-too-long', id: job.id, waitedMs: Date.now() - job.arrivedAt })
      for (const caller of job.callers)
        if (!caller.destroyed && !caller.headersSent)
          caller.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' }).end(JSON.stringify({ detail: 'busy' }))
    }
  }

  private pump(): void {
    if (this.stopped) return
    this.refuseLate()
    while (this.active < this.config.concurrency && this.queue.length) {
      const job = this.queue.shift() as Job
      void this.dispatch(job)
    }
  }

  private async dispatch(job: Job): Promise<void> {
    this.active += 1
    this.running.set(job.key, job)
    job.dispatchedAt = Date.now()
    this.stats.upstream += 1
    this.emit({ event: 'dispatched', id: job.id, waitedMs: job.dispatchedAt - job.arrivedAt })
    try {
      const answer = await this.upstream(job.req, job.body)
      const statuses = this.config.cache?.statuses ?? [200]
      if (this.config.cache && (this.config.mode === 'cached' || this.config.mode === 'record') && statuses.includes(answer.status))
        // A cache that cannot be written (full disk) must not turn a good answer into an error.
        await this.writeCache(job.key, answer).catch(() => this.emit({ event: 'cache-write-failed', id: job.id }))
      for (const caller of job.callers) if (!caller.destroyed && !caller.headersSent) caller.writeHead(answer.status, answer.headers).end(answer.body)
      this.emit({ event: 'done', id: job.id, status: answer.status, ms: Date.now() - job.dispatchedAt })
    } catch (error) {
      const timedOut = error instanceof UpstreamTimeout
      this.emit({ event: timedOut ? 'upstream-timeout' : 'upstream-error', id: job.id, ms: Date.now() - (job.dispatchedAt ?? job.arrivedAt) })
      for (const caller of job.callers)
        if (!caller.destroyed && !caller.headersSent)
          caller
            .writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' })
            .end(JSON.stringify({ detail: `upstream: ${(error as Error).message}` }))
    } finally {
      job.done = true
      this.active -= 1
      this.running.delete(job.key)
      this.pump()
    }
  }

  /** Calls the configured upstream. Only the path and query come from the request: the host never does. */
  private upstream(req: IncomingMessage, body: Buffer): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const base = new URL(this.config.upstream)
    const target = new URL(`${base.origin}${requestPath(req.url)}`)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise((resolveUpstream, reject) => {
      const outgoing = send(
        target,
        { method: req.method, headers: { ...cleanHeaders(req.headers), host: target.host, 'content-length': String(body.length) } },
        (answer) => {
          const chunks: Buffer[] = []
          answer.on('data', (chunk: Buffer) => chunks.push(chunk))
          answer.on('end', () => resolveUpstream({ status: answer.statusCode ?? 502, headers: cleanHeaders(answer.headers), body: Buffer.concat(chunks) }))
          answer.on('error', reject)
        },
      )
      // An upstream that accepts the connection and never answers would hold a slot for the rest of the run.
      outgoing.setTimeout(this.config.upstreamTimeoutMs, () =>
        outgoing.destroy(new UpstreamTimeout(`no answer from ${base.origin} within ${Math.round(this.config.upstreamTimeoutMs / 1000)} s`)),
      )
      this.inFlight.add(outgoing)
      outgoing.on('close', () => this.inFlight.delete(outgoing))
      outgoing.on('error', reject)
      outgoing.end(body)
    })
  }

  private passThrough(req: IncomingMessage, body: Buffer, res: ServerResponse): void {
    this.upstream(req, body)
      .then((answer) => {
        if (!res.headersSent) res.writeHead(answer.status, answer.headers).end(answer.body)
      })
      .catch((error) => {
        if (!res.headersSent) res.writeHead(502).end(String((error as Error).message))
      })
  }

  private delay(): Promise<void> {
    const latency = this.config.latencyMs
    if (!latency) return Promise.resolve()
    const ms = latency.min + Math.random() * Math.max(0, latency.max - latency.min)
    return new Promise((resolveDelay) => {
      const timer = setTimeout(() => {
        this.delays.delete(timer)
        resolveDelay()
      }, ms)
      this.delays.add(timer)
    })
  }

  private replyStub(res: ServerResponse): void {
    const stub = this.config.stub ?? { status: 200, headers: {}, body: '' }
    const body = stub.bodyFile && existsSync(stub.bodyFile) ? readFileSync(stub.bodyFile) : Buffer.from(stub.body ?? '')
    if (!res.destroyed) res.writeHead(stub.status ?? 200, { 'content-type': 'application/json', ...(stub.headers ?? {}) }).end(body)
  }

  private cacheFile(key: string): string {
    return join(this.config.cache?.dir ?? '.', `${key}.json`)
  }

  private async readCache(key: string): Promise<CachedAnswer | undefined> {
    if (!this.config.cache) return undefined
    try {
      return JSON.parse(await readFile(this.cacheFile(key), 'utf8')) as CachedAnswer
    } catch {
      return undefined
    }
  }

  private async writeCache(key: string, answer: { status: number; headers: Headers; body: Buffer }): Promise<void> {
    const entry: CachedAnswer = { status: answer.status, headers: answer.headers, body: answer.body.toString('base64') }
    // Written whole or not at all: a half-written entry would be a cache hit that answers garbage.
    await writeFileAtomic(this.cacheFile(key), JSON.stringify(entry))
  }
}
