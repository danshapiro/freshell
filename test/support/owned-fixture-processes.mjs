import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
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

async function inspectLinuxProcesses(inspect) {
  const entries = (await fs.readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  const matches = []
  // Both ownership scans share the same bound on simultaneous procfs reads.
  // A developer machine can have thousands of live agent processes.
  for (let index = 0; index < entries.length; index += 32) {
    const batch = await Promise.all(entries.slice(index, index + 32).map(inspect))
    matches.push(...batch.filter((pid) => pid !== undefined))
  }
  return matches
}

async function readLinuxProcess(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  return {
    pid: Number(pid), state: fields[0], parent: Number(fields[1]),
    group: Number(fields[2]), session: Number(fields[3]), startTime: fields[19],
  }
}

function knownLinuxProcess(observed, ownership) {
  const startTime = ownership.known.get(observed.pid)
  if (startTime === undefined) return false
  if (startTime === observed.startTime) return true
  ownership.known.delete(observed.pid)
  return false
}

async function attributableLinuxProcess(observed, ownership) {
  let current = observed
  for (let depth = 0; depth < 128; depth += 1) {
    if (knownLinuxProcess(current, ownership) || ownership.groups.has(current.group)) return true
    if (current.parent <= 1) break
    try { current = await readLinuxProcess(current.parent) } catch (error) {
      if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) break
      throw error
    }
  }
  if (!ownership.root) return false
  try {
    const cwd = await fs.readlink(`/proc/${observed.pid}/cwd`)
    return cwd === ownership.root || cwd.startsWith(`${ownership.root}${path.sep}`)
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return false
    throw error
  }
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
  return inspectLinuxProcesses(async (entry) => {
    let observed
    try { observed = await readLinuxProcess(entry) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
      throw error
    }
    // A zombie has already exited and cannot write. A newly detached child
    // starts its own session, whose id remains valid after its leader exits.
    if (observed.group === groupId && observed.session === groupId && observed.state !== 'Z' && observed.state !== 'X') return observed.pid
    return undefined
  })
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
      if (state === 'Z' || state === 'X') return undefined
      if (Date.now() >= deadline) throw error
      await delay(POLL_MS)
    }
  }
}

async function liveTaggedProcesses(ownership, platform, excludedGroups, failedIdentities) {
  const marker = `${OWNER_ENV}=${ownership.owner}`
  if (platform !== 'linux') {
    // Darwin -E includes launch environments; -ww and a final command column
    // preserve the marker even for long CLI arguments. Never log this output:
    // it includes unrelated processes' environment values.
    const { stdout } = await promisify(execFile)('/bin/ps', ['-E', '-ww', '-ax', '-o', 'pid=,pgid=,stat=,command='], {
      env: inspectorEnvironment(), timeout: EXIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    })
    const members = stdout.trim().split('\n').flatMap((line) => {
      const [pid, group, state, ...command] = line.trim().split(/\s+/)
      return state && !/^[ZX]/.test(state) && !excludedGroups.has(Number(group)) && command.includes(marker) ? [Number(pid)] : []
    })
    return { members, failures: [] }
  }
  const failures = []
  const members = await inspectLinuxProcesses(async (entry) => {
    try {
      const directory = `/proc/${entry}`
      const uid = (await fs.stat(directory)).uid
      if (uid !== process.geteuid() && !ownership.known.has(Number(entry))) return undefined
      const observed = await readLinuxProcess(entry)
      if (observed.state === 'Z' || observed.state === 'X') {
        ownership.known.delete(observed.pid)
        return undefined
      }
      if (excludedGroups.has(observed.group)) return undefined
      const known = knownLinuxProcess(observed, ownership)
      if (uid !== process.geteuid() && !known) return undefined
      if (failedIdentities.get(observed.pid) === observed.startTime) return undefined
      let environment
      try { environment = await fs.readFile(`${directory}/environ`, 'utf8') } catch (error) {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error
        // A private unrelated service is not evidence about this fixture.
        // Retain unreadable processes only when identity, ancestry or private
        // cwd ties them to the fixture; normal orphaned children keep the tag.
        if (!await attributableLinuxProcess(observed, ownership)) return undefined
        try { environment = await readLinuxEnvironment(directory) } catch (failure) {
          if (failure.code !== 'EACCES' && failure.code !== 'EPERM') throw failure
          ownership.known.set(observed.pid, observed.startTime)
          failures.push({ pid: observed.pid, startTime: observed.startTime, error: failure })
          return undefined
        }
      }
      if (environment === undefined) {
        ownership.known.delete(observed.pid)
        return undefined
      }
      if (known || environment.split('\0').includes(marker)) {
        ownership.known.set(observed.pid, observed.startTime)
        return observed.pid
      }
      return undefined
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
      // Attributable unreadable environments remain a cleanup error.
      throw error
    }
  })
  return { members, failures }
}

