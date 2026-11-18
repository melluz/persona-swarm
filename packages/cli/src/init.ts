import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIBRARY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../personas')

const WORKSPACE = `# persona-swarm workspace settings
runsDir: runs

# Named model endpoints, used as "<name>:<model>" in roles. Keys are read from the environment.
providers: {}
# providers:
#   local:
#     type: openai-compatible
#     baseURL: http://127.0.0.1:11434/v1   # Ollama, vLLM, LM Studio...
#     vision: true                          # declare what the model can do
#     contextWindow: 32000

# USD per million tokens, for cost tracking of models whose driver does not report cost.
prices: {}
# prices:
#   "openai:gpt-5-mini": { input: 0.25, output: 2.0 }

limits:
  maxBrowsers: 4
  maxAgents: 4
  minFreeMemoryPercent: 30
  stopBelowFreeMemoryPercent: 15
`

const TARGET = `id: my-app
name: My App
baseUrl: http://localhost:3000

# What a user could know before using the product: the marketing page, the welcome email.
brief: |
  My App helps you ... (describe the product as its website would).

# health: { url: http://localhost:3000/health }
# lifecycle:
#   up:
#     - { run: [npm, run, dev], cwd: ../my-app, background: true, readyUrl: http://localhost:3000, timeoutSec: 120 }

accounts:
  - { id: user-1, username: user1@example.test, password: test-password }
  - { id: user-2, username: user2@example.test, password: test-password }

signIn:
  mode: persona            # personas sign in themselves; "scripted" signs them in before they start
  url: /
  # steps: [{ fill: Email, value: "{{username}}" }, { fill: Password, value: "{{password}}" }, { click: Sign in }]

# Files personas can upload: images to annotate, documents to import, a wrong file to pick by mistake.
# A manifest describes each file as its owner would, tags it, and can point to its ground truth
# (never shown to personas). Cohorts choose files per persona by tag. See docs/media.md.
media: []
  # - { dir: ./files, pattern: "\\\\.(png|jpe?g|pdf)$", manifest: files.yaml, tags: [sample] }

# Slow or costly services your app calls, put behind a cache or stub during runs.
dependencies: []

knownIssues: known-issues.yaml
`

const COHORT = `id: smoke
description: A first look with a few very different people.
target: ../targets/my-app.yaml
mode: explore

personas:
  - ../personas/novice-skimmer.yaml
  - ../personas/busy-phone-user.yaml
  - ../personas/keyboard-only.yaml
  - ../personas/expert-power-user.yaml

# What these people came to do in this app (overrides the personas' generic goals).
missions:
  "*": Do the main thing this app is for, from start to finish.

roles:
  # The mock "monkey" needs no model and runs out of the box. Switch to a real model:
  #   persona: { driver: ai-sdk, model: openai:gpt-5-mini }
  #   persona: { driver: ai-sdk, model: anthropic:claude-sonnet-5-5 }
  #   persona: { driver: ai-sdk, model: local:qwen2.5vl }       # a provider from persona-swarm.yaml
  #   persona: { driver: claude-code, model: sonnet }            # the local Claude Code CLI
  persona: { driver: mock, options: { mode: monkey } }

# usdPerRun is a hard cap. With ai-sdk models, give their prices in persona-swarm.yaml so it can be counted.
# Minutes and actions are a baseline: novices, slow and interrupted personas get more of them (see
# docs/personas.md, "Budget"). Give one persona its own: personas: { novice-skimmer: { minutes: 30 } }
budgets: { minutesPerPersona: 20, turnsPerPersona: 150, usdPerRun: 10 }
schedule: { staggerSec: 20 }
# After each run, a model or an agent can group duplicate reports that wording misses:
# grouping: { model: openai:gpt-5-mini }
# grouping: { command: [claude, -p] }   # any agent CLI: the task on stdin, its answer on stdout
exporters:
  - { type: markdown }
  # - { type: github, with: { repo: owner/repo, tokenEnv: GITHUB_TOKEN } }
  # - { type: linear, with: { teamId: TEAM_ID, tokenEnv: LINEAR_API_KEY } }
  # - { type: jira, with: { baseUrl: https://you.atlassian.net, project: APP } }
  # - { type: webhook, with: { urlEnv: TEAM_WEBHOOK_URL } }
`

/** Creates a workspace in `dir` and returns the files written (never overwrites). */
export function scaffold(dir: string): string[] {
  const written: string[] = []
  const write = (relative: string, text: string) => {
    const file = join(dir, relative)
    if (existsSync(file)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    written.push(relative)
  }
  write('persona-swarm.yaml', WORKSPACE)
  write('targets/my-app.yaml', TARGET)
  write('targets/known-issues.yaml', '# Problems the team already knows about; personas are told when they hit one.\n[]\n')
  write('cohorts/smoke.yaml', COHORT)
  write('.gitignore', 'runs/\n.persona-swarm/\n')
  if (existsSync(LIBRARY))
    for (const name of readdirSync(LIBRARY).filter((file) => file.endsWith('.yaml'))) {
      const target = join(dir, 'personas', name)
      if (existsSync(target)) continue
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(LIBRARY, name), target)
      written.push(`personas/${name}`)
    }
  return written
}
