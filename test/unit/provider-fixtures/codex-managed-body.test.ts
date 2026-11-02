// @vitest-environment node
import { expect, it, vi } from 'vitest'

import { cleanupManagedCodexParity, createManagedCodexFixtureWork } from '../../helpers/codex-managed-cleanup.js'
import {
  awaitManagedCodexWork,
  initializeManagedCodexStandaloneMcp,
  readManagedCodexCreateFailureFiles,
  recordManagedCodexMcpResults,
  runManagedCodexAwaitedPlanControl,
  runManagedCodexParityBody,
  sendManagedCodexMessage,
  waitForManagedCodexContextualAnswer,
} from '../../helpers/codex-managed-body.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function nestedErrors(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (value === null || value === undefined || seen.has(value)) return []
  seen.add(value)
  if (typeof value !== 'object') return [value]
  const error = value as { cause?: unknown; errors?: unknown[] }
  return [value, ...nestedErrors(error.cause, seen), ...(error.errors ?? []).flatMap(item => nestedErrors(item, seen))]
}

// Preserve the real polling callback and retry behavior without wall-clock sleeps.
async function waitFor<T>(_label: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await probe()
    if (result !== undefined) return result
  }
  throw new Error('controlled polling exhausted')
}

it('retries deferred managed contextual traffic until the staging answer is present', async () => {
  const first = deferred<any[]>()
  const second = deferred<any[]>()
  const fixtureWork = createManagedCodexFixtureWork()
  const model = { traffic: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) }
  const readModelTraffic = vi.fn(() => fixtureWork.run(() => model.traffic()))
  let settled = false
  const observed = waitForManagedCodexContextualAnswer({ readModelTraffic, waitFor }).then(
    () => { settled = true; return undefined }, error => { settled = true; return error },
  )
  try {
    await flushMicrotasks()
    const settledBeforeFirstRecord = settled
    first.resolve([{ body: { input: [{ content: 'different answer' }] } }])
    await flushMicrotasks()
    const settledAfterNonmatchingRecord = settled
    second.resolve([{ body: { input: [{ content: 'Question: Which managed environment? Answer: Staging.' }] } }])
    expect(await observed).toBeUndefined()
    expect(settledBeforeFirstRecord).toBe(false)
    expect(settledAfterNonmatchingRecord).toBe(false)
    expect(readModelTraffic).toHaveBeenCalledTimes(2)
    expect(settled).toBe(true)
  } finally {
    first.resolve([])
    second.resolve([])
    await observed
  }
})

it('runs the managed question and MCP paths normally when the body is not cancelled', async () => {
  const fixtureWork = createManagedCodexFixtureWork()
  const deadline = new AbortController()
  const frames: any[] = []
  const wire = {
    send: vi.fn((frame: any) => { frames.push(frame) }),
    wait: vi.fn(async (predicate: (frame: any) => boolean) => {
      const accepted = { type: 'freshAgent.send.accepted', requestId: frames.at(-1).requestId }
      expect(predicate(accepted)).toBe(true)
      return accepted
    }),
  }
  const send = (text: string, settings?: unknown) => sendManagedCodexMessage({ fixtureWork, wire, sessionId: 'session-1', text, settings })
  const snapshot = vi.fn()
    .mockResolvedValueOnce({ pendingQuestions: [{ requestId: 'question-1', questions: [{ id: 'managed_choice' }] }] })
    .mockResolvedValueOnce({ status: 'idle', pendingQuestions: [], turns: ['Managed awaited answer completed.'] })
  const mcpResults: any[] = []
  const writeIncident = vi.fn()
  const client = { request: vi.fn(async () => ({})), notify: vi.fn() }
  const traffic = ['accept', 'decline', 'cancel'].map(action => ({ event: 'elicitation_result', route: 'url', result: { action } }))

  await runManagedCodexParityBody(fixtureWork, deadline.signal, async () => {
    await runManagedCodexAwaitedPlanControl({ fixtureWork, send, snapshot, waitFor, wire, sessionId: 'session-1' })
    await initializeManagedCodexStandaloneMcp(fixtureWork, client)
    await recordManagedCodexMcpResults({ fixtureWork, route: 'url', readTraffic: async () => JSON.stringify(traffic), mcpResults, writeIncident })
    await send('MANAGED_DURABLE_CHILD')
  })

  expect(frames.filter(frame => frame.type === 'freshAgent.send').map(frame => frame.text))
    .toEqual(['AWAITED_PLAN', 'ASYNC_QUESTION', 'MANAGED_DURABLE_CHILD'])
  expect(frames.find(frame => frame.type === 'freshAgent.question.respond')).toMatchObject({
    requestId: 'question-1', answers: { managed_choice: 'Alpha' },
  })
  expect(mcpResults).toEqual([{ route: 'url', results: traffic }])
  expect(writeIncident).toHaveBeenCalledWith('freshcodex-managed-native-mcp-results', mcpResults)
  expect(client.request).toHaveBeenCalledWith('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'freshell-mcp-bridge-test', version: '0.0.0' },
  })
  expect(client.notify).toHaveBeenCalledWith('notifications/initialized')
})

