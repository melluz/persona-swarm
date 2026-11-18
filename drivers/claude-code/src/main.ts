#!/usr/bin/env node
import { serveDriver } from '@persona-swarm/driver-kit'
import { claudeCodeDriver, stopAll } from './driver.js'

// Stopped by the host: stop the CLI sessions too, then go.
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopAll()
    setTimeout(() => process.exit(0), 200).unref()
  })

await serveDriver(claudeCodeDriver)
