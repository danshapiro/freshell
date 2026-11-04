// This case requires a separately admitted, independently qualified guest and
// a bounded external driver. The local preflight is only a second check.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ManagedRuntimeOwner } from './runtime-sandbox.js'
import { authorizeFreshAgentParityRequest, readProviderParitySource } from '../../test/helpers/provider-parity-broker.js'

type Input = { repo: string; daemonId: string; socket: string; privateRoot: string; dockerCli: string }
type OwnerResult = Awaited<ReturnType<ManagedRuntimeOwner['stop']>>
type Failure = { phase: 'case' | 'control' | 'broker' | 'socket' | 'owner_stop' | 'final_observation'; kind: 'assertion' | 'operation' | 'reported_failure' | 'unsettled' }

function event(name: string, fields: Record<string, unknown>): void {
  const severity = /failed|recovery_required/.test(name) ? 'error' : 'info'
  process.stdout.write(`${JSON.stringify({ severity, event: name, ...fields })}\n`)
}

// The admitted guest driver should attach stdout to an already-open private
// evidence file. Complete this write before an operation can allocate a name.
function identity(name: string, fields: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify({ severity: 'info', event: name, ...fields })}\n`
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    process.stdout.once('error', onError)
    try {
      process.stdout.write(line, error => {
        if (error) { setImmediate(() => process.stdout.off('error', onError)); reject(error) }
        else { process.stdout.off('error', onError); resolve() }
      })
    } catch (error) { process.stdout.off('error', onError); reject(error) }
  })
}

function docker(args: string[]): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000, maxBuffer: 1024 * 1024 }).trim()
  } catch { throw new Error('qualified daemon observation unavailable') }
}

function volumeExists(name: string, daemonId: string): boolean {
  assert.match(name, /^freshell-provider-[a-f0-9]{24}$/)
  assert.equal(docker(['info', '--format', '{{.ID}}']), daemonId)
  const names = docker(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']).split('\n')
  assert.equal(docker(['info', '--format', '{{.ID}}']), daemonId)
  return names.includes(name)
}

function absent(name: string): void {
  try { fs.lstatSync(name) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw new Error('private control path already exists')
}

function pathStatus(name: string): 'absent' | 'present' | 'unknown' {
  try { fs.lstatSync(name); return 'present' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown' }
}

function retarget(link: string, next: string, from: string, to: string): void {
  assert.equal(fs.readlinkSync(link), from)
  absent(next)
  fs.symlinkSync(to, next)
  try { fs.renameSync(next, link) }
  catch (error) {
    // Remove only the exact temporary link just created by this operation.
    try { if (fs.readlinkSync(next) === to) fs.unlinkSync(next) } catch { /* retained for recovery */ }
    throw error
  }
  assert.equal(fs.readlinkSync(link), to)
}

function startTicks(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  assert.match(value ?? '', /^\d+$/)
  return value
}

// This controls only the finite single-volume child; it does not own the
// runtime, send signals, or act as a general proxy.
function startLostAckControl(input: Input, socket: string, volume: string) {
  const child = spawn(process.execPath, [path.join(input.repo, 'scripts/testing/codex-one-volume-forwarder.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      FRESHELL_TASK4_GUEST_QUALIFIED: process.env.FRESHELL_TASK4_GUEST_QUALIFIED,
      FRESHELL_TASK4_FORWARD_MODE: 'lost_ack', FRESHELL_TASK4_FORWARD_SOCKET: socket,
      FRESHELL_TASK4_DOCKER_SOCKET: input.socket, FRESHELL_TASK4_PRIVATE_ROOT: input.privateRoot,
      FRESHELL_TASK4_FORWARD_VOLUME: volume, FRESHELL_TASK4_DAEMON_ID: input.daemonId,
    },
  })
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  void ready.catch(() => {})
  let readySeen = false, invalid = false
  let buffer = ''
  const records: Array<Record<string, unknown>> = []
  child.stdout.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString()
    if (Buffer.byteLength(buffer) > 64 * 1024) { invalid = true; return }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        records.push(row)
        if (row.event === 'forwarder.ready') {
          if (readySeen || row.mode !== 'lost_ack' || row.socket !== socket || row.daemonId !== input.daemonId || row.volume !== volume) {
            invalid = true
          } else { readySeen = true; readyResolve() }
        }
      } catch { invalid = true }
    }
  })
  child.stdout.on('error', () => { invalid = true })
  child.stderr.on('data', () => {})
  child.stderr.on('error', () => { invalid = true })
  const settled = new Promise<{ ok: boolean; code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', () => { invalid = true; if (!readySeen) readyReject(new Error('forwarder unavailable')) })
    child.once('close', (code, signal) => {
      if (!readySeen) readyReject(new Error('forwarder did not become ready'))
      const created = records.filter(row => row.event === 'forwarder.daemon_create_observed'
        && row.daemonId === input.daemonId && row.volume === volume && row.status === 201)
      const dropped = records.filter(row => row.event === 'forwarder.acknowledgement_dropped' && row.volume === volume)
      const finished = records.filter(row => row.event === 'forwarder.settled' && row.mode === 'lost_ack'
        && row.ok === true && row.phase === 1 && row.socketStillExists === false
        && row.active === 0 && row.upstreams === 0 && row.sockets === 0)
      const allowed = new Set(['forwarder.ready', 'forwarder.daemon_create_observed', 'forwarder.acknowledgement_dropped', 'forwarder.settled'])
      const ordered = records.findIndex(row => row === created[0]) < records.findIndex(row => row === dropped[0])
        && records.findIndex(row => row === dropped[0]) < records.findIndex(row => row === finished[0])
      const ok = code === 0 && signal === null && !invalid && !buffer && readySeen && created.length === 1
        && dropped.length === 1 && finished.length === 1 && ordered && records.every(row => allowed.has(String(row.event)))
      resolve({ ok, code, signal })
    })
  })
  return { child, ready, settled }
}

function createThroughBroker(socket: string, body: Record<string, unknown>): Promise<{ error: boolean; response: boolean }> {
  return new Promise(resolve => {
    let error = false, response = false
    const request = http.request({ socketPath: socket, path: '/v1.47/volumes/create', method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' } }, result => {
      response = true
      result.resume()
    })
    request.once('error', () => { error = true })
    request.once('close', () => resolve({ error, response }))
    request.setTimeout(15_000, () => request.destroy(new Error('owned broker request timeout')))
    request.end(JSON.stringify(body))
  })
}

/** Run only inside the independently qualified, admitted disposable guest. */
export async function runLostAckVolumeCase(input: Input): Promise<void> {
  assert.equal(process.env.DOCKER_HOST, `unix://${input.socket}`)
  assert.ok(path.isAbsolute(input.privateRoot) && path.isAbsolute(input.socket) && path.isAbsolute(input.dockerCli))
  const root = fs.realpathSync(input.privateRoot)
  assert.notEqual(root, path.parse(root).root)
  const link = path.join(root, 'broker-upstream.sock')
  const next = path.join(root, 'broker-next.sock')
  const forwardSocket = path.join(root, 'forward.sock')
  assert.ok([link, next, forwardSocket].every(value => Buffer.byteLength(value) < 104))
  const rig = new ManagedRuntimeOwner(() => { throw new Error('web server is unused by this case') }, input.repo, 2)
  const failures: Failure[] = []
  const errors: unknown[] = []
  let linkCreated = false, linkForwarded = false, brokerIdle = true, clientJoined = true, controlJoined = true
  let control: ReturnType<typeof startLostAckControl> | undefined
  let controlResult: Awaited<ReturnType<typeof startLostAckControl>['settled']> | undefined
  let forwarderStartTicks: string | null = null
  let fixtureVolume: string | null = null
  let allocationAttempted = false
  let bodyComplete = false
  let stopResult: OwnerResult | undefined
  let stopCalls = 0
  let beforeStop: boolean | null = null, afterStop: boolean | null = null

  try {
    await identity('real_lost_ack.owner', { daemonId: input.daemonId, runId: rig.runtime.runId,
      testRoot: rig.runtime.testRoot, buildDir: rig.runtime.buildDir, evidenceDir: rig.runtime.evidenceDir })
    absent(link); absent(next); absent(forwardSocket)
    fs.symlinkSync(input.socket, link)
    linkCreated = true
    process.env.DOCKER_HOST = `unix://${link}`
    try { await rig.runtime.prepare() } finally { process.env.DOCKER_HOST = `unix://${input.socket}` }
    assert.equal(fs.readlinkSync(link), input.socket)
    assert.equal(docker(['info', '--format', '{{.ID}}']), input.daemonId)
    const source = await readProviderParitySource(rig.runtime, `task4-${randomUUID()}`)
    assert.equal(source.daemonId, input.daemonId)
    const owner = authorizeFreshAgentParityRequest(rig.runtime.broker, source, 'codex', randomUUID())
    fixtureVolume = owner.providerVolumeName
    assert.equal(volumeExists(fixtureVolume, input.daemonId), false, 'never adopt a pre-existing volume')
    assert.equal(rig.runtime.broker.initialProviderVolumeCreations().some(value => value.providerVolumeName === fixtureVolume), false)
    assert.equal(rig.runtime.broker.receipts().some(value => value.providerVolumeName === fixtureVolume), false)
    const reservationId = randomUUID(), incarnationId = `task4-${randomUUID()}`
    const labels = {
      'com.freshell.installation-id': owner.installationId, 'com.freshell.soul-id': owner.soulId,
      'freshell.input.reservation': reservationId, 'freshell.input.incarnation': incarnationId, 'freshell.input.intent': '1',
      'freshell.input.daemon': owner.daemonId, 'freshell.input.image': owner.imageRef, 'freshell.input.binary-sha256': owner.binarySha256,
    }
    await identity('real_lost_ack.volume_attempt', { daemonId: input.daemonId, runId: rig.runtime.runId,
      volume: fixtureVolume, installationId: owner.installationId, soulId: owner.soulId,
      imageRef: owner.imageRef, binarySha256: owner.binarySha256, reservationId, incarnationId })
    control = startLostAckControl(input, forwardSocket, fixtureVolume)
    controlJoined = false
    assert.ok(control.child.pid && Number.isSafeInteger(control.child.pid))
    const pid = control.child.pid
    forwarderStartTicks = startTicks(pid)
    await identity('real_lost_ack.forwarder', { daemonId: input.daemonId, volume: fixtureVolume, pid, startTicks: forwarderStartTicks })
    await control.ready
    brokerIdle = await rig.runtime.broker.settleForwarded(10_000)
    assert.equal(brokerIdle, true)
    retarget(link, next, input.socket, forwardSocket)
    linkForwarded = true
    allocationAttempted = true
    clientJoined = false
    const client = await createThroughBroker(rig.runtime.broker.proxySocketPath, { Name: fixtureVolume, Driver: 'local', Labels: labels })
    clientJoined = true
    assert.deepEqual(client, { error: true, response: false })
    brokerIdle = await rig.runtime.broker.settleForwarded(10_000)
    assert.equal(brokerIdle, true)
    controlResult = await control.settled
    controlJoined = true
    assert.equal(controlResult.ok, true)
    retarget(link, next, forwardSocket, input.socket)
    linkForwarded = false
    assert.equal(volumeExists(fixtureVolume, input.daemonId), true)
    const reservations = rig.runtime.broker.initialProviderVolumeCreations().filter(value => value.providerVolumeName === fixtureVolume)
    assert.deepEqual(reservations, [owner])
    assert.equal(rig.runtime.broker.receipts().some(value => value.providerVolumeName === fixtureVolume), false)
    beforeStop = true
    bodyComplete = true
  } catch (error) {
    failures.push({ phase: 'case', kind: error instanceof assert.AssertionError ? 'assertion' : 'operation' })
    errors.push(error)
  }

  process.env.DOCKER_HOST = `unix://${input.socket}`
  if (control && !controlJoined) {
    try { controlResult = await control.settled; controlJoined = true }
    catch (error) { failures.push({ phase: 'control', kind: 'operation' }); errors.push(error) }
  }
  if (!controlJoined) failures.push({ phase: 'control', kind: 'unsettled' })
  else if (controlResult && !controlResult.ok) failures.push({ phase: 'control', kind: 'reported_failure' })
  if (rig.runtime.broker) {
    try { brokerIdle = await rig.runtime.broker.settleForwarded(10_000) }
    catch (error) { brokerIdle = false; failures.push({ phase: 'broker', kind: 'operation' }); errors.push(error) }
  }
  if (!brokerIdle || !clientJoined) failures.push({ phase: 'broker', kind: 'unsettled' })
  if (linkCreated && linkForwarded && brokerIdle && clientJoined && controlJoined) {
    try { retarget(link, next, forwardSocket, input.socket); linkForwarded = false }
    catch (error) { failures.push({ phase: 'socket', kind: 'operation' }); errors.push(error) }
  }
  let directConfirmed = false
  if (!linkForwarded && brokerIdle && clientJoined && controlJoined) {
    try {
      if (linkCreated) assert.equal(fs.readlinkSync(link), input.socket)
      assert.equal(docker(['info', '--format', '{{.ID}}']), input.daemonId)
      directConfirmed = true
    }
    catch (error) { failures.push({ phase: 'socket', kind: 'operation' }); errors.push(error) }
  }
  if (directConfirmed && brokerIdle && clientJoined && controlJoined) {
    try { stopCalls++; stopResult = await rig.stop() }
    catch (error) { failures.push({ phase: 'owner_stop', kind: 'operation' }); errors.push(error) }
  } else {
    failures.push({ phase: 'owner_stop', kind: 'unsettled' })
  }

  if (bodyComplete && fixtureVolume && stopResult) {
    try {
      afterStop = volumeExists(fixtureVolume, input.daemonId)
      const cleanup = JSON.parse(fs.readFileSync(path.join(rig.runtime.evidenceDir, 'cleanup.json'), 'utf8'))
      const transport = cleanup.brokerSettlementFailures
      assert.equal(stopCalls, 1)
      assert.equal(stopResult.ok, false)
      assert.ok(Array.isArray(transport) && transport.length === 1)
      assert.equal(transport[0].method, 'POST')
      assert.equal(transport[0].url, '/v1.47/volumes/create')
      assert.ok(['upstream_request_failed', 'upstream_response_incomplete'].includes(transport[0].reason))
      assert.equal(transport[0].allocationUnknown, false)
      assert.deepEqual(stopResult.errors, [`broker settlement: ${transport[0].reason} (POST /v1.47/volumes/create)`])
      assert.equal(cleanup.brokerSettlementComplete, true)
      assert.equal(cleanup.verifiedKnownResourcesAbsent, true)
      assert.equal(cleanup.verifiedResourcesAbsent, true)
      assert.ok(Array.isArray(cleanup.volumes) && cleanup.volumes.includes(fixtureVolume))
      assert.equal(afterStop, false)
    } catch (error) {
      failures.push({ phase: 'final_observation', kind: error instanceof assert.AssertionError ? 'assertion' : 'operation' })
      errors.push(error)
    }
  } else if (stopResult && !stopResult.ok) {
    failures.push({ phase: 'owner_stop', kind: 'reported_failure' })
  }

  const forwarderSocketStatus = control && controlJoined ? pathStatus(forwardSocket) : undefined
  const nextStatus = linkCreated ? pathStatus(next) : undefined
  if (forwarderSocketStatus && forwarderSocketStatus !== 'absent') failures.push({ phase: 'socket', kind: 'unsettled' })
  if (nextStatus && nextStatus !== 'absent') failures.push({ phase: 'socket', kind: 'unsettled' })
  if (linkCreated && directConfirmed && brokerIdle && clientJoined && controlJoined) {
    try { assert.equal(fs.readlinkSync(link), input.socket); fs.unlinkSync(link); linkCreated = false }
    catch (error) { failures.push({ phase: 'socket', kind: 'operation' }); errors.push(error) }
  }
  if (failures.length || !bodyComplete || !stopResult || linkCreated) {
    event('real_lost_ack.recovery_required', { daemonId: input.daemonId, runId: rig.runtime.runId, volume: fixtureVolume,
      link: linkCreated ? link : null, nextLink: nextStatus && nextStatus !== 'absent' ? next : null,
      forwarderSocket: forwarderSocketStatus && forwarderSocketStatus !== 'absent' ? forwardSocket : null,
      forwarderPid: control?.child.pid ?? null, forwarderStartTicks, controlJoined, controlOk: controlResult?.ok ?? null, clientJoined, brokerIdle,
      allocationAttempted, stopCalls, ownerStopOk: stopResult?.ok ?? null, beforeStop, afterStop, failures })
    throw new AggregateError(errors, 'lost-ack case or cleanup failed')
  }
  event('real_lost_ack.completed', { daemonId: input.daemonId, runId: rig.runtime.runId, volume: fixtureVolume,
    stopCalls, ownerStopOk: false, expectedTransportFailure: true, beforeStop, afterStop, passedCases: 1 })
}

async function main(): Promise<void> {
  const { requireQualifiedGuest } = await import('./codex-real-volume-lifecycle.js')
  const { repo, daemonId } = requireQualifiedGuest()
  const socket = process.env.FRESHELL_TASK4_DOCKER_SOCKET
  const privateRoot = process.env.FRESHELL_TASK4_PRIVATE_ROOT
  const dockerCli = process.env.FRESHELL_TASK4_DOCKER_CLI
  assert.ok(socket && privateRoot && dockerCli)
  await runLostAckVolumeCase({ repo, daemonId, socket, privateRoot, dockerCli })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { event('real_lost_ack.failed', { phase: 'driver', kind: 'operation' }); process.exitCode = 1 })
}
