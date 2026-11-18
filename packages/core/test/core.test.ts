import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  deriveToolProfile,
  EventStore,
  fingerprint,
  JsonLinesWriter,
  loadCohort,
  loadExporters,
  loadGroupingConfig,
  loadPersona,
  loadWorkspace,
  machineId,
  newRunId,
  parseMeminfo,
  parseMemoryPressure,
  parseVmStat,
  problemSimilarity,
  processIdentity,
  RunLock,
  readEvents,
  resolveDeviceProfile,
  resolveEnvReferences,
  routePattern,
  runCommand,
  textSimilarity,
  withFileLock,
} from '../src/index.js'

describe('device presets and tool profiles', () => {
  it('clamps the device scale and merges overrides', () => {
    const profile = resolveDeviceProfile('iphone-13', { locale: 'sv-SE' }, { maxDeviceScaleFactor: 1 })
    expect(profile).toMatchObject({ deviceScaleFactor: 1, hasTouch: true, input: 'touch', locale: 'sv-SE' })
    expect(() => resolveDeviceProfile('nokia-3310', undefined, { maxDeviceScaleFactor: 1 })).toThrow(/Known presets/)
  })

  it('keeps a preset intact when a persona overrides only its locale (regression)', () => {
    const { persona } = loadPersona(join(__dirname, '../../../personas/busy-phone-user.yaml'))
    const profile = resolveDeviceProfile(persona.device, persona.deviceOverrides, { maxDeviceScaleFactor: 1 })
    expect(profile).toMatchObject({ hasTouch: true, isMobile: true, input: 'touch', locale: 'sv-SE' })
    expect(deriveToolProfile(persona, profile)).toBe('sight')
  })

  it('derives the tool profile from input first, then proficiency', () => {
    const desktop = resolveDeviceProfile('desktop-1440', undefined, { maxDeviceScaleFactor: 1 })
    expect(deriveToolProfile({ proficiency: 2 }, desktop)).toBe('sight')
    expect(deriveToolProfile({ proficiency: 3 }, desktop)).toBe('reader')
    expect(deriveToolProfile({ proficiency: 5 }, desktop)).toBe('power')
    expect(deriveToolProfile({ proficiency: 5 }, { ...desktop, input: 'keyboard' })).toBe('keyboard')
    expect(deriveToolProfile({ proficiency: 5 }, resolveDeviceProfile('pixel-7', undefined, { maxDeviceScaleFactor: 1 }))).toBe('sight')
    expect(deriveToolProfile({ proficiency: 1, toolProfile: 'screenreader' }, desktop)).toBe('screenreader')
  })
})

