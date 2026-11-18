import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dependency } from '@persona-swarm/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bodyDigest, cacheKey, type DependencyEvent, DependencyProxy, requestPath } from '../src/index.js'

let upstream: Server
let upstreamUrl: string
let calls = 0
const proxies: DependencyProxy[] = []

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      calls += 1
      const n = calls
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ n, bytes: Buffer.concat(chunks).length })), 300)
    })
  })
  await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterAll(async () => {
  await Promise.all(proxies.map((proxy) => proxy.stop()))
  await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()))
})

async function proxy(overrides: Record<string, unknown>, events: DependencyEvent[] = []) {
  const config = Dependency.parse({ id: 'tagger', listen: { port: 0 }, upstream: upstreamUrl, ...overrides })
  const instance = new DependencyProxy(config, (event) => events.push(event))
  await instance.start()
  proxies.push(instance)
  return instance
}

const post = (url: string, body: string, signal?: AbortSignal) =>
  fetch(`${url}/detect`, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, ...(signal ? { signal } : {}) })

describe('DependencyProxy', () => {
  it('coalesces identical requests and serves the cache with latency', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-cache-'))
    const events: DependencyEvent[] = []
    const instance = await proxy({ mode: 'cached', cache: { dir }, latencyMs: { min: 100, max: 120 } }, events)
    const before = calls
    const [a, b, c] = await Promise.all([post(instance.address, 'same'), post(instance.address, 'same'), post(instance.address, 'other')])
    expect((await a.json()).n).toBe((await b.json()).n)
    expect((await c.json()).bytes).toBe(5)
    expect(calls - before).toBe(2)
    const started = Date.now()
    const hit = await post(instance.address, 'same')
    expect(hit.status).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(95)
    expect(calls - before).toBe(2)
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(['coalesced', 'cache-hit', 'done']))
  })

  it('refuses requests that waited too long instead of computing them for nobody', async () => {
    const events: DependencyEvent[] = []
    const instance = await proxy({ mode: 'real', concurrency: 1, maxWaitMs: 150, coalesce: false }, events)
    const results = await Promise.all([1, 2, 3, 4].map((n) => post(instance.address, `job-${n}`)))
    const statuses = results.map((response) => response.status)
    expect(statuses[0]).toBe(200)
    expect(statuses.filter((status) => status === 503).length).toBeGreaterThanOrEqual(1)
    expect(instance.stats.refused).toBeGreaterThanOrEqual(1)
  })

  it('drops a queued request whose caller left', async () => {
    const instance = await proxy({ mode: 'real', concurrency: 1, coalesce: false })
    const first = post(instance.address, 'busy')
    const controller = new AbortController()
    const second = post(instance.address, 'abandoned', controller.signal).catch(() => 'aborted')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    controller.abort()
    expect(await second).toBe('aborted')
    await first
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    expect(instance.stats.dropped).toBe(1)
    expect(instance.stats.upstream).toBe(1)
  })

  it('answers stubs and passes unmatched routes through', async () => {
    const instance = await proxy({ mode: 'stub', match: { pathPrefix: '/detect' }, stub: { status: 503, body: '{"detail":"down"}' } })
    expect((await post(instance.address, 'x')).status).toBe(503)
    const health = await fetch(`${instance.address}/health`)
    expect(health.status).toBe(200)
  })

  it('keys answers by method, path, varying headers and the deciding bytes', () => {
    const body = (boundary: string, field = 'image') =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--${boundary}--\r\n`,
      )
    const image = { multipartField: 'image' }
    // The same file under another boundary: the same answer.
    expect(bodyDigest(body('aaa'), 'multipart/form-data; boundary=aaa', image)).toBe(bodyDigest(body('bbb'), 'multipart/form-data; boundary=bbb', image))
    // Field names with regex characters work.
    const listField = { multipartField: 'images[]' }
    expect(bodyDigest(body('aaa', 'images[]'), 'multipart/form-data; boundary=aaa', listField)).toBe(
      bodyDigest(body('bbb', 'images[]'), 'multipart/form-data; boundary=bbb', listField),
    )
    const empty = bodyDigest(Buffer.alloc(0), undefined, 'body')
    expect(cacheKey({ method: 'GET', path: '/results/1' }, empty)).not.toBe(cacheKey({ method: 'GET', path: '/results/2' }, empty))
    expect(cacheKey({ method: 'GET', path: '/health' }, empty)).not.toBe(cacheKey({ method: 'POST', path: '/health' }, empty))
    const user = (token: string) => ({ method: 'GET', path: '/me', headers: { authorization: token } })
    expect(cacheKey(user('a'), empty, ['Authorization'])).not.toBe(cacheKey(user('b'), empty, ['Authorization']))
    expect(cacheKey(user('a'), empty)).toBe(cacheKey(user('b'), empty))
  })

  it('keys by the whole body when a JSON field is missing, not by an empty value', () => {
    const key = { jsonField: 'image.id' }
    const a = bodyDigest(Buffer.from('{"other":1}'), 'application/json', key)
    const b = bodyDigest(Buffer.from('{"other":2}'), 'application/json', key)
    expect(a).not.toBe(b)
    expect(bodyDigest(Buffer.from('{"image":{"id":7},"x":1}'), 'application/json', key)).toBe(
      bodyDigest(Buffer.from('{"image":{"id":7},"x":2}'), 'application/json', key),
    )
  })

  it('never lets a request choose the upstream host', () => {
    expect(requestPath('//evil.example/steal')).toBe('//evil.example/steal')
    expect(requestPath('http://evil.example/steal?x=1')).toBe('/steal?x=1')
    expect(requestPath(undefined)).toBe('/')
  })

  it('answers what is still queued when it stops, and sends none of it upstream', async () => {
    const instance = await proxy({ mode: 'real', concurrency: 1 })
    const before = calls
    const sent = [post(instance.address, 'first'), post(instance.address, 'second'), post(instance.address, 'third')]
    await new Promise((resolveLater) => setTimeout(resolveLater, 100))
    await instance.stop()
    const answers = await Promise.allSettled(sent)
    await new Promise((resolveLater) => setTimeout(resolveLater, 500))
    // Only the call already in flight reached the upstream; the queued ones were answered, not sent.
    expect(calls - before).toBe(1)
    const statuses = answers.map((answer) => (answer.status === 'fulfilled' ? answer.value.status : 0))
    expect(statuses.filter((status) => status === 503)).toHaveLength(2)
  })

  it('keeps every cookie the upstream sets, live and from the cache', async () => {
    const cookies = createServer((_, res) => {
      res.setHeader('set-cookie', ['session=abc; Path=/', 'csrf=xyz; Path=/'])
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    await new Promise<void>((resolveListen) => cookies.listen(0, '127.0.0.1', resolveListen))
    try {
      const dir = mkdtempSync(join(tmpdir(), 'ps-cookies-'))
      const config = Dependency.parse({
        id: 'login',
        listen: { port: 0 },
        upstream: `http://127.0.0.1:${(cookies.address() as AddressInfo).port}`,
        mode: 'cached',
        cache: { dir },
      })
      const instance = new DependencyProxy(config, () => {})
      await instance.start()
      proxies.push(instance)
      for (let round = 0; round < 2; round += 1) {
        const answer = await post(instance.address, 'sign in')
        expect(answer.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/'])
      }
    } finally {
      await new Promise<void>((resolveClose) => cookies.close(() => resolveClose()))
    }
  })

  it('answers 504 when the upstream accepts and never answers', async () => {
    const silent = createServer(() => {})
    await new Promise<void>((resolveListen) => silent.listen(0, '127.0.0.1', resolveListen))
    const events: DependencyEvent[] = []
    const instance = await proxy({ upstream: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, upstreamTimeoutMs: 300 }, events)
    expect((await post(instance.address, 'x')).status).toBe(504)
    expect(events.map((event) => event.event)).toContain('upstream-timeout')
    silent.closeAllConnections()
    silent.close()
  })
})
