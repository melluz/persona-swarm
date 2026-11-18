import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  bodyOf,
  EventStore,
  interruptionDue,
  pickInterruption,
  readEvents,
  readJsonLines,
  resolveDeviceProfile,
  seededRandom,
  type ToolProfile,
} from '@persona-swarm/core'
import { type DeviceMedia, WebDeviceFarm } from '@persona-swarm/device-web'
import { type FixtureApp, startFixtureApp } from '@persona-swarm/fixture-app'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Diary, type EndpointInfo, outlineParts, type PersonaSession, RunFindings, ToolServer } from '../src/index.js'

let app: FixtureApp
let farm: WebDeviceFarm
let tools: ToolServer
const run = mkdtempSync(join(tmpdir(), 'ps-tools-'))
const events = new EventStore(join(run, 'events'))
const findings = new RunFindings(join(run, 'findings.jsonl'), events, [{ id: 'K-1', title: 'Search ignores accents in names' }])
const diaries: Diary[] = []

beforeAll(async () => {
  app = await startFixtureApp()
  farm = await WebDeviceFarm.launch()
  tools = await ToolServer.start()
})
afterAll(async () => {
  await tools?.close()
  await farm?.close()
  await app?.close()
  await events.close()
  await findings.close()
})

async function session(id: string, preset: string, profile: ToolProfile, extra: Partial<PersonaSession> = {}, media?: DeviceMedia[]) {
  const deviceProfile = resolveDeviceProfile(preset, undefined, { maxDeviceScaleFactor: 1 })
  const device = await farm.createDevice({
    id,
    profile: deviceProfile,
    baseUrl: app.url,
    downloadsDir: join(run, 'dl', id),
    fileSources: [],
    ...(media ? { media } : {}),
  })
  await device.perform({ type: 'open', url: '/sign-in' })
  const persona: PersonaSession = {
    sessionId: id,
    personaName: id,
    device,
    profile,
    input: deviceProfile.input,
    files: [],
    shotsDir: join(run, 'shots', id),
    shotsRel: `shots/${id}`,
    events,
    findings,
    baseUrl: app.url,
    replayShots: true,
    networkToggle: false,
    hooks: { onFinish: (diary) => diaries.push(diary) },
    ...extra,
  }
  const endpoint = tools.register(persona)
  return { device, endpoint }
}

async function connect(endpoint: EndpointInfo) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }))
  return client
}

