import { defineConfig } from 'vitest/config'

// Tests import package sources through the "@persona-swarm/source" export condition; spawned processes (drivers,
// fixtures) run the built output, so `pnpm test` builds first.
export default defineConfig({
  resolve: { conditions: ['@persona-swarm/source', 'module', 'node', 'import', 'default'] },
  ssr: { resolve: { conditions: ['@persona-swarm/source', 'node', 'import', 'default'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'drivers/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Browser-backed suites share the machine with other work: keep parallelism modest.
    maxWorkers: 2,
  },
})
