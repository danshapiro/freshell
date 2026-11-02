// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

import { cleanupManagedCodexParity, createManagedCodexFixtureWork, readManagedCodexFixtureTraffic } from '../../helpers/codex-managed-cleanup.js'
import { startInManagedContext } from '../../integration/providers/codex-local-provider.mjs'

const CONTAINER = 'a'.repeat(64)
const PID = 24680

async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function nestedErrors(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || value === undefined || seen.has(value)) return []
  seen.add(value)
  if (typeof value !== 'object') return [value]
  const error = value as { cause?: unknown; errors?: unknown[] }
  return [value, ...nestedErrors(error.cause, seen), ...(error.errors ?? []).flatMap(item => nestedErrors(item, seen))]
}

/** The owned exec boundary runs only against these inert, in-memory objects. */
function virtualOwnedRig({ runChild = false, pauseChildStartup = false } = {}) {
  const files = new Map<string, string>()
  const signals: Array<{ pid: number; signal: string; target: 'fixture' | 'replacement' }> = []
  const spawned: Array<{ pid: number }> = []
  const childErrors: unknown[] = []
  const calls: Array<{
    args: string[]
    resolve: (value: string) => void
    reject: (error: Error) => void
    pending: boolean
  }> = []
  let directory = ''
  let running = true
  let inspectionError: Error | undefined
  let incarnation: 'fixture' | 'replacement' = 'fixture'
  let childHandler: ((record: unknown, context: unknown) => Promise<unknown>) | undefined
  let resumeChildStartup!: () => void
  const childStartup = new Promise<void>(resolve => { resumeChildStartup = resolve })
  let readinessWriteObserver: (() => void) | undefined
  let trafficAppendObserver: (() => void) | undefined
  const childTimers = new Set<ReturnType<typeof setInterval>>()
  const handlers = new Map<string, () => unknown>()
  let resolveClose!: () => void
  const close = new Promise<void>(resolve => { resolveClose = resolve })
  const stopTimers = () => {
    for (const timer of childTimers) clearInterval(timer)
    childTimers.clear()
  }
  const signal = (pid: number, name: string) => {
    signals.push({ pid, signal: name, target: incarnation })
    if (pid === PID && incarnation === 'fixture') {
      const handler = handlers.get(name)
      handlers.delete(name)
      if (handler) void Promise.resolve().then(handler).catch(error => { childErrors.push(error) })
    }
    return true
  }
  const fs = {
    mkdirSync(target: string) { directory = String(target) },
    openSync(target: string) { files.set(String(target), ''); return 7 },
    writeFileSync(target: string, data: unknown) {
      const file = String(target)
      const text = String(data)
      let isReadinessRecord = false
      try {
        const record = JSON.parse(text)
        isReadinessRecord = typeof record?.baseUrl === 'string' && Number.isSafeInteger(record?.pid)
      } catch { /* Other fixture files are not readiness records. */ }
      if (isReadinessRecord && readinessWriteObserver) {
        // Opening the writer exposes an empty file before its bytes are written.
        // A separate provider exec can read in precisely that interval.
        files.set(file, '')
        const observe = readinessWriteObserver
        readinessWriteObserver = undefined
        observe()
      }
      files.set(file, text)
    },
    renameSync(source: string, destination: string) {
      const value = files.get(String(source))
      if (value === undefined) throw Object.assign(new Error('virtual file missing'), { code: 'ENOENT' })
      files.delete(String(source))
      files.set(String(destination), value)
    },
    appendFileSync(target: string, data: unknown) {
      const file = String(target)
      const before = files.get(file) ?? ''
      const text = String(data)
      if (trafficAppendObserver) {
        // Allow the generated reader to execute after a partial append and
        // before the writer publishes the remainder, including its newline.
        const split = Math.floor(text.length / 2)
        files.set(file, before + text.slice(0, split))
        const observe = trafficAppendObserver
        trafficAppendObserver = undefined
        observe()
      }
      files.set(file, before + text)
    },
    readFileSync(target: string) {
      const value = files.get(String(target))
      if (value === undefined) throw Object.assign(new Error('virtual file missing'), { code: 'ENOENT' })
      return value
    },
    existsSync(target: string) { return files.has(String(target)) },
  }
  const childProcessObject = {
    pid: PID, version: 'v-test',
    getuid: () => 65534, getgid: () => 0,
    once(name: string, handler: () => unknown) { handlers.set(name, handler) },
    kill: signal,
    exit() { stopTimers() },
  }
  const childProcess = {
    spawn(_executable: string, args: string[]) {
      spawned.push({ pid: PID })
      if (runChild) {
        expect(args.slice(0, 2)).toEqual(['--input-type=module', '-e'])
        const code = args[2]
          .replace("import fs from 'node:fs';", "const fs = require('node:fs');")
          .replace(/await import\("data:text\/javascript;base64,[A-Za-z0-9+/=]+"\)/, 'await importFixture()')
        expect(code).not.toContain("import fs from 'node:fs'")
        expect(code).not.toContain('await import(')
        const imported = async () => ({
          createCodexLocalProvider: async (handler: typeof childHandler) => {
            childHandler = handler
            if (pauseChildStartup) await childStartup
            return { baseUrl: 'http://127.0.0.1:51991/v1', close: () => close }
          },
        })
        const childPromise = runInNewContext(`(async () => { ${code} })()`, {
          require: (name: string) => {
            if (name === 'node:fs') return fs
            throw new Error(`unexpected child module: ${name}`)
          },
          importFixture: imported,
          process: childProcessObject,
          setInterval: (callback: () => void, ms: number) => {
            const timer = setInterval(callback, ms)
            childTimers.add(timer)
            return timer
          },
          clearInterval: (timer: ReturnType<typeof setInterval>) => { clearInterval(timer); childTimers.delete(timer) },
        }, { timeout: 500 }) as Promise<void>
        void childPromise.catch(error => { childErrors.push(error) })
      }
      return { pid: PID, unref() {} }
    },
  }

  function evaluate(args: string[]) {
    if (args[0] === 'cat' && args.length === 2) return fs.readFileSync(args[1])
    if (args.length !== 3 || args[0] !== 'node' || args[1] !== '-e') {
      throw new Error('unexpected virtual owned command')
    }
    let output = ''
    const process = {
      execPath: '/virtual/node',
      stdout: { write(value: unknown) { output += String(value); return true } },
      kill: signal,
    }
    const require = (name: string) => {
      if (name === 'node:fs') return fs
      if (name === 'node:child_process') return childProcess
      throw new Error(`unexpected virtual module: ${name}`)
    }
    runInNewContext(args[2], { require, process }, { timeout: 500 })
    return output
  }

  function ownedProviderExec(containerId: string, args: string[]) {
    expect(containerId).toBe(CONTAINER)
    return new Promise<string>((resolve, reject) => {
      calls.push({ args, resolve, reject, pending: true })
    })
  }

  async function release(index: number) {
    await flushMicrotasks()
    const call = calls[index]
    expect(call, `missing owned exec ${index}`).toBeDefined()
    expect(call.pending, `owned exec ${index} already settled`).toBe(true)
    call.pending = false
    try { call.resolve(evaluate(call.args)) } catch (error) { call.reject(error as Error) }
    await flushMicrotasks()
  }

  async function reject(index: number, error: Error, afterExecuting = false) {
    await flushMicrotasks()
    const call = calls[index]
    expect(call, `missing owned exec ${index}`).toBeDefined()
    expect(call.pending).toBe(true)
    call.pending = false
    if (afterExecuting) evaluate(call.args)
    call.reject(error)
    await flushMicrotasks()
  }

  async function dispose() {
    resumeChildStartup()
    resolveClose()
    // A failed startup can begin a new cleanup probe after the previous one
    // settles. Drain those virtual calls without executing their commands.
    for (let round = 0; round < 4; round++) {
      for (const call of calls) if (call.pending) { call.pending = false; call.resolve('null') }
      await flushMicrotasks()
    }
    stopTimers()
    vi.clearAllTimers()
    vi.useRealTimers()
  }

  function readDuringWrite(index: number) {
    let observed: string | undefined
    const observe = () => {
      const call = calls[index]
      expect(call, `missing owned exec ${index}`).toBeDefined()
      expect(call.pending, `owned exec ${index} already settled`).toBe(true)
      call.pending = false
      try {
        observed = evaluate(call.args)
        call.resolve(observed)
      } catch (error) { call.reject(error as Error) }
    }
    return { observe, result: () => observed }
  }

  function observeReadDuringReadinessWrite(index: number) {
    const read = readDuringWrite(index)
    readinessWriteObserver = read.observe
    return read.result
  }

  function observeReadDuringTrafficAppend(index: number) {
    const read = readDuringWrite(index)
    trafficAppendObserver = read.observe
    return read.result
  }

  return {
    rig: { ownedProviderExec, ownedContainerRunning: vi.fn(async (id: string) => {
      expect(id).toBe(CONTAINER)
      if (inspectionError) throw inspectionError
      return running
    }), runtime: { isContainerRunning: vi.fn((_id: string, _required: boolean) => {
      if (inspectionError) throw inspectionError
      return running
    }) } },
    calls, files, signals, spawned, childErrors, release, reject, dispose, resolveClose,
    resumeChildStartup, observeReadDuringReadinessWrite, observeReadDuringTrafficAppend,
    setRunning: (value: boolean) => { running = value },
    failInspection: (error: Error) => { inspectionError = error },
    replaceFixture: () => { stopTimers(); incarnation = 'replacement' },
    request: async (record: unknown) => {
      expect(childHandler).toBeDefined()
      return childHandler!(record, {})
    },
    directory: () => directory,
  }
}

