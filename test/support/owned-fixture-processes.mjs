import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createWindowsFixtureSession, prepareWindowsFixtureHost } from './windows-fixture-processes.mjs'

const EXIT_TIMEOUT_MS = 3_000
const POLL_MS = 25
const OWNER_ENV = 'FRESHELL_CLAUDE_FIXTURE_OWNER'

const log = (severity, event, fields) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), severity, component: 'claude-fixture', event, ...fields })}\n`)
}

function inspectorEnvironment() {
  const environment = { ...process.env }
  // Some SDK harnesses adopt fixture.env() themselves. Inspectors must not
  // inherit its ownership tag and appear as a new writer on every scan.
  delete environment[OWNER_ENV]
  return environment
}

async function liveGroupMembers(groupId, platform) {
  try { process.kill(-groupId, 0) } catch (error) {
    if (error.code === 'ESRCH') return []
    // A signal-zero refusal is not proof of a live writer. Inspect members
    // (and exclude exited zombies); real TERM/KILL refusals still propagate.
    if (error.code !== 'EPERM') throw error
  }
  if (platform !== 'linux') {
    // Darwin's session field is not the numeric Linux SID. The PGID of our
    // detached child is sufficient, and ps exposes it on both POSIX systems.
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { env: inspectorEnvironment(), timeout: EXIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    return stdout.trim().split('\n').flatMap((line) => {
      const [pid, group, state] = line.trim().split(/\s+/)
      return Number(group) === groupId && state && !/^[ZX]/.test(state) ? [Number(pid)] : []
    })
  }
  const entries = await fs.readdir('/proc')
  const members = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    let stat
    try { stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8') } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
      throw error
    }
    const [state, , processGroup, session] = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    // A zombie has already exited and cannot write. A newly detached child
    // starts its own session, whose id remains valid after its leader exits.
    if (Number(processGroup) === groupId && Number(session) === groupId && state !== 'Z' && state !== 'X') return Number(entry)
    return undefined
  }))
  return members.filter((pid) => pid !== undefined)
}

async function readLinuxEnvironment(directory) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  while (true) {
    try { return await fs.readFile(`${directory}/environ`, 'utf8') } catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error
      // Linux can drop environment access before a dying process becomes a
      // zombie. Recheck until it exits, becomes readable, or exhausts budget.
      const stat = await fs.readFile(`${directory}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
      if (state === 'Z' || state === 'X') return ''
      if (Date.now() >= deadline) throw error
      await delay(POLL_MS)
    }
  }
}

