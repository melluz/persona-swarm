import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { resolveDeviceProfile } from '@persona-swarm/core'
import { ELSEWHERE, type FixtureApp, startFixtureApp } from '@persona-swarm/fixture-app'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type DeviceMedia, describeFailure, findCachedChromium, listFiles, normalizeChord, resolveFile, WebDeviceFarm } from '../src/index.js'

let app: FixtureApp
let farm: WebDeviceFarm
const dir = mkdtempSync(join(tmpdir(), 'ps-device-'))
writeFileSync(join(dir, 'goods.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 1)]))
writeFileSync(join(dir, 'notes.txt'), 'not an image')

const limits = { maxDeviceScaleFactor: 1 }
const refFor = (outline: string, label: RegExp): string => {
  const line = outline.split('\n').find((candidate) => label.test(candidate) && /\[ref=/.test(candidate))
  const ref = line && /\[ref=([^\]]+)\]/.exec(line)?.[1]
  if (!ref) throw new Error(`no ref for ${label} in:\n${outline}`)
  return ref
}

beforeAll(async () => {
  app = await startFixtureApp()
  farm = await WebDeviceFarm.launch()
})
afterAll(async () => {
  await farm?.close()
  await app?.close()
})

async function signedIn(id: string, preset: string, extra: { media?: DeviceMedia[] } = {}) {
  const device = await farm.createDevice({
    id,
    profile: resolveDeviceProfile(preset, undefined, limits),
    baseUrl: app.url,
    downloadsDir: join(dir, id),
    fileSources: [{ dir, pattern: '.*' }],
    ...extra,
  })
  await device.perform({ type: 'open', url: '/sign-in' })
  const outline = (await device.outline()).text
  await device.perform({ type: 'fill', ref: refFor(outline, /textbox "Email"/), text: `${id}@fixture.test` })
  await device.perform({ type: 'fill', ref: refFor(outline, /textbox "Password"/), text: 'secret' })
  const result = await device.perform({ type: 'click', target: { ref: refFor(outline, /button "Sign in"/) } })
  expect(result.ok).toBe(true)
  await device.perform({ type: 'wait', seconds: 3, forText: 'New order' })
  return device
}

describe('WebDevice on the fixture app', () => {
  it('shows the page as a persona with low or colour-blind vision sees it', async () => {
    const zoomed = await farm.createDevice({
      id: 'zoomed',
      profile: resolveDeviceProfile('desktop-1440', { zoom: 2, forcedColors: 'active', contrast: 'more' }, limits),
      baseUrl: app.url,
      downloadsDir: join(dir, 'zoomed'),
      fileSources: [],
    })
    await zoomed.perform({ type: 'open', url: '/sign-in' })
    expect((await zoomed.status()).viewport).toEqual({ width: 720, height: 450 })
    const media = await (zoomed as unknown as { page(): Page })
      .page()
      .evaluate(() => [innerWidth, matchMedia('(forced-colors: active)').matches, matchMedia('(prefers-contrast: more)').matches])
    expect(media).toEqual([720, true, true])
    expect((await zoomed.screenshot()).width).toBe(720)
    await zoomed.close()

    // The first pixel of a PNG's first row is stored as is, whatever the row's filter.
    const firstPixel = (png: Buffer): number[] => {
      const channels = png[25] === 6 ? 4 : 3
      const chunks: Buffer[] = []
      for (let at = 8; at < png.length; ) {
        const length = png.readUInt32BE(at)
        if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length))
        at += length + 12
      }
      return [...inflateSync(Buffer.concat(chunks)).subarray(1, 1 + channels)].slice(0, 3)
    }
    const red = async (deficiency?: 'achromatopsia') => {
      const device = await farm.createDevice({
        id: `red-${deficiency ?? 'normal'}`,
        profile: resolveDeviceProfile('laptop-1280', deficiency ? { visionDeficiency: deficiency } : undefined, limits),
        baseUrl: app.url,
        downloadsDir: join(dir, 'red'),
        fileSources: [],
      })
      await device.perform({ type: 'open', url: '/sign-in' })
      const page = (device as unknown as { page(): Page }).page()
      await page.evaluate(() => {
        document.body.innerHTML = ''
        document.body.style.background = 'rgb(255, 0, 0)'
      })
      const pixel = firstPixel(await page.screenshot({ type: 'png', clip: { x: 20, y: 20, width: 4, height: 4 } }))
      await device.close()
      return pixel
    }
    expect(await red()).toEqual([255, 0, 0])
    const [r, g, b] = await red('achromatopsia')
    expect(Math.abs((r ?? 0) - (g ?? 0))).toBeLessThan(8)
    expect(Math.abs((g ?? 0) - (b ?? 0))).toBeLessThan(8)
  })

  it('signs in, reads the outline and takes a screenshot', async () => {
    const device = await signedIn('desk', 'desktop-1440')
    const status = await device.status()
    expect(new URL(status.url).pathname).toBe('/')
    expect(status.title).toContain('Orders')
    const shot = await device.screenshot()
    expect(shot.mimeType).toBe('image/jpeg')
    expect(shot.width).toBe(1440)
    expect(shot.data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true)
    const found = await device.outline({ query: 'jose' })
    expect(found.text).toContain('José')
    expect(app.events().some((event) => event.type === 'sign-in' && event.account === 'desk@fixture.test')).toBe(true)
    await device.close()
  })

  it('reports harness errors separately from app behaviour', async () => {
    const device = await signedIn('harness', 'laptop-1366')
    const stale = await device.perform({ type: 'click', target: { ref: 'e99999' } })
    expect(stale.ok).toBe(false)
    expect(stale.harnessError).toBe(true)
    const outside = await device.perform({ type: 'click', target: { x: 5000, y: 10 } })
    expect(outside).toMatchObject({ ok: false, harnessError: true })
    const foreign = await device.perform({ type: 'open', url: 'https://example.com/' })
    expect(foreign).toMatchObject({ ok: false, harnessError: true })
    await device.close()
  })

  it('handles native dialogs, uploads and the canvas on a touch device', async () => {
    const device = await signedIn('phone', 'iphone-13')
    expect(device.capabilities().touch).toBe(true)
    const outline = (await device.outline()).text
    await device.perform({ type: 'click', target: { ref: refFor(outline, /link "Mia Chen"/) } })
    let page = (await device.outline()).text
    const upload = await device.perform({ type: 'pick_file', target: { ref: refFor(page, /Upload a photo|button "Choose File"/) }, file: 'goods.png' })
    expect(upload.ok).toBe(true)
    await device.perform({ type: 'wait', seconds: 3, forText: 'Photo uploaded' })
    expect(app.events().some((event) => event.type === 'photo-uploaded' && event.account === 'phone@fixture.test')).toBe(true)

    const swipe = await device.perform({ type: 'swipe', from: { x: 200, y: 500 }, to: { x: 200, y: 200 } })
    expect(swipe.ok).toBe(true)
    const pinch = await device.perform({ type: 'pinch', at: { x: 190, y: 300 }, scale: 1.5 })
    expect(pinch.ok).toBe(true)

    page = (await device.outline()).text
    const asked = await device.perform({ type: 'click', target: { ref: refFor(page, /button "Delete order"/) } })
    expect(asked.status.dialog?.message).toBe('Delete this order?')
    // The page is frozen behind the dialog: a screenshot says so at once instead of timing out.
    await expect(device.screenshot()).rejects.toThrow(/answer it first/)
    const blocked = await device.perform({ type: 'reload' })
    expect(blocked).toMatchObject({ ok: false, harnessError: true })
    const answered = await device.perform({ type: 'dialog', answer: 'accept' })
    expect(answered.ok).toBe(true)
    await device.perform({ type: 'wait', seconds: 3, forText: 'Search customers' })
    expect(app.events().some((event) => event.type === 'order-deleted')).toBe(true)
    await device.close()
  })

  it('picks files by pointing, every time, and through a picker that is already open', async () => {
    const device = await signedIn('picker', 'laptop-1280')
    // An earlier test deletes Mia Chen's order; this one opens another.
    await device.perform({ type: 'click', target: { ref: refFor((await device.outline()).text, /link "Oliver Brown"/) } })
    const box = await (device as unknown as { page(): Page }).page().locator('#photo').boundingBox()
    if (!box) throw new Error('no file input on the order page')
    const at = { x: Math.round(box.x + 30), y: Math.round(box.y + box.height / 2) }
    // Pointing right after a page loads used to race the picker listener and open nothing.
    for (const file of ['goods.png', 'notes.txt', 'goods.png'])
      expect(await device.perform({ type: 'pick_file', target: at, file })).toMatchObject({ ok: true, message: `Chose ${file}.` })

    // With the focus elsewhere, pick_file refuses rather than press Enter on whatever has it.
    await (device as unknown as { page(): Page }).page().locator('a').first().focus()
    const refused = await device.perform({ type: 'pick_file', target: 'focused', file: 'goods.png' })
    expect(refused).toMatchObject({ ok: false, harnessError: true, message: expect.stringContaining('not a file chooser') })

    const clicked = await device.perform({ type: 'click', target: at })
    expect(clicked.status.filePicker).toBe(true)
    const chosen = await device.perform({ type: 'pick_file', target: 'focused', file: 'goods.png' })
    expect(chosen).toMatchObject({ ok: true, message: 'Chose goods.png.' })
    expect(chosen.status.filePicker).toBeUndefined()

    await device.perform({ type: 'click', target: at })
    expect((await device.perform({ type: 'press', keys: 'Escape' })).status.filePicker).toBeUndefined()
    const missed = await device.perform({ type: 'pick_file', target: { x: box.x + box.width + 300, y: box.y + box.height / 2 }, file: 'goods.png' })
    expect(missed).toMatchObject({ ok: false, harnessError: false, message: 'No file picker opened.' })
    await device.close()
  })

  it('keeps the persona in the app: links, redirects and pop-ups to other origins', async () => {
    const device = await signedIn('stayer', 'laptop-1280')
    await device.perform({ type: 'open', url: '/settings' })
    const link = await device.perform({ type: 'click', target: { ref: refFor((await device.outline()).text, /link "Help centre"/) } })
    expect(link.status.url).toMatch(/\/settings$/)
    expect(link.status.notices.join(' ')).toContain('not a problem in the app')
    const redirect = await device.perform({ type: 'click', target: { ref: refFor((await device.outline()).text, /link "Supplier portal"/) } })
    expect(redirect.status.url).not.toContain(ELSEWHERE)
    expect(redirect.status.notices.join(' ')).toContain(`${ELSEWHERE}/portal`)
    await device.perform({ type: 'open', url: '/settings' })
    await device.perform({ type: 'click', target: { ref: refFor((await device.outline()).text, /button "Open chat"/) } })
    await device.perform({ type: 'wait', seconds: 1 })
    const after = await device.status()
    expect(after.tab.count).toBe(1)
    expect(after.url).toMatch(/\/settings$/)
    expect(
      device
        .drainSignals()
        .filter((signal) => signal.kind === 'blocked')
        .map((signal) => signal.url),
    ).toEqual(expect.arrayContaining([`${ELSEWHERE}/help`, `${ELSEWHERE}/portal`, `${ELSEWHERE}/chat`]))
    await device.close()
  })

  it('offers only plain files inside the fixture folder, whatever links are there', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ps-outside-'))
    writeFileSync(join(outside, 'id_rsa'), 'secret')
    const fixtures = join(mkdtempSync(join(tmpdir(), 'ps-fixtures-')), 'files')
    mkdirSync(fixtures)
    writeFileSync(join(fixtures, 'photo.png'), 'png')
    symlinkSync(join(fixtures, 'photo.png'), join(fixtures, 'alias.png'))
    symlinkSync(join(outside, 'id_rsa'), join(fixtures, 'key.png'))
    symlinkSync(join(fixtures, 'gone.png'), join(fixtures, 'dangling.png'))
    const sources = [{ dir: fixtures, pattern: '\\.png$' }]
    expect(listFiles(sources).map((file) => file.name)).toEqual(['alias.png', 'photo.png'])
    expect(resolveFile(sources, 'key.png')).toBeUndefined()
    expect(resolveFile(sources, 'dangling.png')).toBeUndefined()
    expect(resolveFile(sources, 'alias.png')).toBe(join(fixtures, 'alias.png'))
  })

  it('tells a stale ref (harness) from a disabled, covered or locked control (app)', () => {
    // Call logs as Playwright 1.63 writes them.
    const timeout = (log: string) => new Error(`locator.click: Timeout 6000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e2')\n${log}`)
    expect(describeFailure(timeout(''))).toEqual({ message: expect.stringContaining('stale'), harness: true })
    expect(describeFailure(timeout('    - locator resolved to <button disabled>Save</button>\n      - element is not enabled'))).toEqual({
      message: 'That control is disabled.',
      harness: false,
    })
    expect(describeFailure(timeout('    - locator resolved to <button>Under</button>\n    - <div></div> intercepts pointer events'))).toMatchObject({
      harness: false,
    })
    expect(describeFailure(timeout('    - locator resolved to <input readonly>\n      - element is not editable'))).toEqual({
      message: 'That field cannot be changed.',
      harness: false,
    })
    expect(describeFailure(new Error('keyboard.press: Unknown key: "Hyper"'))).toMatchObject({ harness: true })
  })

  it('says what a drop-down list holds, since its pop-up never shows in a screenshot', async () => {
    const device = await signedIn('lister', 'laptop-1280')
    await device.perform({ type: 'open', url: '/settings' })
    const box = await (device as unknown as { page(): Page }).page().locator('#lang').boundingBox()
    if (!box) throw new Error('no language list')
    const opened = await device.perform({ type: 'click', target: { x: box.x + 20, y: box.y + box.height / 2 } })
    expect(opened.message).toContain('A drop-down list opened: English (chosen) · Español.')
    expect(opened.message).toContain('ArrowDown')
    const chosen = await device.perform({ type: 'press', keys: 'ArrowDown Enter' })
    expect(chosen.ok).toBe(true)
    expect(await (device as unknown as { page(): Page }).page().locator('#lang').inputValue()).toBe('es')
    await device.close()
  })

  it("uploads only the session's own files, by the names it knows them by, with their declared types", async () => {
    writeFileSync(join(dir, 'scan.dcm'), Buffer.concat([Buffer.alloc(128), Buffer.from('DICM')]))
    const device = await signedIn('media', 'laptop-1280', {
      media: [
        { name: 'scan.dcm', file: join(dir, 'scan.dcm'), type: 'application/dicom' },
        { name: 'goods (2).png', file: join(dir, 'goods.png'), type: 'image/png' },
      ],
    })
    await device.perform({ type: 'click', target: { ref: refFor((await device.outline()).text, /link "Oliver Brown"/) } })
    const page = (device as unknown as { page(): Page }).page()
    const box = await page.locator('#photo').boundingBox()
    if (!box) throw new Error('no file input on the order page')
    const at = { x: Math.round(box.x + 30), y: Math.round(box.y + box.height / 2) }
    const chosen = () => page.evaluate(() => [...((document.querySelector('#photo') as HTMLInputElement).files ?? [])].map((file) => [file.name, file.type]))
    expect(await device.perform({ type: 'pick_file', target: at, file: 'scan.dcm' })).toMatchObject({ ok: true, message: 'Chose scan.dcm.' })
    expect(await chosen()).toEqual([['scan.dcm', 'application/dicom']])
    // A renamed duplicate goes up under its own file name.
    expect(await device.perform({ type: 'pick_file', target: at, file: 'goods (2).png' })).toMatchObject({ ok: true })
    expect(await chosen()).toEqual([['goods.png', 'image/png']])
    // Files of the target this session was not given are not on its computer.
    const missing = await device.perform({ type: 'pick_file', target: at, file: 'notes.txt' })
    expect(missing).toMatchObject({ ok: false, harnessError: true, message: expect.stringContaining('scan.dcm, goods (2).png') })
    await device.close()
  })

  it('chooses from custom drop-down lists as well as native ones', async () => {
    const device = await signedIn('chooser', 'desktop-1440')
    await device.perform({ type: 'open', url: '/settings' })
    const outline = (await device.outline()).text
    const chosen = await device.perform({ type: 'select', ref: refFor(outline, /combobox "Reminder"/), option: '1 week before' })
    expect(chosen).toMatchObject({ ok: true, message: 'Selected 1 week before.' })
    expect(await (device as unknown as { page(): Page }).page().locator('#remind').textContent()).toBe('1 week before')
    const wrong = await device.perform({ type: 'select', ref: refFor((await device.outline()).text, /combobox "Reminder"/), option: 'Every hour' })
    expect(wrong).toMatchObject({ ok: false, harnessError: false, message: expect.stringContaining('1 day before') })
    const native = await device.perform({ type: 'select', ref: refFor((await device.outline()).text, /combobox "Language"/), option: 'Español' })
    expect(native).toMatchObject({ ok: true })
    await device.close()
  })

  it('selects text the way a person would, on any host', async () => {
    expect(normalizeChord('ctrl+A')).toBe('ControlOrMeta+a')
    expect(normalizeChord('Cmd+Shift+z')).toBe('ControlOrMeta+Shift+z')
    expect(normalizeChord('Control+Alt+a')).toBe('Control+Alt+a')
    expect(normalizeChord('esc')).toBe('Escape')
    expect(normalizeChord('Control++')).toBe('Control++')

    const device = await signedIn('typist', 'laptop-1280')
    await device.perform({ type: 'open', url: '/orders/new' })
    const quantity = (device as unknown as { page(): Page }).page().locator('#quantity')
    const box = await quantity.boundingBox()
    if (!box) throw new Error('no quantity field')
    // A double-click selects the number, so typing replaces it.
    await device.perform({ type: 'click', target: { x: box.x + 10, y: box.y + box.height / 2 }, count: 2 })
    await device.perform({ type: 'type', text: '6' })
    expect(await quantity.inputValue()).toBe('6')
    // Control+A selects all on every persona device (on a macOS host it would move to the line start).
    await device.perform({ type: 'press', keys: 'ctrl+A' })
    await device.perform({ type: 'type', text: '7' })
    expect(await quantity.inputValue()).toBe('7')
    expect(await device.perform({ type: 'press', keys: 'Hyper+q' })).toMatchObject({ ok: false, harnessError: true })
    await device.close()
  })

  // Stands in for a VM or a cloud browser service: a separate Chromium that only speaks CDP.
  const executable = findCachedChromium()
  it.skipIf(!executable)('drives a browser running elsewhere over CDP, uploads included', async () => {
    const remote = spawn(executable as string, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ps-remote-'))}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let seen = ''
        remote.stderr?.on('data', (chunk: Buffer) => {
          seen += chunk.toString()
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen)
          if (match?.[1]) resolveUrl(match[1])
        })
        remote.on('exit', () => reject(new Error(`the remote browser exited: ${seen}`)))
      })
      const remoteFarm = await WebDeviceFarm.launch({ connect: { url } })
      const device = await remoteFarm.createDevice({
        id: 'remote',
        profile: resolveDeviceProfile('laptop-1280', undefined, limits),
        baseUrl: app.url,
        downloadsDir: join(dir, 'remote'),
        fileSources: [{ dir, pattern: '.*' }],
      })
      await device.perform({ type: 'open', url: '/sign-in' })
      let outline = (await device.outline()).text
      await device.perform({ type: 'fill', ref: refFor(outline, /textbox "Email"/), text: 'remote@fixture.test' })
      await device.perform({ type: 'fill', ref: refFor(outline, /textbox "Password"/), text: 'secret' })
      await device.perform({ type: 'click', target: { ref: refFor(outline, /button "Sign in"/) } })
      await device.perform({ type: 'wait', seconds: 3, forText: 'New order' })
      await device.perform({ type: 'click', target: { ref: refFor((await device.outline()).text, /link "José Álvarez"/) } })
      outline = (await device.outline()).text
      const upload = await device.perform({ type: 'pick_file', target: { ref: refFor(outline, /Upload a photo|button "Choose File"/) }, file: 'goods.png' })
      expect(upload).toMatchObject({ ok: true, message: 'Chose goods.png.' })
      await device.perform({ type: 'wait', seconds: 3, forText: 'Photo uploaded' })
      expect(app.events().some((event) => event.type === 'photo-uploaded' && event.account === 'remote@fixture.test')).toBe(true)
      await remoteFarm.close()
    } finally {
      remote.kill()
    }
  })

  it('never waits forever: a wait for text has a limit, and a frozen page is said to be frozen', async () => {
    const device = await farm.createDevice({
      id: 'frozen',
      profile: resolveDeviceProfile('laptop-1280', undefined, limits),
      baseUrl: app.url,
      downloadsDir: join(dir, 'frozen'),
      fileSources: [],
      actionCeilingMs: 3_000,
    })
    await device.perform({ type: 'open', url: '/__fixture/freeze' })
    const started = Date.now()
    // "0 seconds" must not mean "forever" (Playwright's reading of a 0 timeout).
    expect(await device.perform({ type: 'wait', seconds: 0, forText: 'never on this page' })).toMatchObject({ ok: true, matched: false })
    expect(Date.now() - started).toBeLessThan(5_000)
    const outline = (await device.outline()).text
    const frozen = await device.perform({ type: 'click', target: { ref: refFor(outline, /button "Freeze"/) } })
    expect(frozen).toMatchObject({ ok: false, message: expect.stringContaining('stopped responding') })
    expect(frozen.harnessError).toBeFalsy()
    expect(Date.now() - started).toBeLessThan(20_000)
    await device.close()
  }, 40_000)

  it('goes offline and comes back on a throttled device, keeping its throttling', async () => {
    const device = await farm.createDevice({
      id: 'slow',
      profile: resolveDeviceProfile('laptop-1280', { network: 'fast-3g' }, limits),
      baseUrl: app.url,
      downloadsDir: join(dir, 'slow'),
      fileSources: [],
    })
    expect((await device.perform({ type: 'open', url: '/sign-in' })).ok).toBe(true)
    expect((await device.perform({ type: 'set_network', state: 'offline' })).status.online).toBe(false)
    expect((await device.perform({ type: 'reload' })).ok).toBe(false)
    await device.perform({ type: 'set_network', state: 'online' })
    expect((await device.perform({ type: 'reload' })).ok).toBe(true)
    // Still throttled after coming back: a load takes at least the profile's latency.
    const started = Date.now()
    await device.perform({ type: 'reload' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(device.drainSignals().filter((signal) => signal.text.startsWith('network:'))).toEqual([])
    await device.close()
  }, 60_000)

  it('goes offline and comes back', async () => {
    const device = await signedIn('offline', 'laptop-1280')
    expect((await device.perform({ type: 'set_network', state: 'offline' })).status.online).toBe(false)
    const reload = await device.perform({ type: 'reload' })
    expect(reload.ok).toBe(false)
    await device.perform({ type: 'set_network', state: 'online' })
    expect((await device.perform({ type: 'reload' })).ok).toBe(true)
    await device.close()
  })
})
