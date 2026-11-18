import type { Persona } from './schemas/config.js'
import { DeviceProfile, type DeviceProfileInput, type ToolProfile, type VisionDeficiency } from './schemas/device.js'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID_PHONE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const ANDROID_TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-T830) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** Device presets. Viewports are CSS pixels; scale factors are clamped by limits at run time. */
export const DEVICE_PRESETS: Record<string, DeviceProfileInput> = {
  'desktop-1920': { label: 'Desktop 1920×1080', viewport: { width: 1920, height: 1080 }, userAgent: WINDOWS_UA },
  'desktop-2560': { label: 'Desktop 2560×1440', viewport: { width: 2560, height: 1440 } },
  'desktop-1440': { label: 'Desktop 1440×900', viewport: { width: 1440, height: 900 } },
  'laptop-1366': { label: 'Laptop 1366×768', viewport: { width: 1366, height: 768 }, userAgent: WINDOWS_UA },
  'laptop-1280': { label: 'Laptop 1280×800', viewport: { width: 1280, height: 800 } },
  'laptop-old': {
    label: 'Old laptop 1366×768 at 125%',
    viewport: { width: 1093, height: 614 },
    deviceScaleFactor: 1.25,
    userAgent: WINDOWS_UA,
    cpuThrottle: 2,
  },
  'iphone-13': {
    label: 'iPhone 13',
    viewport: { width: 390, height: 664 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
    input: 'touch',
  },
  'iphone-se': {
    label: 'iPhone SE',
    viewport: { width: 375, height: 553 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
    input: 'touch',
  },
  'pixel-7': {
    label: 'Pixel 7',
    viewport: { width: 412, height: 839 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_PHONE_UA,
    input: 'touch',
  },
  'ipad-pro-11-landscape': {
    label: 'iPad Pro 11 (landscape)',
    viewport: { width: 1194, height: 834 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    input: 'touch',
  },
  'ipad-mini': {
    label: 'iPad Mini',
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    input: 'touch',
  },
  'galaxy-tab-s4': {
    label: 'Galaxy Tab S4',
    viewport: { width: 712, height: 1138 },
    deviceScaleFactor: 2.25,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_TABLET_UA,
    input: 'touch',
  },
}

export class UnknownPresetError extends Error {}

/** Resolves a persona's device (preset name or profile) plus overrides into a full profile. */
export function resolveDeviceProfile(
  device: Persona['device'],
  overrides: Partial<DeviceProfileInput> | undefined,
  limits: { maxDeviceScaleFactor: number },
): DeviceProfile {
  let base: DeviceProfileInput
  if (typeof device === 'string') {
    const preset = DEVICE_PRESETS[device]
    if (!preset) throw new UnknownPresetError(`Unknown device preset "${device}". Known presets: ${Object.keys(DEVICE_PRESETS).join(', ')}`)
    base = preset
  } else {
    base = device
  }
  const merged = { ...base, ...(overrides ?? {}) }
  if (overrides?.viewport) merged.viewport = { ...base.viewport, ...overrides.viewport }
  const profile = DeviceProfile.parse(merged)
  profile.deviceScaleFactor = Math.min(profile.deviceScaleFactor, limits.maxDeviceScaleFactor)
  return profile
}

/**
 * The tool profile decides what a persona can do, so fidelity does not rest on the prompt alone:
 * novices and touch users act on what they see (screenshots and coordinates); keyboard and
 * screen-reader users get keys and the outline.
 */
export function deriveToolProfile(persona: Pick<Persona, 'proficiency' | 'toolProfile'>, profile: DeviceProfile): ToolProfile {
  if (persona.toolProfile) return persona.toolProfile
  if (profile.input === 'keyboard') return 'keyboard'
  if (profile.input === 'screenreader') return 'screenreader'
  if (profile.input === 'touch') return 'sight'
  if (persona.proficiency <= 2) return 'sight'
  if (persona.proficiency === 3) return 'reader'
  return 'power'
}

/** Whether a tool profile needs a model that can see images. */
export function profileNeedsVision(profile: ToolProfile): boolean {
  return profile !== 'screenreader'
}

const VISION_LABELS: Record<Exclude<VisionDeficiency, 'none'>, string> = {
  protanopia: 'protanopia (red-blind)',
  deuteranopia: 'deuteranopia (green-blind)',
  tritanopia: 'tritanopia (blue-blind)',
  achromatopsia: 'achromatopsia (no colour)',
  blurredVision: 'blurred vision',
  reducedContrast: 'reduced contrast sensitivity',
}

/**
 * The CSS viewport the page lays out in: the window divided by the zoom. Browser zoom at 200 % on a
 * 1440-pixel window lays a page out as a 720-pixel one, so breakpoints and reflow behave as they do
 * for a person who zooms.
 */
export function layoutViewport(profile: Pick<DeviceProfile, 'viewport' | 'zoom'>): { width: number; height: number } {
  const zoom = profile.zoom ?? 1
  return { width: Math.round(profile.viewport.width / zoom), height: Math.round(profile.viewport.height / zoom) }
}

export function describeDevice(profile: DeviceProfile): string {
  const size = `${profile.viewport.width}×${profile.viewport.height}`
  const base = profile.label ?? `${profile.kind} ${size}`
  const extras = [
    profile.input !== 'mouse' ? `${profile.input} input` : '',
    profile.network ? `network ${typeof profile.network === 'string' ? profile.network : 'custom'}` : '',
    profile.locale !== 'en-US' ? profile.locale : '',
    profile.colorScheme === 'dark' ? 'dark mode' : '',
    profile.zoom > 1 ? `zoomed to ${Math.round(profile.zoom * 100)} %` : '',
    profile.forcedColors === 'active' ? 'high-contrast mode' : profile.contrast === 'more' ? 'more contrast' : '',
    profile.visionDeficiency && profile.visionDeficiency !== 'none' ? `seen with ${VISION_LABELS[profile.visionDeficiency]}` : '',
  ].filter(Boolean)
  return extras.length ? `${base} (${extras.join(', ')})` : base
}
