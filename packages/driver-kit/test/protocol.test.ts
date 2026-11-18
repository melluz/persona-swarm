import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DriverProcess, type SessionEvent } from '../src/index.js'

const echo = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-driver.mjs')
const drivers: DriverProcess[] = []
const start = async () => {
  const driver = await DriverProcess.start({ command: [process.execPath, echo] })
  drivers.push(driver)
  return driver
}
const spec = (sessionId: string, options: Record<string, unknown> = {}) => ({
  sessionId,
  model: 'test-model',
  instructions: 'be a test',
  kickoff: 'go',
  mcp: { url: 'http://127.0.0.1:1/mcp/x', headers: {} },
  budget: { maxTurns: 5, maxSeconds: 10 },
  options,
})

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.shutdown(1000)))
})

describe('driver protocol', () => {
  it('initializes and reports model capabilities', async () => {
    const driver = await start()
    expect(driver.info).toEqual({ name: 'echo', version: '1.0.0' })
    expect(await driver.capabilities('text-only')).toMatchObject({ imageInput: false, contextWindow: 8000 })
  })

  it('runs a session and streams its events', async () => {
    const driver = await start()
    const events: SessionEvent[] = []
    const result = await driver.runSession(spec('s1'), { onEvent: (event) => events.push(event) })
    expect(result).toMatchObject({ stopReason: 'finished', finalMessage: 'done', turns: 1 })
    expect(result.usage.inputTokens).toBe(10)
    expect(events.map((event) => event.type)).toEqual(['turn', 'assistant', 'usage'])
  })

  it('delivers notices and cancels a running session', async () => {
    const driver = await start()
    const events: SessionEvent[] = []
    const controller = new AbortController()
    const running = driver.runSession(spec('s2', { mode: 'wait' }), {
      onEvent: (event) => events.push(event),
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    driver.notice('s2', 'five minutes left')
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort('test over')
    const result = await running
    expect(result.stopReason).toBe('cancelled')
    expect(events.some((event) => event.type === 'assistant' && event.text.includes('five minutes left'))).toBe(true)
  })

  it('rejects pending work when the driver dies', async () => {
    const driver = await start()
    await expect(driver.runSession(spec('s3', { mode: 'crash' }))).rejects.toThrow(/exited/)
    expect(driver.alive).toBe(false)
  })

  it('fails fast when the command is not a driver', async () => {
    await expect(DriverProcess.start({ command: [process.execPath, '-e', 'setTimeout(()=>{}, 5000)'], initializeTimeoutMs: 500 })).rejects.toThrow(
      /did not answer initialize/,
    )
  })
})
