import { existsSync, readdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** Where Playwright keeps downloaded browsers on this machine. */
export function playwrightCacheDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
  return join(homedir(), '.cache', 'ms-playwright')
}

function findFile(dir: string, names: string[], depth = 3): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) if (entry.isFile() && names.includes(entry.name)) return join(dir, entry.name)
  for (const entry of entries)
    if (entry.isDirectory()) {
      const found = findFile(join(dir, entry.name), names, depth - 1)
      if (found) return found
    }
  return undefined
}

/**
 * Finds a cached Chromium headless shell (newest revision first), then a full Chromium. Lets the
 * framework reuse browsers already installed by any Playwright version on the machine.
 */
export function findCachedChromium(): string | undefined {
  const cache = playwrightCacheDir()
  if (!existsSync(cache)) return undefined
  const revisions = (prefix: string) =>
    readdirSync(cache)
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
  const shellNames = ['chrome-headless-shell', 'chrome-headless-shell.exe']
  for (const dir of revisions('chromium_headless_shell-')) {
    const found = findFile(join(cache, dir), shellNames)
    if (found) return found
  }
  for (const dir of revisions('chromium-')) {
    const found = findFile(join(cache, dir), ['Chromium', 'chrome', 'chrome.exe', 'Google Chrome for Testing'], 5)
    if (found) return found
  }
  return undefined
}
