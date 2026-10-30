import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const EXIT_TIMEOUT_MS = 3_000
const POLL_MS = 25

const log = (severity, event, fields) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), severity, component: 'claude-fixture', event, ...fields })}\n`)
}

async function liveGroupMembers(groupId) {
  try { process.kill(-groupId, 0) } catch (error) {
    if (error.code === 'ESRCH') return []
    throw error
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

async function waitForGroupExit(groupId, signal) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  while (true) {
    const remaining = await liveGroupMembers(groupId)
    if (remaining.length === 0 || Date.now() >= deadline) return remaining
    // Recheck after SIGKILL too: a child already being forked at the first
    // signal must not escape settlement while its parent is being killed.
    if (signal === 'SIGKILL') signalGroup(groupId, signal)
    await delay(POLL_MS)
  }
}

async function stopGroup(groupId) {
  const members = await liveGroupMembers(groupId)
  if (members.length === 0) return
  log('info', 'fixture.process_group.stopping', { groupId, members })
  signalGroup(groupId, 'SIGTERM')
  if ((await waitForGroupExit(groupId, 'SIGTERM')).length === 0) return
  log('warn', 'fixture.process_group.force_stopping', { groupId })
  signalGroup(groupId, 'SIGKILL')
  const remaining = await waitForGroupExit(groupId, 'SIGKILL')
  if (remaining.length !== 0) {
    throw new Error(`owned fixture process group ${groupId} still has live members after SIGKILL: ${remaining.join(', ')}`)
  }
}

/** Own a separate Linux session for each fixture child and its native CLI. */
export function createFixtureProcessOwner() {
  const groups = new Set()
  let closing = false
  return {
    spawn(command, args, options = {}) {
      if (closing) throw new Error('cannot spawn a fixture process after cleanup has started')
      if (process.platform !== 'linux') throw new Error('Claude fixture process ownership requires Linux /proc')
      // Node establishes pgid = sid = child.pid before spawn returns. Ownership
      // is captured before any created frame or native-CLI initialization, and
      // survives an immediate sidecar exit without a PID-journal race.
      const child = spawn(command, args, { ...options, detached: true })
      if (child.pid !== undefined) groups.add(child.pid)
      return child
    },
    async stop() {
      closing = true
      for (const groupId of groups) {
        await stopGroup(groupId)
        groups.delete(groupId)
      }
    },
  }
}
