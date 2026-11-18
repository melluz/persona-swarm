import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { hostname, uptime } from 'node:os'
import { dirname } from 'node:path'

interface LockOwner {
  pid: number
  host: string
  /** When the lock was taken. */
  t: string
  /** When the owning process started (older locks): tells a live owner from a later process that reuses its pid. */
  started?: string
  /** The owning process's start as the system records it (see processIdentity). */
  identity?: string
  /** The machine (see machineId): a host name can change, the machine does not. */
  machine?: string
  /** Identifies this holding of the lock: only its holder removes it. */
  token?: string
}

const STARTED = new Date(Date.now() - process.uptime() * 1000).toISOString()

let bootId: string | undefined
let selfIdentity: string | undefined | null = null
let machine: string | undefined | null = null

/** A stable id for this machine: macOS's hardware UUID or Linux's machine-id; undefined elsewhere (the host name stands in). */
export function machineId(): string | undefined {
  if (machine !== null) return machine
  machine = undefined
  if (process.platform === 'linux')
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(file, 'utf8').trim()
        if (id) {
          machine = `linux:${id}`
          break
        }
      } catch {
        // Not there: try the next.
      }
    }
  else if (process.platform === 'darwin') {
    const out = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3_000 }).stdout ?? ''
    const id = /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1]
    if (id) machine = `mac:${id}`
  }
  return machine
}

/**
 * A process's start as the system records it: fixed for the life of the process (a clock change does
 * not move it) and different for a later process that reuses the pid. Linux: the boot and the start
 * in clock ticks since boot; elsewhere, `ps`'s start time in UTC.
 */
export function processIdentity(pid: number): string | undefined {
  if (pid === process.pid && selfIdentity !== null) return selfIdentity
  let identity: string | undefined
  if (process.platform === 'linux') {
    try {
      bootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // Field 22 (starttime) counts from field 3, which follows the command name in parentheses.
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      identity = ticks ? `linux:${bootId}:${ticks}` : undefined
    } catch {
      identity = undefined
    }
  } else if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
    identity = result.stdout?.trim() || undefined
  }
  if (pid === process.pid) selfIdentity = identity
  return identity
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** When a process on this machine started, if the system says (`ps`, on macOS and Linux). */
function processStart(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' } })
  const started = Date.parse(result.stdout?.trim() ?? '')
  return Number.isFinite(started) ? started : undefined
}

/**
 * Whether the owner is a process on this machine: the same machine id (whatever the host is called
 * now); for a lock without one, the same host name, or a live local process with its identity.
 */
function isLocal(owner: LockOwner): boolean {
  const here = machineId()
  if (owner.machine && here) return owner.machine === here
  if (owner.host === hostname()) return true
  return owner.identity !== undefined && alive(owner.pid) && processIdentity(owner.pid) === owner.identity
}

/**
 * Whether the lock's owner still holds it. On this machine: the process is alive and is the same
 * process (its identity matches, so a reused pid does not count). A lock from another machine (a
 * shared folder) is trusted until `staleMs` after it was taken.
 */
function holding(owner: LockOwner, staleMs: number): boolean {
  if (!isLocal(owner)) return Date.now() - Date.parse(owner.t) <= staleMs
  if (!alive(owner.pid)) return false
  if (owner.identity !== undefined) {
    const now = processIdentity(owner.pid)
    return now === undefined || now === owner.identity
  }
  // A lock written before identities: start times compared to the second, and none from before the last boot.
  const bootedAt = Date.now() - uptime() * 1000
  if (Date.parse(owner.t) < bootedAt) return false
  if (!owner.started) return true
  const started = owner.pid === process.pid ? Date.parse(STARTED) : processStart(owner.pid)
  return started === undefined || Math.abs(started - Date.parse(owner.started)) < 2_000
}

/**
 * Removes a dead owner's lock, unless it changed since it was read. Takeovers are serialised by a
 * marker file, so two processes that found the same dead owner cannot remove each other's new lock.
 */
function takeOver(file: string, owner: LockOwner, stillDead: () => boolean = () => true): boolean {
  const marker = `${file}.takeover`
  try {
    closeSync(openSync(marker, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Another process is taking over; a marker left by a crash is cleared after a while.
    try {
      if (Date.now() - statSync(marker).mtimeMs > 10_000) rmSync(marker, { force: true })
    } catch {
      // Gone meanwhile.
    }
    return false
  }
  try {
    if (readOwner(file)?.token !== owner.token || !stillDead()) return false
    rmSync(file, { force: true })
    return true
  } finally {
    rmSync(marker, { force: true })
  }
}

function readOwner(file: string): LockOwner | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockOwner
  } catch {
    return undefined
  }
}

