import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { dispatchNativeFeasibility, nativeFeasibilityCases, parseNativeFeasibilityArguments,
  runNativeFeasibility, executeManagedNativeCase, executeManagedNativeApproval, nativeCheckpointTranscriptRetained, nativeTwoToolBatchMatches, amplifierNativeProfileRetained,
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
  it('sends terminal Claude through its own real launch route with the selected profile', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-claude-route-'))
    const launch = vi.fn(async (_supervisor: unknown, request: any) => {
      expect(request.params.terminal.providerBootstrapFiles).toBeUndefined()
      const selected = request.params.terminal.providerLaunchContext.config.find((file: any) => file.providerRelativePath === '.claude.json')
      expect(selected.root).toBe('workspace')
      const preferences = JSON.parse(fs.readFileSync(path.join(request.params.terminal.cwd, selected.relativePath), 'utf8'))
      expect(preferences.projects[request.params.terminal.cwd].hasTrustDialogAccepted).toBe(true)
      throw new Error('controlled terminal launch boundary')
    })
    const harness = { testRoot: directory, startSupervisor: async () => ({}), writeArtifact: () => '', adminOk: launch } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({
      name: 'claude/' + name, path: path.join(directory, path.basename(name)), sha256: 'e'.repeat(64) }))
    fs.writeFileSync(sources[2]!.path, JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true,
      projects: { [path.join(directory, 'claude-create-workspace')]: { hasTrustDialogAccepted: true } } }))
    try {
      await expect(executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, 'create'))
        .rejects.toThrow('controlled terminal launch boundary')
      expect(launch).toHaveBeenCalledOnce()
      const request = (launch.mock.calls[0] as any)[1]
      expect(request.params.provider).toBe('claude')
      expect(request.params.terminal.mode).toBe('claude')
      expect(request.params.terminal.resumeSessionId).toBeUndefined()
      expect(request.params.fixture).toBeUndefined()
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it('captures current provider-owned terminal signals before a startup refusal tears down the enclosure', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-signal-failure-'))
    const source = path.join(directory, 'preferences.json')
    fs.writeFileSync(source, '{}')
    const records = new Map<string, unknown>()
    const capture = vi.fn(async (_container: string, uid: string) => {
      expect(uid).toBe('65534:0')
      return JSON.stringify({ processes: [{ pid: 7, signals: [] }] })
    })
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 60_000)
    const harness = { testRoot: directory, startSupervisor: async () => ({}),
      writeArtifact: (name: string, value: unknown) => records.set(name, value),
      adminOk: async (_supervisor: unknown, request: any) => {
        if (request.method === 'launch') return { data: { view: { containerId: 'owned-native-container', recoveryState: 'live' } } }
        if (request.method === 'inventory') return { data: [] }
        return { data: {} }
      }, execOwnedContainerAsExact: capture,
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({ name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      await expect(executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, 'create'))
        .rejects.toThrow('terminal Claude current post-load observation missing')
      expect(capture).toHaveBeenCalledOnce()
      expect(capture.mock.calls[0]?.[0]).toBe('owned-native-container')
      expect(records.get('claude-create-signal-native-private.json')).toEqual({ processes: [{ pid: 7, signals: [] }] })
    } finally { clock.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it('refreshes the current host observation before reading terminal inventory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-observation-refresh-'))
    const source = path.join(directory, 'preferences.json'); fs.writeFileSync(source, '{}')
    let request: any
    let refreshed = false
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 25_000)
    const view = () => ({ soulId: request.params.soulId, containerId: 'owned-container', incarnationId: 'owned-incarnation',
      recoveryState: 'live', nativeSessionId: request.params.nativeSessionId,
      nativeIdentityObservation: refreshed ? { nativeSessionId: request.params.nativeSessionId,
        incarnationId: 'owned-incarnation', source: 'claude_native_event' } : undefined })
    const harness = { testRoot: directory, startSupervisor: async () => ({}), writeArtifact: () => '',
      inventoryBody: () => ({ method: 'inventory' }), terminalReadOutputBody: () => ({ method: 'terminal_read_output' }),
      probeRecoveryBody: () => ({ method: 'probe_recovery' }),
      adminOk: async (_supervisor: unknown, body: any) => {
        if (body.method === 'launch') { request = body; return { data: { view: view() } } }
        if (body.method === 'probe_recovery') { refreshed = true; return { data: { kind: 'unknown' } } }
        return { data: body.method === 'inventory' ? [view()] : {} }
      },
      execOwnedContainerAsExact: async (_container: string, _uid: string, args: string[]) => JSON.stringify(args.at(-1) === 'terminal'
        ? { uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true, httpsStatus: 200,
          tlsVerifyMode: 2, tlsCheckHostname: true, version: '2.1.263', executableSha256: 'f'.repeat(64), profileFiles: [],
          hook: { launch: {} }, loaded: { launch: {}, native: { version: '2.1.263', session_id: request.params.nativeSessionId,
            model: { id: 'claude-haiku-4-5-20251001' }, workspace: { current_dir: request.params.terminal.cwd } } } }
        : { processes: [] }),
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({ name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      const original = await executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, 'create')
      expect(refreshed).toBe(true)
      expect(original.assertions.every((assertion) => assertion.pass)).toBe(true)
    } finally { clock.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['death', 'published', 'cached', 'redispatch'])('protects the native post-effect observation boundary (%s)', async (fault) => {
    const publishedOutcome = fault === 'published'
    const recover = fault === 'cached' || fault === 'redispatch'
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'native-effect-edge-'))
    const command = `printf 'effect\\n' >> '${path.join(workspace, 'owned-native-effect.jsonl')}'`
    const toolUseID = 'toolu_original1'
    const nativeRoot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const methods: string[] = []
    let read = false
    const payload = { tool: { name: 'Bash', input: { command } }, toolUseID,
      nativeCheckpoint: { nativeSessionId: nativeRoot, toolUseID }, nativeRequestId: 'current-native-request' }
    const harness = { writeArtifact: () => '',
      freshAgentResolveBody: (_soul: string, decision: string, value: unknown) => ({ method: 'fresh_agent_resolve', params: { decision, value } }),
      probeRecoveryBody: () => ({ method: 'probe_recovery' }),
      recoverBody: () => ({ method: 'recover' }),
      adminOk: async (_supervisor: unknown, body: any) => {
        methods.push(body.method)
        if (body.method === 'fresh_agent_read_events') {
          if (read && recover) return { data: { head: 2, events: fault === 'redispatch' && methods.filter((m) => m === 'fresh_agent_read_events').length > 2
            ? [{ event: { kind: 'provider', data: { payload: { event: { type: 'freshAgent.permission.dispatch', ok: true } } } } }] : [] } }
          if (read) throw new Error('unexpected observation read after parked card')
          read = true
          return { data: { head: 1, events: [{ event: { kind: 'permission_requested', data: { decision_id: 'current-card', payload } } }] } }
        }
        if (body.method === 'fresh_agent_resolve') {
          expect(body.params.decision).toBe('current-card')
          expect(body.params.value).toEqual({ behavior: 'allow', updatedInput: { command } })
          fs.writeFileSync(path.join(workspace, 'owned-native-effect.jsonl'), 'effect\n')
          fs.writeFileSync(path.join(workspace, 'native-after-effect-before-observation.json'), JSON.stringify({
            hook_event_name: 'PostToolUse', session_id: nativeRoot, tool_name: 'Bash', tool_use_id: toolUseID, tool_input: { command } }))
        }
        if (body.method === 'recover') return { data: { outcome: 'replaced', view: {
          incarnationId: 'new-incarnation', containerId: 'replacement-container', nativeSessionId: nativeRoot,
          recoveryState: 'live', nativeIdentityObservation: { nativeSessionId: nativeRoot } } } }
        return { data: { kind: 'reattach_ready' } }
      },
      adminRaw: async () => { methods.push('cached-decision-resolve'); return { result: { Ok: { kind: 'fresh_agent_command', data: { state: 'completed' } } } } },
      waitForFile: async (file: string) => { expect(fs.existsSync(file)).toBe(true) },
      execOwnedContainerAsExact: async (_container: string, uid: string, args: string[]) => {
        const bytes = Buffer.from(JSON.stringify(uid === '0:0' ? { decisions: { 'current-card': { state: 'resolved',
          responseDigest: createHash('sha256').update(JSON.stringify({ behavior: 'allow', updatedInput: { command } })).digest('hex') } } }
          : { phase: 'dispatching', nativeSessionId: nativeRoot, toolUseID }))
        return JSON.stringify({ path: args.at(-1), readerUid: Number(uid.split(':')[0]), bytesBase64: bytes.toString('base64'),
          sha256: createHash('sha256').update(bytes).digest('hex') })
      },
      killOwnedRuntimeExact: async () => { if (!recover) throw new Error('controlled exact native death') },
      waitForContainerExit: async () => {},
    } as unknown as RuntimeHarness
    const rows = [{ type: 'assistant', sessionId: nativeRoot, message: { id: 'msg_original',
      content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input: { command } }] } },
    { type: 'attachment', sessionId: nativeRoot, attachment: { type: 'hook_deferred_tool', toolUseID } }]
    const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const nativeBytes = publishedOutcome ? Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'user', sessionId: nativeRoot,
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: false }] } }) + '\n')]) : bytes
    try {
      const run = executeManagedNativeApproval({ harness, supervisor: {}, soulId: 'owned-soul', workspace,
        view: { incarnationId: 'old-incarnation', nativeSessionId: nativeRoot, containerId: 'owned-container' }, scenario: 'controlled-effect-edge',
        decision: 'effect-before-observation', inspect: async () => ({ nativeRoot,
          transcript: { bytesBase64: nativeBytes.toString('base64'), sha256: createHash('sha256').update(nativeBytes).digest('hex'), completeEof: true } }) })
      if (fault === 'cached') await expect(run).resolves.toBeDefined()
      else await expect(run).rejects.toThrow(publishedOutcome ? 'post-effect native outcome was already published'
        : fault === 'redispatch' ? 'native decision dispatched again after its effect' : 'controlled exact native death')
      if (recover) {
        expect(methods.filter((m) => m === 'fresh_agent_resolve')).toHaveLength(1)
        expect(methods.filter((m) => m === 'cached-decision-resolve')).toHaveLength(1)
        expect(fs.readFileSync(path.join(workspace, 'owned-native-effect.jsonl'), 'utf8')).toBe('effect\n')
      } else expect(methods).toEqual(['fresh_agent_send', 'fresh_agent_read_events', 'fresh_agent_resolve', ...(publishedOutcome ? [] : ['probe_recovery'])])
    } finally { fs.rmSync(workspace, { recursive: true, force: true }) }
  })
  it.each(['changed-tool', 'missing-tool', 'changed-input', 'changed-profile', 'changed-root', 'stale-callback',
    'crash-before-checkpoint', 'multiple-tools', 'effect-before-observation', 'exact-resume'])(
    'dispatches %s through the managed native launch boundary', async (caseId) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-negative-route-'))
      const launch = vi.fn(async (_supervisor: unknown, _body: any) => { throw new Error('controlled native launch boundary') })
      const harness = { testRoot: directory, startSupervisor: async () => ({}),
        writeArtifact: () => '', adminOk: launch } as unknown as RuntimeHarness
      try {
        await expect(executeManagedNativeCase(harness,
          ['env_file', 'ca_file'].map((suffix) => ({ name: 'claude/grants/' + suffix,
            path: path.join(directory, suffix), sha256: 'e'.repeat(64) })),
          { mode: 'freshclaude', case: caseId === 'exact-resume' ? 'startup' : 'approval-checkpoint' }, caseId))
          .rejects.toThrow('controlled native launch boundary')
        expect(launch).toHaveBeenCalledOnce()
        expect(launch.mock.calls[0]![1].params.freshAgent.sessionType).toBe('freshclaude')
      } finally { fs.rmSync(directory, { recursive: true, force: true }) }
    })
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
  it('recognizes two actual native tool rows sharing one model message without combining unrelated turns', () => {
    const commands = ['first independent command', 'second independent command']
    const row = (command: string, id: string, messageId = 'msg_actual_batch', name = 'Bash') => ({
      type: 'assistant', sessionId: root, message: { id: messageId,
        content: [{ type: 'tool_use', id, name, input: { command } }] } })
    const native = (rows: unknown[]) => snapshot(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'))
    const first = row(commands[0]!, 'toolu_first1'); const second = row(commands[1]!, 'toolu_second1')
    expect(nativeTwoToolBatchMatches(native([first, second]), commands)).toBe(true)
    expect(nativeTwoToolBatchMatches(native([{ ...first, message: { ...first.message,
      content: [...first.message.content, ...second.message.content] } }]), commands)).toBe(true)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_second1', 'msg_next_turn')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[0]!, 'toolu_second1')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_first1')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_second1', '', 'Bash')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_second1', 'msg_actual_batch', 'Read')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, { ...second, sessionId: 'other-root' }]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches({ ...native([first, second]), transcript: {
      ...native([first, second]).transcript, sha256: 'f'.repeat(64) } }, commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, second]), [commands[0]!, commands[0]!])).toBe(false)
  })
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

