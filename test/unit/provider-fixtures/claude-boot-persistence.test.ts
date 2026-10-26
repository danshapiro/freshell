// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { pollTranscript, SCENARIOS } from '../../integration/providers/claude-cli-scenarios.mjs'

afterEach(() => { vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('keeps first-appearance timing but waits through partial and wrong-assistant disk rows before capturing the first turn', async () => {
  vi.useFakeTimers()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-boot-persistence-'))
  const file = path.join(root, 'session.jsonl')
  const partial = [{ type: 'user', uuid: 'u1' }, { type: 'attachment', uuid: 'attachment-1' }]
  const unrelated = { type: 'assistant', uuid: 'another-turn' }
  const expected = { type: 'assistant', uuid: 'first-turn-assistant' }
  const write = (rows: unknown[]) => fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  await write(partial)
  const boundary = deferred<string>()
  const thirdRead = deferred<void>()
  const observations: Record<string, any> = {}
  const trace = { add: vi.fn() }
  let reads = 0
  let startedSecondTurn = false
  const fixture = {
    async readTranscript() {
      const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      reads++
      if (reads === 2) boundary.resolve('waiting-for-assistant-persistence')
      if (reads === 3) thirdRead.resolve()
      return rows
    },
  }
  const session = {
    frames: [expected],
    init: async () => {}, call: async () => {},
    push(_text: string, label: string) {
      if (label === 'u2') { startedSecondTurn = true; boundary.resolve('started-second-turn-with-partial-history') }
    },
    waitForResults: async () => ({}), waitForCount: async () => ({}), close: async () => {},
    messages(predicate: (message: unknown) => boolean) { return this.frames.filter(predicate) },
  }
  const capturing = SCENARIOS.boot({
    uuid: () => 'session-X', open: () => session, files: async () => [],
    observe: (key: string, value: unknown) => { observations[key] = value },
    pollTranscript: (...args: any[]) => pollTranscript(fixture, trace, ...args),
    need(value: unknown, what: string) {
      if (!value) throw new Error(`scenario prerequisite missing: ${what}`)
      return value
    },
  })
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(await boundary.promise).toBe('waiting-for-assistant-persistence')
    expect(startedSecondTurn).toBe(false)
    await write([...partial, unrelated])
    await vi.advanceTimersByTimeAsync(50)
    await thirdRead.promise
    expect(startedSecondTurn).toBe(false)
    await write([...partial, unrelated, expected])
    await vi.advanceTimersByTimeAsync(50)
    await capturing
    expect(observations.transcriptAfterFirstResult).toEqual({
      // This still measures first file appearance, before the delayed assistant.
      msAfterResult: 0,
      shape: [...partial, unrelated, expected].map(row => ({ type: row.type, uuid: row.uuid, parentUuid: null })),
    })
    expect(startedSecondTurn).toBe(true)
  } finally {
    await write([...partial, expected])
    await vi.advanceTimersByTimeAsync(50)
    await capturing.finally(() => fs.rm(root, { recursive: true, force: true }))
  }
})

it('bounds a missing assistant persistence wait with a transcript-specific trace', async () => {
  vi.useFakeTimers()
  const trace = { add: vi.fn() }
  const fixture = { readTranscript: async () => [{ type: 'user', uuid: 'u1' }] }
  const waiting = pollTranscript(fixture, trace, 'session-X', 100, 1,
    (rows: any[]) => rows.some(row => row.type === 'assistant' && row.uuid === 'first-turn-assistant'))
  await vi.advanceTimersByTimeAsync(150)
  await expect(waiting).resolves.toBeNull()
  expect(trace.add).toHaveBeenLastCalledWith({ k: 'transcript-missing', id: 'session-X' })
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses a boot capture whose observed assistant never saves and identifies both native IDs', async () => {
  vi.useFakeTimers()
  const trace = { add: vi.fn() }
  const fixture = { readTranscript: async () => [{ type: 'user', uuid: 'u1' }] }
  const assistant = { type: 'assistant', uuid: 'first-turn-assistant' }
  const session = {
    frames: [assistant], init: async () => {}, call: async () => {}, push: vi.fn(),
    waitForResults: async () => ({}),
    messages: (predicate: (message: unknown) => boolean) => [assistant].filter(predicate),
  }
  const capturing = SCENARIOS.boot({
    uuid: () => 'session-X', open: () => session, files: async () => [], observe: () => {},
    pollTranscript: (...args: any[]) => pollTranscript(fixture, trace, ...args),
    need(value: unknown, what: string) {
      if (!value) throw new Error(`scenario prerequisite missing: ${what}`)
      return value
    },
  })
  const rejected = expect(capturing).rejects.toThrow('first-turn assistant first-turn-assistant saved for session session-X within 4000ms')
  rejected.catch(() => {})
  await vi.advanceTimersByTimeAsync(6050)
  await rejected
  expect(session.push).toHaveBeenCalledExactlyOnceWith('first prompt', 'u1')
  expect(trace.add).toHaveBeenLastCalledWith({ k: 'transcript-missing', id: 'session-X' })
  expect(vi.getTimerCount()).toBe(0)
})