it('preserves every late create-failure diagnostic read error before the body settles', async () => {
  const fixtureWork = createManagedCodexFixtureWork()
  const deadline = new AbortController()
  const first = deferred<string>()
  const second = deferred<string>()
  const firstFailure = new Error('first late owned diagnostic failure')
  const secondFailure = new Error('second late owned diagnostic failure')
  const inventory = [{ containerId: 'first-container' }, { containerId: 'second-container' }]
  const readFiles = vi.fn((containerId: string) => containerId === 'first-container' ? first.promise : second.promise)
  let bodySettled = false
  const body = runManagedCodexParityBody(fixtureWork, deadline.signal, () =>
    awaitManagedCodexWork(fixtureWork, () => readManagedCodexCreateFailureFiles(fixtureWork, inventory, readFiles)),
  ).then(() => { bodySettled = true }, () => { bodySettled = true })
  const order: string[] = []
  const rig = {
    // The real owner joins both owned probes even when the test body exits early.
    stop: vi.fn(async () => {
      await Promise.allSettled([first.promise, second.promise])
      order.push('runtime stopped')
      return { ok: true, errors: [] as string[] }
    }),
    runtime: { writeIncident: vi.fn() },
  }
  const dependencies = {
    captureVolumes: vi.fn(() => []),
    removeVolumes: vi.fn(() => []),
    removeDirectory: vi.fn(() => { order.push('fixture path removed') }),
  }
  await flushMicrotasks()
  const readsAtCancellation = readFiles.mock.calls.map(([containerId]) => containerId)
  const cleanup = cleanupManagedCodexParity({
    rig, owners: [], wire: undefined, model: undefined, fixtureWork, finalObservation: undefined,
    naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: '/virtual/home',
  }, dependencies).then(() => undefined, error => error)
  await flushMicrotasks()
  first.reject(firstFailure)
  await flushMicrotasks()
  const bodySettledBeforeSecondRead = bodySettled
  second.reject(secondFailure)
  const cleanupError = await cleanup
  await body

  expect(readsAtCancellation).toEqual(['first-container', 'second-container'])
  expect(nestedErrors(cleanupError)).toEqual(expect.arrayContaining([firstFailure, secondFailure]))
  expect(bodySettledBeforeSecondRead).toBe(false)
  expect(order).toEqual(['runtime stopped', 'fixture path removed'])

  const normalWork = createManagedCodexFixtureWork()
  const normal = await readManagedCodexCreateFailureFiles(normalWork,
    [...inventory, { containerId: undefined }],
    async containerId => {
      if (containerId === 'second-container') throw new Error('ordinary unavailable read')
      return 'readable provider files'
    })
  expect(normal).toEqual([
    { containerId: 'first-container', files: 'readable provider files' },
    { containerId: 'second-container', unavailable: true },
  ])
})