describe('config loading', () => {
  it('resolves placeholders only where a command needs them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-config-'))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is what is under test
    writeFileSync(join(dir, 'persona-swarm.yaml'), "browser: { connect: { url: 'wss://b.test/?t=${env:NOT_SET_HERE}' } }\n")
    expect(() => loadWorkspace(dir)).toThrow(/NOT_SET_HERE/)
    expect(loadWorkspace(dir, { resolveEnv: false }).runsDir).toBe(join(dir, 'runs'))
    writeFileSync(
      join(dir, 'cohort.yaml'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is what is under test
      "id: c\ntarget: t.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock, options: { key: '${env:NOT_SET_HERE}' } } }\nexporters: [{ type: markdown }]\n",
    )
    expect(loadExporters(join(dir, 'cohort.yaml'))).toMatchObject([{ type: 'markdown' }])
  })

  it('rejects settings that would only fail later', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-config-'))
    writeFileSync(join(dir, 'target.yaml'), 'id: app\nname: App\nbaseUrl: localhost:3000\n')
    writeFileSync(join(dir, 'p.yaml'), 'id: p\nname: P\nproficiency: 3\nbackground: x\nmission: { goal: y }\ndevice: laptop-1280\n')
    writeFileSync(join(dir, 'cohort.yaml'), 'id: c\ntarget: target.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock } }\n')
    expect(() => loadCohort(join(dir, 'cohort.yaml'))).toThrow(/http\(s\) address/)
    writeFileSync(
      join(dir, 'cohort.yaml'),
      'id: c\ntarget: target.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock } }\nexporters: [{ type: githb }]\n',
    )
    expect(() => loadExporters(join(dir, 'cohort.yaml'))).toThrow(ConfigError)
    writeFileSync(
      join(dir, 'cohort.yaml'),
      'id: c\ntarget: target.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock } }\nexporters: [{ type: webhook }, { type: webhook }]\n',
    )
    expect(() => loadExporters(join(dir, 'cohort.yaml'))).toThrow(/need an id each/)
    // Exporting needs only the cohort file, not the target (whose secrets may be unset here).
    writeFileSync(
      join(dir, 'cohort.yaml'),
      'id: c\ntarget: target.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock } }\nexporters: [{ type: markdown }]\n',
    )
    expect(loadExporters(join(dir, 'cohort.yaml'))).toMatchObject([{ type: 'markdown' }])
  })

  it('reads a workspace for a read-only command whatever secrets are unset, but never guesses its runs folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-config-'))
    writeFileSync(
      join(dir, 'persona-swarm.yaml'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is what is under test
      "providers: { lab: { type: openai-compatible, baseURL: '${env:PS_UNSET_URL}' } }\nbrowser: { executablePath: ./bin/chrome }\n",
    )
    const ws = loadWorkspace(dir, { resolveEnv: false })
    expect(ws.config.providers.lab?.type).toBe('openai-compatible')
    expect(ws.config.browser.executablePath).toBe(join(dir, 'bin', 'chrome'))
    expect(() => loadWorkspace(dir)).toThrow(/PS_UNSET_URL/)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is what is under test
    writeFileSync(join(dir, 'persona-swarm.yaml'), "runsDir: '${env:PS_UNSET_RUNS}'\n")
    expect(() => loadWorkspace(dir, { resolveEnv: false })).toThrow(/runsDir uses .*PS_UNSET_RUNS/)
  })

  it("reads a cohort's grouping on its own: a model or a command, never both", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-config-'))
    const cohort = (grouping: string) =>
      writeFileSync(join(dir, 'cohort.yaml'), `id: c\ntarget: missing.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock } }\n${grouping}`)
    cohort('')
    expect(loadGroupingConfig(join(dir, 'cohort.yaml'))).toBeUndefined()
    cohort('grouping: { model: openai:gpt-5-mini }\n')
    expect(loadGroupingConfig(join(dir, 'cohort.yaml'))).toEqual({ model: 'openai:gpt-5-mini', timeoutSec: 300 })
    cohort('grouping: { command: [claude, -p], timeoutSec: 60 }\n')
    expect(loadGroupingConfig(join(dir, 'cohort.yaml'))).toEqual({ command: ['claude', '-p'], timeoutSec: 60 })
    cohort('grouping: { model: openai:gpt-5-mini, command: [claude, -p] }\n')
    expect(() => loadGroupingConfig(join(dir, 'cohort.yaml'))).toThrow(/a model or a command/)
    cohort('grouping: {}\n')
    expect(() => loadGroupingConfig(join(dir, 'cohort.yaml'))).toThrow(/a model or a command/)
  })

  it('reports typos with the file and the field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-config-'))
    writeFileSync(join(dir, 'target.yaml'), 'id: app\nname: App\nbaseUrl: http://localhost:1\n')
    writeFileSync(join(dir, 'cohort.yaml'), 'id: c\ntarget: target.yaml\npersonas: [p.yaml]\nroles: { persona: { driver: mock } }\nbudget: {}\n')
    expect(() => loadCohort(join(dir, 'cohort.yaml'))).toThrow(ConfigError)
    expect(() => loadCohort(join(dir, 'cohort.yaml'))).toThrow(/budget/)
  })

  it('resolves paths, globs and the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-config-'))
    writeFileSync(join(dir, 'persona-swarm.yaml'), 'runsDir: out\n')
    writeFileSync(join(dir, 'target.yaml'), 'id: app\nname: App\nbaseUrl: http://localhost:1\nfixtures: [{ dir: files }]\n')
    writeFileSync(join(dir, 'a.persona.yaml'), 'id: a\nname: A\nproficiency: 3\nbackground: x\nmission: { goal: y }\ndevice: laptop-1280\n')
    writeFileSync(join(dir, 'b.persona.yaml'), 'id: b\nname: B\nproficiency: 4\nbackground: x\nmission: { goal: y }\ndevice: pixel-7\n')
    writeFileSync(join(dir, 'cohort.yaml'), 'id: c\ntarget: target.yaml\npersonas: ["*.persona.yaml"]\nroles: { persona: { driver: mock } }\n')
    const loaded = loadCohort(join(dir, 'cohort.yaml'))
    expect(loaded.personas.map((entry) => entry.persona.id)).toEqual(['a', 'b'])
    // The older `fixtures` are read as media.
    expect(loaded.target.target.media[0]?.dir).toBe(join(dir, 'files'))
    expect(loaded.workspace.runsDir).toBe(join(dir, 'out'))
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is what is under test
  it('fills in ${env:NAME} so secrets stay out of the files', () => {
    const env = { SHOP_PASSWORD: 's3cret', HOST: 'staging' }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is what is under test
    expect(resolveEnvReferences({ accounts: [{ password: '${env:SHOP_PASSWORD}' }], url: 'https://${env:HOST}.test/' }, 'target.yaml', env)).toEqual({
      accounts: [{ password: 's3cret' }],
      url: 'https://staging.test/',
    })
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder syntax is what is under test
    expect(() => resolveEnvReferences({ password: '${env:NOT_SET_ANYWHERE}' }, 'target.yaml', env)).toThrow(/NOT_SET_ANYWHERE is not set/)
  })
})

