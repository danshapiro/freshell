import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { dispatchNativeFeasibility, nativeFeasibilityCases, parseNativeFeasibilityArguments,
  runNativeFeasibility, nativeCheckpointTranscriptRetained,
  type NativeExperimentOriginal, type NativeSelection } from '../../../../scripts/testing/runtime-native-feasibility.js'

const imageDigest = `sha256:${'a'.repeat(64)}`
const candidateSha = 'b'.repeat(40)
const ownerId = 'unit-finite-child'
const selection: NativeSelection = { mode: 'freshclaude', case: 'startup' }
function child(caseId: string, failure = false): NativeExperimentOriginal {
  const code = `const [caseId,ownerId,imageDigest,candidateSha,failure]=process.argv.slice(1);
    const original={caseId,ownerId,imageDigest,candidateSha,nativeVersion:'fixture-only',
      executableSha256:'c'.repeat(64),profileSha256:'d'.repeat(64),artifactReferences:['fixture://'+process.pid],
      assertions:[{name:'actual-fixture-child-exit',pass:process.pid>0&&failure==='false'}]};
    process.stdout.write(JSON.stringify(original));`
  return JSON.parse(execFileSync(process.execPath, ['-e', code, caseId, ownerId, imageDigest, candidateSha, String(failure)], {
    encoding: 'utf8', timeout: 5_000,
  })) as NativeExperimentOriginal
}