function signalProcess(pid, signal) {
  try { process.kill(pid, signal) } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function stopTaggedProcesses(ownership, platform, excludedGroups) {
  const errors = []
  const refused = new Set()
  const failedIdentities = new Map()
  const membersForSignal = async () => {
    const scan = await liveTaggedProcesses(ownership, platform, excludedGroups, failedIdentities)
    for (const failure of scan.failures) {
      if (failedIdentities.get(failure.pid) === failure.startTime) continue
      failedIdentities.set(failure.pid, failure.startTime)
      errors.push(failure.error)
      log('error', 'fixture.detached_process.inspect_failed', { pid: failure.pid, code: failure.error?.code ?? null, message: String(failure.error?.message ?? failure.error) })
    }
    return scan.members.filter((pid) => !refused.has(pid))
  }
  try {
    signals: for (const signal of ['SIGTERM', 'SIGKILL']) {
      const deadline = Date.now() + EXIT_TIMEOUT_MS
      let members = await membersForSignal()
      if (members.length === 0) break
      log(signal === 'SIGTERM' ? 'info' : 'warn', 'fixture.detached_processes.stopping', { signal, members })
      while (true) {
        for (const pid of members) {
          try { signalProcess(pid, signal) } catch (error) {
            errors.push(error)
            // A refused signal remains an error; do not bypass it with KILL.
            refused.add(pid)
            const startTime = ownership.known.get(pid)
            if (startTime !== undefined) failedIdentities.set(pid, startTime)
            log('error', 'fixture.detached_process.stop_failed', { pid, code: error?.code ?? null, message: String(error?.message ?? error) })
          }
        }
        await delay(POLL_MS)
        members = await membersForSignal()
        if (members.length === 0) break signals
        if (Date.now() >= deadline) break
      }
      if (signal === 'SIGKILL') throw new Error(`owned fixture processes still alive after SIGKILL: ${members.join(', ')}`)
    }
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'fixture detached process cleanup failed')
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
export function createFixtureProcessOwner({ root, cwd = root } = {}) {
  const platform = process.platform
  const owner = randomUUID()
  const environment = Object.freeze(platform === 'win32' ? {} : { [OWNER_ENV]: owner })
  const groups = new Set()
  const ownership = { owner, root: root ? path.resolve(root) : undefined, groups, known: new Map() }
  const windowsSessions = new Set()
  let closing = false
  let launched = false
  return {
    environment,
    spawn(command, args, options = {}) {
      if (closing) throw new Error('cannot spawn a fixture process after cleanup has started')
      options = { ...options, cwd: options.cwd ?? cwd }
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
      const errors = []
      const excludedGroups = new Set()
      for (const session of windowsSessions) {
        try {
          await session.stop()
          windowsSessions.delete(session)
        } catch (error) {
          errors.push(error)
          log('error', 'fixture.job.stop_failed', { pid: session.child?.pid ?? null, message: String(error?.message ?? error) })
        }
      }
      for (const groupId of groups) {
        try {
          await stopGroup(groupId, platform)
          groups.delete(groupId)
        } catch (error) {
          errors.push(error)
          // Do not bypass a refused group signal with direct tagged-PID kills.
          excludedGroups.add(groupId)
          log('error', 'fixture.process_group.stop_failed', { groupId, code: error?.code ?? null, message: String(error?.message ?? error) })
        }
      }
      if (launched) {
        try {
          await stopTaggedProcesses(ownership, platform, excludedGroups)
          if (errors.length === 0) launched = false
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'fixture process cleanup failed')
    },
  }
}
