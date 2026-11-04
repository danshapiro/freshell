// A real-daemon caller and guest verification are still required. The probe
// needs an actual receipt-owned live managed container, not a made-up ID.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import type { ManagedRuntimeOwner } from './runtime-sandbox.js'
import type { InitialProviderVolumeAuthorization } from './runtime-test-broker.js'
import { cleanupManagedCodexParity } from '../../test/helpers/codex-managed-cleanup.js'

type Identity = { pid: number; startTicks: string }
type ProbeOutcome = { kind: 'fulfilled' } | { kind: 'rejected'; error: unknown }

function event(name: string, data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ severity: name.endsWith('.failed') ? 'error' : 'info', event: name, ...data })}\n`)
}

function docker(operation: string, args: string[]): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }).trim()
  } catch { throw new Error(`qualified daemon observation failed: ${operation}`) }
}

function identity(pid: number): Identity | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // stat field 22 (starttime); field 3 (state) is index 0 after ')'.
    if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('malformed process identity')
    return { pid, startTicks: fields[19] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function sameIdentity(expected: Identity): boolean {
  return identity(expected.pid)?.startTicks === expected.startTicks
}

function commandLine(pid: number): string[] {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function exactCliChild(expectedCli: string, expectedArgs: string[]): Identity | undefined {
  const children = fs.readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)
  const matches = children.flatMap(value => {
    const pid = Number(value)
    if (!Number.isSafeInteger(pid) || pid <= 1) return []
    try {
      if (fs.realpathSync(`/proc/${pid}/exe`) !== fs.realpathSync(expectedCli)) return []
      const actual = commandLine(pid)
      if (actual.length !== expectedArgs.length + 1 || !actual.slice(1).every((arg, index) => arg === expectedArgs[index])) return []
      const observed = identity(pid)
      return observed ? [observed] : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  })
  assert.ok(matches.length <= 1, 'one exact Docker CLI child is expected')
  return matches[0]
}

function containerOperation(containerId: string, nonce: string): Identity | undefined {
  // docker top's PID must be visible in this isolated guest's /proc. This
  // precondition is checked rather than assuming a PID namespace mapping.
  const rows = docker('container_top', ['top', containerId, '-eo', 'pid,args']).split('\n').slice(1)
  const matches = rows.flatMap(row => {
    const match = row.trim().match(/^(\d+)\s+(.+)$/)
    if (!match || !match[2].includes(nonce)) return []
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 1 || !commandLine(pid).includes(nonce)) {
      throw new Error('container operation PID is not independently visible in guest /proc')
    }
    const observed = identity(pid)
    return observed ? [observed] : []
  })
  assert.ok(matches.length <= 1, 'one exact waiting container operation is expected')
  return matches[0]
}

function lifecycle(owner: ManagedRuntimeOwner): Array<Record<string, unknown>> {
  return fs.readFileSync(owner.runtime.lifecyclePath, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function rowData(row: Record<string, unknown>): Record<string, unknown> {
  assert.ok(row.data && typeof row.data === 'object' && !Array.isArray(row.data))
  return row.data as Record<string, unknown>
}

/**
 * Call once as the final action on an actual live managed rig. Its callers must
 * have joined/closed their own fixture work and supplied every authorized
 * initial volume. Default cleanup captures them before the real owner stop.
 * The independent guest driver provides the outer deadline and exact recovery.
 */
export async function checkInFlightOwnedProbe(input: {
  owner: ManagedRuntimeOwner
  containerId: string
  owners: InitialProviderVolumeAuthorization[]
  daemonId: string
  daemonSocket: string
  dockerCli: string
}): Promise<void> {
  const { owner, containerId, owners, daemonId, daemonSocket, dockerCli } = input
  assert.match(containerId, /^[a-f0-9]{64}$/)
  assert.equal(process.env.DOCKER_HOST, `unix://${daemonSocket}`)
  assert.equal(docker('daemon_identity', ['info', '--format', '{{.ID}}']), daemonId)
  assert.ok(owner.runtime.broker.receiptIds().has(containerId), 'actual broker receipt is required')
  assert.equal(owner.runtime.broker.receipts().filter(receipt => receipt.containerId === containerId).length, 1)
  const prior = new Set(lifecycle(owner).filter(row => row.event === 'external.provider_probe_started').map(row => rowData(row).probeId))
  const nonce = `task4-probe-${randomUUID()}`
  const command = ['node', '-e', 'setInterval(() => {}, 1000)', nonce]
  const cliArgs = ['exec', '--user', '65534:0', containerId, 'env', 'HOME=/home/freshell/provider', ...command]
  let probeSettled = false
  const settlement: Promise<ProbeOutcome> = owner.ownedProviderExec(containerId, command).then(
    (): ProbeOutcome => ({ kind: 'fulfilled' }),
    (error): ProbeOutcome => ({ kind: 'rejected', error }),
  ).then(result => { probeSettled = true; return result })
  let cli: Identity | undefined
  let inside: Identity | undefined
  let stopCalls = 0
  let inFlightAtStop = false
  let ownerStopSucceeded = false
  let cleanup: Promise<void> | undefined
  const rig = {
    runtime: owner.runtime,
    stop: async () => {
      stopCalls++
      // Even a failed observation must not prevent the real owner from stopping.
      try { inFlightAtStop = !!cli && !!inside && sameIdentity(cli) && sameIdentity(inside) }
      catch { inFlightAtStop = false }
      const result = await owner.stop()
      ownerStopSucceeded = result.ok
      return result
    },
  }
  const startCleanup = () => cleanup ??= cleanupManagedCodexParity({ rig, owners, wire: undefined, model: undefined,
    finalObservation: undefined, naming: undefined, restoreGrants: undefined, grantsDirectory: undefined, home: undefined })
  let caseFailed = false
  let caseError: unknown
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && (!cli || !inside)) {
      if (probeSettled) throw new Error('probe settled before both sides were observed')
      cli ??= exactCliChild(dockerCli, cliArgs)
      inside ??= containerOperation(containerId, nonce)
      if (!cli || !inside) await delay(100)
    }
    assert.ok(cli && inside && sameIdentity(cli) && sameIdentity(inside), 'both operations must overlap')
    event('real_probe.in_flight', { daemonId, containerId, cli, containerOperation: inside })
    await startCleanup()
    const outcome = await settlement
    assert.equal(stopCalls, 1)
    assert.equal(inFlightAtStop, true, 'both exact processes must still be present when real stop begins')
    assert.equal(outcome.kind, 'rejected')
    if (outcome.kind !== 'rejected') throw new Error('probe unexpectedly succeeded')
    const cause = outcome.error instanceof Error ? outcome.error.cause as { signal?: string } | undefined : undefined
    assert.equal(cause?.signal, 'SIGKILL', 'the owned CLI must report the owner cancellation signal')
    assert.equal(sameIdentity(cli), false)
    assert.equal(sameIdentity(inside), false)
    assert.equal(docker('daemon_identity_after_stop', ['info', '--format', '{{.ID}}']), daemonId)
    const listed = docker('container_absence', ['container', 'ls', '-a', '--no-trunc', '--filter', `id=${containerId}`, '--format', '{{.ID}}'])
    assert.equal(listed.split('\n').includes(containerId), false)
    const rows = lifecycle(owner)
    const starts = rows.filter(row => row.event === 'external.provider_probe_started'
      && rowData(row).containerId === containerId && !prior.has(rowData(row).probeId))
    assert.equal(starts.length, 1)
    const probeId = rowData(starts[0]).probeId
    const finishes = rows.filter(row => row.event === 'external.provider_probe_settled' && rowData(row).probeId === probeId)
    assert.equal(finishes.length, 1)
    event('real_probe.case_passed', { daemonId, containerId, probeId,
      cli, containerOperation: inside, signal: cause?.signal ?? null, ownerStopCalls: stopCalls, containerAbsent: true })
  } catch (error) {
    caseFailed = true
    caseError = error
  }
  // A cleanup failure must not skip the probe's separate settlement, and a
  // later cleanup failure must not replace the original observation failure.
  const [cleanupResult, probeResult] = await Promise.allSettled([Promise.resolve().then(startCleanup), settlement])
  const failures: Array<{ phase: string; kind: string }> = []
  const errors: unknown[] = []
  if (caseFailed && !(cleanupResult.status === 'rejected' && cleanupResult.reason === caseError)) {
    failures.push({ phase: 'case', kind: caseError instanceof assert.AssertionError ? 'assertion' : 'operation' })
    errors.push(caseError)
  }
  if (cleanupResult.status === 'rejected') {
    failures.push({ phase: 'cleanup', kind: 'exception' })
    errors.push(cleanupResult.reason)
  }
  if (probeResult.status === 'rejected') {
    failures.push({ phase: 'probe_settlement', kind: 'exception' })
    errors.push(probeResult.reason)
  }
  if ((caseFailed || cleanupResult.status === 'rejected')
    && probeResult.status === 'fulfilled' && probeResult.value.kind === 'rejected') {
    const error = probeResult.value.error
    const cause = error instanceof Error ? error.cause as { signal?: string } | undefined : undefined
    // Capture and removal can fail independently of a successful owner stop.
    const ownerCancellationProven = ownerStopSucceeded && stopCalls === 1 && inFlightAtStop
    const expectedCancellation = ownerCancellationProven && cause?.signal === 'SIGKILL'
    if (!expectedCancellation) {
      failures.push({ phase: 'probe', kind: cause?.signal === 'SIGKILL' ? 'cancellation_unconfirmed' : 'unexpected_rejection' })
      errors.push(error)
    }
  }
  if (failures.length) {
    event('real_probe.failed', { daemonId, containerId, cli: cli ?? null, containerOperation: inside ?? null,
      ownerStopCalls: stopCalls, cleanupStatus: cleanupResult.status,
      probeStatus: probeResult.status === 'fulfilled' ? probeResult.value.kind : 'unavailable', failures })
    throw new AggregateError(errors, 'real owned probe or cleanup failed')
  }
}
