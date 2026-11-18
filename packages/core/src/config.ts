import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { type ZodType, z } from 'zod'
import { Cohort, type ExporterConfig, GroupingConfig, Persona, Target, Workspace } from './schemas/config.js'

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`)
    this.name = 'ConfigError'
  }
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

export function resolveFrom(baseDir: string, path: string): string {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded)
}

const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Replaces `${env:NAME}` in every string of a parsed config with the environment variable, so
 * passwords and tokens can stay out of the files. A missing variable is an error, not an empty string.
 */
export function resolveEnvReferences(value: unknown, file: string, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string')
    return value.replace(ENV_REFERENCE, (_, name: string) => {
      const found = env[name]
      if (found === undefined) throw new ConfigError(file, `environment variable ${name} is not set (used as \${env:${name}})`)
      return found
    })
  if (Array.isArray(value)) return value.map((item) => resolveEnvReferences(item, file, env))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvReferences(item, file, env)]))
  return value
}

const HAS_PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/

/** Fills in the placeholders whose variables are set and leaves the others as written. */
export function fillAvailableEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') return value.replace(ENV_REFERENCE, (whole, name: string) => env[name] ?? whole)
  if (Array.isArray(value)) return value.map((item) => fillAvailableEnv(item, env))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillAvailableEnv(item, env)]))
  return value
}

const valueAt = (data: unknown, path: PropertyKey[]): unknown =>
  path.reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<PropertyKey, unknown>)[key] : undefined), data)

/**
 * Validates a config whose unset placeholders were left as written. A field that fails only because
 * it still holds a placeholder is dropped (it falls back to its default): a command that never uses
 * it (a provider's URL, for `status`) must not stop on it.
 */
function validateLenient<T extends ZodType>(schema: T, data: unknown, file: string): z.output<T> {
  let current = data
  for (let round = 0; round < 50; round += 1) {
    const result = schema.safeParse(current)
    if (result.success) return result.data
    const paths = result.error.issues
      .map((issue) => issue.path)
      .filter((path) => {
        const value = valueAt(current, path)
        return typeof value === 'string' && HAS_PLACEHOLDER.test(value)
      })
    if (!paths.length) throw new ConfigError(file, `\n${z.prettifyError(result.error)}`)
    current = structuredClone(current)
    for (const path of paths) {
      const parent = valueAt(current, path.slice(0, -1))
      if (parent && typeof parent === 'object') delete (parent as Record<PropertyKey, unknown>)[path.at(-1) as PropertyKey]
    }
  }
  return validate(schema, current, file)
}

/** A YAML key with nothing after it (often a key whose examples are commented out) means "not set". */
function dropEmptyKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropEmptyKeys)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key, dropEmptyKeys(item)]),
    )
  return value
}

/** A YAML file's data. `${env:NAME}` placeholders are filled in unless `resolveEnv` is false. */
export function readYamlFile(file: string, options: { resolveEnv?: boolean } = {}): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new ConfigError(file, `cannot read file (${(error as Error).message})`)
  }
  let data: unknown
  try {
    data = parseYaml(text) ?? {}
  } catch (error) {
    throw new ConfigError(file, `invalid YAML: ${(error as Error).message}`)
  }
  const plain = dropEmptyKeys(data)
  return options.resolveEnv === false ? plain : resolveEnvReferences(plain, file)
}

export function validate<T extends ZodType>(schema: T, data: unknown, file: string): z.output<T> {
  const result = schema.safeParse(data)
  if (!result.success) throw new ConfigError(file, `\n${z.prettifyError(result.error)}`)
  return result.data
}

/** A program name found on PATH, as a shell would find it. */
function onPath(name: string): string | undefined {
  for (const folder of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!folder) continue
    for (const candidate of process.platform === 'win32' ? [`${name}.exe`, name] : [name]) {
      const file = join(folder, candidate)
      try {
        if (statSync(file).isFile()) return file
      } catch {
        // Not here.
      }
    }
  }
  return undefined
}

export interface LoadedWorkspace {
  dir: string
  file?: string
  config: Workspace
  runsDir: string
  registryFile: string
}

/**
 * The workspace a folder belongs to: `persona-swarm.yaml` from `startDir` upwards; without one, the
 * start directory is the workspace. Commands that only read runs (status, stop, ui, export) pass
 * `resolveEnv: false`: placeholders whose variables are set are filled in, and a secret they never
 * use (a browser token) cannot stop them. The runs folder and the registry must always resolve.
 */
export function loadWorkspace(startDir: string, options: { resolveEnv?: boolean } = {}): LoadedWorkspace {
  let dir = resolve(startDir)
  for (;;) {
    const file = join(dir, 'persona-swarm.yaml')
    if (existsSync(file)) {
      const raw = readYamlFile(file, { resolveEnv: false })
      const config =
        options.resolveEnv === false ? validateLenient(Workspace, fillAvailableEnv(raw), file) : validate(Workspace, resolveEnvReferences(raw, file), file)
      for (const [key, value] of [
        ['runsDir', config.runsDir],
        ['registry', config.registry],
      ] as const) {
        const unset = HAS_PLACEHOLDER.exec(value)?.[1]
        if (unset) throw new ConfigError(file, `${key} uses \${env:${unset}}, and ${unset} is not set`)
      }
      // A path to a browser is relative to this file; a bare name is looked up on PATH, as a shell would.
      const executable = config.browser.executablePath
      if (executable) config.browser.executablePath = /[\\/]|^[.~]/.test(executable) ? resolveFrom(dir, executable) : (onPath(executable) ?? executable)
      return {
        dir,
        file,
        config,
        runsDir: resolveFrom(dir, config.runsDir),
        registryFile: resolveFrom(dir, config.registry),
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const config = Workspace.parse({})
  const base = resolve(startDir)
  return { dir: base, config, runsDir: resolveFrom(base, config.runsDir), registryFile: resolveFrom(base, config.registry) }
}

export interface LoadedTarget {
  file: string
  dir: string
  target: Target
}

/** Loads a target and makes every path in it absolute. */
export function loadTarget(file: string): LoadedTarget {
  const abs = resolve(file)
  const dir = dirname(abs)
  const target = validate(Target, readYamlFile(abs), abs)
  const at = (path: string) => resolveFrom(dir, path)
  // `fixtures` is the older name for `media`: both are read, as one list.
  target.media = [...target.media, ...target.fixtures]
  target.fixtures = []
  for (const source of target.media) {
    source.dir = at(source.dir)
    if (source.manifest) source.manifest = at(source.manifest)
  }
  for (const dependency of target.dependencies) {
    if (dependency.cache) dependency.cache.dir = at(dependency.cache.dir)
    if (dependency.stub?.bodyFile) dependency.stub.bodyFile = at(dependency.stub.bodyFile)
  }
  for (const phase of ['up', 'down', 'reset'] as const) for (const command of target.lifecycle[phase] ?? []) command.cwd = at(command.cwd ?? '.')
  if (target.knownIssues) target.knownIssues = at(target.knownIssues)
  if (target.hooks) target.hooks = at(target.hooks)
  return { file: abs, dir, target }
}

export interface LoadedPersona {
  file?: string
  persona: Persona
}

export function loadPersona(file: string): LoadedPersona {
  const abs = resolve(file)
  return { file: abs, persona: validate(Persona, readYamlFile(abs), abs) }
}

/** Expands `dir/*.yaml`-style entries (a `*` in the last path segment only). */
export function expandPattern(baseDir: string, entry: string): string[] {
  const abs = resolveFrom(baseDir, entry)
  const name = basename(abs)
  if (!name.includes('*')) return [abs]
  const dir = dirname(abs)
  if (!existsSync(dir)) return []
  const pattern = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  return readdirSync(dir)
    .filter((candidate) => pattern.test(candidate) && statSync(join(dir, candidate)).isFile())
    .sort()
    .map((candidate) => join(dir, candidate))
}

