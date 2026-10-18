// @vitest-environment node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, vi } from 'vitest'

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import type { BrokerReceipt, RestrictedDockerBroker } from '../../../../scripts/testing/runtime-test-broker.js'

const supervisorId = 'a'.repeat(64)
const runtimeId = 'b'.repeat(64)

// Real files and finite CLI processes exercise collection followed by normal
// cleanup. Removing either owned resource destroys the source journals.
async function fixture(check: (harness: RuntimeHarness, receipt: BrokerReceipt, commands: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-journal-'))
  const bin = path.join(root, 'bin')
  const state = path.join(root, 'state.json')
  const commands = path.join(root, 'commands.jsonl')
  const previousPath = process.env.PATH
  fs.mkdirSync(bin)
  fs.writeFileSync(state, JSON.stringify({ ids: [supervisorId, runtimeId] }))
  const tool = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), statePath = ${JSON.stringify(state)}, log = ${JSON.stringify(commands)};
if (process.argv[1].endsWith('/git')) { console.log('c'.repeat(40)); process.exit(0); }
fs.appendFileSync(log, JSON.stringify(args)+'\\n');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (args[0] === 'run') {
  state.runtimeRoot = args[args.indexOf('--runtime-root')+1];
  fs.writeFileSync(statePath, JSON.stringify(state)); console.log('${supervisorId}');
} else if (args[0] === 'inspect') { process.exit(state.ids.includes(args[1]) ? 0 : 1);
} else if (args[0] === 'rm') {
  state.ids = state.ids.filter(id => id !== args[2]);
  fs.writeFileSync(statePath, JSON.stringify(state)); fs.rmSync(state.runtimeRoot, {recursive:true, force:true});
} else if (args[0] === 'exec') {
  if (!state.ids.includes(args[1])) process.exit(1);
  const result = cp.spawnSync(args[2], args.slice(3), {encoding:'utf8'});
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
} else if (args[0] !== 'volume') { process.exit(2); }
`
  for (const name of ['git', 'docker']) fs.writeFileSync(path.join(bin, name), tool, { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`
  const harness = new RuntimeHarness(root, randomUUID(), 2)
  harness.broker = {
    proxySocketPath: path.join(root, 'broker.sock'),
    receipts: () => [receipt], receiptIds: () => new Set([runtimeId]),
    unsafeAttempts: () => [], eventsSnapshot: () => [],
  } as unknown as RestrictedDockerBroker
  const instance = await harness.startSupervisor({ scenarioId: 'journal', waitForHealth: false })
  const receipt: BrokerReceipt = {
    containerId: runtimeId, createdAt: new Date().toISOString(), requestDigest: 'fixture',
    incarnationId: 'incarnation-failed', soulId: 'soul-failed', imageRef: 'fixture',
    runtimeDir: harness.runtimeDir(instance, 'incarnation-failed'),
  }
  fs.mkdirSync(receipt.runtimeDir, { recursive: true, mode: 0o700 })
  try {
    await check(harness, receipt, commands)
  } finally {
    vi.restoreAllMocks()
    await harness.cleanup()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    fs.rmSync(harness.testRoot, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function journal(receipt: BrokerReceipt, suffix = ''): string {
  return path.join(receipt.runtimeDir, `host-lifecycle.jsonl${suffix}`)
}

function rows(harness: RuntimeHarness): any[] {
  return fs.readFileSync(harness.lifecyclePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

function assertRemoved(harness: RuntimeHarness, commands: string): void {
  const calls: string[][] = fs.readFileSync(commands, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls.filter(args => args[0] === 'rm').map(args => args[2]), [supervisorId, runtimeId])
  const cleanup = JSON.parse(fs.readFileSync(path.join(harness.evidenceDir, 'cleanup.json'), 'utf8'))
  assert.deepEqual(cleanup.exactContainerIds, [runtimeId]) // supervisors were removed from the tracking sets
  assert.deepEqual(cleanup.unsafeBrokerAttempts, [])
}

describe('host journal evidence before resource removal', { concurrent: false }, () => {
  it('retains a failed command and receipt identity after normal cleanup, once only', async () => {
    await fixture(async (harness, receipt, commands) => {
      const failure = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        try { fs.readFileSync(process.argv[2]); process.exit(2); }
        catch (error) { fs.appendFileSync(process.argv[1], JSON.stringify({event:'host.command_failed', data:{code:'HOST_UNREACHABLE', message:'prepare input: '+error.code}})+'\\n', {mode:0o600}); }
      `, journal(receipt), path.join(receipt.runtimeDir, 'missing-input')], { encoding: 'utf8' })
      assert.equal(failure.status, 0, failure.stderr)
      const cleanup = harness.cleanup()
      assert.equal(harness.cleanup(), cleanup)
      assert.deepEqual(await cleanup, { ok: true, errors: [] })
      assert.equal(fs.existsSync(receipt.runtimeDir), false)
      const captured = rows(harness).filter(row => row.event === 'host.lifecycle')
      assert.equal(captured.length, 1, 'the actual failed command must survive source journal removal')
      assert.deepEqual(captured[0].data, {
        containerId: runtimeId, soulId: receipt.soulId, incarnationId: receipt.incarnationId,
        journal: 'host-lifecycle.jsonl', raw: { event: 'host.command_failed', data: { code: 'HOST_UNREACHABLE', message: 'prepare input: ENOENT' } },
      })
      const retained = fs.readFileSync(harness.lifecyclePath, 'utf8')
      await harness.cleanup()
      assert.equal(fs.readFileSync(harness.lifecyclePath, 'utf8'), retained)
      assertRemoved(harness, commands)
    })
  })

  it('keeps existing redacted rotations in oldest-to-newest order and private evidence modes', async () => {
    await fixture(async (harness, receipt) => {
      const secret = 'fixture-private-provider-token'
      for (const [index, suffix] of ['.2', '.1', ''].entries()) {
        const event = { event: 'host.connection_error', data: { index, message: `token=${secret}`.replace(secret, '[REDACTED]') } }
        fs.writeFileSync(journal(receipt, suffix), `${JSON.stringify(event)}\n`, { mode: 0o600 })
      }
      const unrelated = path.join(path.dirname(receipt.runtimeDir), 'unreceipted')
      fs.mkdirSync(unrelated)
      fs.writeFileSync(path.join(unrelated, 'host-lifecycle.jsonl'), secret)
      assert.deepEqual(await harness.cleanup(), { ok: true, errors: [] })
      const captured = rows(harness).filter(row => row.event === 'host.lifecycle')
      assert.deepEqual(captured.map(row => row.data.journal), ['host-lifecycle.jsonl.2', 'host-lifecycle.jsonl.1', 'host-lifecycle.jsonl'])
      assert.deepEqual(captured.map(row => row.data.raw.data.index), [0, 1, 2])
      assert.equal(fs.readFileSync(harness.lifecyclePath, 'utf8').includes(secret), false)
      assert.equal(fs.statSync(harness.evidenceDir).mode & 0o777, 0o700)
      assert.equal(fs.statSync(harness.lifecyclePath).mode & 0o777, 0o600)
    })
  })

  it('diagnoses malformed rows without leaking them or preventing exact cleanup and later valid rows', async () => {
    await fixture(async (harness, receipt, commands) => {
      const secret = 'malformed-private-token'
      fs.writeFileSync(journal(receipt), `${secret}\n${JSON.stringify({ event: 'host.connection_error', data: { message: 'frame ended' } })}\n`)
      const cleanup = await harness.cleanup()
      assert.equal(cleanup.ok, false)
      assert.equal(cleanup.errors.some(error => error.includes('INVALID_JSON')), true)
      assert.equal(rows(harness).some(row => row.event === 'host.lifecycle' && row.data.raw.event === 'host.connection_error'), true)
      const diagnostics = rows(harness).filter(row => row.event === 'host.lifecycle.collection_failed')
      assert.equal(diagnostics.some(row => row.data.code === 'INVALID_JSON' && row.data.line === 1), true)
      assert.equal(fs.readFileSync(harness.lifecyclePath, 'utf8').includes(secret), false)
      assert.equal(JSON.stringify(cleanup).includes(secret), false)
      assertRemoved(harness, commands)
    })
  })

  it('allows never-started receipts to lack journals and still completes exact cleanup', async () => {
    await fixture(async (harness, receipt, commands) => {
      assert.deepEqual(await harness.cleanup(), { ok: true, errors: [] })
      assert.equal(rows(harness).filter(row => row.event === 'host.lifecycle').length, 0)
      assert.equal(fs.existsSync(receipt.runtimeDir), false)
      assertRemoved(harness, commands)
    })
  })

  it('uses only its owning trusted supervisor when direct private journal access is denied', async () => {
    await fixture(async (harness, receipt, commands) => {
      fs.writeFileSync(journal(receipt), `${JSON.stringify({ event: 'host.command_failed', data: { code: 'HOST_UNREACHABLE', message: 'private preparation failed' } })}\n`)
      const nativeLstat = fs.lstatSync
      vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, ...args: any[]) => {
        if (String(file).startsWith(journal(receipt))) throw Object.assign(new Error('private journal'), { code: 'EACCES' })
        return (nativeLstat as any)(file, ...args)
      }) as typeof fs.lstatSync)
      assert.deepEqual(await harness.cleanup(), { ok: true, errors: [] })
      assert.equal(rows(harness).filter(row => row.event === 'host.lifecycle').length, 1)
      const calls: string[][] = fs.readFileSync(commands, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.filter(args => args[0] === 'exec').every(args => args[1] === supervisorId), true)
      assert.equal(calls.some(args => args[0] === 'exec'), true)
      assertRemoved(harness, commands)
    })
  })

  it('reports inaccessible journals and rejects symlinks while preserving all cleanup attempts', async () => {
    await fixture(async (harness, receipt, commands) => {
      const secret = path.join(harness.repoRoot, 'private-input')
      fs.writeFileSync(secret, 'private-material-must-not-be-exported')
      fs.symlinkSync(secret, journal(receipt))
      const nativeLstat = fs.lstatSync
      vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, ...args: any[]) => {
        if (String(file) === journal(receipt, '.1')) throw Object.assign(new Error('unavailable'), { code: 'EIO' })
        return (nativeLstat as any)(file, ...args)
      }) as typeof fs.lstatSync)
      const cleanup = await harness.cleanup()
      assert.equal(cleanup.ok, false)
      assert.equal(cleanup.errors.some(error => error.includes('EIO')), true)
      assert.equal(cleanup.errors.some(error => error.includes('NOT_REGULAR')), true)
      assert.equal(fs.readFileSync(harness.lifecyclePath, 'utf8').includes('private-material'), false)
      assertRemoved(harness, commands)
    })
  })
})
