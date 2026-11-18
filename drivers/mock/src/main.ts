#!/usr/bin/env node
import { serveDriver } from '@persona-swarm/driver-kit'
import { mockDriver } from './driver.js'

await serveDriver(mockDriver)
