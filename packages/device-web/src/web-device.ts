import { mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  ActionOutcome,
  Device,
  DeviceAction,
  DeviceCapabilities,
  DeviceProfile,
  DeviceSignal,
  DeviceStatus,
  NetworkProfile,
  Outline,
  PointTarget,
  Screenshot,
} from '@persona-swarm/core'
import { layoutViewport, mediaType, normalizeText, plainFileIn } from '@persona-swarm/core'
import type { BrowserContext, CDPSession, Dialog, FileChooser, Locator, Page } from 'playwright-core'
import { type DeviceMedia, resolveFile } from './files.js'

const NETWORK_PROFILES: Record<Exclude<NetworkProfile & string, 'offline'>, { latencyMs: number; downloadKbps: number; uploadKbps: number }> = {
  'slow-3g': { latencyMs: 400, downloadKbps: 500, uploadKbps: 500 },
  'fast-3g': { latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
  'clinic-dsl': { latencyMs: 120, downloadKbps: 4000, uploadKbps: 1000 },
}

const ACTION_TIMEOUT_MS = 6000
const NAV_TIMEOUT_MS = 20_000

/** A page call that may never answer (a page stuck in a loop): its result, or `fallback` after `ms`. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([work.catch(() => fallback), new Promise<T>((resolveLater) => (timer = setTimeout(() => resolveLater(fallback), ms)))]).finally(() =>
    clearTimeout(timer),
  )
}

/** How long an action may take before the page counts as frozen. */
function ceilingMs(action: DeviceAction, ordinary = 30_000): number {
  switch (action.type) {
    case 'wait':
      return (Math.min(120, Math.max(1, action.seconds)) + 10) * 1000
    case 'type':
      return Math.max(30_000, action.text.length * 40 + 10_000)
    case 'long_press':
      return (action.ms ?? 800) + 20_000
    case 'open':
    case 'reload':
    case 'back':
    case 'forward':
    case 'new_tab':
      return NAV_TIMEOUT_MS + 10_000
    default:
      return ordinary
  }
}

/** An action failed because of how it was asked (bad ref, bad arguments), not because of the app. */
class HarnessError extends Error {}

/** The action reached the app but nothing came of it, as a person would notice. */
class NoEffect extends Error {}

export interface WebDeviceOptions {
  id: string
  profile: DeviceProfile
  context: BrowserContext
  baseUrl: string
  allowedOrigins: string[]
  downloadsDir: string
  fileSources: { dir: string; pattern: string }[]
  /** The session's own files: when given, only these can be uploaded (instead of fileSources). */
  media?: DeviceMedia[]
  throttleUrls: string[]
  screenshotQuality: number
  settleMs: number
  /** Send uploaded files as data rather than paths (a remote browser cannot read this machine's disk). */
  uploadAsData?: boolean
  /** How long an ordinary action may take before the page counts as frozen (default 30 s). */
  actionCeilingMs?: number
  /** Return as soon as an action is done, without waiting for the page to settle (a persona who rushes). */
  rush?: boolean
  onSignal?: (signal: DeviceSignal) => void
}

export class WebDevice implements Device {
  readonly id: string
  readonly kind = 'web' as const
  readonly profile: DeviceProfile
  private readonly context: BrowserContext
  private readonly pages: Page[] = []
  /** The tab the persona is in; a closing pop-up hands back to the page that opened it. */
  private currentPage?: Page
  private readonly openers = new WeakMap<Page, Page>()
  /** Each page's network and CPU emulation: a new tab's first navigation waits for it. */
  private readonly emulations = new WeakMap<Page, Promise<void>>()
  private readonly cdp = new WeakMap<Page, Promise<CDPSession>>()
  private pendingDialog?: Dialog
  private dialogWaiters: Array<(dialog: Dialog) => void> = []
  private pendingChooser?: FileChooser
  private chooserWaiters: Array<(chooser: FileChooser) => void> = []
  /** One-off notices for the next status: navigations the guard stopped. */
  private guardNotices: string[] = []
  private readonly guards: Promise<void>[] = []
  private signals: DeviceSignal[] = []
  private online = true
  private closed = false
  private downloads: string[] = []
  private downloadCount = 0
  /** Downloads still being saved: an action waits (briefly) for the ones it started. */
  private readonly savingDownloads = new Set<Promise<void>>()

  constructor(private readonly options: WebDeviceOptions) {
    this.id = options.id
    this.profile = options.profile
    this.context = options.context
    mkdirSync(options.downloadsDir, { recursive: true })
    // A resumed session numbers its downloads after the ones already there: nothing is overwritten.
    for (const name of readdirSync(options.downloadsDir)) this.downloadCount = Math.max(this.downloadCount, Number(/^(\d+)-/.exec(name)?.[1] ?? 0))
    this.context.on('page', (page) => {
      this.attach(page)
      this.currentPage = page
      void page
        .opener()
        .then((opener) => {
          if (opener) this.openers.set(page, opener)
        })
        .catch(() => {})
    })
  }

  static async create(options: WebDeviceOptions): Promise<WebDevice> {
    const device = new WebDevice(options)
    if (options.profile.network === 'offline') {
      device.online = false
      await options.context.setOffline(true)
    }
    await options.context.newPage()
    // The first page is guarded before the persona's first action.
    await Promise.all(device.guards)
    return device
  }

  private allowedUrl(url: string): boolean {
    if (url.startsWith('about:') || url.startsWith('chrome-error:')) return true
    try {
      return this.options.allowedOrigins.includes(new URL(url).origin)
    } catch {
      return false
    }
  }

  /** Tells the persona, in plain words, that the test (not the app) stopped a navigation. */
  private blocked(url: string, what: 'link' | 'window'): void {
    const where = url.slice(0, 200)
    const text =
      what === 'window'
        ? `A new window for another website (${where}) was closed: that website is outside this test. This is a limit of the test, not a problem in the app.`
        : `That leads to another website (${where}), which is outside this test, so it did not open. This is a limit of the test, not a problem in the app.`
    this.guardNotices.push(text)
    this.signal({ kind: 'blocked', text, url })
  }

  /**
   * Keeps the persona in the app: a main-frame navigation to another origin (a link, a form, a
   * redirect) is answered "204 No Content", which leaves the current page as it is. Subresources and
   * frames are not touched.
   */
  private async guard(page: Page, popup: boolean): Promise<void> {
    const cdp = await this.session(page)
    const { frameTree } = await cdp.send('Page.getFrameTree')
    const mainFrame = frameTree.frame.id
    cdp.on('Fetch.requestPaused', (event) => {
      const leaving = event.frameId === mainFrame && !this.allowedUrl(event.request.url)
      if (!leaving) return void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {})
      // A pop-up that was only ever going elsewhere is closed rather than left blank.
      const blankPopup = page.url() === 'about:blank' && this.pages.length > 1
      this.blocked(event.request.url, blankPopup ? 'window' : 'link')
      void cdp
        .send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 204, body: '' })
        .catch(() => {})
        .then(() => (blankPopup ? page.close() : undefined))
        .catch(() => {})
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
    // A pop-up can arrive already navigated (or failed) before the guard exists: its history knows where it went.
    if (popup) {
      const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory')
      const url = entries[currentIndex]?.url ?? page.url()
      if (!this.allowedUrl(url)) await this.leftTheApp(page, url)
    }
  }

  /** What the guard could not stop in time (a pop-up's first page): close it, or step back. */
  private async leftTheApp(page: Page, url: string): Promise<void> {
    if (this.pages.length > 1) {
      this.blocked(url, 'window')
      await page.close().catch(() => {})
      return
    }
    this.blocked(url, 'link')
    if (!(await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null)))
      await page.goto(this.options.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
  }

  capabilities(): DeviceCapabilities {
    return {
      kind: 'web',
      pointer: this.profile.input !== 'keyboard' && this.profile.input !== 'screenreader',
      touch: this.profile.hasTouch,
      keyboard: true,
      outline: true,
      rotate: this.profile.isMobile,
      network: true,
      files: true,
      tabs: true,
    }
  }

  private page(): Page {
    const page = this.currentPage && this.pages.includes(this.currentPage) ? this.currentPage : this.pages.at(-1)
    if (!page) throw new Error('the device has no open page')
    return page
  }

  /** The persona's input decides the gesture, not the hardware: a mouse on a touch laptop still clicks. */
  private get touchInput(): boolean {
    return this.profile.input === 'touch'
  }

  private signal(signal: Omit<DeviceSignal, 't'>): void {
    const full = { t: new Date().toISOString(), ...signal }
    this.signals.push(full)
    if (this.signals.length > 500) this.signals.shift()
    this.options.onSignal?.(full)
  }

  private attach(page: Page): void {
    const popup = this.pages.length > 0
    this.pages.push(page)
    this.guards.push(this.guard(page, popup).catch((error) => this.signal({ kind: 'console.warning', text: `navigation guard: ${error.message}` })))
    this.emulations.set(
      page,
      this.emulate(page).catch((error) => this.signal({ kind: 'console.warning', text: `emulation: ${error.message}` })),
    )
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
    page.on('console', (message) => {
      const type = message.type()
      if (type === 'error' || type === 'warning')
        this.signal({ kind: type === 'error' ? 'console.error' : 'console.warning', text: message.text().slice(0, 800), url: page.url() })
    })
    page.on('pageerror', (error) => this.signal({ kind: 'pageerror', text: String(error.stack ?? error).slice(0, 1500), url: page.url() }))
    page.on('crash', () => this.signal({ kind: 'crash', text: 'the page crashed', url: page.url() }))
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'failed'
      if (failure.includes('ERR_ABORTED')) return
      this.signal({ kind: 'requestfailed', text: `${request.method()} ${request.url()} ${failure}`, url: request.url() })
    })
    page.on('response', (response) => {
      const status = response.status()
      if (status < 400) return
      const request = response.request()
      const type = request.resourceType()
      if (!['document', 'fetch', 'xhr'].includes(type)) return
      void response
        .text()
        .catch(() => '')
        .then((body) =>
          this.signal({
            kind: 'http',
            status,
            text: `${request.method()} ${response.url()} → ${status} ${body.slice(0, 300)}`,
            url: response.url(),
          }),
        )
    })
    page.on('dialog', (dialog) => {
      this.pendingDialog = dialog
      this.signal({ kind: 'dialog', text: `${dialog.type()}: ${dialog.message()}` })
      for (const waiter of this.dialogWaiters.splice(0)) waiter(dialog)
    })
    // File pickers are always intercepted. A listener added just before a click races the click,
    // and a picker nobody intercepts shows nothing in a headless browser. An open picker waits
    // for pick_file, as a real one waits for the person to choose.
    page.on('filechooser', (chooser) => {
      this.pendingChooser = chooser
      for (const waiter of this.chooserWaiters.splice(0)) waiter(chooser)
    })
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      if (this.pendingChooser?.page() === page) this.pendingChooser = undefined
      if (!this.allowedUrl(frame.url())) void this.leftTheApp(page, frame.url())
    })
    page.on('download', (download) => {
      // Numbered, so two files with the same name never overwrite each other.
      this.downloadCount += 1
      const target = join(this.options.downloadsDir, `${String(this.downloadCount).padStart(3, '0')}-${download.suggestedFilename()}`)
      const saving: Promise<void> = download
        .saveAs(target)
        .then(() => {
          this.downloads.push(target)
          this.signal({ kind: 'download', text: target })
        })
        .catch((error) => this.signal({ kind: 'console.warning', text: `download failed: ${error.message}` }))
        .finally(() => this.savingDownloads.delete(saving))
      this.savingDownloads.add(saving)
    })
    page.on('close', () => {
      if (this.pendingChooser?.page() === page) this.pendingChooser = undefined
      const index = this.pages.indexOf(page)
      if (index >= 0) this.pages.splice(index, 1)
      if (this.currentPage === page) {
        const opener = this.openers.get(page)
        this.currentPage = opener && this.pages.includes(opener) ? opener : this.pages.at(-1)
      }
    })
  }

  /** One CDP session per page: Chrome tracks touch sequences per session. */
  private session(page: Page): Promise<CDPSession> {
    let session = this.cdp.get(page)
    if (!session) {
      session = this.context.newCDPSession(page)
      this.cdp.set(page, session)
    }
    return session
  }

  /**
   * The persona's network: its profile's throttling (on the throttled URLs: absolute URL patterns, or
   * every request) and the device's online state, sent together through this device's own session (a
   * second sender would undo the other). Offline is a first rule that matches every request, and the
   * page's navigator.onLine follows.
   */
  private async applyNetwork(page: Page): Promise<void> {
    const { network } = this.profile
    if (!network || network === 'offline') return
    const numbers = typeof network === 'string' ? NETWORK_PROFILES[network] : network
    const conditions = {
      latency: numbers.latencyMs,
      downloadThroughput: (numbers.downloadKbps * 1000) / 8,
      uploadThroughput: (numbers.uploadKbps * 1000) / 8,
    }
    const patterns = this.options.throttleUrls.map((pattern) => (pattern === '*' ? '' : pattern))
    const rules = [
      ...(this.online ? [] : [{ urlPattern: '', offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }]),
      ...patterns.map((urlPattern) => ({ urlPattern, ...conditions })),
    ]
    const cdp = await this.session(page)
    await cdp.send('Network.enable')
    try {
      await cdp.send('Network.emulateNetworkConditionsByRule' as 'Network.emulateNetworkConditions', { matchedNetworkConditions: rules } as never)
      await cdp.send('Network.overrideNetworkState' as 'Network.emulateNetworkConditions', { offline: !this.online, ...conditions } as never).catch(() => {})
    } catch (error) {
      // A Chromium without rules (or a pattern it refuses): everything is throttled, and the operator is told.
      if (!this.throttleFallbackSaid) {
        this.throttleFallbackSaid = true
        this.signal({
          kind: 'console.warning',
          text: `network: throttling every request instead of ${patterns.join(', ') || 'all'} (${(error as Error).message})`,
        })
      }
      await cdp.send('Network.emulateNetworkConditions', { offline: !this.online, ...conditions })
    }
  }

  private throttleFallbackSaid = false

  private get throttled(): boolean {
    return Boolean(this.profile.network && this.profile.network !== 'offline')
  }

  private async emulate(page: Page): Promise<void> {
    await this.applyNetwork(page)
    if (this.profile.cpuThrottle) await (await this.session(page)).send('Emulation.setCPUThrottlingRate', { rate: this.profile.cpuThrottle })
    // Rendered for the persona's eyes: screenshots show the page as they see it.
    if (this.profile.visionDeficiency && this.profile.visionDeficiency !== 'none')
      await (await this.session(page)).send('Emulation.setEmulatedVisionDeficiency', { type: this.profile.visionDeficiency })
  }

  drainSignals(): DeviceSignal[] {
    return this.signals.splice(0)
  }

  /** Where the persona is. Never hangs: a page that does not answer (stuck in a loop) gives an empty title and no notices. */
  async status(): Promise<DeviceStatus> {
    const page = this.pages.length ? this.page() : undefined
    const viewport = page?.viewportSize() ?? layoutViewport(this.profile)
    const status: DeviceStatus = {
      url: page?.url() ?? 'about:blank',
      title: page ? await within(page.title(), 2_000, '') : '',
      tab: { index: page ? this.pages.indexOf(page) : 0, count: this.pages.length },
      viewport,
      notices: [...this.guardNotices.splice(0), ...(page ? await within(this.notices(page), 2_000, [] as string[]) : [])],
      online: this.online,
    }
    if (this.pendingDialog) status.dialog = { type: this.pendingDialog.type(), message: this.pendingDialog.message() }
    if (page && this.pendingChooser?.page() === page) status.filePicker = true
    return status
  }

  private async notices(page: Page): Promise<string[]> {
    if (this.pendingDialog) return []
    try {
      const texts = await page
        .locator('[role=alert]:visible, [role=alertdialog]:visible h2, [data-sonner-toast]:visible, .toast:visible, [role=status]:visible')
        .allInnerTexts()
      const seen = new Set<string>()
      return texts
        .map((text) => text.replace(/\s+/g, ' ').trim().slice(0, 240))
        .filter((text) => text && !seen.has(text) && seen.add(text))
        .slice(0, 6)
    } catch {
      return []
    }
  }

  private locate(ref: string): Locator {
    if (!/^(f\d+)?e\d+$/.test(ref)) throw new HarnessError(`"${ref}" is not a ref from the outline (refs look like e42).`)
    return this.page().locator(`aria-ref=${ref}`)
  }

  private inViewport(point: { x: number; y: number }): void {
    const viewport = this.page().viewportSize() ?? layoutViewport(this.profile)
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new HarnessError('x and y must be numbers (CSS pixels of the screenshot).')
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height)
      throw new HarnessError(`(${point.x}, ${point.y}) is outside the screen (${viewport.width}×${viewport.height}).`)
  }

  private async touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id?: number }[]): Promise<void> {
    const cdp = await this.session(this.page())
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
  }

  private async touchPath(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12, holdMs = 0): Promise<void> {
    await this.touch('touchStart', [from])
    if (holdMs) await this.page().waitForTimeout(holdMs)
    for (let step = 1; step <= steps; step += 1)
      await this.touch('touchMove', [{ x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps }])
    await this.touch('touchEnd', [])
  }

  private async pointAt(target: PointTarget, mode: 'click' | 'tap', options: { button?: 'left' | 'right'; count?: number } = {}): Promise<void> {
    if ('ref' in target) {
      const locator = this.locate(target.ref)
      if (mode === 'tap') await locator.tap()
      else await locator.click({ button: options.button ?? 'left', clickCount: options.count ?? 1 })
      return
    }
    this.inViewport(target)
    if (mode === 'tap') await this.page().touchscreen.tap(target.x, target.y)
    else await this.page().mouse.click(target.x, target.y, { button: options.button ?? 'left', clickCount: options.count ?? 1 })
  }

  /** The next file picker to open, or undefined if none opens in time. */
  private nextChooser(timeoutMs: number): Promise<FileChooser | undefined> {
    return new Promise((resolveChooser) => {
      const waiter = (chooser: FileChooser) => {
        clearTimeout(timer)
        resolveChooser(chooser)
      }
      const timer = setTimeout(() => {
        this.chooserWaiters = this.chooserWaiters.filter((each) => each !== waiter)
        resolveChooser(undefined)
      }, timeoutMs)
      this.chooserWaiters.push(waiter)
    })
  }

  private async settle(): Promise<void> {
    if (!this.pages.length || this.options.rush) return
    const page = this.page()
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(this.profile.network ? this.options.settleMs * 2 : this.options.settleMs)
  }

  private checkOrigin(url: string): string {
    let resolved: URL
    try {
      resolved = new URL(url, this.page().url().startsWith('http') ? this.page().url() : this.options.baseUrl)
    } catch {
      throw new HarnessError(`"${url}" is not a valid address.`)
    }
    if (!this.options.allowedOrigins.includes(resolved.origin))
      throw new HarnessError(`Only the app under test can be opened (${this.options.allowedOrigins.join(', ')}).`)
    return resolved.href
  }

  async perform(action: DeviceAction): Promise<ActionOutcome> {
    if (this.closed) return { ok: false, message: 'This device is closed.', status: await this.status(), harnessError: true }
    if (this.pendingDialog && action.type !== 'dialog' && action.type !== 'wait')
      return {
        ok: false,
        message: `A browser dialog is open ("${this.pendingDialog.message()}"). Answer it first.`,
        status: await this.status(),
        harnessError: true,
      }
    // Doing anything else with a file picker open cancels it, as Escape or a tap outside would.
    if (action.type !== 'pick_file' && action.type !== 'wait') this.pendingChooser = undefined
    const before = this.downloads.length
    const work = this.run(action)
    const dialog = new Promise<'dialog'>((resolveDialog) => this.dialogWaiters.push(() => resolveDialog('dialog')))
    // A page stuck in a loop never answers some calls (a click, a script): the persona hears that it froze.
    let frozenTimer: NodeJS.Timeout | undefined
    const limit = ceilingMs(action, this.options.actionCeilingMs)
    const frozen = new Promise<'frozen'>((resolveFrozen) => (frozenTimer = setTimeout(() => resolveFrozen('frozen'), limit)))
    try {
      const outcome = await Promise.race([work, dialog, frozen])
      work.catch(() => {})
      if (outcome === 'dialog') {
        return { ok: true, message: 'A browser dialog opened.', status: await this.status() }
      }
      if (outcome === 'frozen')
        return { ok: false, message: `The page stopped responding: nothing came back for ${Math.round(limit / 1000)} s.`, status: await this.status() }
      await this.settle()
      if (this.savingDownloads.size)
        await Promise.race([Promise.allSettled([...this.savingDownloads]), new Promise((resolveWait) => setTimeout(resolveWait, 10_000))])
      const files = this.downloads.slice(before)
      const message = typeof outcome === 'string' ? outcome : outcome.message
      return {
        ok: true,
        message,
        status: await this.status(),
        ...(files.length ? { files } : {}),
        ...(typeof outcome === 'string' ? {} : { matched: outcome.matched }),
      }
    } catch (error) {
      const failure = describeFailure(error)
      return {
        ok: false,
        message: failure.message,
        status: await this.status().catch(() => ({
          url: '',
          title: '',
          tab: { index: 0, count: 0 },
          viewport: layoutViewport(this.profile),
          notices: [],
          online: this.online,
        })),
        harnessError: failure.harness,
      }
    } finally {
      clearTimeout(frozenTimer)
      this.dialogWaiters = []
    }
  }

  private async run(action: DeviceAction): Promise<string | { message: string; matched: boolean }> {
    const page = this.page()
    switch (action.type) {
      case 'open':
        await page.goto(this.checkOrigin(action.url), { waitUntil: 'domcontentloaded' })
        return 'Opened.'
      case 'click': {
        if (this.profile.input === 'keyboard' || this.profile.input === 'screenreader') {
          // Without a mouse an element is activated from the keyboard, as its user would: focused, then Enter (Space
          // for a check box). Only by ref (a scripted sign-in on this device): coordinates mean a mouse.
          if (!('ref' in action.target)) throw new HarnessError('This persona has no mouse.')
          const locator = this.locate(action.target.ref)
          const toggle = await locator
            .evaluate(
              (el) =>
                (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) ||
                ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(el.getAttribute('role') ?? ''),
            )
            .catch(() => false)
          await locator.focus()
          await page.keyboard.press(toggle ? 'Space' : 'Enter')
          return 'Activated.'
        }
        const list = await this.listAt(action.target)
        await this.pointAt(action.target, this.touchInput && action.button !== 'right' && (action.count ?? 1) === 1 ? 'tap' : 'click', {
          ...(action.button ? { button: action.button } : {}),
          count: action.count ?? 1,
        })
        return `${action.count === 2 ? 'Double-clicked.' : this.touchInput ? 'Tapped.' : 'Clicked.'}${list}`
      }
      case 'tap': {
        if (!this.profile.hasTouch) throw new HarnessError('This device has no touch screen.')
        const list = await this.listAt(action.target)
        await this.pointAt(action.target, 'tap')
        return `Tapped.${list}`
      }
      case 'long_press': {
        const point = 'ref' in action.target ? await this.center(action.target.ref) : action.target
        this.inViewport(point)
        if (this.touchInput) {
          await this.touch('touchStart', [point])
          await page.waitForTimeout(action.ms ?? 800)
          await this.touch('touchEnd', [])
        } else {
          await page.mouse.move(point.x, point.y)
          await page.mouse.down()
          await page.waitForTimeout(action.ms ?? 800)
          await page.mouse.up()
        }
        return 'Long-pressed.'
      }
      case 'type':
        // Pasted text arrives at once, with no key presses.
        if (action.paste) await page.keyboard.insertText(action.text)
        else await page.keyboard.type(action.text, { delay: 15 })
        return action.paste ? 'Pasted.' : 'Typed.'
      case 'fill':
        await this.locate(action.ref).fill(action.text)
        return 'Filled.'
      case 'press':
        for (const chord of action.keys.trim().split(/\s+/)) {
          const key = normalizeChord(chord)
          if (await this.stepList(key)) continue
          await page.keyboard.press(key)
        }
        return `Pressed ${action.keys}.`
      case 'select': {
        const locator = this.locate(action.ref)
        const native = await locator.evaluate((el) => el instanceof HTMLSelectElement).catch(() => false)
        if (native) {
          try {
            await locator.selectOption({ label: action.option })
          } catch {
            await locator.selectOption(action.option)
          }
          return `Selected ${action.option}.`
        }
        // A custom list (a combobox or button that opens options): open it and pick, as a person would.
        // The options are those of the list this control opens (aria-controls), else any list on the page;
        // an exact name wins over a partial one ("India", not "British Indian Ocean Territory").
        const controls = await locator.getAttribute('aria-controls').catch(() => null)
        await locator.click()
        const scope = controls ? page.locator(`[id="${controls.replace(/"/g, '')}"]`) : page
        const exact = scope.getByRole('option', { name: action.option, exact: true }).first()
        let option = exact
        try {
          await exact.waitFor({ state: 'visible', timeout: 1_500 })
        } catch {
          option = scope.getByRole('option', { name: action.option, exact: false }).first()
        }
        try {
          await option.waitFor({ state: 'visible', timeout: 1_500 })
        } catch {
          const names = (
            await scope
              .getByRole('option')
              .allInnerTexts()
              .catch(() => [] as string[])
          )
            .map((name) => name.trim())
            .filter(Boolean)
          await page.keyboard.press('Escape').catch(() => {})
          throw new NoEffect(
            names.length
              ? `There is no option "${action.option}" in that list. Its options: ${names.slice(0, 20).join(' · ')}.`
              : 'That control did not open a list of options.',
          )
        }
        await option.click()
        return `Selected ${action.option}.`
      }
      case 'scroll': {
        const viewport = page.viewportSize() ?? layoutViewport(this.profile)
        const at = action.at ?? { x: viewport.width / 2, y: viewport.height / 2 }
        this.inViewport(at)
        const amount = (action.amount ?? 1) * 0.8
        const dx = action.direction === 'left' ? -viewport.width * amount : action.direction === 'right' ? viewport.width * amount : 0
        const dy = action.direction === 'up' ? -viewport.height * amount : action.direction === 'down' ? viewport.height * amount : 0
        await page.mouse.move(at.x, at.y)
        await page.mouse.wheel(dx, dy)
        return 'Scrolled.'
      }
      case 'drag':
      case 'swipe':
        this.inViewport(action.from)
        this.inViewport(action.to)
        if (this.touchInput) await this.touchPath(action.from, action.to)
        else {
          if (action.type === 'swipe') throw new HarnessError('This persona uses a mouse, not touch; use drag.')
          await page.mouse.move(action.from.x, action.from.y)
          await page.mouse.down()
          await page.mouse.move(action.to.x, action.to.y, { steps: 12 })
          await page.mouse.up()
        }
        return action.type === 'swipe' ? 'Swiped.' : 'Dragged.'
      case 'pinch': {
        if (!this.profile.hasTouch) throw new HarnessError('Pinch needs a touch screen.')
        this.inViewport(action.at)
        const start = 40
        const end = Math.max(8, start * action.scale)
        const { x, y } = action.at
        await this.touch('touchStart', [
          { x: x - start, y, id: 0 },
          { x: x + start, y, id: 1 },
        ])
        for (let step = 1; step <= 10; step += 1) {
          const d = start + ((end - start) * step) / 10
          await this.touch('touchMove', [
            { x: x - d, y, id: 0 },
            { x: x + d, y, id: 1 },
          ])
        }
        await this.touch('touchEnd', [])
        return action.scale >= 1 ? 'Zoomed in.' : 'Zoomed out.'
      }
      case 'back':
        return (await page.goBack({ waitUntil: 'domcontentloaded' })) ? 'Went back.' : 'There is no earlier page.'
      case 'forward':
        return (await page.goForward({ waitUntil: 'domcontentloaded' })) ? 'Went forward.' : 'There is no later page.'
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' })
        return 'Reloaded.'
      case 'rotate': {
        if (!this.profile.isMobile) throw new HarnessError('Only phones and tablets rotate.')
        const viewport = page.viewportSize() ?? layoutViewport(this.profile)
        for (const each of this.pages) await each.setViewportSize({ width: viewport.height, height: viewport.width })
        return viewport.width > viewport.height ? 'Turned to portrait.' : 'Turned to landscape.'
      }
      case 'set_network':
        this.online = action.state === 'online'
        // A throttled device keeps its throttling: online state and throttling travel together.
        if (this.throttled) for (const each of this.pages) await this.applyNetwork(each)
        else await this.context.setOffline(!this.online)
        return this.online ? 'The connection is back.' : 'The connection dropped.'
      case 'pick_file': {
        const file = this.file(action.file)
        if (action.target !== 'focused' && 'ref' in action.target) {
          const locator = this.locate(action.target.ref)
          const isInput = await locator.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file').catch(() => false)
          if (isInput) {
            this.pendingChooser = undefined
            await locator.setInputFiles(await this.upload(file))
            return `Chose ${action.file}.`
          }
        }
        // A picker the persona already opened (by clicking the control) takes the file directly.
        let chooser = action.target === 'focused' && this.pendingChooser?.page() === page ? this.pendingChooser : undefined
        if (!chooser) {
          // Pressing Enter on whatever has focus could press a Delete button: only a file control will do.
          if (action.target === 'focused') {
            const focused = await page.evaluate(() => {
              const el = document.activeElement
              if (el instanceof HTMLInputElement && el.type === 'file') return undefined
              const name = (el?.getAttribute('aria-label') || el?.textContent || '').trim().slice(0, 60)
              return el && el !== document.body ? `${el.tagName.toLowerCase()}${name ? ` "${name}"` : ''}` : 'nothing'
            })
            if (focused)
              throw new HarnessError(
                `The focus is on ${focused}, not a file chooser. Move the focus to the file control first; if another control opens the picker, activate it (press Enter), then call pick_file with just the file.`,
              )
          }
          this.pendingChooser = undefined
          const opened = this.nextChooser(ACTION_TIMEOUT_MS)
          if (action.target === 'focused') await page.keyboard.press('Enter')
          else await this.pointAt(action.target, this.touchInput ? 'tap' : 'click')
          chooser = await opened
        }
        if (!chooser) throw new NoEffect('No file picker opened.')
        this.pendingChooser = undefined
        await chooser.setFiles(await this.upload(file))
        return `Chose ${action.file}.`
      }
      case 'drop_file': {
        if (this.touchInput) throw new HarnessError('Files cannot be dragged with touch.')
        const file = this.file(action.file)
        const { readFile } = await import('node:fs/promises')
        const data = (await readFile(file.path)).toString('base64')
        const name = basename(file.path)
        const type = file.type
        const transfer = await page.evaluateHandle(
          ({ data: payload, name: fileName, type: mime }) => {
            const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
            const dt = new DataTransfer()
            dt.items.add(new File([bytes], fileName, { type: mime }))
            return dt
          },
          { data, name, type },
        )
        // The page holds the whole file while the handle lives: released however the drop went.
        try {
          if ('ref' in action.target) {
            const locator = this.locate(action.target.ref)
            for (const type of ['dragenter', 'dragover', 'drop']) await locator.dispatchEvent(type, { dataTransfer: transfer })
          } else {
            this.inViewport(action.target)
            const { x, y } = action.target
            await page.evaluate(
              ({ x: px, y: py, dt }) => {
                const el = document.elementFromPoint(px, py)
                if (!el) return
                for (const type of ['dragenter', 'dragover', 'drop'])
                  el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt as DataTransfer }))
              },
              { x, y, dt: transfer },
            )
          }
        } finally {
          await transfer.dispose().catch(() => {})
        }
        return `Dropped ${name}.`
      }
      case 'dialog': {
        const dialog = this.pendingDialog
        if (!dialog) return 'No dialog is open.'
        this.pendingDialog = undefined
        if (action.answer === 'accept') await dialog.accept(action.text)
        else await dialog.dismiss()
        return action.answer === 'accept' ? 'Accepted the dialog.' : 'Dismissed the dialog.'
      }
      case 'wait': {
        const seconds = Math.min(120, Math.max(0, action.seconds))
        if (action.forText) {
          // A timeout of 0 means "forever" to Playwright: a wait for text always has a limit.
          const limit = Math.max(1, seconds)
          try {
            await page
              .getByText(action.forText, { exact: false })
              .first()
              .waitFor({ state: 'visible', timeout: limit * 1000 })
            return { message: `"${action.forText}" is on screen.`, matched: true }
          } catch {
            return { message: `"${action.forText}" did not appear within ${limit} s.`, matched: false }
          }
        }
        await page.waitForTimeout(seconds * 1000)
        return `Waited ${seconds} s.`
      }
      case 'new_tab': {
        const created = await this.context.newPage()
        this.currentPage = created
        // Offline or throttled from its first request, like the device's other tabs.
        await this.emulations.get(created)
        if (action.url) await created.goto(this.checkOrigin(action.url), { waitUntil: 'domcontentloaded' })
        return 'Opened a new tab.'
      }
      case 'switch_tab': {
        if (!this.pages[action.index]) throw new HarnessError(`There is no tab ${action.index + 1}.`)
        this.currentPage = this.pages[action.index]
        await this.page().bringToFront()
        return `Switched to tab ${action.index + 1}.`
      }
      case 'close_tab':
        if (this.pages.length <= 1) throw new HarnessError('This is the last tab.')
        await page.close({ runBeforeUnload: true })
        return 'Closed the tab.'
    }
  }

  /**
   * Arrow keys on a focused drop-down list change the choice, as on Windows and Linux. (A browser on a
   * macOS host would open a native menu instead, which a headless browser never shows.) Returns
   * whether the key was handled here.
   */
  private async stepList(key: string): Promise<boolean> {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return false
    return this.page()
      .evaluate((pressed) => {
        const select = document.activeElement
        if (!(select instanceof HTMLSelectElement) || select.multiple || !select.options.length) return false
        const last = select.options.length - 1
        const index = pressed === 'Home' ? 0 : pressed === 'End' ? last : Math.min(last, Math.max(0, select.selectedIndex + (pressed === 'ArrowDown' ? 1 : -1)))
        if (index !== select.selectedIndex) {
          select.selectedIndex = index
          select.dispatchEvent(new Event('input', { bubbles: true }))
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
        return true
      }, key)
      .catch(() => false)
  }

  /**
   * A native drop-down list opens outside the page, so it never shows in a screenshot. When a click
   * lands on one, the persona is told what the list holds and how to choose, as their eyes would.
   */
  private async listAt(target: PointTarget): Promise<string> {
    try {
      const options = await ('ref' in target
        ? this.locate(target.ref).evaluate((el) => {
            const select = el.closest('select')
            return select ? [...select.options].map((option) => ({ text: option.text, selected: option.selected })) : null
          })
        : this.page().evaluate(({ x, y }) => {
            const select = document.elementFromPoint(x, y)?.closest('select')
            return select ? [...select.options].map((option) => ({ text: option.text, selected: option.selected })) : null
          }, target))
      if (!options?.length) return ''
      const shown = options.slice(0, 30).map((option) => (option.selected ? `${option.text} (chosen)` : option.text))
      return ` A drop-down list opened: ${shown.join(' · ')}${options.length > 30 ? ` · and ${options.length - 30} more` : ''}. Choose with ArrowDown or ArrowUp (or type the first letters of an option), then Enter.`
    } catch {
      return ''
    }
  }

  private async center(ref: string): Promise<{ x: number; y: number }> {
    const box = await this.locate(ref).boundingBox()
    if (!box) throw new HarnessError(`${ref} is not visible.`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  /**
   * What the browser receives. A remote browser cannot read this disk, and a declared type the browser
   * would not guess from the extension (DICOM) must be sent as given: both go as data.
   */
  private async upload(file: { path: string; type: string }): Promise<string | { name: string; mimeType: string; buffer: Buffer }> {
    if (!this.options.uploadAsData && file.type === mimeFor(basename(file.path))) return file.path
    const { readFile } = await import('node:fs/promises')
    return { name: basename(file.path), mimeType: file.type, buffer: await readFile(file.path) }
  }

  /** A file the persona may upload, by the name it knows it by, with its type. */
  private file(name: string): { path: string; type: string } {
    if (this.options.media) {
      const wanted = name.replace(/^\.\//, '')
      const item = this.options.media.find((each) => each.name === wanted)
      // Still a plain file where it was: a link swapped in since the run started does not count.
      if (!item || !plainFileIn(dirname(item.file), basename(item.file)))
        throw new HarnessError(
          `There is no file named "${name}" on this computer. Its files: ${this.options.media.map((each) => each.name).join(', ') || 'none'}.`,
        )
      return { path: item.file, type: item.type }
    }
    const file = resolveFile(this.options.fileSources, name)
    if (!file) throw new HarnessError(`There is no file named "${name}" on this computer.`)
    return { path: file, type: mimeFor(basename(file)) }
  }

  async screenshot(options: { grid?: boolean; maxWidth?: number } = {}): Promise<Screenshot> {
    // The page is frozen behind a native dialog; a capture would only time out.
    if (this.pendingDialog) throw new Error(`A browser dialog is open ("${this.pendingDialog.message()}"): answer it first with answer_dialog.`)
    const page = this.page()
    // A page stuck in a loop never runs the script: the picture is taken without the grid then.
    if (options.grid) await within(page.evaluate(drawGrid), 2_000, undefined)
    try {
      const data = await page.screenshot({
        type: 'jpeg',
        quality: this.options.screenshotQuality,
        scale: 'css',
        // Looking must not change the app: finishing animations would fire their end events (closing a toast).
        animations: 'allow',
        caret: 'initial',
        timeout: 15_000,
      })
      const viewport = page.viewportSize() ?? layoutViewport(this.profile)
      return { data, mimeType: 'image/jpeg', width: viewport.width, height: viewport.height }
    } finally {
      if (options.grid)
        await within(
          page.evaluate(() => document.getElementById('__persona_swarm_grid')?.remove()),
          2_000,
          undefined,
        )
    }
  }

  async outline(options: { maxChars?: number; query?: string } = {}): Promise<Outline> {
    const page = this.page()
    const raw = await page.ariaSnapshot({ mode: 'ai', timeout: 15_000 })
    let lines = raw.split('\n').filter((line) => !/^\s*- generic( \[ref=\w+\])?:$/.test(line))
    if (options.query) {
      const needle = normalizeText(options.query)
      lines = lines.filter((line) => normalizeText(line).includes(needle))
    }
    const refs = (raw.match(/\[ref=/g) ?? []).length
    let text = lines.join('\n')
    const max = options.maxChars ?? 12_000
    let truncated = false
    if (text.length > max) {
      text = `${text.slice(0, max)}\n… (${text.length - max} more characters: scroll, or search the outline)`
      truncated = true
    }
    if (options.query && !text) text = `Nothing on this page mentions "${options.query}".`
    return { text, truncated, refs }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.context.close().catch(() => {})
  }
}

function drawGrid(): void {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.id = '__persona_swarm_grid'
  const w = window.innerWidth
  const h = window.innerHeight
  svg.setAttribute('style', `position:fixed;inset:0;width:${w}px;height:${h}px;z-index:2147483647;pointer-events:none`)
  let content = ''
  for (let x = 0; x <= w; x += 50)
    content +=
      `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${x % 100 ? '#f0f8' : '#f0f'}" stroke-width="${x % 100 ? 0.5 : 1}"/>` +
      (x % 100 ? '' : `<text x="${x + 2}" y="11" fill="#f0f" font-size="10" font-family="monospace">${x}</text>`)
  for (let y = 0; y <= h; y += 50)
    content +=
      `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${y % 100 ? '#f0f8' : '#f0f'}" stroke-width="${y % 100 ? 0.5 : 1}"/>` +
      (y % 100 ? '' : `<text x="2" y="${y - 2}" fill="#f0f" font-size="10" font-family="monospace">${y}</text>`)
  svg.innerHTML = content
  document.body.appendChild(svg)
}

const mimeFor = mediaType

/**
 * What a failure means for the persona, and whether the harness caused it (the request was wrong:
 * a stale ref, a point off screen, an unknown key) or the app did (a disabled or covered control).
 * Playwright's call log tells the two apart: a ref that resolved to an element is not stale.
 */
export function describeFailure(error: unknown): { message: string; harness: boolean } {
  if (error instanceof HarnessError) return { message: error.message, harness: true }
  if (error instanceof NoEffect) return { message: error.message, harness: false }
  const message = String((error as Error)?.message ?? error)
  const first = message.split('\n')[0]?.slice(0, 300) ?? 'The action failed.'
  if (/Unknown key|outside the screen|must be numbers|strict mode violation/i.test(message)) return { message: first, harness: true }
  const viaRef = /waiting for locator\('aria-ref=[^']+'\)/.test(message)
  const found = /locator resolved to/.test(message)
  if (viaRef && !found) return { message: 'That element is no longer on the page (the outline is stale). Look again.', harness: true }
  if (/Timeout \d+ms exceeded/.test(message)) {
    if (/intercepts pointer events/.test(message)) return { message: 'Something else is covering that element; the click did not reach it.', harness: false }
    if (/element is not enabled/.test(message)) return { message: 'That control is disabled.', harness: false }
    if (/element is not editable/.test(message)) return { message: 'That field cannot be changed.', harness: false }
    if (/element is not visible/.test(message)) return { message: 'That element is not visible.', harness: false }
    if (/element is not stable/.test(message)) return { message: 'That element kept moving; the action did not land.', harness: false }
    return { message: 'Nothing happened within 6 seconds.', harness: false }
  }
  if (/net::ERR_INTERNET_DISCONNECTED/.test(message)) return { message: 'There is no internet connection.', harness: false }
  if (/Target page, context or browser has been closed/.test(message)) return { message: 'The page was closed.', harness: false }
  if (/Navigation|net::/.test(message)) return { message: `The page did not load (${first.slice(0, 160)}).`, harness: false }
  return { message: first, harness: false }
}

const KEY_ALIASES: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  super: 'Meta',
  opt: 'Alt',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  space: ' ',
  spacebar: ' ',
  tab: 'Tab',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
}
const EDIT_KEYS = new Set(['a', 'c', 'v', 'x', 'y', 'z'])

/**
 * A key chord as Playwright names it ("ctrl+A" → "ControlOrMeta+a"). Edit shortcuts (select all, copy,
 * paste, cut, undo, redo) work with Control or Meta on every persona device: the persona's phone or
 * Windows laptop should not inherit the habits of the host the browser happens to run on.
 */
export function normalizeChord(chord: string): string {
  const parts = chord === '+' ? ['+'] : chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+')
  const keys = parts.filter(Boolean).map((part) => KEY_ALIASES[part.toLowerCase()] ?? part)
  const key = keys.at(-1) ?? ''
  const modifiers = keys.slice(0, -1)
  const command = modifiers.filter((modifier) => modifier === 'Control' || modifier === 'Meta')
  if (EDIT_KEYS.has(key.toLowerCase()) && command.length && modifiers.every((modifier) => ['Control', 'Meta', 'Shift'].includes(modifier))) {
    // Redo is Ctrl+Y on Windows but Cmd+Shift+Z on a Mac host, which has no Cmd+Y: Shift+Z is redo on both.
    if (key.toLowerCase() === 'y') return 'ControlOrMeta+Shift+z'
    return ['ControlOrMeta', ...(modifiers.includes('Shift') ? ['Shift'] : []), key.toLowerCase()].join('+')
  }
  return keys.join('+')
}

/** Turns Playwright errors into what a person would notice. */
export function humanizeError(error: unknown): string {
  return describeFailure(error).message
}