describe('finite native experiment dispatch (fixtures do not qualify providers)', () => {
  it('actual entrypoint prepares finite phase-one artifacts and joins cleanup on preparation failure', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-entry-unit-'))
    const manifest = path.join(directory, 'artifacts.json')
    const previous = process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
    fs.writeFileSync(manifest, JSON.stringify({ candidateSha, imageDigest,
      artifacts: { supervisor: { path: '/fixture/supervisor', sha256: 'c'.repeat(64) },
        host: { path: '/fixture/host', sha256: 'd'.repeat(64) } }, sourceFiles: [] }), { mode: 0o600 })
    process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = manifest
    let selectedPhase: number | undefined
    const prepare = vi.spyOn(RuntimeHarness.prototype, 'prepareNativeArtifacts').mockImplementation(async function () {
      selectedPhase = this.phase
      throw new Error('controlled native preparation failure')
    })
    const cleanup = vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    try {
      await expect(runNativeFeasibility(['--mode', 'freshclaude', '--case', 'startup']))
        .rejects.toThrow('controlled native preparation failure')
      expect(selectedPhase).toBe(1)
      expect(prepare).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      prepare.mockRestore(); cleanup.mockRestore()
      if (previous === undefined) delete process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
      else process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = previous
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each(['freshclaude', 'kilroy'] as const)('sends the logical %s workload and Claude native grants to the actual launch route', async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-logical-mode-'))
    const manifest = path.join(directory, 'artifacts.json')
    const previous = process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
    fs.writeFileSync(manifest, JSON.stringify({ candidateSha, imageDigest,
      artifacts: { supervisor: { path: '/fixture/supervisor', sha256: 'c'.repeat(64) },
        host: { path: '/fixture/host', sha256: 'd'.repeat(64) } }, sourceFiles: [] }), { mode: 0o600 })
    process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = manifest
    let scratch: string | undefined
    const requests: any[] = []
    const prepare = vi.spyOn(RuntimeHarness.prototype, 'prepareNativeArtifacts').mockImplementation(async function () {
      scratch = this.testRoot
      fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
      this.imageRef = imageDigest
      return { supervisorPath: '/fixture/supervisor', hostPath: '/fixture/host', files:
        ['env_file', 'ca_file'].map((suffix) => ({ name: 'claude/grants/' + suffix,
          path: path.join(directory, suffix), sha256: 'e'.repeat(64) })) }
    })
    const start = vi.spyOn(RuntimeHarness.prototype, 'startSupervisor').mockResolvedValue({} as never)
    const write = vi.spyOn(RuntimeHarness.prototype, 'writeArtifact').mockReturnValue('fixture-artifact')
    const admin = vi.spyOn(RuntimeHarness.prototype, 'adminOk').mockImplementation(async (_supervisor, body) => {
      requests.push(body)
      throw new Error('controlled stop after actual launch request')
    })
    const cleanup = vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    try {
      await expect(runNativeFeasibility(['--mode', mode, '--case', 'approval-checkpoint'])).rejects.toThrow('native experiment cases failed')
      expect(requests).toHaveLength(1)
      const launch = requests[0].params
      const logical = mode === 'kilroy' ? 'kilroy' : 'claude'
      expect(launch.provider).toBe(logical)
      expect(launch.freshAgent.provider).toBe(logical)
      expect(launch.freshAgent.sessionType).toBe(mode)
      expect(launch.freshAgent.providerSecretReferences.map((reference: any) => reference.profile))
        .toEqual(['claude_onecli_environment', 'claude_onecli_ca_file'])
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      for (const spy of [prepare, start, write, admin, cleanup]) spy.mockRestore()
      if (previous === undefined) delete process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
      else process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = previous
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  it('prepares only exact private native artifacts and selected source copies without ambient mounts', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-artifact-unit-'))
    execFileSync('git', ['init', '-q', directory])
    const gitOptions = { cwd: directory, encoding: 'utf8' as const }
    const tree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { ...gitOptions, input: '' }).trim()
    const identity = 'Dan Shapiro <3732858+danshapiro@users.noreply.github.com> 1 +0000'
    const fixtureCommit = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'],
      { ...gitOptions, input: 'tree ' + tree + '\nauthor ' + identity + '\ncommitter ' + identity + '\n\nNative artifact unit fixture\n' }).trim()
    execFileSync('git', ['update-ref', 'HEAD', fixtureCommit], gitOptions)
    const bin = path.join(directory, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), '#!' + process.execPath + '\n' +
      `const kind=process.argv[2];if(kind==='info')process.stdout.write('["name=rootless"]');else if(kind==='image')process.stdout.write('${imageDigest}');else process.exit(2);`, { mode: 0o500 })
    const originalPath = process.env.PATH
    process.env.PATH = bin + path.delimiter + originalPath
    const artifact = (name: string, body: string) => {
      const file = path.join(directory, name)
      fs.writeFileSync(file, body, { mode: 0o500 })
      return { path: file, sha256: createHash('sha256').update(body).digest('hex') }
    }
    const supervisor = artifact('fixture-supervisor', 'fixture-only-supervisor')
    const host = artifact('fixture-host', 'fixture-only-host')
    const server = artifact('fixture-server', '#!' + process.execPath + '\nprocess.stdout.write("owned-native-server-fixture");\n')
    const profile = artifact('selected-profile', 'owned-selected-profile-bytes')
    fs.chmodSync(profile.path, 0o600)
    const harness = new RuntimeHarness(directory, randomUUID(), 1)
    try {
      const prepared = await harness.prepareNativeArtifacts({ candidateSha: fixtureCommit, imageDigest, supervisor, host,
        ...{ server },
        sourceFiles: [{ name: 'claude/settings.json', ...profile }] })
      expect(harness.imageRef).toBe(imageDigest)
      expect(fs.readFileSync(harness.testHostBinary, 'utf8')).toBe('fixture-only-host')
      expect(fs.readFileSync(harness.testSupervisorBinary, 'utf8')).toBe('fixture-only-supervisor')
      expect(execFileSync(path.join(harness.buildDir, 'freshell-server-native'), [], { encoding: 'utf8' }))
        .toBe('owned-native-server-fixture')
      expect(prepared.sourceRoot.startsWith(harness.testRoot + path.sep)).toBe(true)
      expect(prepared.files[0]?.path).toBe(path.join(prepared.sourceRoot, 'claude/settings.json'))
      expect(fs.readFileSync(prepared.files[0]!.path, 'utf8')).toBe('owned-selected-profile-bytes')
      expect(fs.statSync(prepared.files[0]!.path).mode & 0o777).toBe(0o600)
      expect(prepared.files.map((file) => file.path)).not.toContain(path.join(os.homedir(), '.claude/settings.json'))
      const withoutServer = new RuntimeHarness(directory, randomUUID(), 1)
      try {
        await withoutServer.prepareNativeArtifacts({ candidateSha: fixtureCommit, imageDigest, supervisor, host,
          sourceFiles: [{ name: 'claude/settings.json', ...profile }] })
        expect(fs.existsSync(path.join(withoutServer.buildDir, 'freshell-server-native'))).toBe(false)
      } finally {
        await withoutServer.cleanup()
        fs.rmSync(withoutServer.testRoot, { recursive: true, force: true })
      }
      await expect(harness.prepareNativeArtifacts({ candidateSha: fixtureCommit, imageDigest, supervisor, host,
        ...{ server }, sourceFiles: [] })).rejects.toThrow('native run already exists')
      for (const fault of ['candidate', 'image', 'phase', 'writable-binary', 'changed-source', 'escaped-name', 'duplicate-name', 'writable-server', 'changed-server', 'missing-server', 'symlink-server']) {
        const denied = new RuntimeHarness(directory, randomUUID(), fault === 'phase' ? 2 : 1)
        const input = { candidateSha: fixtureCommit, imageDigest, supervisor, host, server: { ...server },
          sourceFiles: [{ name: 'claude/settings.json', ...profile }] }
        if (fault === 'candidate') input.candidateSha = 'c'.repeat(40)
        if (fault === 'image') input.imageDigest = `sha256:${'b'.repeat(64)}`
        if (fault === 'writable-binary') fs.chmodSync(host.path, 0o700)
        if (fault === 'writable-server') fs.chmodSync(server.path, 0o700)
        if (fault === 'changed-server') {
          fs.chmodSync(server.path, 0o700)
          fs.writeFileSync(server.path, 'changed-server')
          fs.chmodSync(server.path, 0o500)
        }
        if (fault === 'missing-server') input.server.path = path.join(directory, 'missing-server')
        if (fault === 'symlink-server') {
          input.server.path = path.join(directory, 'server-link')
          fs.symlinkSync(server.path, input.server.path)
        }
        if (fault === 'changed-source') fs.writeFileSync(profile.path, 'changed-source')
        if (fault === 'escaped-name') input.sourceFiles[0]!.name = 'claude/../escaped.json'
        if (fault === 'duplicate-name') input.sourceFiles.push({ ...input.sourceFiles[0]! })
        try {
          await expect(denied.prepareNativeArtifacts(input), fault).rejects.toThrow()
          expect(fs.existsSync(path.join(denied.testRoot, 'native-source')), fault).toBe(false)
          expect(fs.existsSync(denied.buildDir), fault).toBe(false)
        } finally {
          fs.chmodSync(host.path, 0o500)
          fs.chmodSync(server.path, 0o700)
          fs.writeFileSync(server.path, '#!' + process.execPath + '\nprocess.stdout.write("owned-native-server-fixture");\n')
          fs.chmodSync(server.path, 0o500)
          fs.writeFileSync(profile.path, 'owned-selected-profile-bytes')
          await denied.cleanup()
          fs.rmSync(denied.testRoot, { recursive: true, force: true })
        }
      }
    } finally {
      process.env.PATH = originalPath
      await harness.cleanup()
      fs.rmSync(harness.testRoot, { recursive: true, force: true })
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  it('selects the supported provider/mode and refuses real-root and arbitrary command arguments', () => {
    expect(parseNativeFeasibilityArguments(['--mode', 'kilroy', '--case', 'approval-checkpoint']))
      .toEqual({ mode: 'kilroy', case: 'approval-checkpoint' })
    for (const args of [[], ['--provider', 'unknown', '--case', 'startup'],
      ['--provider', 'claude', '--case', 'approval-checkpoint'],
      ['--mode', 'freshcodex', '--case', 'approval-checkpoint'],
      ['--provider', 'claude', '--case', 'startup', '--root', 'real-root'],
      ['--shell', 'anything', '--case', 'startup']]) {
      expect(() => parseNativeFeasibilityArguments(args)).toThrow()
    }
  })

  it('executes every finite child and always joins owned cleanup', async () => {
    const executed: string[] = []
    let cleaned = false
    const originals = await dispatchNativeFeasibility({ selection, imageDigest, candidateSha, ownerId,
      execute: async (caseId) => { executed.push(caseId); return child(caseId) },
      cleanup: async () => { cleaned = true },
    })
    expect(executed).toEqual(nativeFeasibilityCases(selection))
    expect(originals).toHaveLength(executed.length)
    expect(cleaned).toBe(true)
  })

  it('refuses startup-only evidence for a native continuity turn', async () => {
    let cleaned = false
    await expect(dispatchNativeFeasibility({ selection: { mode: 'freshclaude', case: 'native-turn' },
      imageDigest, candidateSha, ownerId, execute: async (caseId) => child(caseId),
      cleanup: async () => { cleaned = true },
    })).rejects.toThrow()
    expect(cleaned).toBe(true)
  })

  it.each(['failed-assertion', 'child-timeout', 'foreign-owner', 'incomplete-provenance'])(
    'refuses %s without reporting success and still cleans owned resources', async (fault) => {
      let cleaned = false
      await expect(dispatchNativeFeasibility({ selection, imageDigest, candidateSha, ownerId,
        execute: async (caseId) => {
          if (fault === 'child-timeout') throw new Error('child timeout')
          const original = child(caseId, fault === 'failed-assertion')
          if (fault === 'foreign-owner') original.ownerId = 'unowned-real-store'
          if (fault === 'incomplete-provenance') original.executableSha256 = ''
          return original
        }, cleanup: async () => { cleaned = true },
      })).rejects.toThrow()
      expect(cleaned).toBe(true)
    },
  )
})

describe('original native checkpoint byte continuity (fixtures do not qualify providers)', () => {
  const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const toolUseID = 'toolu_original1'
  const bytes = Buffer.from(JSON.stringify({ type: 'attachment', sessionId: root,
    attachment: { type: 'hook_deferred_tool', toolUseID } }) + '\n')
  const snapshot = (raw: Buffer, device = '2065', inode = '42') => ({ nativeRoot: root,
    transcript: { bytesBase64: raw.toString('base64'), sha256: createHash('sha256').update(raw).digest('hex'),
      completeEof: raw.at(-1) === 10, identity: [device, inode, String(raw.length)] } })
  const lifecycle = Buffer.from(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: root }) + '\n'
    + JSON.stringify({ type: 'attachment', sessionId: root, attachment: { type: 'hook_success' } }) + '\n')
  it('retains the original EOF bytes and inode when native resume appends only lifecycle rows', () => {
    expect(nativeCheckpointTranscriptRetained(snapshot(bytes), snapshot(bytes), toolUseID)).toBe(true)
    expect(nativeCheckpointTranscriptRetained(snapshot(bytes), snapshot(Buffer.concat([bytes, lifecycle])), toolUseID)).toBe(true)
  })
  it.each(['mutation', 'truncation', 'replacement', 'device', 'incomplete-eof', 'tool-result', 'new-checkpoint', 'wrong-root', 'malformed-tail', 'wrong-tail-root', 'new-assistant', 'missing-identity'])(
    'refuses actual %s before an approval decision', (fault) => {
      const before = snapshot(bytes)
      let raw = Buffer.concat([bytes, lifecycle])
      if (fault === 'mutation') { raw = Buffer.from(raw); raw[10] ^= 1 }
      if (fault === 'truncation') raw = bytes.subarray(0, bytes.length - 2)
      if (fault === 'incomplete-eof') raw = raw.subarray(0, raw.length - 1)
      if (fault === 'tool-result') raw = Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'user', sessionId: root,
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: true }] } }) + '\n')])
      if (fault === 'new-checkpoint') raw = Buffer.concat([bytes, bytes])
      if (fault === 'malformed-tail') raw = Buffer.concat([bytes, Buffer.from('{broken\n')])
      if (fault === 'wrong-tail-root') raw = Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'queue-operation',
        operation: 'enqueue', sessionId: 'different-native-root' }) + '\n')])
      if (fault === 'new-assistant') raw = Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'assistant', sessionId: root }) + '\n')])
      const after = snapshot(raw, fault === 'device' ? '2066' : '2065', fault === 'replacement' ? '43' : '42')
      if (fault === 'wrong-root') after.nativeRoot = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      if (fault === 'missing-identity') { before.transcript.identity = []; after.transcript.identity = [] }
      expect(nativeCheckpointTranscriptRetained(before, after, toolUseID)).toBe(false)
    })
})
