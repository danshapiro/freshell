import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { stopFixtureProcess } from './stop-fixture-process.mjs'

const EXIT_TIMEOUT_MS = 3_000
const POLL_MS = 25

const log = (severity, event, fields) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), severity, component: 'claude-fixture', event, ...fields })}\n`)
}

async function liveGroupMembers(groupId, platform) {
  try { process.kill(-groupId, 0) } catch (error) {
    if (error.code === 'ESRCH') return []
    throw error
  }
  if (platform !== 'linux') {
    // Darwin's session field is not the numeric Linux SID. The PGID of our
    // detached child is sufficient, and ps exposes it on both POSIX systems.
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { timeout: EXIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
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

function signalGroup(groupId, signal) {
  try { process.kill(-groupId, signal) } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
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

function guardedNodeLaunch(args, options, root) {
  if (!root) throw new Error('a Windows Node fixture requires its owned root')
  const env = options.env ?? process.env
  if (env.NODE_OPTIONS || args.some((arg) => /^(?:--(?:require|import)(?:=|$)|-r)/.test(arg))) {
    throw new Error('fixture Node ownership requires its controlled entrypoint and environment')
  }
  const record = path.join(root, `.native-exit-${randomUUID()}.json`)
  return {
    record,
    args: ['--import', new URL('./fixture-native-exit-guard.mjs', import.meta.url).href, ...args],
    options: { ...options, env: { ...env, FRESHELL_FIXTURE_NATIVE_EXIT_RECORD: record } },
  }
}

async function stopWindowsChild(child, record) {
  await stopFixtureProcess(child)
  if (!record || child.pid === undefined) return
  let evidence
  try { evidence = JSON.parse(await fs.readFile(record, 'utf8')) } catch (error) {
    throw new Error(`unconfirmed native process exit for fixture child ${child.pid}`, { cause: error })
  }
  if (evidence.pid !== child.pid || evidence.state !== 'complete') {
    throw new Error(`unconfirmed native process exit for fixture child ${child.pid}`)
  }
}

/**
 * POSIX children own detached process groups. Windows keeps the original
 * ChildProcess/PID and, for Node sidecars, observes the SDK child's actual
 * exit before allowing the sidecar to exit. Unconfirmed exits retain files.
 */
export function createFixtureProcessOwner({ platform = process.platform, root } = {}) {
  const groups = new Set()
  const windowsChildren = new Map()
  let closing = false
  return {
    spawn(command, args, options = {}) {
      if (closing) throw new Error('cannot spawn a fixture process after cleanup has started')
      if (platform === 'win32') {
        const isNode = command === process.execPath || /(?:^|[\\/])node(?:\.exe)?$/i.test(command)
        const launch = isNode ? guardedNodeLaunch(args, options, root) : { args, options }
        const child = spawn(command, launch.args, { ...launch.options, detached: false })
        windowsChildren.set(child, launch.record)
        return child
      }
      // Node establishes pgid = sid = child.pid before spawn returns. Ownership
      // is captured before any created frame or native-CLI initialization, and
      // survives an immediate sidecar exit without a PID-journal race.
      const child = spawn(command, args, { ...options, detached: true })
      if (child.pid !== undefined) groups.add(child.pid)
      return child
    },
    async stop() {
      closing = true
      for (const [child, record] of windowsChildren) {
        await stopWindowsChild(child, record)
        windowsChildren.delete(child)
      }
      for (const groupId of groups) {
        await stopGroup(groupId, platform)
        groups.delete(groupId)
      }
    },
  }
}
