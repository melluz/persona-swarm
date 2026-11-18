import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { formatSize, plainFileIn } from '@persona-swarm/core'

export interface FileSource {
  dir: string
  pattern: string
  label?: string
}

/** A file this device may upload, chosen for its session (see core's `selectMedia`). */
export interface DeviceMedia {
  /** What the persona calls it. */
  name: string
  file: string
  type: string
}

/** Only files the target declares can be uploaded; a name never escapes its directory. */
export function resolveFile(sources: FileSource[], name: string): string | undefined {
  const plain = basename(name)
  if (plain !== name.replace(/^\.\//, '')) return undefined
  for (const source of sources) if (new RegExp(source.pattern).test(plain) && plainFileIn(source.dir, plain)) return join(source.dir, plain)
  return undefined
}

export interface FileInfo {
  name: string
  /** Human-readable size, as a file manager shows it. */
  size: string
  label?: string
}

export function listFiles(sources: FileSource[]): FileInfo[] {
  const out: FileInfo[] = []
  for (const source of sources) {
    if (!existsSync(source.dir)) continue
    const pattern = new RegExp(source.pattern)
    for (const name of readdirSync(source.dir).sort()) {
      if (!pattern.test(name)) continue
      const file = plainFileIn(source.dir, name)
      if (file) out.push({ name, size: formatSize(file.size), ...(source.label ? { label: source.label } : {}) })
    }
  }
  return out
}
