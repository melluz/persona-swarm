import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, describeMedia, loadMedia, loadTarget, MediaSource, mediaType, seededRandom, selectMedia } from '../src/index.js'

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'ps-media-'))
  const photos = join(root, 'photos')
  const wrong = join(root, 'wrong')
  mkdirSync(photos)
  mkdirSync(wrong)
  mkdirSync(join(root, 'truth'))
  for (const name of ['a.png', 'b.png', 'c.png', 'd.dcm']) writeFileSync(join(photos, name), Buffer.alloc(2048, 1))
  writeFileSync(join(wrong, 'a.png'), 'a screenshot')
  writeFileSync(join(wrong, 'report.pdf'), '%PDF')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  symlinkSync(join(root, 'secret.txt'), join(wrong, 'escape.png'))
  writeFileSync(
    join(root, 'photos.yaml'),
    'files:\n  - { name: a.png, description: "an adult, clear image", tags: [adult], truth: truth/a.json, notes: reference case }\n  - { name: d.dcm, description: the same patient as a DICOM file }\n',
  )
  const sources = [
    MediaSource.parse({ id: 'photos', dir: photos, tags: ['photo'], description: 'a holiday photo', manifest: join(root, 'photos.yaml') }),
    MediaSource.parse({ dir: wrong, tags: ['wrong-kind'], description: 'something a user uploads by mistake' }),
  ]
  return { root, sources }
}

describe('media', () => {
  it('describes files from the manifest, the source and the extension, and never follows links out', () => {
    const { root, sources } = folder()
    const items = loadMedia(sources)
    expect(items.map((item) => item.name)).toEqual(['a.png', 'b.png', 'c.png', 'd.dcm', 'a (2).png', 'report.pdf'])
    const [a, b] = items
    expect(a).toMatchObject({
      description: 'an adult, clear image',
      tags: ['photo', 'adult'],
      truth: join(root, 'truth/a.json'),
      notes: 'reference case',
      source: 'photos',
    })
    expect(b).toMatchObject({ description: 'a holiday photo', tags: ['photo'], type: 'image/png' })
    expect(items.find((item) => item.name === 'd.dcm')?.type).toBe('application/dicom')
    expect(items.find((item) => item.name === 'a (2).png')).toMatchObject({ file: join(root, 'wrong', 'a.png'), source: 'wrong' })
    expect(items.some((item) => item.name === 'escape.png')).toBe(false)
    expect(describeMedia(items.slice(0, 1))).toBe('a.png (2 KB, an adult, clear image)')
    expect(mediaType('scan.TIFF')).toBe('image/tiff')
  })

  it('refuses a manifest that names a file that is not there', () => {
    const { root, sources } = folder()
    writeFileSync(join(root, 'photos.yaml'), 'files:\n  - { name: missing.png }\n')
    expect(() => loadMedia(sources)).toThrow(ConfigError)
    expect(() => loadMedia(sources)).toThrow(/missing\.png/)
  })

  it("reads a target's older fixtures as media, with paths made absolute", () => {
    const { root } = folder()
    writeFileSync(
      join(root, 'target.yaml'),
      'id: t\nname: T\nbaseUrl: http://127.0.0.1:9\nfixtures: [{ dir: ./wrong, label: files }]\nmedia: [{ dir: ./photos, manifest: photos.yaml }]\n',
    )
    const { target } = loadTarget(join(root, 'target.yaml'))
    expect(target.media.map((source) => source.dir)).toEqual([join(root, 'photos'), join(root, 'wrong')])
    expect(target.media[0]?.manifest).toBe(join(root, 'photos.yaml'))
    expect(loadMedia(target.media).find((item) => item.name === 'report.pdf')?.description).toBe('files')
  })

  it('chooses by tag, name and count, spreading choices across sessions', () => {
    const items = loadMedia(folder().sources)
    const usage = new Map<string, number>()
    const random = seededRandom(1)
    const pick = (selection: Parameters<typeof selectMedia>[1]) => selectMedia(items, selection, { random, usage }).map((item) => item.name)
    expect(pick({ tags: ['wrong-kind'], spread: true })).toEqual(['a (2).png', 'report.pdf'])
    expect(pick({ tags: ['photo'], exclude: ['adult'], spread: true })).toEqual(['b.png', 'c.png', 'd.dcm'])
    expect(pick({ files: ['report.pdf'], tags: ['adult'], spread: true })).toEqual(['a.png', 'report.pdf'])
    // Four sessions taking one photo each: the four photos, each once.
    usage.clear()
    const one = Array.from({ length: 4 }, () => pick({ tags: ['photo'], count: 1, spread: true })[0])
    expect(new Set(one).size).toBe(4)
    // Without a selection, every file.
    expect(selectMedia(items, undefined, { random, usage })).toHaveLength(items.length)
    // A filter from outside (the dependency cache).
    expect(selectMedia(items, { tags: ['photo'], spread: true }, { random, usage, keep: (item) => item.name !== 'b.png' }).map((item) => item.name)).toEqual([
      'a.png',
      'c.png',
      'd.dcm',
    ])
  })
})
