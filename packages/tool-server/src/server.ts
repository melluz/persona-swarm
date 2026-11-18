import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { buildPersonaServer, type PersonaSession } from './tools.js'

interface Connection {
  transport: StreamableHTTPServerTransport
  used: number
}

interface Endpoint {
  session: PersonaSession
  token: Buffer
  connections: Map<string, Connection>
}

/**
 * Open MCP connections kept per session. Drivers that connect once per action may never say
 * goodbye; beyond this many, the least recently used connection is closed.
 */
const MAX_CONNECTIONS = 4

export interface EndpointInfo {
  url: string
  headers: Record<string, string>
}

async function readJson(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('request too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

/**
 * The run's MCP tool server. Each persona session has its own endpoint and token: a driver can only
 * ever reach the device of the session it was started for.
 */
export class ToolServer {
  private readonly endpoints = new Map<string, Endpoint>()

  private constructor(
    private readonly server: Server,
    readonly baseUrl: string,
  ) {}

  static async start(options: { host?: string; port?: number } = {}): Promise<ToolServer> {
    const holder: { tool?: ToolServer } = {}
    const server = createServer((req, res) => {
      void holder.tool?.handle(req, res).catch((error) => reply(res, 500, (error as Error).message))
    })
    server.keepAliveTimeout = 65_000
    // A port in use is an error to report, not an unhandled event that ends the process.
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
        server.off('error', reject)
        resolveListen()
      })
    })
    const address = server.address() as AddressInfo
    holder.tool = new ToolServer(server, `http://${options.host ?? '127.0.0.1'}:${address.port}`)
    return holder.tool
  }

  register(session: PersonaSession): EndpointInfo {
    const token = randomBytes(24).toString('base64url')
    const existing = this.endpoints.get(session.sessionId)
    if (existing) for (const { transport } of existing.connections.values()) void transport.close()
    this.endpoints.set(session.sessionId, { session, token: Buffer.from(token), connections: new Map() })
    return { url: `${this.baseUrl}/mcp/${encodeURIComponent(session.sessionId)}`, headers: { Authorization: `Bearer ${token}` } }
  }

  async unregister(sessionId: string): Promise<void> {
    const endpoint = this.endpoints.get(sessionId)
    if (!endpoint) return
    this.endpoints.delete(sessionId)
    await Promise.all([...endpoint.connections.values()].map(({ transport }) => transport.close().catch(() => {})))
  }

  private authorized(endpoint: Endpoint, req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? ''
    const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    return presented.length === endpoint.token.length && timingSafeEqual(presented, endpoint.token)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl)
    const match = /^\/mcp\/([^/]+)$/.exec(url.pathname)
    if (!match) return reply(res, 404, 'not found')
    const endpoint = this.endpoints.get(decodeURIComponent(match[1] ?? ''))
    if (!endpoint) return reply(res, 404, 'no such session')
    if (!this.authorized(endpoint, req)) return reply(res, 401, 'unauthorized')

    const mcpSessionId = req.headers['mcp-session-id']
    const sessionKey = Array.isArray(mcpSessionId) ? mcpSessionId[0] : mcpSessionId
    const connection = sessionKey ? endpoint.connections.get(sessionKey) : undefined
    if (connection) connection.used = Date.now()
    if (req.method === 'POST') {
      const body = await readJson(req)
      let transport = connection?.transport
      if (!transport) {
        if (sessionKey || !isInitializeRequest(body)) return reply(res, 400, 'no valid MCP session; send initialize first')
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            endpoint.connections.set(id, { transport: created, used: Date.now() })
            this.prune(endpoint)
          },
        })
        created.onclose = () => {
          if (created.sessionId) endpoint.connections.delete(created.sessionId)
        }
        await buildPersonaServer(endpoint.session).connect(created)
        transport = created
      }
      await transport.handleRequest(req, res, body)
      return
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!connection) return reply(res, 400, 'unknown MCP session')
      await connection.transport.handleRequest(req, res)
      return
    }
    reply(res, 405, 'method not allowed')
  }

  private prune(endpoint: Endpoint): void {
    while (endpoint.connections.size > MAX_CONNECTIONS) {
      const [oldest] = [...endpoint.connections.entries()].sort((a, b) => a[1].used - b[1].used)
      if (!oldest) return
      endpoint.connections.delete(oldest[0])
      void oldest[1].transport.close().catch(() => {})
    }
  }

  /** Open connections per session (for tests and diagnostics). */
  connections(sessionId: string): number {
    return this.endpoints.get(sessionId)?.connections.size ?? 0
  }

  async close(): Promise<void> {
    await Promise.all([...this.endpoints.keys()].map((id) => this.unregister(id)))
    await new Promise<void>((resolveClose) => {
      this.server.closeAllConnections()
      this.server.close(() => resolveClose())
    })
  }
}