export interface LoadedCohort {
  file: string
  dir: string
  cohort: Cohort
  target: LoadedTarget
  personas: LoadedPersona[]
  workspace: LoadedWorkspace
}

/** Only a cohort's exporters: exporting must not need the target's or personas' settings (or their secrets). */
export function loadExporters(cohortFile: string): ExporterConfig[] {
  const abs = resolve(cohortFile)
  // Placeholders are filled in for the exporters only: the rest of the file may name secrets this process lacks.
  const data = readYamlFile(abs, { resolveEnv: false }) as { exporters?: unknown }
  return validate(Cohort.shape.exporters, resolveEnvReferences(data.exporters, abs), abs)
}

/** Only a cohort's grouping settings (placeholders filled in for them alone), for grouping a finished run. */
export function loadGroupingConfig(cohortFile: string): GroupingConfig | undefined {
  const abs = resolve(cohortFile)
  const data = readYamlFile(abs, { resolveEnv: false }) as { grouping?: unknown }
  return data.grouping === undefined ? undefined : validate(GroupingConfig, resolveEnvReferences(data.grouping, abs), abs)
}

export function loadCohort(file: string, options: { workspaceDir?: string } = {}): LoadedCohort {
  const abs = resolve(file)
  const dir = dirname(abs)
  const cohort = validate(Cohort, readYamlFile(abs), abs)
  const target = loadTarget(resolveFrom(dir, cohort.target))
  const personas: LoadedPersona[] = []
  for (const entry of cohort.personas) {
    if (typeof entry === 'string') {
      const files = expandPattern(dir, entry)
      if (files.length === 0) throw new ConfigError(abs, `no persona file matches "${entry}"`)
      for (const personaFile of files) personas.push(loadPersona(personaFile))
    } else {
      personas.push({ persona: entry })
    }
  }
  const workspace = loadWorkspace(options.workspaceDir ?? dir)
  return { file: abs, dir, cohort, target, personas, workspace }
}