describe('memory sampling parsers', () => {
  it('reads memory_pressure, vm_stat and meminfo', () => {
    expect(parseMemoryPressure('System-wide memory free percentage: 42%')).toBe(42)
    const vm =
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100000.\nPages inactive: 50000.\nPages speculative: 0.\nPages purgeable: 0.\n'
    expect(parseVmStat(vm, 16384 * 300000)).toBeCloseTo(50, 0)
    expect(parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\n')).toBe(25)
  })
})

describe('locks', () => {
  it('takes over a lock whose process is gone, or whose pid now belongs to another process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-locks-'))
    const file = join(dir, 'review.json')
    // A live pid (this process) but another start time: a later process reusing a dead run's pid.
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, host: hostname(), t: new Date().toISOString(), started: '2001-01-01T00:00:00.000Z', token: 'old' }),
    )
    expect(await withFileLock(file, async () => 'ran', { timeoutMs: 500 })).toBe('ran')
    expect(existsSync(`${file}.lock`)).toBe(false)
    writeFileSync(
      join(dir, 'run.lock'),
      JSON.stringify({ pid: process.pid, host: hostname(), t: new Date().toISOString(), started: '2001-01-01T00:00:00.000Z' }),
    )
    expect(RunLock.holder(dir)).toBeUndefined()
  })

  it('knows its own live process after a host-name change, and a dead one whatever the name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-locks-'))
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise((resolveLater) => setTimeout(resolveLater, 300))
      const identity = processIdentity(child.pid as number)
      expect(identity).toBeTruthy()
      // Written under the machine's old name (a laptop that changed networks): still this machine's live process.
      writeFileSync(
        join(dir, 'run.lock'),
        JSON.stringify({ pid: child.pid, host: 'old-name.local', t: new Date().toISOString(), identity, ...(machineId() ? { machine: machineId() } : {}) }),
      )
      expect(RunLock.holder(dir)).toEqual({ pid: child.pid, host: 'old-name.local', local: true })
      expect(RunLock.acquire(dir)).toMatchObject({ heldBy: child.pid, local: true })
    } finally {
      child.kill('SIGKILL')
    }
    await new Promise((resolveLater) => setTimeout(resolveLater, 300))
    const lock = RunLock.acquire(dir)
    expect(lock).toBeInstanceOf(RunLock)
    ;(lock as RunLock).release()
    // Another machine's lock (a shared folder) is never taken over: it cannot be checked from here.
    writeFileSync(join(dir, 'run.lock'), JSON.stringify({ pid: 999_999, host: 'elsewhere', t: new Date().toISOString(), identity: 'x', machine: 'another' }))
    expect(RunLock.acquire(dir)).toMatchObject({ host: 'elsewhere', local: false })
  })

  it('never hands a live lock to a second holder, and leaves a lock it does not own alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-locks-'))
    const file = join(dir, 'exports.json')
    let inside = 0
    let most = 0
    const work = () =>
      withFileLock(
        file,
        async () => {
          inside += 1
          most = Math.max(most, inside)
          await new Promise((resolveWait) => setTimeout(resolveWait, 30))
          inside -= 1
        },
        { staleMs: 1 },
      )
    await Promise.all([work(), work(), work()])
    expect(most).toBe(1)
  })
})