async function liveTaggedProcesses(owner, platform) {
  const marker = `${OWNER_ENV}=${owner}`
  if (platform !== 'linux') {
    // Darwin -E includes launch environments; -ww and a final command column
    // preserve the marker even for long CLI arguments. Never log this output:
    // it includes unrelated processes' environment values.
    const { stdout } = await promisify(execFile)('/bin/ps', ['-E', '-ww', '-ax', '-o', 'pid=,stat=,command='], {
      env: inspectorEnvironment(), timeout: EXIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.trim().split('\n').flatMap((line) => {
      const [pid, state, ...command] = line.trim().split(/\s+/)
      return state && !/^[ZX]/.test(state) && command.includes(marker) ? [Number(pid)] : []
    })
  }
  const entries = (await fs.readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  const owned = []
  // Bound open files when the developer's machine has many concurrent agents.
  for (let index = 0; index < entries.length; index += 32) {
    const matches = await Promise.all(entries.slice(index, index + 32).map(async (entry) => {
      try {
        const directory = `/proc/${entry}`
        if ((await fs.stat(directory)).uid !== process.geteuid()) return undefined
        const stat = await fs.readFile(`${directory}/stat`, 'utf8')
        const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
        if (state === 'Z' || state === 'X') return undefined
        const environment = await readLinuxEnvironment(directory)
        return environment.split('\0').includes(marker) ? Number(entry) : undefined
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
        // Unreadable same-user environments leave ownership unknown. Retain
        // the fixture instead of claiming no detached writer remains.
        throw error
      }
    }))
    owned.push(...matches.filter((pid) => pid !== undefined))
  }
  return owned
}

function signalProcess(pid, signal) {
  try { process.kill(pid, signal) } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function stopTaggedProcesses(owner, platform) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const deadline = Date.now() + EXIT_TIMEOUT_MS
    let members = await liveTaggedProcesses(owner, platform)
    if (members.length === 0) return
    log(signal === 'SIGTERM' ? 'info' : 'warn', 'fixture.detached_processes.stopping', { signal, members })
    while (true) {
      for (const pid of members) signalProcess(pid, signal)
      await delay(POLL_MS)
      members = await liveTaggedProcesses(owner, platform)
      if (members.length === 0) return
      if (Date.now() >= deadline) break
    }
    if (signal === 'SIGKILL') throw new Error(`owned fixture processes still alive after SIGKILL: ${members.join(', ')}`)
  }
}

function signalGroup(groupId, signal) {
  signalProcess(-groupId, signal)
}

async function waitForGroupExit(groupId, signal, platform) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  while (true) {
    const remaining = await liveGroupMembers(groupId, platform)
    if (remaining.length === 0 || Date.now() >= deadline) return remaining
    // Recheck after SIGKILL too: a child already being forked at the first
    // signal must not escape settlement while its parent is being killed.
    if (signal === 'SIGKILL') signalGroup(groupId, signal)
    await delay(POLL_MS)
  }
}

async function stopGroup(groupId, platform) {
  const members = await liveGroupMembers(groupId, platform)
  if (members.length === 0) return
  log('info', 'fixture.process_group.stopping', { groupId, members })
  signalGroup(groupId, 'SIGTERM')
  if ((await waitForGroupExit(groupId, 'SIGTERM', platform)).length === 0) return
  log('warn', 'fixture.process_group.force_stopping', { groupId })
  signalGroup(groupId, 'SIGKILL')
  const remaining = await waitForGroupExit(groupId, 'SIGKILL', platform)
  if (remaining.length !== 0) {
    throw new Error(`owned fixture process group ${groupId} still has live members after SIGKILL: ${remaining.join(', ')}`)
  }
}

export async function prepareFixtureProcessOwner() {
  if (process.platform === 'win32') await prepareWindowsFixtureHost()
}

/**
 * POSIX children own process groups plus an inherited fixture tag, which
 * follows ordinary detached descendants across sessions and reparenting.
 * Windows starts every target suspended in its own Job Object. Both retain
 * ownership after root exit and require writer exit before file deletion.
 */
export function createFixtureProcessOwner({ root } = {}) {
  const platform = process.platform
  const owner = randomUUID()
  const environment = Object.freeze(platform === 'win32' ? {} : { [OWNER_ENV]: owner })
  const groups = new Set()
  const windowsSessions = new Set()
  let closing = false
  let launched = false
  return {
    environment,
    spawn(command, args, options = {}) {
      if (closing) throw new Error('cannot spawn a fixture process after cleanup has started')
      if (platform === 'win32') {
        const session = createWindowsFixtureSession(root)
        windowsSessions.add(session)
        return session.start(command, args, options)
      }
      // Node establishes pgid = sid = child.pid before spawn returns. Ownership
      // is captured before any created frame or native-CLI initialization, and
      // survives an immediate sidecar exit without a PID-journal race.
      const child = spawn(command, args, { ...options, env: { ...(options.env ?? process.env), ...environment }, detached: true })
      if (child.pid !== undefined) {
        groups.add(child.pid)
        launched = true
      }
      return child
    },
    async stop() {
      closing = true
      for (const session of windowsSessions) {
        await session.stop()
        windowsSessions.delete(session)
      }
      for (const groupId of groups) {
        await stopGroup(groupId, platform)
        groups.delete(groupId)
      }
      if (launched) {
        await stopTaggedProcesses(owner, platform)
        launched = false
      }
    },
  }
}
