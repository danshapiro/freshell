// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }))
import { NativeClient } from '../../integration/providers/codex-cli-contract.mjs'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((signal: string) => {
      setTimeout(() => { child.signalCode = signal; child.emit('exit', null, signal) }, 0)
      return true
    }),
  })
  spawn.mockReturnValue(child)
  const capture: any = { probeOnly: true, environment: {}, observations: {}, frames: [], responses: [], notifications: [] }
  const native = new NativeClient('/owned/launcher', { workspace: '/owned/workspace', environment: {} }, capture)
  return { child, native, capture }
}

it('waits beyond launcher exit for inherited native stdio to close, preserving final frames', async () => {
  vi.useFakeTimers()
  const { child, native, capture } = fixture()
  let settled = false
  const closing = native.close().then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(child.signalCode).toBe('SIGTERM')
  expect(settled).toBe(false)

  child.stdout.write(`${JSON.stringify({ method: 'native/final-frame', params: {} })}\n`)
  child.stderr.write('final native shutdown diagnostic')
  child.stdout.end(); child.stderr.end()
  child.emit('close', null, 'SIGTERM')
  await closing
  expect(capture.notifications).toEqual([{ method: 'native/final-frame', params: {} }])
  expect(capture.stderr).toBe('final native shutdown diagnostic')
  expect(capture.processCloses).toEqual([{ connectionId: 0, pid: child.pid, code: null, signal: 'SIGTERM' }])
  expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  expect(vi.getTimerCount()).toBe(0)
})

it('fails within a bounded deadline when an exited launcher leaves native stdio open', async () => {
  vi.useFakeTimers()
  const { child, native } = fixture()
  const closing = native.close()
  const rejected = expect(closing).rejects.toThrow(/owned process stdio close.*12345/)
  rejected.catch(() => {})
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  child.stdout.end(); child.stderr.end(); child.emit('close', null, 'SIGTERM')
  expect(vi.getTimerCount()).toBe(0)
})
