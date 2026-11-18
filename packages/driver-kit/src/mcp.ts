import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface PersonaTool {
  name: string
  description: string
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>
}

export interface ToolImage {
  data: string
  mimeType: string
}

export interface ToolCallResult {
  /** All text parts joined. */
  text: string
  images: ToolImage[]
  isError: boolean
}

export interface PersonaTools {
  tools: PersonaTool[]
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult>
  close(): Promise<void>
}

/** Connects to a persona's MCP endpoint (url and headers from the session spec). */
export async function connectPersonaTools(mcp: { url: string; headers: Record<string, string> }): Promise<PersonaTools> {
  const client = new Client({ name: 'persona-swarm-driver', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } })
  await client.connect(transport)
  const listed = await client.listTools()
  const tools = listed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }))
  return {
    tools,
    async call(name, args, signal) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        ...(signal ? { signal } : {}),
        // Waits and slow pages can take minutes; the host owns the overall budget.
        timeout: 330_000,
      })
      const content = (result.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string }[]
      return {
        text: content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n'),
        images: content
          .filter((part) => part.type === 'image' && part.data)
          .map((part) => ({ data: part.data ?? '', mimeType: part.mimeType ?? 'image/jpeg' })),
        isError: Boolean(result.isError),
      }
    },
    async close() {
      // Say goodbye so the server can drop the connection, then close our side.
      await transport.terminateSession().catch(() => {})
      await client.close()
    },
  }
}