type Harness = ReturnType<typeof virtualOwnedRig>

function begin(h: Harness, signal?: AbortSignal) {
  const started = startInManagedContext(h.rig, {
    containerId: CONTAINER,
    handlerSource: '() => ({ text: "ok" })',
    ...(signal ? { signal } : {}),
  })
  // The result is observed even if an earlier assertion fails. An ignored
  // owned-exec rejection is intentionally *not* given a blanket observer.
  void started.catch(() => {})
  return started
}

async function startReady(h: Harness) {
  const ready = { baseUrl: 'http://127.0.0.1:51991/v1', uid: 65534, gid: 0, pid: PID, node: 'v-test' }
  const started = begin(h)
  await flushMicrotasks()
  expect(h.calls).toHaveLength(1)
  expect(h.spawned).toEqual([])
  await h.release(0)
  expect(h.spawned).toEqual([{ pid: PID }])
  await h.release(1) // The generated readiness probe reads a missing file as null.
  await vi.advanceTimersByTimeAsync(50)
  expect(h.calls).toHaveLength(3)
  h.files.set(`${h.directory()}/ready.json`, JSON.stringify(ready))
  await h.release(2)
  const model = await started
  expect(model.baseUrl).toBe(ready.baseUrl)
  expect(model.context).toEqual(ready)
  expect(h.calls.some(call => call.args[0] === 'cat')).toBe(false)
  return model
}