it.each(['success', 'failure'] as const)(
  'joins late create-failure reads and handles cancellation with a first-read %s', async outcome => {
    const fixtureWork = createManagedCodexFixtureWork()
    const deadline = new AbortController()
    const first = deferred<string>()
    const second = deferred<string>()
    const failure = new Error('first owned diagnostic failed late')
    const inventory = [{ containerId: 'first-container' }, { containerId: 'second-container' }]
    const readFiles = vi.fn((containerId: string) => containerId === 'first-container' ? first.promise : second.promise)
    let bodySettled = false
    const body = runManagedCodexParityBody(fixtureWork, deadline.signal, () =>
      awaitManagedCodexWork(fixtureWork, () => readManagedCodexCreateFailureFiles(fixtureWork, inventory, readFiles)),
    ).then(() => { bodySettled = true }, () => { bodySettled = true })
    const rig = {
      stop: vi.fn(async () => { await Promise.allSettled([first.promise, second.promise]); return { ok: true, errors: [] as string[] } }),
      runtime: { writeIncident: vi.fn() },
    }
    const dependencies = {
      captureVolumes: vi.fn(() => []),
      removeVolumes: vi.fn(() => []),
      removeDirectory: vi.fn(),
    }
    await flushMicrotasks()
    const readsAtCancellation = readFiles.mock.calls.map(([containerId]) => containerId)
    const cleanup = cleanupManagedCodexParity({
      rig, owners: [], wire: undefined, model: undefined, fixtureWork, finalObservation: undefined,
      naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: '/virtual/home',
    }, dependencies).then(() => undefined, error => error)
    await flushMicrotasks()
    if (outcome === 'failure') first.reject(failure)
    else first.resolve('first provider files')
    await flushMicrotasks()
    const bodySettledBeforeSecondRead = bodySettled
    second.resolve('second provider files')
    const cleanupError = await cleanup
    await body

    expect(readsAtCancellation).toEqual(['first-container', 'second-container'])
    expect(bodySettledBeforeSecondRead).toBe(false)
    expect(rig.stop).toHaveBeenCalledOnce()
    expect(dependencies.removeDirectory).toHaveBeenCalledOnce()
    if (outcome === 'failure') expect(nestedErrors(cleanupError)).toContain(failure)
    else expect(cleanupError).toBeUndefined()
    expect(nestedErrors(cleanupError)).not.toContain(fixtureWork.signal.reason)
  },
)

type Stage = 'wire wait' | 'snapshot' | 'MCP read' | 'MCP initialize'
type Trigger = 'deadline' | 'teardown'
type Outcome = 'success' | 'failure'

const bodyCases: Array<[Stage, Trigger, Outcome]> = []
for (const stage of ['wire wait', 'snapshot', 'MCP read', 'MCP initialize'] as const) {
  for (const trigger of ['deadline', 'teardown'] as const) {
    for (const outcome of ['success', 'failure'] as const) bodyCases.push([stage, trigger, outcome])
  }
}

