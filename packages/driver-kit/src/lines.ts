import type { Readable, Writable } from 'node:stream'

/** Splits a byte stream into lines without losing partial chunks. */
export function onLines(stream: Readable, handle: (line: string) => void, maxLineBytes = 32 * 1024 * 1024): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.trim()) handle(line)
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > maxLineBytes) buffer = ''
  })
  stream.on('end', () => {
    if (buffer.trim()) handle(buffer)
    buffer = ''
  })
}

/** Writes one JSON value per line; respects back-pressure ordering by queueing writes. */
export class LineWriter {
  constructor(private readonly stream: Writable) {}

  send(value: unknown): void {
    if (this.stream.destroyed || this.stream.writableEnded) return
    this.stream.write(`${JSON.stringify(value)}\n`)
  }
}
