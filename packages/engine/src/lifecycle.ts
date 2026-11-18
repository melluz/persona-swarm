import { type ChildProcess, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Command, Device, Target } from '@persona-swarm/core'

export async function isHealthy(url: string, timeoutSec = 5): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutSec * 1000), redirect: 'manual' })
    return response.status < 500
  } catch {
    return false
  }
}

export async function waitUntilHealthy(url: string, timeoutSec: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline && !signal?.aborted) {
    if (await isHealthy(url, 3)) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
  }
  return false
}

export class LifecycleError extends Error {}

/**
 * Runs lifecycle commands; background ones (servers) are returned so they can be stopped later, and
 * handed to `track` as soon as they start, so they are stopped even when a later step fails.
 */
export async function runCommands(
  commands: Command[],
  options: { logsDir: string; label: string; log: (message: string) => void; signal?: AbortSignal; track?: (child: ChildProcess) => void },
): Promise<ChildProcess[]> {
  const background: ChildProcess[] = []
  mkdirSync(options.logsDir, { recursive: true })
  for (const [index, command] of commands.entries()) {
    const [program, ...args] = command.run
    if (!program) continue
    const logFile = join(options.logsDir, `${options.label}-${index + 1}.log`)
    const output = createWriteStream(logFile, { flags: 'a' })
    options.log(`${options.label}: ${command.run.join(' ')}`)
    const child = spawn(program, args, {
      cwd: command.cwd,
      env: { ...process.env, ...(command.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    // An exit right after the start (a missing database) must be seen, however soon it comes.
    const exited = new Promise<{ exited: number | null }>((resolveExit) => child.once('exit', (code) => resolveExit({ exited: code })))
    // Both streams share the log, which closes once both are done: a late line must not hit a closed file.
    output.on('error', () => {})
    child.stdout?.pipe(output, { end: false })
    child.stderr?.pipe(output, { end: false })
    child.on('close', () => output.end())
    options.track?.(child)
    if (command.background) {
      // A program or folder that does not exist is reported, not an unhandled error.
      let failed: Error | undefined
      child.on('error', (error) => {
        failed = error
        options.log(`${options.label}: ${command.run.join(' ')} failed: ${error.message}`)
      })
      background.push(child)
      await new Promise((resolveTick) => setImmediate(resolveTick))
      if (failed) throw new LifecycleError(`${command.run.join(' ')} could not start: ${failed.message}`)
      if (command.readyUrl) {
        // A server that dies while starting (its database is not running) says so now, not after the whole timeout.
        const stopWaiting = new AbortController()
        const ready = await Promise.race([
          waitUntilHealthy(command.readyUrl, command.timeoutSec, options.signal ? AbortSignal.any([options.signal, stopWaiting.signal]) : stopWaiting.signal),
          exited,
        ])
        stopWaiting.abort()
        if (typeof ready === 'object')
          throw new LifecycleError(`${command.run.join(' ')} exited (${ready.exited}) before ${command.readyUrl} answered (see ${logFile})`)
        if (!ready)
          throw new LifecycleError(`${command.run.join(' ')} did not become ready at ${command.readyUrl} within ${command.timeoutSec} s (see ${logFile})`)
      }
      continue
    }
    const code = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => stopProcess(child), command.timeoutSec * 1000)
      const onStop = () => stopProcess(child)
      options.signal?.addEventListener('abort', onStop, { once: true })
      child.on('exit', (exitCode) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onStop)
        resolveExit(exitCode)
      })
      child.on('error', () => resolveExit(-1))
    })
    if (code !== 0) throw new LifecycleError(`${command.run.join(' ')} exited with ${code} (see ${logFile})`)
    if (command.readyUrl && !(await waitUntilHealthy(command.readyUrl, command.timeoutSec, options.signal)))
      throw new LifecycleError(`${command.readyUrl} is not answering after ${command.run.join(' ')}`)
  }
  return background
}

/** Signals a child's whole process group (servers often start children of their own). */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    child.kill(signal)
  }
}

/** SIGTERM, then SIGKILL for whatever is still there 5 s later. */
export function stopProcess(child: ChildProcess): void {
  killProcessGroup(child, 'SIGTERM')
  setTimeout(() => killProcessGroup(child, 'SIGKILL'), 5_000).unref()
}

/**
 * Finds a ref in an outline by role words and accessible name, e.g. ("textbox", "Email"). An exact
 * name wins over a partial one: "Sign in" is not "Sign in with Google", wherever each stands.
 */
export function findRef(outline: string, name: string, roles?: string[]): string | undefined {
  const wanted = name.trim().toLowerCase()
  let partial: string | undefined
  for (const line of outline.split('\n')) {
    const match = /- (\w+) "([^"]*)"[^\n]*\[ref=([^\]]+)\]/.exec(line)
    if (!match) continue
    const [, role, label, ref] = match
    if (roles && !roles.includes(role ?? '')) continue
    const text = (label ?? '').trim().toLowerCase()
    if (text === wanted) return ref
    if (!partial && text.includes(wanted)) partial = ref
  }
  return partial
}

/**
 * Signs a device in with the target's scripted steps, through the accessibility outline only, so it
 * works on any device kind. Steps: { goto }, { fill: <field name>, value }, { click: <name> }, { waitFor }.
 */
export async function scriptedSignIn(device: Device, target: Target, account: { username: string; password: string }): Promise<void> {
  const fillIn = (value: string) => value.replaceAll('{{username}}', account.username).replaceAll('{{password}}', account.password)
  for (const step of target.signIn.steps) {
    if ('goto' in step) {
      const outcome = await device.perform({ type: 'open', url: step.goto })
      if (!outcome.ok) throw new LifecycleError(`sign-in step goto ${step.goto}: ${outcome.message}`)
    } else if ('waitFor' in step) {
      // The step that proves the sign-in worked: a wrong password, a locked account or an extra step stop here.
      const text = fillIn(step.waitFor)
      const outcome = await device.perform({ type: 'wait', seconds: 15, forText: text })
      // Only the text itself proves it (a dialog that opened instead, an "Incorrect password" alert, does not).
      if (!outcome.ok || outcome.matched !== true)
        throw new LifecycleError(`sign-in did not reach "${text}" (still on ${outcome.status.url}): check the account and the target's signIn steps`)
    } else {
      const outline = (await device.outline({ maxChars: 200_000 })).text
      const name = 'fill' in step ? step.fill : step.click
      const ref =
        'fill' in step
          ? findRef(outline, name, ['textbox', 'searchbox', 'combobox', 'spinbutton'])
          : findRef(outline, name, ['button', 'link', 'menuitem', 'checkbox', 'tab'])
      if (!ref) throw new LifecycleError(`sign-in step: no element named "${name}" on ${(await device.status()).url}`)
      const outcome =
        'fill' in step ? await device.perform({ type: 'fill', ref, text: fillIn(step.value) }) : await device.perform({ type: 'click', target: { ref } })
      if (!outcome.ok) throw new LifecycleError(`sign-in step "${name}": ${outcome.message}`)
    }
  }
}