async function startRunningChild(h: Harness) {
  const started = begin(h)
  await h.release(0)
  await h.release(1)
  const model = await started
  expect(model.context).toMatchObject({ uid: 65534, gid: 0, pid: PID })
  expect(h.childErrors).toEqual([])
  return model
}

it('waits for the owned launch before probing and retries readiness', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig()
  try { await startReady(h) } finally { await h.dispose() }
})

it('awaits readiness output instead of parsing its unresolved promise', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig()
  try {
    const started = begin(h)
    let outcome: unknown
    void started.then(value => { outcome = value }, error => { outcome = error })
    await h.release(0)
    expect(outcome).toBeUndefined()
    expect(h.calls).toHaveLength(2)
    const ready = { baseUrl: 'http://127.0.0.1:51991/v1', uid: 65534, gid: 0, pid: PID, node: 'v-test' }
    h.files.set(`${h.directory()}/ready.json`, JSON.stringify(ready))
    await h.release(1)
    expect((await started).context).toEqual(ready)
  } finally { await h.dispose() }
})

it('does not expose an incomplete readiness record to a concurrent provider probe', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true, pauseChildStartup: true })
  try {
    const started = begin(h)
    await h.release(0)
    expect(h.calls).toHaveLength(2)
    const duringWrite = h.observeReadDuringReadinessWrite(1)
    h.resumeChildStartup()
    await flushMicrotasks()

    // This is the generated owned readiness probe's actual result while the
    // fixture is opening its record, not a simulated parse of test data.
    expect(duringWrite()).toBe('null')
    await vi.advanceTimersByTimeAsync(50)
    expect(h.calls).toHaveLength(3)
    await h.release(2)
    expect((await started).context).toMatchObject({ uid: 65534, gid: 0, pid: PID })
    expect(h.childErrors).toEqual([])
  } finally { await h.dispose() }
})

