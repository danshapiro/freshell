// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeFixture } from '../../integration/providers/claude-local-provider.mjs'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

// An ordinary owned writer, stopped by IPC rather than signals. This exercises
// the same HOME ownership as a native CLI running under a separate sidecar.
const writer = `
  const fs = require('node:fs/promises')
  const path = require('node:path')
  process.on('message', async message => {
    if (message === 'finish') return process.disconnect()
    if (message !== 'write') return
    try {
      await fs.writeFile(path.join(process.env.HOME, 'last-native-write'), 'saved')
      process.send({ written: true })
    } catch (error) { process.send({ written: false, code: error.code }) }
  })
  process.send({ ready: true })
`

async function finish(child: ChildProcess, closed: Promise<unknown>) {
  if (child.connected) child.send('finish')
  await closed
}

it.each(['child', 'native-pid'] as const)('retains HOME until an explicitly owned %s finishes its final write and exits', async ownership => {
  const fixture = await createClaudeFixture({ prefix: 'claude-fixture-cleanup-' })
  const child = spawn(process.execPath, ['-e', writer], {
    env: fixture.env('http://127.0.0.1:9'),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const closed = once(child, 'close')
  await once(child, 'message')
  if (ownership === 'child') fixture.ownProcess(child)
  else await fixture.ownProcessId(child.pid!)
  let writerReleased = false
  let removedBeforeWriterRelease = false
  const remove = fs.rm
  const removal = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    if (target === fixture.root && !writerReleased) removedBeforeWriterRelease = true
    return remove(target, options)
  })
  const cleaning = fixture.cleanup()
  try {
    // A final write after teardown begins must still have its owned HOME.
    // The IPC acknowledgement establishes the schedule without a sleep.
    const written = once(child, 'message')
    child.send('write')
    const report = (await written)[0]
    const saved = report.written ? await fs.readFile(path.join(fixture.home, 'last-native-write'), 'utf8') : null
    expect(report).toEqual({ written: true })
    expect(saved).toBe('saved')
    writerReleased = true
    await finish(child, closed)
    await cleaning
    expect(removedBeforeWriterRelease, 'cleanup must not remove HOME before its owned writer is released').toBe(false)
    await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    writerReleased = true
    await finish(child, closed)
    try {
      await cleaning
      await fixture.cleanup()
    } finally { removal.mockRestore() }
  }
})

it('retains HOME while a native PID is live and releases it when the same identity becomes a zombie', async () => {
  const fixture = await createClaudeFixture({ prefix: 'claude-fixture-native-boundary-' })
  const pid = 456789
  const procStat = `/proc/${pid}/stat`
  let state: 'S' | 'Z' = 'S'
  let observingCleanup = false
  let observeBoundary!: (kind: 'poll' | 'removed' | 'settled') => void
  const boundary = new Promise<'poll' | 'removed' | 'settled'>(resolve => { observeBoundary = resolve })
  const read = fs.readFile
  vi.spyOn(fs, 'readFile').mockImplementation(async (target, options) => {
    if (target !== procStat) return read(target, options)
    if (observingCleanup) observeBoundary('poll')
    // Linux stat field 3 is state; field 22 is the captured start time.
    return `${pid} (held native writer) ${[state, ...Array(18).fill('0'), '424242', '0'].join(' ')}\n`
  })
  await fixture.ownProcessId(pid)
  let removedWhileIdentityLive = false
  const remove = fs.rm
  vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    if (target === fixture.root) {
      removedWhileIdentityLive ||= state === 'S'
      observeBoundary('removed')
    }
    return remove(target, options)
  })
  vi.useFakeTimers()
  observingCleanup = true
  let cleanupSettled = false
  const cleaning = fixture.cleanup().finally(() => {
    cleanupSettled = true
    observeBoundary('settled')
  })
  try {
    // Account for early removal/settlement too: an omitted native wait must
    // fail on actual HOME deletion rather than hang waiting for a missing poll.
    const observed = await boundary
    await vi.advanceTimersByTimeAsync(0)
    if (observed !== 'poll') await cleaning
    expect((await fs.stat(fixture.home)).isDirectory()).toBe(true)
    expect(cleanupSettled, 'cleanup must remain pending while the captured native identity is live').toBe(false)
    expect(removedWhileIdentityLive).toBe(false)
    const finalWrite = path.join(fixture.home, 'last-native-write')
    await fs.writeFile(finalWrite, 'saved while live')
    expect(await fs.readFile(finalWrite, 'utf8')).toBe('saved while live')

    // No Node exit/close event is available for this separately owned PID.
    // Only its kernel state changes; the captured start time stays identical.
    state = 'Z'
    await vi.advanceTimersByTimeAsync(10)
    await cleaning
    expect(removedWhileIdentityLive).toBe(false)
    await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    state = 'Z'
    await vi.advanceTimersByTimeAsync(10)
    try { await cleaning } finally { await fixture.cleanup() }
  }
})

it('joins inherited stdio close after sidecar exit before removing its fixture', async () => {
  const fixture = await createClaudeFixture({ prefix: 'claude-fixture-pipe-close-' })
  const sidecar = Object.assign(new EventEmitter(), { pid: 12345 })
  fixture.ownProcess(sidecar)
  const cleaning = fixture.cleanup()
  try {
    sidecar.emit('exit', 0, null)
    // A descendant still holding the pipes may write after the sidecar exits.
    await fs.writeFile(path.join(fixture.home, 'inherited-writer'), 'final')
    expect(await fs.readFile(path.join(fixture.home, 'inherited-writer'), 'utf8')).toBe('final')
  } finally {
    sidecar.emit('close', 0, null)
    await cleaning
  }
  await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('bounds a missing owner close and retains HOME for diagnosis instead of deleting active state', async () => {
  const fixture = await createClaudeFixture({ prefix: 'claude-fixture-missing-close-' })
  const sidecar = Object.assign(new EventEmitter(), { pid: 12345 })
  fixture.ownProcess(sidecar)
  vi.useFakeTimers()
  const cleaning = fixture.cleanup()
  const failure = cleaning.catch(error => error)
  await vi.advanceTimersByTimeAsync(5_000)
  const error = await failure
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.message).toContain('Claude fixture process cleanup incomplete; retained')
  expect(error.errors[0].message).toContain('fixture-owned process 12345 did not settle within 5000ms')
  expect((await fs.stat(fixture.home)).isDirectory()).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  sidecar.emit('close', 0, null)
  await fixture.cleanup()
  expect(vi.getTimerCount()).toBe(0)
})
