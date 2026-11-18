import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type Dependency, writeFileAtomic } from '@persona-swarm/core'
import { cacheKey, requestPath } from './proxy.js'

export interface WarmResult {
  file: string
  status: 'cached' | 'computed' | 'failed'
  httpStatus?: number
  seconds?: number
  error?: string
}

/**
 * Whether this dependency's cache already holds an answer for the file posted as is (the key `warmCache`
 * writes). Lets a cohort give personas only files whose slow answers are cached.
 */
export function isWarm(dependency: Dependency, file: string, path?: string): boolean {
  const cache = dependency.cache
  if (!cache || cache.key === 'body' || !('multipartField' in cache.key)) return false
  const key = cacheKey(
    { method: 'POST', path: requestPath(path ?? dependency.match.pathPrefix ?? '/') },
    createHash('sha256').update(readFileSync(file)).digest('hex'),
    cache.vary,
  )
  try {
    return typeof (JSON.parse(readFileSync(join(cache.dir, `${key}.json`), 'utf8')) as { body?: unknown }).body === 'string'
  } catch {
    return false
  }
}

/**
 * Pre-computes cache entries for files a target's personas will upload, by sending each file to the
 * real upstream as a multipart field. Keys match the proxy's `multipartField` key for unmodified files.
 */
export async function warmCache(
  dependency: Dependency,
  files: string[],
  options: { path?: string; timeoutMs?: number; onProgress?: (result: WarmResult) => void } = {},
): Promise<WarmResult[]> {
  const cache = dependency.cache
  if (!cache || cache.key === 'body' || !('multipartField' in cache.key))
    throw new Error(`dependency ${dependency.id} needs cache.key.multipartField to be warmed from files`)
  mkdirSync(cache.dir, { recursive: true })
  const path = options.path ?? dependency.match.pathPrefix ?? '/'
  const results: WarmResult[] = []
  for (const file of files) {
    const bytes = await readFile(file)
    // The same key the proxy computes for this file posted to this path (headers in cache.vary are not sent here).
    const key = cacheKey({ method: 'POST', path: requestPath(path) }, createHash('sha256').update(bytes).digest('hex'), cache.vary)
    const target = join(cache.dir, `${key}.json`)
    // An entry an interrupted warm left half-written does not count: it is computed again.
    const whole = await readFile(target, 'utf8').then(
      (data) => {
        try {
          return typeof (JSON.parse(data) as { body?: unknown }).body === 'string'
        } catch {
          return false
        }
      },
      () => false,
    )
    if (whole) {
      const result: WarmResult = { file, status: 'cached' }
      results.push(result)
      options.onProgress?.(result)
      continue
    }
    const form = new FormData()
    const type = /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'application/octet-stream'
    form.append(cache.key.multipartField, new Blob([bytes], { type }), basename(file))
    const started = Date.now()
    try {
      // fetch has a default header timeout; long inferences need our own budget instead.
      const response = await fetch(new URL(path, dependency.upstream), {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs ?? 15 * 60_000),
      })
      const body = Buffer.from(await response.arrayBuffer())
      // fetch has already decompressed the body: its encoding and length headers no longer apply.
      const headers = Object.fromEntries(
        [...response.headers].filter(([name]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)),
      )
      if (cache.statuses.includes(response.status))
        await writeFileAtomic(target, JSON.stringify({ status: response.status, headers, body: body.toString('base64') }))
      const result: WarmResult = { file, status: 'computed', httpStatus: response.status, seconds: Math.round((Date.now() - started) / 1000) }
      results.push(result)
      options.onProgress?.(result)
    } catch (error) {
      const result: WarmResult = { file, status: 'failed', error: (error as Error).message }
      results.push(result)
      options.onProgress?.(result)
    }
  }
  return results
}