describe('similarity', () => {
  it('scores paraphrased reports above unrelated ones', () => {
    const same = textSimilarity(
      'Detection failure tells the clinician to check the provider connection',
      'Detection failure message tells a clinic to check the provider connection',
    )
    const different = textSimilarity('PDF replaces Japanese characters', 'Dashboard never refreshes')
    expect(same).toBeGreaterThan(0.4)
    expect(different).toBeLessThan(0.15)
  })

  it('compares problem reports by title or by title and description, whichever is closer', () => {
    // Short titles carry the gist; long descriptions add noise (a real pair from a fixture-app run).
    const a = { title: 'Delete order is a tiny red x with no label', actual: 'There is a tiny red x square right under the customer name with no text.' }
    const b = { title: 'Tiny red x on the order page with no label', actual: 'Tab lands on a small red x whose focus outline is barely visible.' }
    expect(problemSimilarity(a, b)).toBeGreaterThan(0.5)
    expect(problemSimilarity(a, b)).toBe(Math.max(textSimilarity(a.title, b.title), textSimilarity(`${a.title} ${a.actual}`, `${b.title} ${b.actual}`)))
  })

  it('compares reports in any script, and nothing is not the same as nothing', () => {
    const ru = (text: string) => ({ title: text, actual: '' })
    expect(problemSimilarity(ru('Кнопка сохранения не работает'), ru('Дата доставки показана неправильно'))).toBeLessThan(0.2)
    expect(problemSimilarity(ru('Кнопка сохранения не работает'), ru('Кнопка сохранения совсем не работает'))).toBeGreaterThan(0.5)
    expect(problemSimilarity(ru('保存ボタンが動かない'), ru('保存ボタンが反応しない'))).toBeGreaterThan(0.3)
    expect(problemSimilarity(ru('保存ボタンが動かない'), ru('配送日の表示がおかしい'))).toBeLessThan(0.15)
    expect(textSimilarity('!!!', '???')).toBe(0)
    expect(fingerprint('Кнопка не работает', 'http://x/a')).not.toBe(fingerprint('Дата неверна', 'http://x/a'))
  })

  it('keeps the marks that make a different word, and folds only decorative accents', () => {
    const hi = (text: string) => ({ title: text, actual: '' })
    // "the form is empty" and "the form is open": the vowel signs are the difference.
    expect(problemSimilarity(hi('फ़ॉर्म खाली है'), hi('फ़ॉर्म खुला है'))).toBeLessThan(0.9)
    expect(textSimilarity('ไม่', 'ไม้')).toBeLessThan(1)
    expect(textSimilarity('Café crème brûlée', 'cafe creme brulee')).toBe(1)
    // Hebrew's maqaf joins two words with a hyphen of its own: they stay two words.
    expect(textSimilarity('בית־ספר', 'בית ספר')).toBe(1)
  })

  it('ignores ids in routes and keeps fingerprints stable', () => {
    expect(routePattern('http://x/cases/3f2a0b4c-1111-4222-8333-944455556666/edit')).toBe('/cases/:id/edit')
    // An app that routes in the fragment keeps its pages apart.
    expect(routePattern('http://x/#/orders/7')).toBe('/#/orders/:id')
    expect(routePattern('http://x/#/settings')).not.toBe(routePattern('http://x/#/orders/7'))
    expect(routePattern('http://x/page#section-2')).toBe('/page')
    expect(fingerprint('Save does nothing', 'http://x/orders/123')).toBe(fingerprint('save does NOTHING!', 'http://x/orders/456'))
  })
})

describe('commands', () => {
  it('kills a command that hangs with everything it started, and never waits for a child holding its pipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-command-'))
    const pidFile = join(dir, 'grandchild.pid')
    const script = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000)`
    const started = Date.now()
    const result = await runCommand([process.execPath, '-e', script], '', { timeoutMs: 800 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((resolveLater) => setTimeout(resolveLater, 300))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  it('does not start when it is already stopped, and keeps characters whole across chunks', async () => {
    const stopped = new AbortController()
    stopped.abort('the run is over')
    expect(await runCommand([process.execPath, '-e', ''], '', { timeoutMs: 5_000, signal: stopped.signal })).toMatchObject({ code: null })
    const result = await runCommand([process.execPath, '-e', "process.stdout.write('é'.repeat(200000))"], '', { timeoutMs: 10_000 })
    expect(result.out).toBe('é'.repeat(200_000))
  })
})

describe('json-lines writer', () => {
  it('keeps the records it could not write and writes them, in order, once it can', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ps-writer-')), 'events.jsonl')
    // A folder where the file should be: every write fails, as on a full disk.
    mkdirSync(file)
    const writer = new JsonLinesWriter(file, { retryMs: 10 })
    writer.write({ n: 1 })
    writer.write({ n: 2 })
    await new Promise((resolveLater) => setTimeout(resolveLater, 100))
    rmSync(file, { recursive: true })
    for (let i = 0; i < 100 && !existsSync(file); i += 1) await new Promise((resolveLater) => setTimeout(resolveLater, 20))
    writer.write({ n: 3 })
    await writer.close()
    expect(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).n),
    ).toEqual([1, 2, 3])
  })
})

describe('event store', () => {
  it('numbers events per session and survives a resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-events-'))
    const store = new EventStore(dir)
    store.append('s1', 'note', { text: 'a' })
    store.append('s1', 'note', { text: 'b' })
    await store.close()
    const resumed = new EventStore(dir)
    await resumed.primeFromDisk('s1')
    expect(resumed.append('s1', 'note', { text: 'c' }).seq).toBe(3)
    await resumed.close()
    expect((await readEvents(dir, 's1', { afterSeq: 1 })).map((event) => event.text)).toEqual(['b', 'c'])
    expect(newRunId()).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/)
  })
})
