import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadExporters, ReviewStatus, type RunEvent, type RunState, readJsonFile, Severity } from '@persona-swarm/core'
import { exportRun, readFindings, setApart, setReview, triageRun, writeReport } from '@persona-swarm/findings'

/** A run that is executing in this process; the API streams it and can stop it. */
export interface LiveRun {
  runId: string
  getState(): RunState
  onState(listener: (state: RunState) => void): () => void
  onEvent(listener: (event: RunEvent) => void): () => void
  stop(reason: string): void
  stopSession(id: string, reason?: string): void
}

export interface ApiServerOptions {
  runsDir: string
  host?: string
  port?: number
  live?: LiveRun
  registryFile?: string
  /** Host names (besides loopback and `host`) the UI may be reached by, for a VM behind a name. */
  allowedHosts?: string[]
}

export interface ApiServer {
  url: string
  close(): Promise<void>
}

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jsonl': 'application/x-ndjson',
}

/** Sent with every response: no framing, no sniffing, no referrer. */
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }

/** The UI runs only its own script and talks only to this server. */
const UI_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

/**
 * Run files are data: a downloaded HTML or SVG page from the app under test must not run here. The
 * sandbox allows no scripts and no forms; it keeps the origin so the report's screenshots (img-src
 * 'self') still load.
 */
const FILE_POLICY = "sandbox allow-same-origin; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'"

/** The run files the UI shows. Session briefs and bridge files (endpoint tokens) and logs are never served. */
const SERVED = [/^shots\/[\w.@-]+\/[\w.-]+\.(jpg|jpeg|png)$/, /^downloads\/[\w.@-]+\/[^/]+$/, /^report\.html$/]

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** Serves a file only if it is inside `root`. */
function sendFile(res: ServerResponse, root: string, relative: string, options: { cache?: string; policy?: string } = {}): void {
  const target = normalize(join(root, relative))
  if (!target.startsWith(root + sep) || !existsSync(target) || !statSync(target).isFile()) {
    json(res, 404, { error: 'not found' })
    return
  }
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': options.cache ?? 'no-store',
    ...(options.policy ? { 'content-security-policy': options.policy } : {}),
  })
  createReadStream(target).pipe(res)
}

/**
 * Only this machine's own pages may use the API: the Host header must name the server (no DNS
 * rebinding), and writes must be JSON from the same origin (no cross-site requests).
 */
/** The name in a Host header, without its port ("[::1]:4400" → "[::1]"). */
function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  const colon = host.lastIndexOf(':')
  return colon >= 0 ? host.slice(0, colon) : host
}

/**
 * Whether a request may be served: its Host must name this machine (a page on another site that
 * resolves its name here, DNS rebinding, is refused), on any port (an SSH tunnel may forward a
 * different one), and a write must come from the UI's own origin.
 */
function allowed(req: IncomingMessage, hosts: Set<string>): string | undefined {
  const host = (req.headers.host ?? '').toLowerCase()
  if (!hosts.has(hostnameOf(host))) return `unexpected host "${host}"`
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request'
  const origin = req.headers.origin
  if (origin && origin !== `http://${host}`) return 'cross-origin request'
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return 'writes must be application/json'
  return undefined
}

interface RunSummary {
  runId: string
  status: string
  statusReason?: string
  mode: string
  createdAt: string
  updatedAt: string
  target: RunState['target']
  cohort: RunState['cohort']
  sessions: number
  running: number
  findings: number
  costUsd: number
  live: boolean
}

