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
  let removedWhileWriterActive = false
  const remove = fs.rm
  const removal = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
    if (target === fixture.root && child.exitCode === null && child.signalCode === null) removedWhileWriterActive = true
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
    await finish(child, closed)
    await cleaning
    expect(removedWhileWriterActive, 'cleanup must not remove HOME while its owned writer is running').toBe(false)
    expect(report).toEqual({ written: true })
    expect(saved).toBe('saved')
    await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await finish(child, closed)
    try {
      await cleaning
      await fixture.cleanup()
    } finally { removal.mockRestore() }
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