describe('ToolServer', () => {
  it('gives each profile its own tools', async () => {
    const names = async (id: string, preset: string, profile: ToolProfile) => {
      const { endpoint } = await session(id, preset, profile)
      const client = await connect(endpoint)
      const list = (await client.listTools()).tools.map((tool) => tool.name)
      await client.close()
      return list
    }
    const sight = await names('novice', 'laptop-1366', 'sight')
    expect(sight).toContain('click_at')
    expect(sight).not.toContain('outline')
    expect(sight).not.toContain('click')
    const power = await names('expert', 'desktop-1440', 'power')
    expect(power).toEqual(expect.arrayContaining(['outline', 'find_text', 'click', 'click_at', 'tabs', 'drop_file']))
    const phone = await names('phone', 'iphone-13', 'sight')
    expect(phone).toEqual(expect.arrayContaining(['tap_at', 'swipe', 'pinch', 'rotate']))
    expect(phone).not.toContain('click_at')
    const keys = await names('keys', 'laptop-1280', 'keyboard')
    expect(keys).not.toContain('click_at')
    expect(keys).toEqual(expect.arrayContaining(['press', 'type', 'screenshot']))
    const reader = await names('reader', 'laptop-1280', 'screenreader')
    expect(reader).not.toContain('screenshot')
    expect(reader).toContain('outline')
  })

  it('enforces body traits: shaky clicks, typos, a second tab, all in the log', async () => {
    const { endpoint } = await session('shaky', 'laptop-1280', 'sight', { body: bodyOf({ precision: 1, typing: 'typos', multitab: true }), seed: 7 })
    const client = await connect(endpoint)
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]?.text ?? ''
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('tabs')
    for (let index = 0; index < 6; index += 1) await call('click_at', { x: 300, y: 200 })
    await call('type', { text: 'Please deliver the large ceramic order to the warehouse tomorrow morning before lunchtime, thank you kindly' })
    const after = await call('wait', { seconds: 0 })
    expect(after).toMatch(/tab \d of 2/)
    await client.close()
    await events.close()
    const log = await readEvents(join(run, 'events'), 'shaky')
    const slips = log.filter((event) => event.type === 'tool.result').flatMap((event) => (event.body as string[] | undefined) ?? [])
    expect(slips.some((slip) => /px off/.test(slip))).toBe(true)
    expect(slips.some((slip) => slip.includes(' → '))).toBe(true)
    expect(log.some((event) => event.type === 'interruption' && event.kind === 'second-tab')).toBe(true)
  })

  it('interrupts a persona with a reload, a dropped connection or a reopened tab', async () => {
    // The seed whose first interruption is each kind, found the way the tool server draws its numbers
    // for actions that use none of their own (waits).
    const seedFor = (wanted: string) => {
      for (let seed = 1; seed < 5000; seed += 1) {
        const random = seededRandom(seed)
        let since = 0
        for (let action = 1; action <= 40; action += 1) {
          since += 1
          if (!interruptionDue('many', action, since, random)) continue
          if (pickInterruption(random) === wanted) return { seed, action }
          break
        }
      }
      throw new Error(`no seed for ${wanted}`)
    }
    for (const kind of ['reload', 'offline', 'reopen'] as const) {
      const { seed, action } = seedFor(kind)
      const id = `interrupted-${kind}`
      const { device, endpoint } = await session(id, 'laptop-1280', 'sight', { body: bodyOf({ interruptions: 'many' }), seed })
      const client = await connect(endpoint)
      let text = ''
      for (let index = 1; index <= action; index += 1)
        text = ((await client.callTool({ name: 'wait', arguments: { seconds: 0 } })).content as { text: string }[])[0]?.text ?? ''
      expect(text).toMatch(kind === 'reload' ? /reloaded the page/ : kind === 'offline' ? /connection dropped/ : /closed the tab by accident/)
      expect((await device.status()).online).toBe(true)
      expect((await device.status()).tab.count).toBe(1)
      await client.close()
    }
  })

  it('lists each file with what it is, and names the files uploaded before a report as its evidence', async () => {
    const photo = join(run, 'vase.png')
    writeFileSync(photo, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, 1)]))
    // Its own findings: the tests after this one count the shared ones.
    const own = new RunFindings(join(run, 'uploader-findings.jsonl'), events, [])
    const { device, endpoint } = await session(
      'uploader',
      'desktop-1440',
      'power',
      { files: [{ name: 'vase.png', size: '1 KB', label: 'a photo of the blue vase' }], findings: own },
      [{ name: 'vase.png', file: photo, type: 'image/png' }],
    )
    const client = await connect(endpoint)
    const tools = (await client.listTools()).tools
    expect(tools.find((tool) => tool.name === 'pick_file')?.description).toContain('vase.png (1 KB, a photo of the blue vase)')
    const outline = (await device.outline()).text
    const ref = (label: RegExp) => /\[ref=([^\]]+)\]/.exec(outline.split('\n').find((line) => label.test(line)) ?? '')?.[1]
    await device.perform({ type: 'fill', ref: ref(/textbox "Email"/) ?? '', text: 'uploader@fixture.test' })
    await device.perform({ type: 'fill', ref: ref(/textbox "Password"/) ?? '', text: 'secret' })
    await device.perform({ type: 'click', target: { ref: ref(/button "Sign in"/) ?? '' } })
    await device.perform({ type: 'wait', seconds: 3, forText: 'New order' })
    const order = /\[ref=([^\]]+)\]/.exec((await device.outline()).text.split('\n').find((line) => /link "Oliver Brown"/.test(line)) ?? '')?.[1]
    await device.perform({ type: 'click', target: { ref: order ?? '' } })
    const box = await (device as unknown as { page(): Page }).page().locator('#photo').boundingBox()
    if (!box) throw new Error('no file input on the order page')
    const at = { x: Math.round(box.x + 30), y: Math.round(box.y + box.height / 2) }
    const picked = ((await client.callTool({ name: 'pick_file', arguments: { file: 'vase.png', ...at } })).content as { text: string }[])[0]?.text
    expect(picked).toContain('Chose vase.png.')
    await client.callTool({
      name: 'report_problem',
      arguments: {
        title: 'The vase photo upload shows nothing',
        what_i_did: 'Chose the photo',
        what_i_expected: 'A preview',
        what_happened: 'No preview',
        how_bad: 'minor',
        sure: true,
      },
    })
    expect(own.all()[0]?.evidence.media).toEqual(['vase.png'])
    await client.close()
    await own.close()
  })

  it('acts, reports a problem with evidence and records the diary', async () => {
    const { endpoint } = await session('alice', 'desktop-1440', 'power')
    const client = await connect(endpoint)
    const shot = await client.callTool({ name: 'screenshot', arguments: {} })
    const content = shot.content as { type: string; mimeType?: string; text?: string }[]
    expect(content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect(content[1]?.text).toContain('[Screen]')

    const outline = (await client.callTool({ name: 'outline', arguments: {} })).content as { text: string }[]
    const ref = /textbox "Email" \[ref=([^\]]+)\]/.exec(outline[0]?.text ?? '')?.[1]
    expect(ref).toBeTruthy()
    const filled = (await client.callTool({ name: 'fill', arguments: { ref, text: 'alice@fixture.test' } })).content as { text: string }[]
    expect(filled[0]?.text).toContain('Filled.')

    const stale = await client.callTool({ name: 'click', arguments: { ref: 'e99999' } })
    expect(stale.isError).toBe(true)

    const draft = {
      title: 'Search ignores accents so Jose is not found',
      what_i_did: 'Typed jose in the search box',
      what_i_expected: 'José Álvarez in the results',
      what_happened: 'No orders match',
      how_bad: 'annoying',
      sure: true,
    }
    // Close to a known issue: held back until the reporter says it is a different problem.
    const held = (await client.callTool({ name: 'report_problem', arguments: draft })).content as { text: string }[]
    expect(held[0]?.text).toContain('Not filed yet')
    expect(held[0]?.text).toContain('K-1')
    expect(findings.all()).toHaveLength(0)
    const report = (await client.callTool({ name: 'report_problem', arguments: { ...draft, not_same_as: ['k-1'] } })).content as { text: string }[]
    expect(report[0]?.text).toMatch(/Reported as F-\d+/)
    expect(findings.all()[0]?.notSameAs).toEqual(['K-1'])

    await client.callTool({
      name: 'finish',
      arguments: { outcome: 'gave_up', summary: 'test', ease: 4, trust: 5, would_use: 'maybe', why: 'search' },
    })
    expect(diaries.at(-1)).toMatchObject({ outcome: 'gave_up', ease: 4 })
    await client.close()

    await events.close()
    const log = await readEvents(join(run, 'events'), 'alice')
    const results = log.filter((event) => event.type === 'tool.result')
    expect(results.some((event) => event.harnessError === true)).toBe(true)
    expect(results.some((event) => typeof event.screenshot === 'string')).toBe(true)
    const saved = await readJsonLines<{ type: string; evidence: { screenshot?: string } }>(join(run, 'findings.jsonl'))
    expect(saved.find((line) => line.type === 'finding')?.evidence.screenshot).toMatch(/^shots\/alice\/r/)
  })

  it('holds likely duplicates and records confirmations with evidence', async () => {
    const { endpoint } = await session('bob', 'laptop-1280', 'sight')
    const client = await connect(endpoint)
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]?.text ?? ''

    const held = await call('report_problem', {
      title: 'Search does not find Jose because of the accent',
      what_i_did: 'Searched for jose',
      what_i_expected: 'José in the list',
      what_happened: 'No orders match',
      how_bad: 'minor',
      sure: true,
    })
    expect(held).toContain('Not filed yet')
    expect(held).toMatch(/F-1 "Search ignores accents so Jose is not found" \(1 tester so far\)/)
    expect(held).toMatch(/not_same_as: \[[^\]]*"F-1"/)

    // Sending the very same report again files it rather than holding it forever.
    const insisted = await call('report_problem', {
      title: 'Search does not find Jose because of the accent',
      what_i_did: 'Searched for jose',
      what_i_expected: 'José in the list',
      what_happened: 'No orders match',
      how_bad: 'minor',
      sure: true,
    })
    expect(insisted).toMatch(/Reported as F-\d+/)

    expect(await call('confirm_problem', { id: 'f-1', note: 'Same on my laptop' })).toContain('Confirmed F-1')
    expect(await call('confirm_problem', { id: 'F-1' })).toContain('already confirmed')
    expect(await call('confirm_problem', { id: 'K-1', note: 'still happens' })).toContain('Confirmed K-1')
    expect(await call('confirm_problem', { id: 'F-404' })).toContain('There is no problem F-404')
    const vote = findings.get('F-1')?.votes[0]
    expect(vote).toMatchObject({ session: 'bob', note: 'Same on my laptop' })
    expect(vote?.screenshot).toMatch(/^shots\/bob\/v\d{4}\.jpg$/)
    expect(vote?.url).toContain('/sign-in')
    expect(findings.knownIssueHits()).toMatchObject([{ id: 'K-1', votes: [{ session: 'bob', note: 'still happens' }] }])
    await client.close()

    const own = await connect((await session('alice', 'desktop-1440', 'power')).endpoint)
    const text = ((await own.callTool({ name: 'confirm_problem', arguments: { id: 'F-1' } })).content as { text: string }[])[0]?.text
    expect(text).toContain('your own report')
    await own.close()

    // Votes on reports and known issues survive a reload of the findings file.
    await findings.close()
    const reloaded = new RunFindings(join(run, 'findings.jsonl'), events, [{ id: 'K-1', title: 'Search ignores accents in names' }])
    await reloaded.load()
    expect(reloaded.get('F-1')?.votes).toHaveLength(1)
    expect(reloaded.knownIssueHits()[0]?.votes).toHaveLength(1)
    await reloaded.close()
  })

  it('numbers screenshots per session, across connections', async () => {
    const { endpoint } = await session('carol', 'laptop-1280', 'sight')
    const names: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const client = await connect(endpoint)
      await client.callTool({ name: 'screenshot', arguments: {} })
      await client.close()
    }
    await events.close()
    for (const event of await readEvents(join(run, 'events'), 'carol')) if (event.type === 'tool.result') names.push(String(event.message))
    expect(new Set(names).size).toBe(3)
    expect(names).toEqual(['screenshot shots/carol/s0001.jpg', 'screenshot shots/carol/s0002.jpg', 'screenshot shots/carol/s0003.jpg'])
  })

  it('attaches the errors of the last minutes to a report, even after other actions', async () => {
    const { endpoint } = await session('fay', 'laptop-1280', 'sight')
    const client = await connect(endpoint)
    // Signed out, the orders API answers 401: an HTTP error signal.
    await client.callTool({ name: 'go_to', arguments: { address: '/api/orders' } })
    await client.callTool({ name: 'screenshot', arguments: {} })
    await client.callTool({ name: 'back', arguments: {} })
    const report = await client.callTool({
      name: 'report_problem',
      arguments: {
        title: 'The orders address shows raw text',
        what_i_did: 'opened it',
        what_i_expected: 'a page',
        what_happened: 'a line of code',
        how_bad: 'minor',
        sure: true,
      },
    })
    expect((report.content as { text: string }[])[0]?.text).toMatch(/Reported as F-\d+/)
    const finding = findings.all().find((candidate) => candidate.session === 'fay')
    expect(finding?.evidence.signals.join('\n')).toMatch(/http: GET \S+\/api\/orders → 401/)
    await client.close()
  })

  it('counts down time and actions, then allows only finish', async () => {
    const { endpoint } = await session('erin', 'laptop-1280', 'sight', { maxActions: 3, deadline: Date.now() + 9.5 * 60_000 })
    const client = await connect(endpoint)
    const say = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      return { text: (result.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('\n'), isError: Boolean(result.isError) }
    }
    // Looking and speaking up are free; steps in the app count.
    expect((await say('screenshot', {})).text).toContain('about 10 min left · 3 actions left')
    await say('note', { text: 'looking around' })
    expect((await say('press', { keys: 'Tab' })).text).toContain('2 actions left')
    expect((await say('press', { keys: 'Tab' })).text).toContain('1 action left')
    expect((await say('press', { keys: 'Tab' })).text).toContain('no actions left: call finish now')
    expect((await say('screenshot', {})).isError).toBe(false)
    const refused = await say('click_at', { x: 10, y: 10 })
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining('No actions left') })
    expect((await say('note', { text: 'out of steps' })).isError).toBe(false)
    expect((await say('finish', { outcome: 'completed', summary: 'done', ease: 7, trust: 7, would_use: 'yes', why: 'fine' })).isError).toBe(false)
    await client.close()
  })

  it('splits a long outline into parts at line breaks', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- button "Action ${i}" [ref=e${i}]`)
    const parts = outlineParts(lines.join('\n'), 300)
    expect(parts.length).toBeGreaterThan(3)
    expect(parts.every((part) => part.length <= 300)).toBe(true)
    expect(parts.join('\n')).toBe(lines.join('\n'))
    expect(outlineParts('', 300)).toEqual([''])
  })

  it('closes connections that a driver never ends', async () => {
    const { endpoint } = await session('dave', 'laptop-1280', 'sight')
    const clients = []
    for (let i = 0; i < 6; i += 1) clients.push(await connect(endpoint))
    expect(tools.connections('dave')).toBe(4)
    // The newest connections still work.
    expect((await clients.at(-1)?.listTools())?.tools.length).toBeGreaterThan(5)
    for (const client of clients) await client.close().catch(() => {})
  })

  it('refuses another session token', async () => {
    const one = await session('one', 'laptop-1280', 'reader')
    const two = await session('two', 'laptop-1280', 'reader')
    const client = new Client({ name: 'intruder', version: '1' })
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(one.endpoint.url), { requestInit: { headers: two.endpoint.headers } })),
    ).rejects.toThrow()
  })
})
