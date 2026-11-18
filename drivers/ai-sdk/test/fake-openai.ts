import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ScriptedCall {
  name: string
  args: Record<string, unknown>
  /** Arguments sent as this exact text instead (a model that writes broken JSON). */
  rawArgs?: string
  /** Optional text the model "says" alongside the call. */
  say?: string
}

export interface FakeModel {
  url: string
  requests: { messages: { role: string; content: unknown; tool_calls?: unknown }[]; tools?: { function: { name: string } }[] }[]
  close(): Promise<void>
}

/**
 * A scripted model behind the OpenAI chat-completions API: call n answers with the n-th scripted
 * tool call (one per turn), then a plain text reply.
 */
export async function startFakeModel(script: ScriptedCall[]): Promise<FakeModel> {
  const requests: FakeModel['requests'] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      requests.push(body)
      const turn = body.messages.filter((message: { role: string }) => message.role === 'assistant').length
      const step = script[turn]
      const message = step
        ? {
            role: 'assistant',
            content: step.say ?? null,
            tool_calls: [{ id: `call_${turn + 1}`, type: 'function', function: { name: step.name, arguments: step.rawArgs ?? JSON.stringify(step.args) } }],
          }
        : { role: 'assistant', content: 'I am done.' }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: `chatcmpl-${turn}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message, finish_reason: step ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1000 + turn, completion_tokens: 20, total_tokens: 1020 + turn },
        }),
      )
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  }
}
