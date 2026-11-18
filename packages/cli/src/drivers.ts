import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoadedWorkspace } from '@persona-swarm/core'
import type { DriverRegistry } from '@persona-swarm/engine'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

/** A driver package's executable entry: `dist/main.js` next to its `dist/index.js`. */
function packageMain(name: string): string | undefined {
  try {
    return join(dirname(require.resolve(name)), 'main.js')
  } catch {
    return undefined
  }
}

/** Built-in drivers plus any the workspace declares (workspace entries win). */
export function driverRegistry(workspace?: LoadedWorkspace): DriverRegistry {
  const registry: DriverRegistry = {}
  for (const [name, pkg] of [
    ['mock', '@persona-swarm/driver-mock'],
    ['ai-sdk', '@persona-swarm/driver-ai-sdk'],
    ['claude-code', '@persona-swarm/driver-claude-code'],
    ['external', '@persona-swarm/driver-external'],
  ] as const) {
    const main = packageMain(pkg)
    if (main && existsSync(main)) registry[name] = { command: [process.execPath, main] }
  }
  const python = resolve(here, '../../../drivers/python-reference/driver.py')
  if (existsSync(python)) registry['python-reference'] = { command: ['python3', python] }
  for (const [name, entry] of Object.entries(workspace?.config.drivers ?? {}))
    registry[name] = {
      command: entry.command.map((part) => (part.startsWith('./') || part.startsWith('../') ? resolve(workspace?.dir ?? '.', part) : part)),
      env: entry.env,
    }
  return registry
}