it.each(bodyCases)(
  'settles the actual managed body path after %s, %s and late %s', async (stage, trigger, outcome) => {
    const gate = deferred<any>()
    const lateFailure = new Error(`controlled late ${stage} failure`)
    const fixtureWork = createManagedCodexFixtureWork()
    const deadline = new AbortController()
    const activity: string[] = []
    let snapshotCount = 0
    const question = { requestId: 'question-1', questions: [{ id: 'managed_choice' }] }
    const accepted = { type: 'freshAgent.send.accepted' }
    const mcpTraffic = JSON.stringify(['accept', 'decline', 'cancel'].map(action => ({
      event: 'elicitation_result', route: 'url', result: { action },
    })))
    const wire = {
      send: vi.fn((frame: any) => { activity.push(`wire.send:${frame.type}`) }),
      wait: vi.fn(async (_predicate: (frame: any) => boolean) => {
        activity.push('wire.wait')
        return stage === 'wire wait' ? gate.promise : accepted
      }),
    }
    const send = (text: string, settings?: unknown) => sendManagedCodexMessage({ fixtureWork, wire, sessionId: 'session-1', text, settings })
    const snapshot = vi.fn(async () => {
      activity.push('snapshot')
      snapshotCount++
      if (stage === 'snapshot' && snapshotCount === 1) return gate.promise
      if (snapshotCount === 1) return { pendingQuestions: [question] }
      return { status: 'idle', pendingQuestions: [], turns: ['Managed awaited answer completed.'] }
    })
    const readTraffic = vi.fn(() => { activity.push('MCP read'); return gate.promise as Promise<string> })
    const writeIncident = vi.fn(() => { activity.push('write incident') })
    const client = {
      request: vi.fn(() => { activity.push('MCP initialize'); return gate.promise }),
      notify: vi.fn(() => { activity.push('MCP notification') }),
    }
    const body = runManagedCodexParityBody(fixtureWork, deadline.signal, async () => {
      if (stage === 'MCP read') {
        await recordManagedCodexMcpResults({ fixtureWork, route: 'url', readTraffic, mcpResults: [], writeIncident })
        await send('MANAGED_DURABLE_CHILD')
      } else if (stage === 'MCP initialize') {
        await initializeManagedCodexStandaloneMcp(fixtureWork, client)
        await send('MANAGED_DURABLE_CHILD')
      } else {
        await runManagedCodexAwaitedPlanControl({ fixtureWork, send, snapshot, waitFor, wire, sessionId: 'session-1' })
      }
    }).then(() => undefined, error => error)

    const order: string[] = []
    const rig = {
      stop: vi.fn(async () => { order.push('runtime stopped'); return { ok: true, errors: [] as string[] } }),
      runtime: { writeIncident: vi.fn() },
    }
    const dependencies = {
      captureVolumes: vi.fn(() => []),
      removeVolumes: vi.fn(() => []),
      removeDirectory: vi.fn(() => { order.push('fixture path removed') }),
    }
    let cleanupSettled = false
    const startCleanup = () => cleanupManagedCodexParity({
      rig, owners: [], wire: undefined, model: undefined, fixtureWork, finalObservation: undefined,
      naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: '/virtual/home',
    }, dependencies).then(
      () => { cleanupSettled = true; return undefined },
      error => { cleanupSettled = true; return error },
    )

    await flushMicrotasks()
    const activityAtCancellation = [...activity]
    let cleanup: ReturnType<typeof startCleanup> | undefined
    let cleanupSettledBeforeOperation: boolean | undefined
    let removedBeforeOperation: boolean | undefined
    if (trigger === 'deadline') {
      // Vitest aborts its context before the original promise necessarily settles.
      deadline.abort(new Error('controlled test deadline'))
    } else {
      cleanup = startCleanup()
      await flushMicrotasks()
      cleanupSettledBeforeOperation = cleanupSettled
      removedBeforeOperation = dependencies.removeDirectory.mock.calls.length > 0
    }

    if (outcome === 'failure') gate.reject(lateFailure)
    else if (stage === 'wire wait') gate.resolve(accepted)
    else if (stage === 'snapshot') gate.resolve({ pendingQuestions: [question] })
    else if (stage === 'MCP read') gate.resolve(mcpTraffic)
    else gate.resolve({})
    const bodyError = await body
    await flushMicrotasks()
    cleanup ??= startCleanup()
    const cleanupError = await cleanup

    expect(activityAtCancellation).toContain(stage === 'wire wait' ? 'wire.wait' : stage)
    if (trigger === 'teardown') {
      expect(cleanupSettledBeforeOperation).toBe(false)
      expect(removedBeforeOperation).toBe(false)
    }
    expect(activity).toEqual(activityAtCancellation)
    expect(bodyError).toBeDefined()
    expect(cleanupSettled).toBe(true)
    expect(rig.stop).toHaveBeenCalledOnce()
    expect(order).toEqual(['runtime stopped', 'fixture path removed'])
    if (outcome === 'failure') expect(nestedErrors(cleanupError)).toContain(lateFailure)
  },
)
