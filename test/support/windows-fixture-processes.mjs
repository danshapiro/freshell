import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { stopFixtureProcess } from './stop-fixture-process.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOST = path.resolve(REPO_ROOT, process.env.CARGO_TARGET_DIR || 'target', 'debug/examples/fixture-job-host.exe')
const POLL_MS = 10
const TIMEOUT_MS = 30_000
let preparation

export function prepareWindowsFixtureHost() {
  return preparation ??= promisify(execFile)('cargo', ['build', '-p', 'freshell-platform', '--locked', '--example', 'fixture-job-host'], {
    cwd: REPO_ROOT, timeout: 900_000, maxBuffer: 4 * 1024 * 1024,
  }).then(() => HOST)
}

function publish(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value))
  fs.renameSync(temporary, file)
}

function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/** Preserve the target's PID, pipes and exit events while its Job owner lives. */
class FixtureChild extends EventEmitter {
  pid
  exitCode = null
  signalCode = null
  killed = false

  constructor(session, controller, command, args) {
    super()
    this.session = session
    this.fixtureHostPid = controller.pid
    this.stdin = controller.stdin
    this.stdout = controller.stdout
    this.stderr = controller.stderr
    this.stdio = controller.stdio
    this.spawnfile = command
    this.spawnargs = [command, ...args]
    this.openPipes = new Set([this.stdin, this.stdout, this.stderr].filter(Boolean))
    for (const pipe of this.openPipes) pipe.once('close', () => {
      this.openPipes.delete(pipe)
      this.maybeClose()
    })
  }

  maybeClose() {
    if (this.closed || !this.completedEvent || !exited(this) || this.openPipes.size !== 0) return
    this.closed = true
    this.emit('close', this.exitCode, this.signalCode)
  }

  observe(status) {
    this.pid ??= status.pid
    if (status.error && !this.failure) {
      this.failure = Object.assign(new Error(status.error), { code: status.errorCode ?? 'EIO' })
      if (status.pid === undefined) {
        this.exitCode = -1
        this.stdin?.destroy()
      }
      this.emit('error', this.failure)
      if (status.pid === undefined) this.completedEvent = true
    }
    if (status.rootExited && !this.exitObserved) {
      this.exitObserved = true
      this.exitCode = this.requestedSignal ? null : status.exitCode
      this.signalCode = this.requestedSignal ?? null
      this.stdin?.destroy()
      this.emit('exit', this.exitCode, this.signalCode)
      this.completedEvent = true
    }
    this.maybeClose()
  }

  kill(signal = 'SIGTERM') {
    this.session.refresh()
    if (exited(this)) return false
    if (signal === 0) {
      try { process.kill(this.pid, 0); return true } catch (error) {
        if (error.code === 'ESRCH') return false
        throw error
      }
    }
    this.session.command({ action: 'kill-root', signal })
    this.killed = true
    this.requestedSignal = signal
    return true
  }

  ref() { this.session.controller.ref(); this.session.timer?.ref(); return this }
  unref() { this.session.controller.unref(); this.session.timer?.unref(); return this }
}

/** Registered before start(), so even a failed startup remains owned. */
export function createWindowsFixtureSession(root) {
  if (!root) throw new Error('Windows fixture process ownership requires its root')
  const directory = fs.mkdtempSync(path.join(root, '.process-job-'))
  const statusFile = path.join(directory, 'status.json')
  const controlFile = path.join(directory, 'control.json')
  const requestFile = path.join(directory, 'request.json')
  const session = {
    controller: undefined,
    child: undefined,
    status: undefined,
    timer: undefined,
    command(value) { publish(controlFile, { ...value, id: randomUUID() }) },
    poll() {
      clearInterval(this.timer)
      this.timer = setInterval(() => {
        try { this.refresh() } catch (error) {
          this.controllerFailure = error
          clearInterval(this.timer)
        }
      }, POLL_MS)
    },
    refresh() {
      const status = readStatus(statusFile)
      if (status) {
        this.status = status
        this.child?.observe(status)
      }
      return this.status
    },
    start(command, args, options = {}) {
      if (options.shell || options.detached) throw new Error('fixture Job Objects require a direct, owned executable')
      if (!fs.existsSync(HOST)) throw new Error('Windows fixture host is missing; prepareWindowsFixtureHost must run first')
      publish(requestFile, { command, args, cwd: options.cwd, ownerPid: process.pid })
      // Passing env through spawn preserves libuv's essential Windows vars
      // without writing the caller's credentials into a request file.
      this.controller = spawn(HOST, [requestFile, statusFile, controlFile], {
        cwd: options.cwd, env: options.env, stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      this.child = new FixtureChild(this, this.controller, command, args)
      this.controller.once('error', (error) => {
        this.child.emit('error', error)
        if (this.child.pid === undefined) this.child.completedEvent = true
        this.child.maybeClose()
      })
      this.controller.once('exit', () => {
        this.refresh()
        if (!this.status?.settled) {
          this.controllerFailure = new Error('fixture Job host exited without confirming its process tree')
        }
      })
      if (this.controller.pid === undefined) {
        this.child.exitCode = -1
        this.status = { settled: true }
        return this.child
      }
      // spawn callbacks are synchronous. The helper creates the actual target
      // suspended in its job before publishing its PID; no target PID changes.
      const deadline = Date.now() + TIMEOUT_MS
      const sleeper = new Int32Array(new SharedArrayBuffer(4))
      while (true) {
        const status = readStatus(statusFile)
        if (status?.pid !== undefined || status?.error) {
          this.status = status
          this.child.pid = status.pid
          break
        }
        if (Date.now() >= deadline) throw new Error('fixture Job host startup timed out; retain its files')
        Atomics.wait(sleeper, 0, 0, POLL_MS)
      }
      // Caller listeners, including SDK spawn/exit listeners, attach first.
      queueMicrotask(() => {
        if (this.status.pid !== undefined) this.child.emit('spawn')
        this.refresh()
      })
      this.poll()
      if (options.signal) {
        const abort = () => {
          if (!exited(this.child)) this.child.kill('SIGTERM')
        }
        options.signal.addEventListener('abort', abort, { once: true })
        this.child.once('close', () => options.signal.removeEventListener('abort', abort))
        if (options.signal.aborted) queueMicrotask(abort)
      }
      return this.child
    },
    async stop() {
      if (!this.controller) return
      try {
        this.poll()
        this.refresh()
        if (this.controllerFailure && !this.status?.settled) throw this.controllerFailure
        if (this.child?.pid !== undefined && !exited(this.child)) await stopFixtureProcess(this.child)
        if (!this.status?.settled) this.command({ action: 'stop' })
        const deadline = Date.now() + TIMEOUT_MS
        while (!this.refresh()?.settled) {
          if (this.controllerFailure || exited(this.controller) || Date.now() >= deadline) {
            throw this.controllerFailure ?? new Error('unconfirmed fixture Job member exits; retain its files')
          }
          await delay(POLL_MS)
        }
        while (!exited(this.controller)) {
          if (Date.now() >= deadline) throw new Error('fixture Job host did not exit after settlement')
          await delay(POLL_MS)
        }
      } finally {
        clearInterval(this.timer)
      }
    },
  }
  return session
}