function summarize(state: RunState, live: boolean): RunSummary {
  const sessions = Object.values(state.sessions)
  return {
    runId: state.runId,
    status: state.status,
    ...(state.statusReason ? { statusReason: state.statusReason } : {}),
    mode: state.mode,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    target: state.target,
    cohort: state.cohort,
    sessions: sessions.length,
    running: sessions.filter((session) => session.status === 'running' || session.status === 'starting').length,
    findings: state.totals.findings,
    costUsd: state.totals.costUsd,
    live,
  }
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const runsDir = resolve(options.runsDir)
  const runDir = (id: string) => {
    if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') throw new Error('bad run id')
    return join(runsDir, id)
  }
  const stateOf = async (id: string): Promise<RunState | undefined> =>
    options.live?.runId === id ? options.live.getState() : readJsonFile<RunState | undefined>(join(runDir(id), 'run.json'), undefined)

  // Filled in once the port is known; requests arrive only after that.
  let hosts = new Set<string>()
  const server: Server = createServer((req, res) => {
    void route(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: (error as Error).message })
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refused = allowed(req, hosts)
    if (refused) return json(res, 403, { error: refused })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // A decoded segment is one name: an encoded slash or a dot-dot must not walk the path after the checks.
    if (parts.some((part) => part === '.' || part === '..' || /[\\/\0]/.test(part))) return json(res, 404, { error: 'not found' })
    const method = req.method ?? 'GET'

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendFile(res, UI_DIR, 'index.html', { policy: UI_POLICY })
    if (method === 'GET' && parts[0] === 'ui') return sendFile(res, UI_DIR, parts.slice(1).join('/'), { cache: 'no-cache', policy: UI_POLICY })
    if (parts[0] !== 'api') return json(res, 404, { error: 'not found' })

    if (method === 'GET' && parts[1] === 'runs' && parts.length === 2) {
      const list: RunSummary[] = []
      if (existsSync(runsDir))
        for (const name of readdirSync(runsDir)) {
          const state = await stateOf(name).catch(() => undefined)
          if (state) list.push(summarize(state, options.live?.runId === name))
        }
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return json(res, 200, list)
    }
    if (parts[1] !== 'runs' || !parts[2]) return json(res, 404, { error: 'not found' })
    const id = parts[2]
    const dir = runDir(id)
    const state = await stateOf(id)
    if (!state) return json(res, 404, { error: `no run ${id}` })
    const live = options.live?.runId === id ? options.live : undefined
    const action = parts[3]

    if (method === 'GET' && !action) return json(res, 200, { ...state, live: Boolean(live) })
    if (method === 'GET' && action === 'events') {
      const session = url.searchParams.get('session') ?? '_run'
      if (!/^[\w.@-]+$/.test(session)) return json(res, 400, { error: 'bad session' })
      const after = Number(url.searchParams.get('after') ?? 0)
      const limit = Math.min(5000, Number(url.searchParams.get('limit') ?? 5000))
      const file = join(dir, 'events', `${session}.jsonl`)
      if (!existsSync(file)) return json(res, 200, [])
      const lines = (await readFile(file, 'utf8')).split('\n')
      const events: RunEvent[] = []
      for (const line of lines) {
        if (!line) continue
        try {
          const event = JSON.parse(line) as RunEvent
          if (event.seq > after) events.push(event)
        } catch {
          // A partially written last line.
        }
        if (events.length >= limit) break
      }
      return json(res, 200, events)
    }
    if (method === 'GET' && action === 'findings') {
      const [findings, reviews, triage] = await Promise.all([
        readFindings(join(dir, 'findings.jsonl')),
        readJsonFile(join(dir, 'review.json'), {}),
        readJsonFile(join(dir, 'triage.json'), null),
      ])
      return json(res, 200, { findings, reviews, triage })
    }
    if (method === 'POST' && action === 'findings' && parts[4] && parts[5] === 'apart') {
      // A reviewer splits a group: these two are different problems.
      const body = await readBody(req)
      const id = parts[4].toUpperCase()
      const other = typeof body.from === 'string' ? body.from.trim().toUpperCase() : ''
      try {
        await setApart(dir, id, other, 'ui')
      } catch (error) {
        return json(res, 400, { error: (error as Error).message })
      }
      const triage = await triageRun(dir, options.registryFile ? { registryFile: options.registryFile } : {})
      await writeReport(dir, options.registryFile ? { registryFile: options.registryFile } : {})
      return json(res, 200, { clusters: triage.totals.clusters })
    }
    if (method === 'POST' && action === 'findings' && parts[4] && parts[5] === 'review') {
      const body = await readBody(req)
      const status = ReviewStatus.safeParse(body.status)
      if (!status.success) return json(res, 400, { error: 'status must be new, approved, rejected, duplicate or needs-info' })
      // No severity field keeps the earlier one; an empty one clears it.
      const severity = body.severity === undefined || body.severity === '' ? undefined : Severity.safeParse(body.severity)
      if (severity && !severity.success) return json(res, 400, { error: 'severity must be blocker, major, minor or cosmetic' })
      const review = await setReview(dir, parts[4], {
        status: status.data,
        ...(severity?.success ? { severity: severity.data } : body.severity === '' ? { severity: null } : {}),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        ...(status.data === 'duplicate' && typeof body.duplicateOf === 'string' && body.duplicateOf.trim()
          ? { duplicateOf: body.duplicateOf.trim().toUpperCase() }
          : {}),
        by: 'ui',
      })
      return json(res, 200, review)
    }
    if (method === 'POST' && action === 'triage') {
      const triage = await triageRun(dir, options.registryFile ? { registryFile: options.registryFile } : {})
      await writeReport(dir, options.registryFile ? { registryFile: options.registryFile } : {})
      return json(res, 200, triage)
    }
    if (method === 'POST' && action === 'export') {
      const body = await readBody(req)
      const results = await exportRun(dir, loadExporters(state.cohort.file), { dryRun: Boolean(body.dryRun), baseDir: dirname(state.cohort.file) })
      return json(res, 200, results)
    }
    if (method === 'GET' && action === 'files') {
      const relative = parts.slice(4).join('/')
      if (!SERVED.some((pattern) => pattern.test(relative))) return json(res, 404, { error: 'not found' })
      return sendFile(res, dir, relative, { cache: relative === 'report.html' ? 'no-store' : 'max-age=3600', policy: FILE_POLICY })
    }
    if (method === 'POST' && action === 'stop') {
      if (!live) return json(res, 409, { error: 'this run is not executing in this process' })
      live.stop('stopped from the web UI')
      return json(res, 200, { ok: true })
    }
    if (method === 'POST' && action === 'sessions' && parts[4] && parts[5] === 'stop') {
      if (!live) return json(res, 409, { error: 'this run is not executing in this process' })
      live.stopSession(parts[4], 'stopped from the web UI')
      return json(res, 200, { ok: true })
    }
    if (method === 'GET' && action === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('state', state)
      if (!live) {
        send('end', { live: false })
        return void res.end()
      }
      let pending = false
      const flushState = () => {
        pending = false
        send('state', live.getState())
      }
      const offState = live.onState(() => {
        if (pending) return
        pending = true
        setTimeout(flushState, 500)
      })
      const offEvent = live.onEvent((event) => send('event', event))
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
      req.on('close', () => {
        offState()
        offEvent()
        clearInterval(heartbeat)
      })
      return
    }
    json(res, 404, { error: 'not found' })
  }

  // A port in use is an error to report, not an unhandled event that ends the process.
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address() as AddressInfo
  hosts = new Set(
    [
      '127.0.0.1',
      'localhost',
      '[::1]',
      ...(options.host && options.host !== '0.0.0.0' && options.host !== '::' ? [options.host] : []),
      ...(options.allowedHosts ?? []),
    ].map((name) => hostnameOf(name.toLowerCase())),
  )
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections()
        server.close(() => resolveClose())
      }),
  }
}
