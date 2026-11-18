import type { DeviceProfile } from './schemas/device.js'

/** Where a pointer or finger lands: an outline ref, or CSS pixel coordinates of the screenshot. */
export type PointTarget = { ref: string } | { x: number; y: number }

export type DeviceAction =
  | { type: 'open'; url: string }
  | { type: 'click'; target: PointTarget; button?: 'left' | 'right'; count?: 1 | 2 }
  | { type: 'tap'; target: PointTarget }
  | { type: 'long_press'; target: PointTarget; ms?: number }
  /** `paste`: the text arrives at once, as from the clipboard, instead of key by key. */
  | { type: 'type'; text: string; paste?: boolean }
  | { type: 'fill'; ref: string; text: string }
  | { type: 'press'; keys: string }
  | { type: 'select'; ref: string; option: string }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; at?: { x: number; y: number } }
  | { type: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: 'pinch'; at: { x: number; y: number }; scale: number }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'rotate' }
  | { type: 'set_network'; state: 'online' | 'offline' }
  /** `focused`: the keyboard user presses Enter on the control that has focus. */
  | { type: 'pick_file'; target: PointTarget | 'focused'; file: string }
  | { type: 'drop_file'; target: PointTarget; file: string }
  | { type: 'dialog'; answer: 'accept' | 'dismiss'; text?: string }
  | { type: 'wait'; seconds: number; forText?: string }
  | { type: 'new_tab'; url?: string }
  | { type: 'switch_tab'; index: number }
  | { type: 'close_tab' }

export type ActionType = DeviceAction['type']

export interface DeviceCapabilities {
  kind: DeviceProfile['kind']
  pointer: boolean
  touch: boolean
  keyboard: boolean
  outline: boolean
  rotate: boolean
  network: boolean
  files: boolean
  tabs: boolean
}

/** What the person sees without asking: where they are and what pops up. */
export interface DeviceStatus {
  url: string
  title: string
  tab: { index: number; count: number }
  viewport: { width: number; height: number }
  /** Visible toasts, alerts and dialog titles, trimmed. */
  notices: string[]
  /** A native dialog waiting for an answer, if any. */
  dialog?: { type: string; message: string }
  /** A file picker is open and waiting for a file (pick_file). */
  filePicker?: boolean
  online: boolean
}

export interface ActionOutcome {
  ok: boolean
  /** Short human-readable result; errors explain what went wrong in the persona's terms. */
  message: string
  status: DeviceStatus
  /** Files saved by the action (downloads). */
  files?: string[]
  /** The failure came from the harness (bad arguments, unknown ref), not from the app. */
  harnessError?: boolean
  /** A wait for text: whether the text appeared. */
  matched?: boolean
}

export interface Screenshot {
  /** JPEG bytes at CSS pixel scale. */
  data: Buffer
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** Path inside the run folder once stored. */
  path?: string
}

export interface Outline {
  text: string
  truncated: boolean
  /** Number of interactive elements with refs. */
  refs: number
}

/** Things the app did that a person would not necessarily notice, kept as evidence. */
export interface DeviceSignal {
  t: string
  kind: 'console.error' | 'console.warning' | 'pageerror' | 'requestfailed' | 'http' | 'download' | 'dialog' | 'crash' | 'blocked'
  text: string
  url?: string
  status?: number
}

export interface Device {
  readonly id: string
  readonly kind: DeviceProfile['kind']
  readonly profile: DeviceProfile
  capabilities(): DeviceCapabilities
  perform(action: DeviceAction): Promise<ActionOutcome>
  screenshot(options?: { grid?: boolean; maxWidth?: number }): Promise<Screenshot>
  outline(options?: { maxChars?: number; query?: string }): Promise<Outline>
  status(): Promise<DeviceStatus>
  /** Returns and clears the signals collected since the last call. */
  drainSignals(): DeviceSignal[]
  close(): Promise<void>
}

export interface DeviceFarm {
  createDevice(options: {
    id: string
    profile: DeviceProfile
    baseUrl: string
    downloadsDir: string
    fileSources: { dir: string; pattern: string }[]
    onSignal?: (signal: DeviceSignal) => void
  }): Promise<Device>
  readonly openDevices: number
  close(): Promise<void>
}