describe('selected native Amplifier profile continuity (fixture metadata only)', () => {
  const workspace = '/owned/native-workspace'
  const files = (settings = 'a'.repeat(64), keys = 'b'.repeat(64)) => [
    { relative: '.amplifier/settings.yaml', sha256: settings },
    { relative: '.amplifier/bundles/default.yaml', sha256: 'c'.repeat(64) },
    { relative: '.amplifier/keys.env', sha256: keys },
  ]
  const before = () => ({ nativeCwd: workspace, nativeSettingsSha256: 'd'.repeat(64), profileFiles: files() })
  it('uses the full native resolved settings while preserving bundle and workspace when saved secret aliases normalize', () => {
    const old = before()
    const current = { ...before(), profileFiles: files('e'.repeat(64), 'f'.repeat(64)) }
    expect(amplifierNativeProfileRetained(old, current, workspace)).toBe(true)
  })
  it.each(['resolved-settings', 'bundle', 'workspace', 'missing-native-profile', 'missing-file', 'duplicate-file', 'invalid-digest'])(
    'refuses changed %s rather than treating raw-byte differences alone as harmless', (fault) => {
      const old = before(); const current = before()
      if (fault === 'resolved-settings') current.nativeSettingsSha256 = 'e'.repeat(64)
      if (fault === 'bundle') current.profileFiles[1]!.sha256 = 'e'.repeat(64)
      if (fault === 'workspace') current.nativeCwd = '/different/owned/workspace'
      if (fault === 'missing-native-profile') current.nativeSettingsSha256 = ''
      if (fault === 'missing-file') current.profileFiles.pop()
      if (fault === 'duplicate-file') current.profileFiles[2] = { ...current.profileFiles[0]! }
      if (fault === 'invalid-digest') current.nativeSettingsSha256 = 'unqualified'
      expect(amplifierNativeProfileRetained(old, current, workspace)).toBe(false)
    })
})
