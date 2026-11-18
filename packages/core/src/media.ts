import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import { ConfigError, readYamlFile, resolveFrom, validate } from './config.js'
import { type MediaEntry, MediaManifest, type MediaSelection, type MediaSource } from './schemas/config.js'

/** One file a persona can upload, with what is known about it. */
export interface MediaItem {
  /** What the persona calls it (the file name; made unique when two folders share one). */
  name: string
  /** Absolute path. */
  file: string
  bytes: number
  /** Shown to personas. */
  description?: string
  tags: string[]
  /** MIME type: the manifest's or the source's, else from the extension. */
  type: string
  /** Absolute path of the reference results. Never shown to personas. */
  truth?: string
  /** For reviewers and hooks. */
  notes?: string
  /** The source's id. */
  source: string
}

/**
 * A plain file inside the folder: no directory, no special file, and no link that points outside the
 * folder (a link to ~/.ssh/id_rsa must not become an upload). Broken links are skipped, not fatal.
 */
export function plainFileIn(dir: string, name: string): { size: number } | undefined {
  try {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isFile()) return { size: stat.size }
    if (!stat.isSymbolicLink()) return undefined
    const real = realpathSync(path)
    const root = realpathSync(dir)
    if (!real.startsWith(root + sep)) return undefined
    const target = lstatSync(real)
    return target.isFile() ? { size: target.size } : undefined
  } catch {
    return undefined
  }
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.dcm': 'application/dicom',
  '.dicom': 'application/dicom',
  '.nii': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** A file's MIME type from its extension, as a browser would send it. */
export function mediaType(name: string): string {
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** "2.1 MB", as a file manager shows it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A name not yet taken: "scan.png", then "scan (2).png". */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Every file the target's media sources offer, with their manifests applied. A manifest entry for a
 * file that is not there is a configuration error (a typo must not silently drop a file).
 */
export function loadMedia(sources: MediaSource[]): MediaItem[] {
  const items: MediaItem[] = []
  const taken = new Set<string>()
  for (const source of sources) {
    const id = source.id ?? basename(source.dir)
    const entries = new Map<string, MediaEntry>()
    let manifestDir = source.dir
    if (source.manifest) {
      if (!existsSync(source.manifest)) throw new ConfigError(source.manifest, 'this media manifest does not exist')
      const parsed = validate(MediaManifest, readYamlFile(source.manifest), source.manifest)
      for (const entry of Array.isArray(parsed) ? parsed : parsed.files) entries.set(entry.name, entry)
      manifestDir = dirname(source.manifest)
    }
    if (!existsSync(source.dir)) {
      if (entries.size) throw new ConfigError(source.manifest ?? source.dir, `the media folder ${source.dir} does not exist`)
      continue
    }
    const pattern = new RegExp(source.pattern)
    const found = new Set<string>()
    for (const name of readdirSync(source.dir).sort()) {
      if (!pattern.test(name)) continue
      const plain = plainFileIn(source.dir, name)
      if (!plain) continue
      found.add(name)
      const entry = entries.get(name)
      const description = entry?.description ?? source.description ?? source.label
      const display = uniqueName(name, taken)
      taken.add(display)
      items.push({
        name: display,
        file: join(source.dir, name),
        bytes: plain.size,
        ...(description ? { description } : {}),
        tags: [...new Set([...source.tags, ...(entry?.tags ?? [])])],
        type: entry?.type ?? source.type ?? mediaType(name),
        ...(entry?.truth ? { truth: resolveFrom(manifestDir, entry.truth) } : {}),
        ...(entry?.notes ? { notes: entry.notes } : {}),
        source: id,
      })
    }
    const missing = [...entries.keys()].filter((name) => !found.has(name))
    if (missing.length)
      throw new ConfigError(
        source.manifest ?? source.dir,
        `the manifest describes ${missing.length === 1 ? 'a file' : 'files'} not in ${source.dir} (or not matching its pattern): ${missing.slice(0, 5).join(', ')}`,
      )
  }
  return items
}

/**
 * The files one persona has. Filters by name and tags (and `keep`, for the cache), then takes `count`
 * of them: the least used so far in this run first, ties broken at random, so a cohort's sessions
 * cover different files. `usage` is shared by the run's sessions and updated here.
 */
export function selectMedia(
  all: MediaItem[],
  selection: MediaSelection | undefined,
  options: { random: () => number; usage: Map<string, number>; keep?: (item: MediaItem) => boolean },
): MediaItem[] {
  if (!selection) return all
  let pool = all
  if (selection.files?.length || selection.tags?.length) {
    const names = new Set(selection.files ?? [])
    const tags = new Set(selection.tags ?? [])
    pool = pool.filter((item) => names.has(item.name) || item.tags.some((tag) => tags.has(tag)))
  }
  if (selection.exclude?.length) {
    const excluded = new Set(selection.exclude)
    pool = pool.filter((item) => !item.tags.some((tag) => excluded.has(tag)))
  }
  if (options.keep) pool = pool.filter(options.keep)
  if (selection.count === undefined || selection.count >= pool.length) {
    for (const item of pool) options.usage.set(item.file, (options.usage.get(item.file) ?? 0) + 1)
    return pool
  }
  const shuffled = pool.map((item) => ({ item, order: options.random() }))
  if (selection.spread) shuffled.sort((a, b) => (options.usage.get(a.item.file) ?? 0) - (options.usage.get(b.item.file) ?? 0) || a.order - b.order)
  else shuffled.sort((a, b) => a.order - b.order)
  const chosen = shuffled.slice(0, selection.count).map((each) => each.item)
  for (const item of chosen) options.usage.set(item.file, (options.usage.get(item.file) ?? 0) + 1)
  return chosen.sort((a, b) => a.name.localeCompare(b.name))
}

/** How a persona sees its files: "beach.png (2.1 MB, a photo of a beach, a bit tilted)". */
export function describeMedia(items: Pick<MediaItem, 'name' | 'bytes' | 'description'>[]): string {
  return items.length ? items.map((item) => `${item.name} (${formatSize(item.bytes)}${item.description ? `, ${item.description}` : ''})`).join('; ') : 'none'
}
