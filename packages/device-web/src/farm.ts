import { type DeviceFarm, type DeviceProfile, type DeviceSignal, layoutViewport } from '@persona-swarm/core'
import { type Browser, chromium } from 'playwright-core'
import { findCachedChromium } from './browser.js'
import type { DeviceMedia } from './files.js'
import { WebDevice } from './web-device.js'

export interface WebFarmOptions {
  /** Explicit browser binary; otherwise Playwright's own, then any cached headless shell. */
  executablePath?: string
  headless?: boolean
  /** JPEG quality of screenshots (1 to 100). */
  screenshotQuality?: number
  /** Pause after each action so the page can react, in ms (doubled on throttled networks). */
  settleMs?: number
  /** Extra origins personas may open besides the target's. */
  extraOrigins?: string[]
  /**
   * Use a browser running elsewhere (a VM, a cloud browser service) instead of launching one. Files
   * personas upload are then sent as data, since the remote browser cannot read this machine's disk.
   */
  connect?: { url: string; protocol?: 'cdp' | 'playwright'; headers?: Record<string, string> }
}

export class BrowserNotFoundError extends Error {}

/**
 * One Chromium for the whole run, one isolated context per persona. The browser's own overhead is
 * paid once; each context gets its own storage, cookies and emulation.
 */
export class WebDeviceFarm implements DeviceFarm {
  private readonly devices = new Set<WebDevice>()

  private constructor(
    private readonly browser: Browser,
    private readonly options: WebFarmOptions,
  ) {}

  static async launch(options: WebFarmOptions = {}): Promise<WebDeviceFarm> {
    if (options.connect) {
      const { url, protocol = 'cdp', headers = {} } = options.connect
      const browser = protocol === 'playwright' ? await chromium.connect(url, { headers }) : await chromium.connectOverCDP(url, { headers })
      return new WebDeviceFarm(browser, options)
    }
    const args = ['--disable-dev-shm-usage', '--disable-background-networking', '--mute-audio', '--no-first-run']
    // The run owns the signals: on Ctrl-C it stops its sessions and closes the browser itself. (Left to
    // Playwright, the first Ctrl-C would close the browser and exit before the run could wind down.)
    const attempt = (executablePath?: string) =>
      chromium.launch({
        headless: options.headless ?? true,
        args,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(executablePath ? { executablePath } : {}),
      })
    let browser: Browser
    if (options.executablePath) browser = await attempt(options.executablePath)
    else {
      try {
        browser = await attempt()
      } catch (first) {
        const cached = findCachedChromium()
        if (!cached)
          throw new BrowserNotFoundError(
            `No Chromium found. Install one with "npx playwright-core install chromium-headless-shell", or set browser.executablePath. (${(first as Error).message.split('\n')[0]})`,
          )
        browser = await attempt(cached)
      }
    }
    return new WebDeviceFarm(browser, options)
  }

  get openDevices(): number {
    return this.devices.size
  }

  async createDevice(options: {
    id: string
    profile: DeviceProfile
    baseUrl: string
    downloadsDir: string
    fileSources: { dir: string; pattern: string }[]
    /** The session's own files (instead of fileSources). */
    media?: DeviceMedia[]
    onSignal?: (signal: DeviceSignal) => void
    throttleUrls?: string[]
    actionCeilingMs?: number
    /** A persona who rushes acts before the page settles: no pause after actions. */
    rush?: boolean
  }): Promise<WebDevice> {
    const { profile } = options
    const context = await this.browser.newContext({
      // Zoomed, the page lays out in a smaller viewport on the same screen.
      viewport: layoutViewport(profile),
      screen: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
      locale: profile.locale,
      timezoneId: profile.timezoneId,
      colorScheme: profile.colorScheme,
      reducedMotion: profile.reducedMotion,
      ...(profile.forcedColors ? { forcedColors: profile.forcedColors } : {}),
      ...(profile.contrast ? { contrast: profile.contrast } : {}),
      acceptDownloads: true,
    })
    const device = await WebDevice.create({
      id: options.id,
      profile,
      context,
      baseUrl: options.baseUrl,
      allowedOrigins: [new URL(options.baseUrl).origin, ...(this.options.extraOrigins ?? []).map((url) => new URL(url).origin)],
      downloadsDir: options.downloadsDir,
      fileSources: options.fileSources,
      ...(options.media ? { media: options.media } : {}),
      throttleUrls: options.throttleUrls?.length ? options.throttleUrls : ['*'],
      screenshotQuality: this.options.screenshotQuality ?? 70,
      settleMs: this.options.settleMs ?? 350,
      ...(options.rush ? { rush: true } : {}),
      uploadAsData: Boolean(this.options.connect),
      ...(options.onSignal ? { onSignal: options.onSignal } : {}),
      ...(options.actionCeilingMs ? { actionCeilingMs: options.actionCeilingMs } : {}),
    })
    this.devices.add(device)
    const close = device.close.bind(device)
    device.close = async () => {
      this.devices.delete(device)
      await close()
    }
    return device
  }

  async close(): Promise<void> {
    await Promise.all([...this.devices].map((device) => device.close()))
    await this.browser.close().catch(() => {})
  }
}
