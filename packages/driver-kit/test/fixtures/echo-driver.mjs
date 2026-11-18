// A test driver: echoes notices, emits events, can wait for cancellation or crash on demand.
import { serveDriver } from '../../dist/index.js'

await serveDriver({
  name: 'echo',
  version: '1.0.0',
  capabilities: (model) => ({ imageInput: model !== 'text-only', contextWindow: 8000, toolCalling: true }),
  async runSession(spec, context) {
    const mode = spec.options.mode ?? 'quick'
    context.emit({ type: 'turn', n: 1 })
    context.emit({ type: 'assistant', text: `hello from ${spec.model}` })
    if (mode === 'crash') process.exit(3)
    if (mode === 'wait') {
      // Wait for a notice, then for cancellation.
      for (let i = 0; i < 200; i += 1) {
        const notices = context.takeNotices()
        if (notices.length) context.emit({ type: 'assistant', text: `notice: ${notices.join(' / ')}` })
        if (context.signal.aborted) return { stopReason: 'cancelled', finalMessage: 'stopped', turns: 1 }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return { stopReason: 'budget', finalMessage: 'waited too long', turns: 1 }
    }
    context.emit({ type: 'usage', inputTokens: 10, outputTokens: 5 })
    return { stopReason: 'finished', finalMessage: 'done', turns: 1, usage: { inputTokens: 10, outputTokens: 5 } }
  },
})
