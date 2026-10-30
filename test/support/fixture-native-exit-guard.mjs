// Test-only Windows sidecar preload. Observe the SDK's raw native child and
// defer process.exit until that child has actually exited. It sends no signals
// and cannot repair a broken production shutdown or make its contract pass.
import childProcess from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const recordPath = process.env.FRESHELL_FIXTURE_NATIVE_EXIT_RECORD
if (!recordPath) throw new Error('fixture native exit record is required')
const originalSpawn = childProcess.spawn
const originalExit = process.exit.bind(process)
const children = new Set()
let exiting = false

const exited = (child) => child.exitCode !== null || child.signalCode !== null
const record = (state) => writeFileSync(recordPath, JSON.stringify({ pid: process.pid, state }))

childProcess.spawn = function (...args) {
  if (exiting) throw new Error('cannot spawn a native child after fixture exit has started')
  const child = originalSpawn.apply(this, args)
  if (child.pid !== undefined && !exited(child)) {
    children.add(child)
    // An AbortError is not an exit; only the exit event releases ownership.
    child.once('exit', () => children.delete(child))
  }
  return child
}
syncBuiltinESMExports()
record('started')

async function finishExit(code) {
  const deadline = Date.now() + 5_000
  while (children.size !== 0) {
    for (const child of children) if (exited(child)) children.delete(child)
    if (children.size === 0) break
    if (Date.now() >= deadline) {
      process.stderr.write(`${JSON.stringify({ severity: 'error', component: 'claude-fixture', event: 'fixture.native_exit.unconfirmed', pid: process.pid, children: [...children].map((child) => child.pid) })}\n`)
      originalExit(Number(code) || 1)
    }
    await delay(10)
  }
  record('complete')
  originalExit(code)
}

function requestExit(code = process.exitCode ?? 0) {
  if (exiting) return
  exiting = true
  void finishExit(code).catch((error) => {
    process.stderr.write(`${JSON.stringify({ severity: 'error', component: 'claude-fixture', event: 'fixture.native_exit.failed', pid: process.pid, message: String(error?.message ?? error) })}\n`)
    originalExit(1)
  })
}

process.exit = requestExit
process.once('beforeExit', requestExit)
