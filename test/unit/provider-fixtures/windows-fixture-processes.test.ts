// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { FixtureChild, createWindowsFixtureSession } from '../../support/windows-fixture-processes.mjs'

function fixtureChild(session?: ReturnType<typeof createWindowsFixtureSession>) {
  const streams = [new PassThrough(), new PassThrough(), new PassThrough()]
  const controller = Object.assign(new EventEmitter(), {
    pid: 8000,
    exitCode: null as number | null, signalCode: null,
    stdin: streams[0], stdout: streams[1], stderr: streams[2], stdio: streams,
  })
  const child = new FixtureChild(session ?? { controller }, controller, 'test-command', [])
  const events: string[] = []
  child.on('error', () => events.push('error'))
  child.on('exit', () => events.push('exit'))
  child.on('close', () => events.push('close'))
  return { child, streams, events, controller }
}

describe('Windows fixture child completion', () => {
  for (const rootExited of [false, true]) {
    it(`settles abrupt controller exit and stops polling with target exit ${rootExited ? 'confirmed' : 'unknown'}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-controller-failure-'))
      const session = createWindowsFixtureSession(root)
      const { child, streams, events, controller } = fixtureChild(session)
      session.controller = controller
      session.child = child
      const directory = fs.readdirSync(root).find((entry) => entry.startsWith('.process-job-'))!
      const statusFile = path.join(root, directory, 'status.json')
      fs.writeFileSync(statusFile, JSON.stringify({ pid: 1234, rootExited: false, settled: false }))
      session.refresh()
      session.watchController()
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        session.poll()
        if (rootExited) {
          for (const stream of streams) stream.destroy()
          await setImmediate()
          fs.writeFileSync(statusFile, JSON.stringify({ pid: 1234, rootExited: true, exitCode: 7, settled: false }))
        }
        controller.exitCode = 1
        controller.emit('exit', 1, null)
        streams[1]!.destroy()
        streams[2]!.destroy()
        await setImmediate()

        expect(events).toEqual(rootExited ? ['exit', 'error', 'close'] : ['error', 'close'])
        expect(child.exitCode).toBe(rootExited ? 7 : null)
        expect(child.signalCode).toBeNull()
        const refresh = vi.spyOn(session, 'refresh')
        vi.advanceTimersByTime(100)
        expect(refresh).not.toHaveBeenCalled()
        session.poll()
        vi.advanceTimersByTime(100)
        expect(refresh).not.toHaveBeenCalled()
        await expect(session.stop()).rejects.toThrow('fixture Job host exited without confirming its process tree')
        expect(fs.existsSync(root)).toBe(true)
      } finally {
        clearInterval(session.timer)
        vi.useRealTimers()
        for (const stream of streams) stream.destroy()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('closes after a terminal host error with a target PID without inventing its exit', async () => {
    const { child, streams, events } = fixtureChild()
    try {
      child.observe({ pid: 1234, error: 'Job assignment failed', errorCode: 'EACCES', rootExited: false, settled: false })
      expect(events).toEqual(['error'])

      streams[1]!.destroy()
      await setImmediate()
      expect(events).toEqual(['error'])
      streams[2]!.destroy()
      await setImmediate()

      expect(events).toEqual(['error', 'close'])
      expect(streams[0]!.destroyed).toBe(true)
      expect(child.pid).toBe(1234)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
    } finally {
      for (const stream of streams) stream.destroy()
    }
  })

  it('preserves a confirmed target exit while reporting a later terminal host error', async () => {
    const { child, streams, events } = fixtureChild()
    try {
      child.observe({ pid: 1234, rootExited: true, exitCode: 7, settled: false })
      child.observe({ pid: 1234, rootExited: true, exitCode: 7, settled: false, error: 'Job settlement failed' })
      for (const stream of streams) stream.destroy()
      await setImmediate()

      expect(events).toEqual(['exit', 'error', 'close'])
      expect(child.exitCode).toBe(7)
      expect(child.signalCode).toBeNull()
    } finally {
      for (const stream of streams) stream.destroy()
    }
  })

  it('emits a reported target exit before close when the terminal status arrives after pipe closure', async () => {
    const { child, streams, events } = fixtureChild()
    try {
      for (const stream of streams) stream.destroy()
      await setImmediate()
      child.observe({ pid: 1234, rootExited: true, exitCode: 7, settled: false, error: 'Job settlement failed' })

      expect(events).toEqual(['error', 'exit', 'close'])
      expect(child.exitCode).toBe(7)
    } finally {
      for (const stream of streams) stream.destroy()
    }
  })

  it('closes after a startup failure before any target PID exists', async () => {
    const { child, streams, events } = fixtureChild()
    try {
      child.observe({ error: 'executable missing', errorCode: 'ENOENT', rootExited: false, settled: true })
      for (const stream of streams) stream.destroy()
      await setImmediate()

      expect(events).toEqual(['error', 'close'])
      expect(child.exitCode).toBe(-1)
      expect(child.pid).toBeUndefined()
    } finally {
      for (const stream of streams) stream.destroy()
    }
  })
})