type Attempt = { token: string } | { owner: LockOwner }

/**
 * Creates the lock file, or reports who holds it. A dead owner's lock is taken over, but only after
 * reading it again: if it changed meanwhile, another process got there first and holds it now. A
 * re-entrant lock may be taken over from this very process (a run folder left by an earlier run).
 */
function tryLock(file: string, staleMs: number, reentrant = false): Attempt {
  // The first write to a file may also be the first in its folder (a new workspace's registry).
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomBytes(12).toString('hex')
    try {
      const fd = openSync(file, 'wx', 0o600)
      const identity = processIdentity(process.pid)
      const here = machineId()
      try {
        writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            host: hostname(),
            t: new Date().toISOString(),
            started: STARTED,
            ...(identity ? { identity } : {}),
            ...(here ? { machine: here } : {}),
            token,
          } satisfies LockOwner),
        )
      } catch (error) {
        // A lock that could not be written (a full disk) must not be left behind, empty, for others.
        closeSync(fd)
        rmSync(file, { force: true })
        throw error
      }
      closeSync(fd)
      return { token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const owner = readOwner(file)
    if (!owner) {
      // Just created and not written yet, or garbage: give its creator a moment.
      let age = 0
      try {
        age = Date.now() - statSync(file).mtimeMs
      } catch {
        continue
      }
      if (age < 5_000) return { owner: { pid: -1, host: hostname(), t: new Date().toISOString() } }
      // Garbage left by a crash: removed like a dead owner's lock, one taker at a time, and only if it is
      // still old garbage (not a lock another process has just created and is writing).
      const oldGarbage = () => {
        try {
          return !readOwner(file) && Date.now() - statSync(file).mtimeMs >= 5_000
        } catch {
          return false
        }
      }
      if (!takeOver(file, { pid: -1, host: '', t: '' }, oldGarbage))
        return { owner: readOwner(file) ?? { pid: -1, host: hostname(), t: new Date().toISOString() } }
      continue
    }
    const mine = reentrant && owner.pid === process.pid && isLocal(owner)
    if (!mine && holding(owner, staleMs)) return { owner }
    if (!takeOver(file, owner)) return { owner: readOwner(file) ?? owner }
  }
  return { owner: readOwner(file) ?? { pid: -1, host: '', t: '' } }
}

/** Removes the lock only if it is still this holding's (a lock taken over meanwhile is left alone). */
function release(file: string, token: string): void {
  if (readOwner(file)?.token === token) rmSync(file, { force: true })
}

/**
 * Runs `fn` while holding an exclusive lock on `file` (as `<file>.lock`), so read-modify-write
 * updates from different processes (the run, the UI server, the CLI) never lose each other's work.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, options: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const lock = `${file}.lock`
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let token: string | undefined
  for (let wait = 20; ; wait = Math.min(wait * 2, 500)) {
    const attempt = tryLock(lock, options.staleMs ?? 600_000)
    if ('token' in attempt) {
      token = attempt.token
      break
    }
    if (Date.now() > deadline) throw new Error(`${file} is locked by process ${attempt.owner.pid} (remove ${lock} if that process is gone)`)
    await new Promise((resolveWait) => setTimeout(resolveWait, wait))
  }
  try {
    return await fn()
  } finally {
    release(lock, token)
  }
}

/** A run folder held by the process executing it: a second process cannot resume it at the same time. */
export class RunLock {
  private constructor(
    private readonly file: string,
    private readonly token: string,
  ) {}

  /** Takes the lock, or says which process (on which machine) holds it. */
  static acquire(runDir: string): RunLock | { heldBy: number; host: string; local: boolean } {
    const file = `${runDir}/run.lock`
    const attempt = tryLock(file, Number.POSITIVE_INFINITY, true)
    return 'token' in attempt ? new RunLock(file, attempt.token) : { heldBy: attempt.owner.pid, host: attempt.owner.host, local: isLocal(attempt.owner) }
  }

  /**
   * The process executing a run, if any: a live local process (never a later one that reuses a dead
   * run's pid), or a process on another machine that this one cannot check.
   */
  static holder(runDir: string): { pid: number; host: string; local: boolean } | undefined {
    const owner = readOwner(`${runDir}/run.lock`)
    if (!owner || (owner.pid === process.pid && isLocal(owner)) || !holding(owner, Number.POSITIVE_INFINITY)) return undefined
    return { pid: owner.pid, host: owner.host, local: isLocal(owner) }
  }

  release(): void {
    release(this.file, this.token)
  }
}
