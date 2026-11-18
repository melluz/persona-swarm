#!/usr/bin/env node
import { serveDriver } from '@persona-swarm/driver-kit'
import { externalDriver } from './bridge.js'

await serveDriver(externalDriver)