it('reads ordered JSONL traffic and handles empty and missing files', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig()
  try {
    const model = await startReady(h)
    const rows = [
      { index: 0, method: 'POST', path: '/v1/responses', body: { content: 'first\nsecond' } },
      { index: 1, method: 'POST', path: '/v1/responses', body: { model: 'fixture-model', input: [] } },
    ]
    const trafficPath = `${h.directory()}/traffic.jsonl`
    h.files.set(trafficPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    let index = h.calls.length
    let settled = false
    const traffic = model.traffic()
    void traffic.then(() => { settled = true }, () => { settled = true })
    await flushMicrotasks()
    expect(settled).toBe(false)
    await h.release(index)
    expect(await traffic).toEqual(rows)

    h.files.set(trafficPath, '')
    index = h.calls.length
    const empty = model.traffic()
    await h.release(index)
    expect(await empty).toEqual([])
    h.files.delete(trafficPath)
    index = h.calls.length
    const missing = model.traffic()
    await h.release(index)
    expect(await missing).toEqual([])
  } finally { await h.dispose() }
})

it('propagates malformed traffic and asynchronous read failures', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig()
  try {
    const model = await startReady(h)
    h.files.set(`${h.directory()}/traffic.jsonl`, '{"index":0}\nnot-json\n')
    let index = h.calls.length
    const malformed = expect(model.traffic()).rejects.toThrow()
    await h.release(index)
    await malformed

    index = h.calls.length
    const failure = new Error('owned traffic read failed')
    const readFailure = model.traffic().then(() => undefined, (error: unknown) => error)
    await h.reject(index, failure)
    expect(nestedErrors(await readFailure)).toContain(failure)
  } finally { await h.dispose() }
})

it('returns the traffic recorded by the actual child handler in order', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const model = await startRunningChild(h)
    const rows = [
      { index: 0, path: '/v1/responses', body: { input: 'first\nsecond' } },
      { index: 1, path: '/v1/responses', body: { input: 'third' } },
    ]
    await h.request(rows[0])
    await h.request(rows[1])
    const index = h.calls.length
    const traffic = model.traffic()
    await h.release(index)
    expect(await traffic).toEqual(rows)
    expect(h.childErrors).toEqual([])
  } finally { await h.dispose() }
})

