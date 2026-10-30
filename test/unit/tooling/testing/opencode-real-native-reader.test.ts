import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import * as stream from 'node:stream'
import * as streamPromises from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { readNativeRehearsal, REAL_NATIVE_READER } from '../../../../scripts/testing/opencode-restoration-rehearsal.js'
import type { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'

// This portable fixture exercises reader control and real streaming filesystem
// operations. Pinned provider/UID/capability proof is a separate owned Docker
// fixture; these deliberately fake child and identity boundaries cannot qualify it.
async function fixture(mode: 'complete' | 'repeated' | 'empty' | 'failed-cli' | 'signaled' | 'spawn-error' | 'failed-validation') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reader-control-'))
  const map = (file: string | Buffer | URL | number) => typeof file === 'string' && file.startsWith('/scratch/') ? path.join(directory, path.basename(file)) : file
  const nativeFs = { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => fs.openSync(map(args[0]) as string, args[1], args[2]),
    readFileSync: (file: string, ...args: unknown[]) => file === '/proc/self/status' ? 'CapEff:\t00000000\nNoNewPrivs:\t1\n' : Reflect.apply(fs.readFileSync, fs, [map(file), ...args]),
    writeFileSync: (file: string, ...args: unknown[]) => Reflect.apply(fs.writeFileSync, fs, [map(file), ...args]),
    appendFileSync: (file: string, ...args: unknown[]) => Reflect.apply(fs.appendFileSync, fs, [map(file), ...args]),
    createWriteStream: (file: string, options: Parameters<typeof fs.createWriteStream>[1]) => fs.createWriteStream(map(file) as string, options),
  }
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
    kill: (signal: string) => { child.signalCode = signal; queueMicrotask(() => child.emit('close', null, signal)); return true } })
  let stdout = '', stderr = '', closed = false, gets = 0, exports = 0
  child.on('close', () => { closed = true })
  const fakeProcess = { argv: ['node', '/scratch/request.json', '/scratch/result.json'], getuid: () => 65534, getgid: () => 0,
    env: { OPENAI_API_KEY: 'literal-fixture-credential' },
    stdout: { write: (value: string) => { stdout += value } }, stderr: { write: (value: string) => { stderr += value } }, exitCode: 0 }
  const info = { id: 'ses_one' }, messages = [0, 1].map(index => ({ info: { id: `msg_${index}`, sessionID: 'ses_one' }, parts: [] }))
  fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ descriptorFile: '/scratch/descriptor.json', rootSessionId: 'ses_one', workspacePath: directory, destinationDatabase: '/scratch/store.sqlite', nativeBudgetMs: 10_000 }))
  fs.writeFileSync(path.join(directory, 'descriptor.json'), JSON.stringify({ sourceGeneration: 'f'.repeat(64), manifestJson: JSON.stringify({ rows: [
    { table: 'session', key: [{ value: 'ses_one' }] }, ...messages.map(message => ({ table: 'message', key: [{ value: message.info.id }] })),
  ] }) }))
  const cp = {
    execFileSync: () => '1.18.21\n',
    spawn: () => { if (mode === 'spawn-error') queueMicrotask(() => { child.emit('error', new Error('owned spawn failed')); child.emit('close', -1) }); return child },
    spawnSync: (command: string, _args: string[], options: { stdio?: unknown[] }) => {
      if (command === 'opencode') {
        exports++
        if (mode === 'failed-cli') return { status: 7, stderr: Buffer.from('owned CLI failure') }
        fs.writeSync(options.stdio![1] as number, JSON.stringify({ info, messages }))
      }
      if (command === '/opt/transfer-stage' && mode === 'failed-validation') {
        // A normal controlled validator child writes its real failure file and
        // exits. No host process is signaled or killed by this fixture.
        return spawnSync(process.execPath, ['-e',
          'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({severity:"error",event:"opencode.rehearsal.stage_refused",detail:"distinctive part projection difference; api_key=literal-fixture-credential"}));process.stderr.write("distinctive validator stderr");process.exitCode=1',
          path.join(directory, 'native-ses_one-validation-error.json')], { encoding: 'utf8', timeout: 5_000 })
      }
      return { status: 0, stdout: '{"status":"complete"}' }
    },
  }
  const fetch = async (url: string) => {
    if (url.endsWith('/global/health')) return new Response('{}')
    if (!url.includes('/message')) {
      if (mode === 'signaled') { child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('close', null, 'SIGTERM')) }
      return new Response(JSON.stringify(info))
    }
    if (mode === 'signaled') throw new Error('owned server already signaled')
    const page = gets++
    const cursor = mode === 'repeated' ? 'same-cursor' : mode === 'empty' ? '' : page === 0 ? 'next-cursor' : null
    return new Response(JSON.stringify([messages[page % 2]]), { headers: cursor === null ? {} : { 'x-next-cursor': cursor } })
  }
  try {
    await runInNewContext(REAL_NATIVE_READER, { require: (name: string) => ({ 'node:fs': nativeFs, 'node:child_process': cp,
      'node:crypto': { createHash }, 'node:stream': stream, 'node:stream/promises': streamPromises }[name]),
      process: fakeProcess, Buffer, fetch, AbortSignal, setTimeout, clearTimeout })
    const result = fs.existsSync(path.join(directory, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8')) : undefined
    return { result, stdout, stderr, exitCode: fakeProcess.exitCode, closed, gets, exports,
      privateDiagnostic: fs.existsSync(path.join(directory, 'native-failure-private.json'))
        ? JSON.parse(fs.readFileSync(path.join(directory, 'native-failure-private.json'), 'utf8')) : undefined,
      aggregate: result ? JSON.parse(fs.readFileSync(path.join(directory, 'native-ses_one-read.json'), 'utf8')) : undefined }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

describe('streamed complete native-reader lifecycle', () => {
  it('retains an actual validator child cause and execution details after reader teardown', async () => {
    const actual = await fixture('failed-validation')
    expect(actual.closed).toBe(true); expect(actual.exitCode).toBe(1); expect(actual.result).toBeUndefined()
    expect(actual.privateDiagnostic).toMatchObject({
      validation: { diagnostic: { detail: expect.stringContaining('distinctive part projection difference') },
        execution: { status: 1, signal: null, stderr: 'distinctive validator stderr' } },
      error: { message: 'native exact artifact validation failed' },
    })
    expect(JSON.stringify(actual.privateDiagnostic)).not.toContain('literal-fixture-credential')
    expect(actual.stderr).toContain('native_read_failed')
    expect(actual.stderr).not.toContain('distinctive')
  })

  it('captures the reader cause through the production caller before its provider volume disappears', async () => {
    const actual = await fixture('failed-validation')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reader-capture-'))
    const provider = path.join(directory, 'provider'); fs.mkdirSync(provider)
    const diagnostic = path.join(provider, 'native-failure-private.json')
    fs.writeFileSync(diagnostic, JSON.stringify(actual.privateDiagnostic ?? null))
    const execution = Object.assign(new Error('distinctive owned exec failure literal-fixture-credential'), { status: 1, signal: null, stderr: 'native_read_failed' })
    const captures: string[] = []
    const harness = { execTransferProviderExact: () => { throw execution },
      captureTransferFileExact: async (_id: string, source: string, destination: string) => {
        captures.push(source)
        fs.copyFileSync(path.join(provider, path.basename(source)), destination)
      } } as unknown as RuntimeHarness
    try {
      await expect(readNativeRehearsal(harness, 'owned-fixture', directory,
        { rootSessionId: 'ses_one', candidateSha: 'a'.repeat(40), imageDigest: 'sha256:' + 'b'.repeat(64) }, ['literal-fixture-credential']))
        .rejects.toBe(execution)
      fs.rmSync(provider, { recursive: true })
      expect(captures).toContain('/scratch/native-failure-private.json')
      const saved = fs.readFileSync(path.join(directory, 'native-failure-private.json'), 'utf8')
      expect(saved).toContain('distinctive part projection difference')
      const failure = fs.readFileSync(path.join(directory, 'native-failure.json'), 'utf8')
      expect(failure).toContain('distinctive owned exec failure')
      expect(saved + failure).not.toContain('literal-fixture-credential')
      expect(fs.statSync(path.join(directory, 'native-failure-private.json')).mode & 0o077).toBe(0)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it('exhausts all cursor pages and retains full GET and original CLI bytes only after child closure', async () => {
    const actual = await fixture('complete')
    expect(actual.gets).toBe(2); expect(actual.exports).toBe(1); expect(actual.closed).toBe(true)
    expect(actual.exitCode).toBe(0); expect(actual.result.nativeReadableSessionCount).toBe(1)
    expect(actual.aggregate.pages.flat().map((message: { info: { id: string } }) => message.info.id)).toEqual(['msg_0', 'msg_1'])
  })
  it.each(['repeated', 'empty', 'failed-cli', 'signaled', 'spawn-error'] as const)('refuses %s without an artifact receipt and settles the child', async mode => {
    const actual = await fixture(mode)
    expect(actual.exitCode).toBe(1); expect(actual.result).toBeUndefined(); expect(actual.stdout).toBe('')
    expect(actual.stderr).toContain('native_refused'); expect(actual.closed).toBe(true)
  })
})
