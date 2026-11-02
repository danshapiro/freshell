import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'

import type { createManagedCodexFixtureWork } from './codex-managed-cleanup.js'

type WaitFor = <T>(label: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs?: number) => Promise<T>
type FixtureWork = ReturnType<typeof createManagedCodexFixtureWork>
type CreateFailureFile = { containerId: string | null | undefined; files: string }
  | { containerId: string | null | undefined; unavailable: true }

/** Do not start or continue test-body work after its owner is cancelled. */
export async function awaitManagedCodexWork<T>(fixtureWork: FixtureWork, operation: () => Promise<T>): Promise<T> {
  fixtureWork.throwIfAborted()
  const result = await operation()
  fixtureWork.throwIfAborted()
  return result
}

/** Send a user turn over the installed-Codex test's wire. */
export async function sendManagedCodexMessage({ fixtureWork, wire, sessionId, text, settings }: {
  fixtureWork: FixtureWork
  wire: { send(frame: unknown): void; wait(predicate: (frame: any) => boolean, signal?: AbortSignal): Promise<any> }
  sessionId: string
  text: string
  settings?: unknown
}): Promise<any> {
  fixtureWork.throwIfAborted()
  const id = `send-${randomUUID()}`
  wire.send({ type: 'freshAgent.send', sessionType: 'freshcodex', provider: 'codex', sessionId, requestId: id, text, ...(settings ? { settings } : {}) })
  const accepted = await awaitManagedCodexWork(fixtureWork, () =>
    wire.wait(frame => frame.requestId === id && ['freshAgent.send.accepted', 'error'].includes(frame.type), fixtureWork.signal))
  fixtureWork.throwIfAborted()
  expect(accepted.type, JSON.stringify(accepted)).toBe('freshAgent.send.accepted')
  return accepted
}

/** The installed-Codex test body and the timeout signal supplied by Vitest. */
export function runManagedCodexParityBody<T>(
  fixtureWork: FixtureWork, signal: AbortSignal, body: () => Promise<T>,
): Promise<T> {
  const cancel = () => { fixtureWork.cancel() }
  if (signal.aborted) {
    cancel()
    return Promise.reject(signal.reason)
  }
  signal.addEventListener('abort', cancel, { once: true })
  return fixtureWork.run(body).finally(() => signal.removeEventListener('abort', cancel))
}

/** Read the provider files used by the installed test's create-failure incident. */
export async function readManagedCodexCreateFailureFiles(
  fixtureWork: FixtureWork,
  inventory: ReadonlyArray<{ containerId?: string | null }>,
  readFiles: (containerId: string) => Promise<string>,
): Promise<CreateFailureFile[]> {
  const results = await Promise.allSettled(inventory.filter(row => row.containerId).map(async row => {
    try {
      return { containerId: row.containerId, files: await awaitManagedCodexWork(fixtureWork, () => readFiles(row.containerId!)) }
    } catch (error) {
      if (fixtureWork.signal.aborted) throw error
      return { containerId: row.containerId, unavailable: true as const }
    }
  }))
  const files: CreateFailureFile[] = []
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') files.push(result.value)
    else failures.push(result.reason)
  }
  if (failures.length) {
    const errors = failures.filter(error => error !== fixtureWork.signal.reason)
    if (errors.length) throw new AggregateError(errors, 'managed Codex create-failure diagnostic reads failed')
    throw failures[0]
  }
  return files
}

/** Initialize the test-owned standalone MCP client without a late notification. */
export async function initializeManagedCodexStandaloneMcp(
  fixtureWork: FixtureWork,
  client: { request(method: string, params?: unknown): Promise<unknown>; notify(method: string): void },
): Promise<void> {
  await awaitManagedCodexWork(fixtureWork, () => client.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'freshell-mcp-bridge-test', version: '0.0.0' },
  }))
  fixtureWork.throwIfAborted()
  client.notify('notifications/initialized')
}

/** Send the native Plan question and its explicit answer. */
export async function runManagedCodexAwaitedPlanControl({
  fixtureWork, send, snapshot, waitFor, wire, sessionId,
}: {
  fixtureWork: FixtureWork
  send: (text: string, settings?: unknown) => Promise<unknown>
  snapshot: () => Promise<any>
  waitFor: WaitFor
  wire: { send(frame: unknown): void }
  sessionId: string
}): Promise<void> {
  await awaitManagedCodexWork(fixtureWork, () => send('AWAITED_PLAN', { collaborationMode: 'plan' }))
  const pending = await awaitManagedCodexWork(fixtureWork, () => waitFor('managed native awaited Plan control', async () => {
    const value = await awaitManagedCodexWork(fixtureWork, snapshot)
    return value.pendingQuestions?.length ? value.pendingQuestions[0] : undefined
  }))
  fixtureWork.throwIfAborted()
  expect(pending.questions[0].id).toBe('managed_choice')
  wire.send({ type: 'freshAgent.question.respond', sessionType: 'freshcodex', provider: 'codex', sessionId,
    requestId: pending.requestId, answers: { managed_choice: 'Alpha' } })
  await awaitManagedCodexWork(fixtureWork, () => waitFor('managed native awaited decision drained', async () => {
    const value = await awaitManagedCodexWork(fixtureWork, snapshot)
    return value.status === 'idle' && !value.pendingQuestions.length && JSON.stringify(value.turns).includes('Managed awaited answer completed.') ? true : undefined
  }))
  await awaitManagedCodexWork(fixtureWork, () => send('ASYNC_QUESTION', { collaborationMode: 'default' }))
}

/** Observe the contextual answer in the same model traffic used by the test. */
export async function waitForManagedCodexContextualAnswer({ readModelTraffic, waitFor }: {
  readModelTraffic: () => Promise<any[]>
  waitFor: WaitFor
}): Promise<void> {
  await waitFor('managed contextual answer at loopback model', async () =>
    (await readModelTraffic()).some((row: any) => JSON.stringify(row.body.input).includes('Answer: Staging.')) ? true : undefined)
}

/** Read and retain the actual managed MCP route results. */
export async function recordManagedCodexMcpResults({ fixtureWork, route, readTraffic, mcpResults, writeIncident }: {
  fixtureWork: FixtureWork
  route: string
  readTraffic: () => Promise<string>
  mcpResults: any[]
  writeIncident: (name: string, value: unknown) => void
}): Promise<void> {
  const rawTraffic = await awaitManagedCodexWork(fixtureWork, readTraffic)
  fixtureWork.throwIfAborted()
  const traffic = JSON.parse(rawTraffic)
  const results = traffic.filter((row: any) => row.event === 'elicitation_result' && row.route === route)
  expect(results.map((row: any) => row.result.action)).toEqual(['accept', 'decline', 'cancel'])
  expect(traffic.some((row: any) => row.event === 'fixture_error')).toBe(false)
  fixtureWork.throwIfAborted()
  mcpResults.push({ route, results })
  writeIncident('freshcodex-managed-native-mcp-results', mcpResults)
}