it('reads only complete traffic records during an actual generated append', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const model = await startRunningChild(h)
    const first = { index: 0, path: '/v1/responses', body: { input: 'first' } }
    const second = { index: 1, path: '/v1/responses', body: { input: 'second' } }
    await h.request(first)

    const index = h.calls.length
    const during = model.traffic().then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
    const snapshot = h.observeReadDuringTrafficAppend(index)
    await h.request(second)
    expect(snapshot()).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second).slice(0, Math.floor((JSON.stringify(second).length + 1) / 2))}`)
    expect(await during).toEqual({ value: [first] })

    const after = model.traffic()
    await h.release(h.calls.length - 1)
    expect(await after).toEqual([first, second])
    expect(h.childErrors).toEqual([])
  } finally { await h.dispose() }
})

it('waits for the owned signal and a later closed marker', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const model = await startRunningChild(h)
    let index = h.calls.length
    let settled = false
    const stopping = model.stop()
    void stopping.then(() => { settled = true }, () => { settled = true })
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(h.calls).toHaveLength(index + 1)
    await h.release(index++)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.signals).toEqual([{ pid: PID, signal: 'SIGTERM', target: 'fixture' }])
    expect(settled).toBe(false)
    await h.release(index++) // The actual child close remains pending.
    h.resolveClose()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false)
    await h.release(index)
    await stopping
    expect(settled).toBe(true)
    expect(h.childErrors).toEqual([])
  } finally { await h.dispose() }
})

it('does not start a closed-state probe after fixture-stop cancellation', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const model = await startRunningChild(h)
    const index = h.calls.length
    const controller = new AbortController()
    const reason = new Error('fixture stop cancelled by runtime owner')
    const observed = model.stop(controller.signal).then(() => undefined, (error: unknown) => error)
    await flushMicrotasks()
    expect(h.calls).toHaveLength(index + 1)
    controller.abort(reason)
    // The in-flight stop request can complete normally even after cancellation.
    await h.release(index)
    expect(h.calls).toHaveLength(index + 1)
    expect(await observed).toBe(reason)
  } finally { await h.dispose() }
})

it('settles cleanup within the hook after a finite slow fixture inspection', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig()
  try {
    const model = await startReady(h)
    h.rig.runtime.isContainerRunning.mockImplementation(() => {
      // A finite daemon response can still consume four times the intended
      // handoff grace period while the event loop is blocked.
      vi.setSystemTime(Date.now() + 120_000)
      return false
    })
    const cancelled = new Error('owned fixture inspection cancelled')
    let cancelInspection!: () => void
    let inspectionSettled = false
    h.rig.ownedContainerRunning.mockImplementation(() => new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), 120_000)
      cancelInspection = () => { clearTimeout(timer); reject(cancelled) }
    }).finally(() => { inspectionSettled = true }))
    let ownerSettled = false
    let cleanupFinishedAt: number | undefined
    const owner = {
      runtime: { writeIncident: vi.fn() },
      stop: vi.fn(async () => {
        cancelInspection?.()
        for (const call of h.calls) if (call.pending) {
          call.pending = false
          call.reject(cancelled)
        }
        // A separately bounded owner can still need a native capture, broker
        // drain and three successful 100-second volume operations.
        vi.setSystemTime(Date.now() + 120_000 + 90_000 + 3 * 100_000)
        ownerSettled = true
        return { ok: true, errors: [] }
      }),
    }
    const dependencies = {
      captureVolumes: vi.fn(() => []),
      removeVolumes: vi.fn(() => []),
      removeDirectory: vi.fn(),
    }
    const startedAt = Date.now()
    const observed = cleanupManagedCodexParity({
      rig: owner, owners: [], wire: undefined, model, finalObservation: undefined,
      naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: undefined,
    }, dependencies).then(
      () => { cleanupFinishedAt = Date.now(); return undefined },
      error => { cleanupFinishedAt = Date.now(); return error },
    )
    await flushMicrotasks()
    if (!owner.stop.mock.calls.length) await vi.advanceTimersByTimeAsync(30_000)
    const result = await observed
    expect(cleanupFinishedAt).toBeDefined()
    expect(cleanupFinishedAt! - startedAt).toBeLessThanOrEqual(600_000)
    expect(ownerSettled).toBe(true)
    expect(inspectionSettled).toBe(true)
    expect(nestedErrors(result)).toContain(cancelled)
    expect(h.calls.filter(call => call.pending)).toEqual([])
  } finally { await h.dispose() }
})

it.each([
  ['startup', 'success'], ['startup', 'ready'], ['startup', 'failure'],
  ['restart startup', 'success'], ['restart startup', 'ready'], ['restart startup', 'failure'],
  ['fixture stop', 'success'], ['fixture stop', 'failure'],
])('joins in-flight %s and fences its late %s when teardown starts', async (stage, outcome) => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  const fixtureWork = createManagedCodexFixtureWork()
  let fixtureSignal!: AbortSignal
  const failure = new Error('in-flight fixture operation failed')
  let releaseOwner!: () => void
  const ownerFinish = new Promise<void>(resolve => { releaseOwner = resolve })
  try {
    let model: Awaited<ReturnType<typeof startInManagedContext>> | undefined
    if (stage !== 'startup') model = await startRunningChild(h)
    if (stage === 'restart startup') {
      // This is the same stop-then-start sequence used by the managed test.
      const stopIndex = h.calls.length
      const previousStop = model!.stop()
      await h.release(stopIndex)
      await vi.advanceTimersByTimeAsync(50)
      h.resolveClose()
      await flushMicrotasks()
      await h.release(stopIndex + 1)
      await previousStop
      model = undefined
    }

    let operation: Promise<unknown>
    if (stage === 'fixture stop') {
      operation = fixtureWork.run(signal => { fixtureSignal = signal; return model!.stop(signal) })
      await flushMicrotasks()
    } else {
      const launchIndex = h.calls.length
      operation = fixtureWork.run(signal => { fixtureSignal = signal; return begin(h, signal) })
      await h.release(launchIndex)
      // A null result can continue polling after the owner has taken its
      // snapshot; a complete result can assign a new model after teardown.
      if (outcome !== 'ready') h.files.delete(`${h.directory()}/ready.json`)
    }
    let operationSettled = false
    let operationValue: unknown
    let operationError: unknown
    void operation.then(
      value => { operationSettled = true; operationValue = value },
      error => { operationSettled = true; operationError = error },
    )
    const pendingIndex = h.calls.length - 1
    const callsBeforeTeardown = h.calls.length
    expect(h.calls[pendingIndex].pending).toBe(true)
    const owner = {
      runtime: { writeIncident: vi.fn() },
      stop: vi.fn(async () => {
        // Settle any duplicate cleanup probe, while leaving the test body's
        // original in-flight operation under explicit test control.
        for (const call of h.calls.slice(callsBeforeTeardown)) if (call.pending) {
          call.pending = false
          call.reject(new Error('duplicate fixture cleanup probe cancelled'))
        }
        await ownerFinish
        return { ok: true, errors: [] }
      }),
    }
    const dependencies = {
      captureVolumes: vi.fn(() => []),
      removeVolumes: vi.fn(() => []),
      removeDirectory: vi.fn(),
    }
    let cleanupSettled = false
    const cleanupInputs = {
      rig: owner, owners: [], wire: undefined, model, fixtureWork, finalObservation: undefined,
      naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: undefined,
    }
    const cleanup = cleanupManagedCodexParity(cleanupInputs, dependencies).then(
      () => { cleanupSettled = true; return undefined },
      error => { cleanupSettled = true; return error },
    )
    await flushMicrotasks()
    if (!owner.stop.mock.calls.length) await vi.advanceTimersByTimeAsync(30_000)
    expect(owner.stop).toHaveBeenCalledOnce()
    releaseOwner()
    await flushMicrotasks()
    const settledBeforeOperation = cleanupSettled

    if (outcome !== 'failure') await h.release(pendingIndex)
    else await h.reject(pendingIndex, failure)
    await vi.advanceTimersByTimeAsync(50)
    await flushMicrotasks()

    expect(h.calls).toHaveLength(callsBeforeTeardown)
    expect(fixtureSignal.aborted).toBe(true)
    expect(settledBeforeOperation).toBe(false)
    expect(operationSettled).toBe(true)
    expect(operationValue).toBeUndefined()
    expect(operationError).toBeDefined()
    expect(cleanupSettled).toBe(true)
    const result = await cleanup
    if (outcome === 'failure') expect(nestedErrors(result)).toContain(failure)
  } finally {
    releaseOwner()
    await h.dispose()
  }
})

it.each(['success', 'failure'])(
  'joins an in-flight test-body traffic read and fences its late %s', async outcome => {
    vi.useFakeTimers()
    const h = virtualOwnedRig({ runChild: true })
    const fixtureWork = createManagedCodexFixtureWork()
    const failure = new Error('in-flight fixture traffic read failed')
    let releaseOwner!: () => void
    const ownerFinish = new Promise<void>(resolve => { releaseOwner = resolve })
    try {
      const model = await startRunningChild(h)
      let continued = false
      let operationSettled = false
      const operation = (async () => {
        await readManagedCodexFixtureTraffic(fixtureWork, model)
        continued = true
        // A following model read represents a real later fixture operation in
        // the test body, not an inert promise that never resumes.
        await model.traffic()
      })()
      void operation.then(() => { operationSettled = true }, () => { operationSettled = true })
      await flushMicrotasks()
      const pendingIndex = h.calls.length - 1
      const callsBeforeTeardown = h.calls.length
      expect(h.calls[pendingIndex].pending).toBe(true)
      const owner = {
        runtime: { writeIncident: vi.fn() },
        stop: vi.fn(async () => {
          for (const call of h.calls.slice(callsBeforeTeardown)) if (call.pending) {
            call.pending = false
            call.reject(new Error('duplicate fixture cleanup probe cancelled'))
          }
          await ownerFinish
          return { ok: true, errors: [] }
        }),
      }
      const dependencies = {
        captureVolumes: vi.fn(() => []),
        removeVolumes: vi.fn(() => []),
        removeDirectory: vi.fn(),
      }
      let cleanupSettled = false
      const cleanup = cleanupManagedCodexParity({
        rig: owner, owners: [], wire: undefined, model, fixtureWork, finalObservation: undefined,
        naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: undefined,
      }, dependencies).then(
        () => { cleanupSettled = true; return undefined },
        error => { cleanupSettled = true; return error },
      )
      await flushMicrotasks()
      if (!owner.stop.mock.calls.length) await vi.advanceTimersByTimeAsync(30_000)
      expect(owner.stop).toHaveBeenCalledOnce()
      releaseOwner()
      await flushMicrotasks()
      const settledBeforeOperation = cleanupSettled

      if (outcome === 'success') await h.release(pendingIndex)
      else await h.reject(pendingIndex, failure)
      await flushMicrotasks()

      expect(settledBeforeOperation).toBe(false)
      expect(continued).toBe(false)
      expect(h.calls).toHaveLength(callsBeforeTeardown)
      expect(operationSettled).toBe(true)
      expect(cleanupSettled).toBe(true)
      const result = await cleanup
      if (outcome === 'failure') expect(nestedErrors(result)).toContain(failure)
    } finally {
      releaseOwner()
      await h.dispose()
    }
  },
)

it('awaits a failed launch and settles the child created before that failure', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const started = begin(h)
    const failure = new Error('launch response failed after spawning')
    const observed = started.then(() => undefined, (error: unknown) => error)
    await h.reject(0, failure, true)
    expect(h.spawned).toEqual([{ pid: PID }])
    expect(h.calls).toHaveLength(2)
    await h.release(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.signals).toEqual([{ pid: PID, signal: 'SIGTERM', target: 'fixture' }])
    h.resolveClose()
    await flushMicrotasks()
    await h.release(2)
    expect(nestedErrors(await observed)).toContain(failure)
    expect(h.childErrors).toEqual([])
  } finally { await h.dispose() }
})

it.each(['probe rejection', 'malformed JSON', 'wrong uid', 'wrong gid'])(
  'cleans up the launched child after readiness %s', async scenario => {
    vi.useFakeTimers()
    const h = virtualOwnedRig({ runChild: true })
    try {
      const started = begin(h)
      const observed = started.then(() => undefined, error => error)
      await h.release(0)
      const failure = new Error('readiness probe failed')
      if (scenario === 'probe rejection') await h.reject(1, failure)
      else {
        const file = `${h.directory()}/ready.json`
        const ready = JSON.parse(h.files.get(file)!)
        if (scenario === 'wrong uid') ready.uid = 1000
        if (scenario === 'wrong gid') ready.gid = 1000
        h.files.set(file, scenario === 'malformed JSON' ? '{invalid' : JSON.stringify(ready))
        await h.release(1)
      }
      expect(h.calls).toHaveLength(3)
      await h.release(2)
      await vi.advanceTimersByTimeAsync(50)
      expect(h.signals).toEqual([{ pid: PID, signal: 'SIGTERM', target: 'fixture' }])
      h.resolveClose()
      await flushMicrotasks()
      await h.release(3)
      const error = await observed
      expect(error).toBeInstanceOf(Error)
      if (scenario === 'probe rejection') expect(nestedErrors(error)).toContain(failure)
      if (scenario === 'malformed JSON') expect(nestedErrors(error).some(item => item instanceof SyntaxError)).toBe(true)
      if (scenario === 'wrong uid' || scenario === 'wrong gid') expect(nestedErrors(error).map(String).join(' ')).toMatch(/65534|1000|0/)
      expect(h.childErrors).toEqual([])
    } finally { await h.dispose() }
  },
)

it.each(['available', 'read failed'])('awaits timeout diagnostics when stderr is %s without exposing it', async diagnostic => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const started = begin(h)
    let settled = false
    const observed = started.then(() => { settled = true; return undefined }, error => { settled = true; return error })
    await h.release(0)
    h.files.delete(`${h.directory()}/ready.json`)
    await h.release(1)
    vi.setSystemTime(Date.now() + 30_001)
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBe(false)
    expect(h.calls).toHaveLength(3)
    const secret = 'diagnostic-secret-must-not-leak'
    h.files.set(`${h.directory()}/stderr`, secret)
    if (diagnostic === 'available') await h.release(2)
    else await h.reject(2, new Error('diagnostic read failed'))
    expect(h.calls).toHaveLength(4)
    await h.release(3)
    await vi.advanceTimersByTimeAsync(50)
    h.resolveClose()
    await flushMicrotasks()
    await h.release(4)
    const error = await observed
    expect(String(error)).toMatch(/did not start/)
    expect(String(error)).not.toContain(secret)
    expect(h.childErrors).toEqual([])
  } finally { await h.dispose() }
})

it('does not signal a replacement process after an ambiguous failed launch', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const started = begin(h)
    const failure = new Error('launch response lost')
    const observed = started.then(() => undefined, error => error)
    await h.reject(0, failure, true)
    h.replaceFixture() // The same synthetic PID now belongs to a different process.
    expect(h.calls).toHaveLength(2)
    await h.release(1)
    await h.release(2) // No owned closed marker can be produced now.
    vi.setSystemTime(Date.now() + 10_001)
    await vi.advanceTimersByTimeAsync(50)
    const error = await observed
    expect(nestedErrors(error)).toContain(failure)
    expect(nestedErrors(error).map(String).join(' ')).toMatch(/cleanup|did not close|unresolved/i)
    expect(h.signals.filter(entry => entry.target === 'replacement')).toEqual([])
  } finally { await h.dispose() }
})

it.each(['signal', 'closed probe'])('surfaces the asynchronous %s failure', async stage => {
  vi.useFakeTimers()
  const h = virtualOwnedRig({ runChild: true })
  try {
    const model = await startRunningChild(h)
    let index = h.calls.length
    const failure = new Error(`owned ${stage} failed`)
    const observed = model.stop().then(() => undefined, (error: unknown) => error)
    if (stage === 'closed probe') {
      await h.release(index++)
      await vi.advanceTimersByTimeAsync(50)
    }
    await h.reject(index, failure)
    expect(nestedErrors(await observed)).toContain(failure)
  } finally { await h.dispose() }
})

it('requires an observed stopped container and reports unavailable inspection', async () => {
  vi.useFakeTimers()
  const h = virtualOwnedRig()
  try {
    const model = await startReady(h)
    const count = h.calls.length
    h.setRunning(false)
    await model.stop()
    expect(h.rig.ownedContainerRunning).toHaveBeenLastCalledWith(CONTAINER)
    expect(h.rig.runtime.isContainerRunning).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(count)

    const failure = new Error('container observation unavailable')
    h.failInspection(failure)
    await expect(model.stop()).rejects.toBe(failure)
    expect(h.calls).toHaveLength(count)
  } finally { await h.dispose() }
})
