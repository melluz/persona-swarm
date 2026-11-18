import { z } from 'zod'

/** Primary way the persona operates the device. Decides gestures and the default tool profile. */
export const InputMode = z.enum(['mouse', 'touch', 'keyboard', 'screenreader'])
export type InputMode = z.infer<typeof InputMode>

/** Named network conditions, or explicit numbers. Applied only to requests matching `throttleUrls`. */
export const NetworkProfile = z.union([
  z.enum(['slow-3g', 'fast-3g', 'clinic-dsl', 'offline']),
  z.strictObject({
    latencyMs: z.number().min(0),
    downloadKbps: z.number().positive(),
    uploadKbps: z.number().positive(),
  }),
])
export type NetworkProfile = z.infer<typeof NetworkProfile>

/** What Chromium can render the page as for a person with a vision deficiency (CDP `setEmulatedVisionDeficiency`). */
export const VisionDeficiency = z.enum(['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurredVision', 'reducedContrast'])
export type VisionDeficiency = z.infer<typeof VisionDeficiency>

const deviceFields = {
  kind: z.enum(['web', 'ios', 'android', 'desktop']),
  label: z.string(),
  viewport: z.strictObject({ width: z.number().int().min(200), height: z.number().int().min(200) }),
  deviceScaleFactor: z.number().positive(),
  isMobile: z.boolean(),
  hasTouch: z.boolean(),
  userAgent: z.string(),
  input: InputMode,
  locale: z.string(),
  timezoneId: z.string(),
  colorScheme: z.enum(['light', 'dark']),
  reducedMotion: z.enum(['reduce', 'no-preference']),
  network: NetworkProfile,
  /** URL patterns (CDP style, `*` wildcards) the network profile applies to. Default: every request. */
  throttleUrls: z.array(z.string()),
  cpuThrottle: z.number().min(1).max(20),
  /** Browser zoom (1 = 100 %): the page lays out in a viewport this many times smaller, as at that zoom. */
  zoom: z.number().min(1).max(4),
  /** Chromium's vision emulation: colour blindness, blur or low contrast applied to everything rendered. */
  visionDeficiency: VisionDeficiency,
  /** `active` emulates Windows high-contrast mode (`forced-colors: active`). */
  forcedColors: z.enum(['active', 'none']),
  /** The `prefers-contrast` media feature. */
  contrast: z.enum(['more', 'no-preference']),
}

export const DeviceProfile = z.strictObject({
  ...deviceFields,
  kind: deviceFields.kind.default('web'),
  label: deviceFields.label.optional(),
  deviceScaleFactor: deviceFields.deviceScaleFactor.default(1),
  isMobile: deviceFields.isMobile.default(false),
  hasTouch: deviceFields.hasTouch.default(false),
  userAgent: deviceFields.userAgent.optional(),
  input: deviceFields.input.default('mouse'),
  locale: deviceFields.locale.default('en-US'),
  timezoneId: deviceFields.timezoneId.default('UTC'),
  colorScheme: deviceFields.colorScheme.default('light'),
  reducedMotion: deviceFields.reducedMotion.default('no-preference'),
  network: deviceFields.network.optional(),
  throttleUrls: deviceFields.throttleUrls.optional(),
  cpuThrottle: deviceFields.cpuThrottle.optional(),
  zoom: deviceFields.zoom.default(1),
  visionDeficiency: deviceFields.visionDeficiency.optional(),
  forcedColors: deviceFields.forcedColors.optional(),
  contrast: deviceFields.contrast.optional(),
})

/**
 * Overrides carry no defaults: a persona that only changes its locale must not reset the preset's
 * touch screen, input or scale to the profile defaults.
 */
export const DeviceOverrides = z.strictObject(deviceFields).partial()
export type DeviceOverrides = z.infer<typeof DeviceOverrides>

export type DeviceProfile = z.infer<typeof DeviceProfile>
export type DeviceProfileInput = z.input<typeof DeviceProfile>

export const ToolProfile = z.enum(['sight', 'reader', 'power', 'keyboard', 'screenreader'])
export type ToolProfile = z.infer<typeof ToolProfile>
