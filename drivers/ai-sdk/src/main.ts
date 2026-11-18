#!/usr/bin/env node
import { serveDriver } from '@persona-swarm/driver-kit'
import { aiSdkDriver } from './driver.js'

await serveDriver(aiSdkDriver)
