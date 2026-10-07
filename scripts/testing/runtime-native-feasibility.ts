import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { createConnection } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { RuntimeHarness } from './runtime-sandbox.js'

export type NativeProvider = 'claude' | 'codex' | 'opencode' | 'amplifier'
export type NativeMode = 'freshclaude' | 'kilroy' | 'freshcodex' | 'freshopencode'
export type NativeExperimentCase = 'startup' | 'native-turn' | 'approval-checkpoint'
export type NativeSelection = { provider?: NativeProvider; mode?: NativeMode; case: NativeExperimentCase }
export type NativeExperimentOriginal = {
  caseId: string
  ownerId: string
  imageDigest: string
  candidateSha: string
  nativeVersion: string
  executableSha256: string
  profileSha256: string
  artifactReferences: string[]
  assertions: { name: string; pass: boolean }[]
}

export function parseNativeFeasibilityArguments(args: readonly string[]): NativeSelection {
  if (args.length !== 4 || !['--provider', '--mode'].includes(args[0] ?? '') || args[2] !== '--case') {
    throw new Error('usage: runtime-native-feasibility --provider claude|codex|opencode|amplifier OR --mode freshclaude|kilroy|freshcodex|freshopencode --case startup|native-turn|approval-checkpoint')
  }
  const cases = ['startup', 'native-turn', 'approval-checkpoint']
  if (!cases.includes(args[3]!)) throw new Error('unknown finite native case')
  const selected = args[1]!
  if (args[0] === '--provider') {
    if (!['claude', 'codex', 'opencode', 'amplifier'].includes(selected) || args[3] === 'approval-checkpoint') {
      throw new Error('unsupported native provider/case')
    }
    return { provider: selected as NativeProvider, case: args[3] as NativeExperimentCase }
  }
  if (!['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'].includes(selected)
    || (args[3] === 'approval-checkpoint' && !['freshclaude', 'kilroy'].includes(selected))) {
    throw new Error('unsupported native mode/case')
  }
  return { mode: selected as NativeMode, case: args[3] as NativeExperimentCase }
}

export function nativeFeasibilityCases(selection: NativeSelection): readonly string[] {
  if (selection.case === 'native-turn') return ['current-native-turn']
  if (selection.case === 'approval-checkpoint') return [
    'allow', 'deny', 'crash-before-checkpoint', 'changed-tool', 'missing-tool', 'changed-input',
    'changed-profile', 'changed-root', 'multiple-tools', 'stale-callback', 'effect-before-observation',
  ]
  if (selection.provider === 'claude') return [
    'create', 'exact-resume', 'fork-root', 'wrong-root', 'stale-shared-signal', 'disabled-hooks',
    'trust-refusal', 'unwritable-signal', 'timeout', 'provider-exit', 'stop-cancellation', 'restoration-failure-after-hook',
  ]
  if (selection.provider === 'amplifier') return [
    'create', 'exact-resume', 'wrong-root', 'missing-history', 'missing-context-restore', 'load-failure',
    'timeout', 'provider-exit', 'stop-cancellation', 'file-replacement', 'file-truncation', 'old-writer',
    'malformed-ack', 'parent-root', 'native-followup',
  ]
  if (selection.mode === 'freshclaude' || selection.mode === 'kilroy') return [
    'create', 'exact-resume', 'wrong-id', 'missing-native-id', 'placeholder-id', 'disabled-hooks',
    'restoration-failure-after-hook', 'timeout-50s', 'provider-exit', 'stop-cancellation',
  ]
  if (selection.provider === 'opencode') return [
    'null-slot', 'disposal', 'root-load-error', 'history-load-error', 'v1-empty', 'v2-empty-is-not-v1-empty',
    'full-revert', 'part-revert', 'baseline-only-resume', 'stale-observation', 'cancellation',
  ]
  return ['create', 'exact-resume', 'wrong-root', 'cancellation']
}

/** Finite process dispatcher only; fixture children never establish native qualification. */
export async function dispatchNativeFeasibility(input: {
  selection: NativeSelection
  imageDigest: string
  candidateSha: string
  ownerId: string
  execute: (caseId: string) => Promise<NativeExperimentOriginal>
  cleanup: () => Promise<void>
}): Promise<NativeExperimentOriginal[]> {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) || !/^[a-f0-9]{40}$/.test(input.candidateSha)
    || !input.ownerId || !!input.selection.mode === !!input.selection.provider) {
    throw new Error('exact candidate, image, owner and one finite selector required')
  }
  parseNativeFeasibilityArguments([input.selection.mode ? '--mode' : '--provider',
    input.selection.mode ?? input.selection.provider!, '--case', input.selection.case])
  const originals: NativeExperimentOriginal[] = []
  const failures: string[] = []
  const requiredAssertions = input.selection.case === 'native-turn' ? [
    'readable-completed-native-store-before-death', 'replacement-new-incarnation-same-native-root',
    'original-owned-volume-transcript-continuity', 'same-workspace-selected-native-profile',
    'actual-restored-context-private-marker-recall', 'native-turns-requested-no-tools',
  ] : []
  try {
    for (const caseId of nativeFeasibilityCases(input.selection)) {
      try {
        const original = await input.execute(caseId)
        originals.push(original)
        if (original.caseId !== caseId || original.ownerId !== input.ownerId
          || original.imageDigest !== input.imageDigest || original.candidateSha !== input.candidateSha
          || !original.nativeVersion || !/^[a-f0-9]{64}$/.test(original.executableSha256)
          || !/^[a-f0-9]{64}$/.test(original.profileSha256) || original.artifactReferences.length === 0
          || original.assertions.length === 0 || original.assertions.some((assertion) => !assertion.pass)
          || requiredAssertions.some((name) => !original.assertions.some((assertion) => assertion.name === name && assertion.pass))) {
          failures.push(caseId)
        }
      } catch {
        failures.push(caseId)
      }
    }
  } finally {
    await input.cleanup()
  }
  if (failures.length > 0 || originals.length !== nativeFeasibilityCases(input.selection).length) {
    throw new Error(`native experiment cases failed: ${failures.join(',')}`)
  }
  return originals
}

export async function runNativeFeasibility(args = process.argv.slice(2)): Promise<void> {
  const selection = parseNativeFeasibilityArguments(args)
  const manifestPath = process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
  if (!manifestPath || !path.isAbsolute(manifestPath) || fs.realpathSync(manifestPath) !== manifestPath
    || !fs.lstatSync(manifestPath).isFile()) throw new Error('exact private native artifact manifest required')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    candidateSha: string; imageDigest: string
    artifacts: { supervisor: { path: string; sha256: string }; host: { path: string; sha256: string }; server?: { path: string; sha256: string } }
    sourceFiles: { name: string; path: string; sha256: string }[]
  }
  const harness = new RuntimeHarness(process.cwd(), undefined, 1)
  const servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []
  try {
    const prepared = await harness.prepareNativeArtifacts({ candidateSha: manifest.candidateSha,
      imageDigest: manifest.imageDigest, supervisor: manifest.artifacts.supervisor, host: manifest.artifacts.host,
      ...(manifest.artifacts.server ? { server: manifest.artifacts.server } : {}),
      sourceFiles: manifest.sourceFiles })
    harness.writeArtifact('native-selection.json', selection)
    const originals = await dispatchNativeFeasibility({ selection, imageDigest: manifest.imageDigest,
      candidateSha: manifest.candidateSha, ownerId: harness.runId,
      execute: async (caseId) => {
        try { return await executeManagedNativeCase(harness, prepared.files, selection, caseId, prepared.serverPath, servers) }
        catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown native case failure'
          harness.writeArtifact(`native-case-${caseId}-failure.json`, { severity: 'error',
            event: 'runtime.native_feasibility.case_failed', caseId, reason })
          throw error
        }
      },
      cleanup: async () => {},
    })
    harness.writeArtifact('native-originals.json', originals)
  } finally {
    const serverCleanupErrors: string[] = []
    for (const owned of servers) {
      harness.writeArtifact(`${owned.scope}-server-output-private.json`, owned.server.capturedOutput())
      if (owned.pid === undefined) {
        try { owned.pid = owned.server.processEvidence().pid } catch { /* Failed startup may have already joined its child. */ }
      }
      try { await owned.server.stop() } catch (error) { serverCleanupErrors.push(String(error)) }
      const absent = owned.pid === undefined ? null : !fs.existsSync(`/proc/${owned.pid}`)
      harness.writeArtifact(`${owned.scope}-server-cleanup.json`, { pid: owned.pid, absent })
      if (absent === false) serverCleanupErrors.push('owned native server did not stop')
    }
    const containers = new Set([...harness.transferOwnedIds().containers,
      ...(harness.broker?.receipts() ?? []).map((receipt) => receipt.containerId)])
    for (const containerId of containers) {
      try { fs.writeFileSync(path.join(harness.evidenceDir, `native-container-${containerId}.log`),
        await harness.containerLogs(containerId), { mode: 0o600 }) }
      catch { /* Cleanup still joins when an already-owned enclosure exited. */ }
    }
    const cleanup = await harness.cleanup()
    if (!cleanup.ok) throw new Error(`native owned cleanup failed: ${cleanup.errors.join('; ')}`)
    if (serverCleanupErrors.length) throw new Error(`native server cleanup failed: ${serverCleanupErrors.join('; ')}`)
  }
}

async function executeManagedNativeCase(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], selection: NativeSelection,
  caseId: string, serverPath?: string,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []): Promise<NativeExperimentOriginal> {
  if (selection.provider === 'amplifier' && ['create', 'current-native-turn'].includes(caseId)) {
    return executeManagedAmplifier(harness, sources, caseId, serverPath, servers)
  }
  if (!['freshclaude', 'kilroy'].includes(selection.mode ?? '')
    || !['create', 'current-native-turn', 'allow', 'deny'].includes(caseId)) {
    throw new Error(`actual native case has no qualified execution path: ${selection.mode ?? selection.provider}/${caseId}`)
  }
  const mode = selection.mode!
  const family = 'claude'
  const references = (['env_file', 'ca_file'] as const).map((suffix) => {
    const source = sources.find((file) => file.name === `${family}/grants/${suffix}`)
    if (!source) throw new Error(`selected ${family} ${suffix} reference missing`)
    return { sourcePath: source.path, profile: suffix === 'env_file' ? 'claude_onecli_environment' : 'claude_onecli_ca_file' }
  })
  const scenario = `${mode}-${caseId}`
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release' })
  const workspace = path.join(harness.testRoot, scenario + '-workspace')
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  const soulId = 'soul-' + randomUUID()
  const storeId = 'store-' + randomUUID()
  const settings = { model: 'claude-haiku-4-5-20251001', effort: 'low', permissionMode: 'default' }
  const request = { method: 'launch', params: { soulId, provider: family, providerStoreId: storeId,
    creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: scenario,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    freshAgent: { sessionId: 'native-fresh-' + randomUUID(), provider: mode === 'kilroy' ? 'kilroy' : family,
      sessionType: mode, runtimeVariant: 'claude-sdk-sidecar', providerStoreId: storeId,
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, ...settings,
      providerSecretReferences: references, providerLaunchContext: { preparation: { claude: { mcp_args: [] } }, config: [] } } } }
  harness.writeArtifact(`${scenario}-request.json`, request)
  const launch = await harness.adminOk(supervisor, request)
  harness.writeArtifact(`${scenario}-launch.json`, launch)
  const view = launch.data.view
  const observation = view.nativeIdentityObservation
  const assertions: { name: string; pass: boolean }[] = [{ name: 'actual-current-native-observation-before-input',
    pass: view.recoveryState === 'live' && !!observation && observation.nativeSessionId === view.nativeSessionId
      && observation.incarnationId === view.incarnationId && observation.source === 'fresh_provider_handshake' }]
  if (view.recoveryState !== 'live' || !observation || observation.nativeSessionId !== view.nativeSessionId
    || observation.incarnationId !== view.incarnationId || observation.source !== 'fresh_provider_handshake') {
    throw new Error('current managed native startup observation missing')
  }
  const inspect = async (containerId: string, label: string, requireTranscript: boolean) => {
    const metadata = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
      ['python3', '-c', claudeNativeInspection, view.nativeSessionId, String(requireTranscript)]))
    harness.writeArtifact(`${scenario}-${label}-native-private.json`, metadata)
    if (metadata.uid !== 65534 || metadata.gid !== 0 || metadata.caps !== '0000000000000000'
      || !metadata.readOnlyRoot || metadata.httpsStatus !== 200 || metadata.tlsVerifyMode !== 2
      || !metadata.tlsCheckHostname || metadata.nativeRoot !== view.nativeSessionId) {
      throw new Error('actual native namespace/TLS/root differs')
    }
    return metadata
  }
  const namespace = await inspect(view.containerId, 'startup', false)
  harness.writeArtifact(`${scenario}-namespace.json`, namespace)
  if (namespace.uid !== 65534 || namespace.gid !== 0 || !namespace.version.includes('2.1.237')) {
    throw new Error('actual selected native child/UID differs')
  }
  if (caseId === 'current-native-turn') {
    const marker = 'owned-memory-' + randomUUID()
    let cursor = 0
    const nativeTurn = async (text: string, label: string): Promise<any[]> => {
      const receipt = await harness.adminOk(supervisor, { method: 'fresh_agent_send', params: { soulId, text } })
      harness.writeArtifact(`${scenario}-${label}-dispatch.json`, receipt)
      const events: any[] = []
      const batches: unknown[] = []
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const batch = await harness.adminOk(supervisor, { method: 'fresh_agent_read_events',
          params: { soulId, afterSequence: cursor, maxEvents: 100 } })
        batches.push(batch)
        harness.writeArtifact(`${scenario}-${label}-events-private.json`, batches)
        for (const row of batch.data.events) {
          cursor = Math.max(cursor, row.sequence)
          const event = row.event?.data?.payload?.event
          if (event) events.push(event)
          if (event?.type === 'freshAgent.result') {
            if (event.isError || event.nativeSessionId !== view.nativeSessionId) throw new Error('native turn did not finish on the observed root')
            return events
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('bounded native turn deadline exceeded')
    }
    const seedEvents = await nativeTurn(`Remember this private marker: ${marker}. Reply stored. Do not use tools.`, 'seed')
    if (seedEvents.some((event) => (event.content ?? []).some((part: any) => part.type === 'tool_use'))) throw new Error('native seed unexpectedly requested a tool')
    const before = await inspect(view.containerId, 'before-death', true)
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed native store not readable before death')
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact(`${scenario}-recovery.json`, recovery)
    if (recovery.data.outcome !== 'replaced' || recovery.data.view.nativeSessionId !== view.nativeSessionId
      || recovery.data.view.incarnationId === view.incarnationId || !recovery.data.view.nativeIdentityObservation
      || recovery.data.view.recoveryState !== 'live') throw new Error('native exact-root replacement failed')
    const after = await inspect(recovery.data.view.containerId, 'after-death', true)
    if (before.transcript.sha256 !== after.transcript.sha256 || before.transcript.identity[0] !== after.transcript.identity[0]
      || before.transcript.identity[1] !== after.transcript.identity[1]) throw new Error('native transcript lost original owned volume/file continuity')
    const recalled = await nativeTurn('Reply with only the private marker from before. Do not use tools.', 'recall')
    const text = recalled.flatMap((event) => event.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('').trim()
    if (text !== marker) throw new Error('native restored context did not recall the private marker')
    if (recalled.some((event) => (event.content ?? []).some((part: any) => part.type === 'tool_use'))) throw new Error('native recall unexpectedly requested a tool')
    assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
      { name: 'replacement-new-incarnation-same-native-root', pass: recovery.data.outcome === 'replaced'
        && recovery.data.view.incarnationId !== view.incarnationId && recovery.data.view.nativeSessionId === view.nativeSessionId
        && recovery.data.view.nativeIdentityObservation.nativeSessionId === view.nativeSessionId },
      { name: 'original-owned-volume-transcript-continuity', pass: before.transcript.sha256 === after.transcript.sha256
        && before.transcript.identity[0] === after.transcript.identity[0] && before.transcript.identity[1] === after.transcript.identity[1] },
      { name: 'same-workspace-selected-native-profile', pass: JSON.stringify(before.profileFiles) === JSON.stringify(after.profileFiles) },
      { name: 'actual-restored-context-private-marker-recall', pass: text === marker },
      { name: 'native-turns-requested-no-tools', pass: ![...seedEvents, ...recalled].some((event) =>
        (event.content ?? []).some((part: any) => part.type === 'tool_use')) })
  }
  if (selection.case === 'approval-checkpoint' && ['allow', 'deny'].includes(caseId)) {
    assertions.push(...await executeManagedNativeApproval({ harness, supervisor, soulId, workspace,
      view, scenario, decision: caseId, inspect }))
  }
  const profileSha256 = createHash('sha256').update(JSON.stringify({ settings, nativeProfile: namespace.profileFiles })).digest('hex')
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha,
    imageDigest: harness.imageRef, nativeVersion: namespace.version, executableSha256: namespace.executableSha256,
    profileSha256, artifactReferences: [`${scenario}-launch.json`, `${scenario}-namespace.json`],
    assertions }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

async function executeManagedAmplifier(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], caseId: string, serverPath: string | undefined,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[]): Promise<NativeExperimentOriginal> {
  const grants = (['env_file', 'ca_file'] as const).map((suffix) => {
    const file = sources.find((source) => source.name === `amplifier/grants/${suffix}`)
    if (!file) throw new Error(`selected Amplifier ${suffix} reference missing`)
    return { sourcePath: file.path, profile: suffix === 'env_file' ? 'amplifier_onecli_environment' : 'amplifier_onecli_ca_file' }
  })
  const profile = ['settings.yaml', 'bundles/default.yaml'].map((relative) => {
    const file = sources.find((source) => source.name === `amplifier/.amplifier/${relative}`)
    if (!file) throw new Error('selected ordinary Amplifier profile missing')
    return { relative, ...file }
  })
  const home = path.dirname(path.dirname(profile[0]!.path))
  const workspace = path.join(harness.testRoot, 'amplifier-create-workspace')
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  const supervisor = await harness.startSupervisor({ scenarioId: 'amplifier-create', binaryKind: 'release',
    env: { HOME: home, FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'amplifier' } })
  const soulId = 'soul-' + randomUUID()
  const nativeRoot = randomUUID()
  let managedPreparation: any
  if (caseId === 'current-native-turn') {
    if (!serverPath) throw new Error('actual terminal recovery requires the owned real server artifact')
    const { RustServer } = await import('../../test/e2e-browser/helpers/rust-server.js')
    const server = new RustServer({ homeDir: home, preserveHomeOnStop: true,
      env: { FRESHELL_BIND_HOST: '0.0.0.0', FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: supervisor.controlSecretFile,
        FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'amplifier',
        FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE: grants[0]!.sourcePath,
        FRESHELL_MANAGED_AMPLIFIER_ONECLI_CA_FILE: grants[1]!.sourcePath },
      stripEnvPrefixes: ['GEMINI_', 'GOOGLE_API_KEY', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'LUNAROUTE_'],
      setupHome: async (selectedHome) => {
        const config = path.join(selectedHome, '.freshell'); fs.mkdirSync(config, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ version: 1, settings: {
          defaultCwd: workspace, codingCli: { enabledProviders: ['amplifier'], providers: { amplifier: { model: 'glm-5.3', reasoningEffort: 'low' } } },
        } }), { mode: 0o600 })
      } })
    const owned = { server, scope: 'amplifier-native', pid: undefined as number | undefined }; servers.push(owned)
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = serverPath
    try {
      const info = await server.start(); owned.pid = info.pid
      harness.writeArtifact('amplifier-native-server-private.json', { ...info, ...server.processEvidence(),
        executableSha256: createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex') })
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    managedPreparation = await new Promise((resolve, reject) => {
      const socket = createConnection(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock'))
      const chunks: Buffer[] = []
      socket.setTimeout(5_000, () => socket.destroy(new Error('actual native capability issue timed out')))
      socket.once('connect', () => socket.end(JSON.stringify({ action: 'issue', controlSecret: supervisor.controlSecret,
        soulId, incarnationId: null, grantId: null, provider: 'amplifier', tuiSource: null, workspace, cwd: workspace })))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('actual native capability issue failed')) }
      })
    })
    harness.writeArtifact('amplifier-native-managed-preparation-private.json', managedPreparation)
    if (!managedPreparation.context?.mcpCapability || !managedPreparation.secretReferences?.length) {
      throw new Error('actual native managed capability/preparation missing')
    }
  }
  const request = { method: 'launch', params: { soulId, provider: 'amplifier', providerStoreId: 'store-' + randomUUID(),
    nativeSessionId: nativeRoot,
    creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: 'amplifier-native-create',
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    terminal: { terminalId: 'native-terminal-' + randomUUID(), streamId: 'native-stream-' + randomUUID(),
      mode: 'amplifier', program: 'amplifier', args: ['session', 'resume', '--full-history', nativeRoot],
      resumeSessionId: nativeRoot, env: { HOME: '/home/freshell/provider', PROMPT_TOOLKIT_NO_CPR: '1' },
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, cols: 100, rows: 30,
      projectKey: 'amplifier-native-create', providerModel: 'glm-5.3', providerReasoningEffort: 'low',
      providerSecretReferences: managedPreparation?.secretReferences ?? grants,
      providerLaunchContext: managedPreparation?.context ?? { preparation: { amplifier: { bundle: 'default', resume_args: [] } },
        config: profile.map((file) => ({ root: 'user_provider', relativePath: file.relative,
          providerRelativePath: '.amplifier/' + file.relative, format: 'yaml' })) } } } }
  harness.writeArtifact('amplifier-create-request.json', request)
  const result = await harness.adminOk(supervisor, request)
  harness.writeArtifact('amplifier-create-launch.json', result)
  let view = result.data.view
  const deadline = Date.now() + 50_000
  while (!view.nativeIdentityObservation && Date.now() < deadline) {
    harness.writeArtifact('amplifier-create-terminal-private.json',
      await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
    harness.writeArtifact('amplifier-create-store-probe.json',
      await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId)))
    try {
      const signal = await harness.execOwnedContainerAsExact(view.containerId, '65534:0', ['python3', '-c',
        "import pathlib,json; signals=[]\nfor p in pathlib.Path('/proc').iterdir():\n if not p.name.isdigit():continue\n try:\n  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(bytes([0])) if b'=' in v)\n  if 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR' in env:signals.append(pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])/'amplifier-loaded-context.json')\n except (OSError,ValueError):continue\nassert len(set(signals))==1\nprint(next(iter(set(signals))).read_text())"])
      fs.writeFileSync(path.join(harness.evidenceDir, 'amplifier-create-native-signal-original.json'), signal, { mode: 0o600 })
    } catch { /* The producer may not yet have completed load/context restore. */ }
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact('amplifier-create-inventory.json', inventory)
    view = inventory.data.find((row: any) => row.soulId === soulId)
    if (!view) throw new Error('owned Amplifier view disappeared')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const observation = view.nativeIdentityObservation
  harness.writeArtifact('amplifier-create-current-view.json', view)
  if (!observation || !view.nativeSessionId || view.recoveryState !== 'live'
    || observation.nativeSessionId !== view.nativeSessionId || observation.incarnationId !== view.incarnationId
    || observation.source !== 'amplifier_native_loaded_context') throw new Error('current managed Amplifier no-input acknowledgement missing')
  const namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
    ['/opt/amplifier-src/.venv/bin/python', '-c',
      "import os,json,pathlib,hashlib,importlib.metadata as m; p=pathlib.Path('/opt/amplifier-src/.venv/bin/amplifier'); producer=pathlib.Path('/opt/amplifier-src/amplifier_app_cli/freshell_native_resume.py'); print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'executableSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'producerSha256':hashlib.sha256(producer.read_bytes()).hexdigest(),'cliVersion':m.version('amplifier-app-cli'),'coreVersion':m.version('amplifier-core')}))"]))
  harness.writeArtifact('amplifier-create-namespace.json', namespace)
  if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000'
    || !namespace.readOnlyRoot || namespace.cliVersion !== '0.1.1' || namespace.coreVersion !== '1.6.0') {
    throw new Error('actual managed Amplifier namespace/package differs')
  }
  const assertions = [{ name: 'actual-native-loaded-context-before-zero-input', pass: observation.source === 'amplifier_native_loaded_context'
    && observation.nativeSessionId === view.nativeSessionId && observation.incarnationId === view.incarnationId }]
  if (caseId === 'current-native-turn') {
    const signalFile = path.join(harness.evidenceDir, 'amplifier-create-native-signal-original.json')
    const signal = JSON.parse(fs.readFileSync(signalFile, 'utf8'))
    const transcriptPath = signal.native.load.transcript.path
    const inspect = async (containerId: string, label: string) => {
      const snapshot = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
        ['/opt/amplifier-src/.venv/bin/python', '-c', amplifierNativeInspection, transcriptPath, nativeRoot, String(label === 'startup')]))
      harness.writeArtifact(`amplifier-${label}-native-private.json`, snapshot)
      return snapshot
    }
    const startup = await inspect(view.containerId, 'startup')
    if (startup.httpsStatus !== 200 || startup.tlsVerifyMode !== 2 || !startup.tlsCheckHostname) {
      throw new Error('current native Amplifier selected grant/TLS check failed')
    }
    const marker = 'owned-memory-' + randomUUID()
    const turn = async (containerId: string, text: string, label: string) => {
      let before = await inspect(containerId, label + '-before-input')
      const readyDeadline = Date.now() + 15_000
      const inputReady = () => harness.execOwnedContainerAsExact(containerId, '0:0', ['python3', '-c',
        "import pathlib,os,sys,termios; p=pathlib.Path('/proc')/sys.argv[1]; fields=(p/'stat').read_text().rsplit(')',1)[1].split(); device=int(fields[4]); assert os.major(device)==136; fd=os.open('/dev/pts/'+str(os.minor(device)),os.O_RDONLY|os.O_NONBLOCK)\ntry:print(str(not bool(termios.tcgetattr(fd)[3]&termios.ICANON)).lower())\nfinally:os.close(fd)", String(before.nativePid)]).trim() === 'true'
      while (!inputReady() && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        before = await inspect(containerId, label + '-before-input')
      }
      if (!inputReady()) throw new Error('ordinary Amplifier REPL not ready after native gate')
      const receipt = await harness.adminOk(supervisor, harness.terminalInputBody(soulId, text + '\r'))
      harness.writeArtifact(`amplifier-${label}-dispatch.json`, receipt)
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const current = await inspect(containerId, label)
        harness.writeArtifact(`amplifier-${label}-terminal-private.json`,
          await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
        if (current.completedTurns > before.completedTurns) {
          if (current.nativeRoot !== nativeRoot || current.toolEvents !== before.toolEvents
            || current.responses.length <= before.responses.length) throw new Error('native Amplifier completed turn/root/tools differ')
          return current
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error('bounded ordinary Amplifier native turn deadline exceeded')
    }
    const seed = await turn(view.containerId,
      `Remember this private marker: ${marker}. Reply stored. Do not use tools.`, 'seed')
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact('amplifier-turn-store-probe.json', probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed Amplifier native store not readable before death')
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact('amplifier-turn-recovery.json', recovery)
    const replacement = recovery.data.view
    if (recovery.data.outcome !== 'replaced' || replacement.incarnationId === view.incarnationId
      || replacement.nativeSessionId !== nativeRoot || replacement.recoveryState !== 'live'
      || replacement.nativeIdentityObservation?.source !== 'amplifier_native_loaded_context'
      || replacement.nativeIdentityObservation?.nativeSessionId !== nativeRoot) throw new Error('Amplifier exact-root replacement failed')
    const restored = await inspect(replacement.containerId, 'after-death')
    if (seed.transcript.sha256 !== restored.transcript.sha256
      || seed.transcript.identity[0] !== restored.transcript.identity[0]
      || seed.transcript.identity[1] !== restored.transcript.identity[1]) throw new Error('original Amplifier owned transcript continuity lost')
    const recalled = await turn(replacement.containerId,
      'Reply with only the private marker from before. Do not use tools.', 'recall')
    if (recalled.lastAssistantText.trim() !== marker) throw new Error('native Amplifier restored context did not recall private marker')
    assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
      { name: 'replacement-new-incarnation-same-native-root', pass: replacement.incarnationId !== view.incarnationId && replacement.nativeSessionId === nativeRoot },
      { name: 'original-owned-volume-transcript-continuity', pass: seed.transcript.sha256 === restored.transcript.sha256
        && seed.transcript.identity[0] === restored.transcript.identity[0] && seed.transcript.identity[1] === restored.transcript.identity[1] },
      { name: 'same-workspace-selected-native-profile', pass: JSON.stringify(seed.profileFiles) === JSON.stringify(restored.profileFiles)
        && recalled.metadata.model === 'glm-5.3' },
      { name: 'actual-restored-context-private-marker-recall', pass: recalled.lastAssistantText.trim() === marker },
      { name: 'native-turns-requested-no-tools', pass: seed.toolEvents === 0 && recalled.toolEvents === 0 })
  }
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef,
    nativeVersion: `amplifier-app-cli ${namespace.cliVersion}; amplifier-core ${namespace.coreVersion}`,
    executableSha256: namespace.executableSha256,
    profileSha256: createHash('sha256').update(JSON.stringify(profile.map((file) => ({ relative: file.relative, sha256: file.sha256 })))).digest('hex'),
    artifactReferences: ['amplifier-create-current-view.json', 'amplifier-create-native-signal-original.json', 'amplifier-create-namespace.json'],
    assertions }
  harness.writeArtifact(`amplifier-${caseId}-original.json`, original)
  return original
}

async function executeManagedNativeApproval(input: {
  harness: RuntimeHarness; supervisor: any; soulId: string; workspace: string; view: any; scenario: string
  decision: string; inspect: (containerId: string, label: string, requireTranscript: boolean) => Promise<any>
}): Promise<{ name: string; pass: boolean }[]> {
  const { harness, supervisor, soulId, workspace, view, scenario, inspect } = input
  const effectPath = path.join(workspace, 'owned-native-effect.jsonl')
  if (fs.existsSync(effectPath)) throw new Error('native effect oracle must be new')
  const command = `printf 'effect\\n' >> '${effectPath}'`
  const effectCount = () => {
    if (!fs.existsSync(effectPath)) return 0
    const bytes = fs.readFileSync(effectPath, 'utf8')
    if (!/^(effect\n)+$/.test(bytes)) throw new Error('native effect oracle contains unexpected bytes')
    return bytes.split('\n').length - 1
  }
  let cursor = 0
  const batches: unknown[] = []
  const observed: any[] = []
  const wait = async (select: (event: any) => boolean, label: string) => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const batch = await harness.adminOk(supervisor, { method: 'fresh_agent_read_events',
        params: { soulId, afterSequence: cursor, maxEvents: 128 } })
      batches.push(batch); cursor = batch.data.head
      harness.writeArtifact(`${scenario}-approval-events-private.json`, batches)
      const events = batch.data.events.map((row: any) => row.event)
      observed.push(...events)
      const found = events.find(select)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`bounded native ${label} deadline exceeded`)
  }
  const isCard = (event: any) => event.kind === 'permission_requested' && !!event.data.payload.nativeCheckpoint
  harness.writeArtifact(`${scenario}-operation.json`, { command, effectPath })
  await harness.adminOk(supervisor, { method: 'fresh_agent_send', params: { soulId,
    text: `Use the Bash tool exactly once with this exact command: ${command}. Do not use other tools or another command. After its result, reply done.` } })
  const old = (await wait(isCard, 'durable checkpoint/current ask')).data
  harness.writeArtifact(`${scenario}-old-card-private.json`, old)
  const oldPayload = old.payload
  if (oldPayload.tool?.name !== 'Bash' || oldPayload.tool.input?.command !== command
    || oldPayload.nativeCheckpoint.nativeSessionId !== view.nativeSessionId
    || oldPayload.nativeCheckpoint.toolUseID !== oldPayload.toolUseID || effectCount() !== 0) {
    throw new Error('original native solo checkpoint/effect oracle differs')
  }
  const before = await inspect(view.containerId, 'checkpoint-before-death', true)
  const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
  harness.writeArtifact(`${scenario}-approval-store-probe.json`, probe)
  if (probe.data.kind !== 'reattach_ready') throw new Error('native checkpoint store not readable before death')
  await harness.killOwnedRuntimeExact(view.containerId)
  await harness.waitForContainerExit(view.containerId)
  const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
  harness.writeArtifact(`${scenario}-approval-recovery.json`, recovery)
  const currentView = recovery.data.view
  if (recovery.data.outcome !== 'replaced' || currentView.incarnationId === view.incarnationId
    || currentView.nativeSessionId !== view.nativeSessionId || currentView.recoveryState !== 'live'
    || currentView.nativeIdentityObservation?.nativeSessionId !== view.nativeSessionId) throw new Error('native approval replacement not currently live on same root')
  const current = (await wait(isCard, 'rebound current native ask')).data
  harness.writeArtifact(`${scenario}-current-card-private.json`, current)
  const currentPayload = current.payload
  if (current.decision_id !== old.decision_id || currentPayload.nativeRequestId === oldPayload.nativeRequestId
    || JSON.stringify(currentPayload.nativeCheckpoint) !== JSON.stringify(oldPayload.nativeCheckpoint)
    || currentPayload.nativeBinding?.launch.incarnationId !== currentView.incarnationId
    || effectCount() !== 0) throw new Error('same native operation did not rebind to a fresh current request')
  const after = await inspect(currentView.containerId, 'checkpoint-after-death', true)
  if (before.transcript.sha256 !== after.transcript.sha256
    || before.transcript.identity[0] !== after.transcript.identity[0]
    || before.transcript.identity[1] !== after.transcript.identity[1]) throw new Error('original native checkpoint changed across owned enclosure death')
  const decision = input.decision === 'allow' ? { behavior: 'allow', updatedInput: currentPayload.tool.input }
    : { behavior: 'deny', message: 'Denied this original owned operation' }
  const receipt = await harness.adminOk(supervisor, harness.freshAgentResolveBody(soulId, current.decision_id, decision))
  harness.writeArtifact(`${scenario}-approval-dispatch.json`, receipt)
  const result = (await wait((event) => event.kind === 'provider'
    && event.data.payload.event?.type === 'freshAgent.result', 'native completion')).data.payload.event
  const toolResults = observed.filter((event) => event.kind === 'provider'
    && event.data.payload.event?.type === 'freshAgent.tool.result').flatMap((event) => event.data.payload.event.content ?? [])
  const toolResult = toolResults.find((part: any) => part.tool_use_id === oldPayload.toolUseID)
  const count = effectCount()
  harness.writeArtifact(`${scenario}-approval-outcome.json`, { nativeRoot: result.nativeSessionId,
    originalToolUseId: oldPayload.toolUseID, inputDigest: oldPayload.nativeCheckpoint.inputDigest,
    oldNativeRequestId: oldPayload.nativeRequestId, currentNativeRequestId: currentPayload.nativeRequestId,
    nativeToolResultIsError: toolResult?.is_error, nativeResultIsError: result.isError, effectCount: count })
  if (result.nativeSessionId !== view.nativeSessionId || !toolResult
    || toolResult.is_error !== (input.decision === 'deny') || count !== (input.decision === 'allow' ? 1 : 0)) {
    throw new Error('correlated original native outcome/effect differs from decision')
  }
  return [{ name: 'same-native-operation-new-current-request-after-death',
    pass: currentPayload.nativeRequestId !== oldPayload.nativeRequestId && current.decision_id === old.decision_id },
    { name: 'native-checkpoint-original-volume-continuity', pass: before.transcript.sha256 === after.transcript.sha256
      && before.transcript.identity[1] === after.transcript.identity[1] },
    { name: 'correlated-native-tool-result', pass: toolResult.tool_use_id === oldPayload.toolUseID
      && toolResult.is_error === (input.decision === 'deny') },
    { name: 'independent-native-effect-count', pass: count === (input.decision === 'allow' ? 1 : 0) }]
}

const amplifierNativeInspection = String.raw`
import pathlib,os,json,hashlib,sys,base64,ssl,urllib.request
file=pathlib.Path(sys.argv[1]);root=sys.argv[2];check_tls=sys.argv[3]=='true';assert file.name=='transcript.jsonl' and file.parent.name==root
with file.open('rb') as f:
 before=os.fstat(f.fileno());raw=f.read();after=os.fstat(f.fileno())
identity=lambda s:[str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns),str(s.st_ctime_ns)]
assert identity(before)==identity(after)==identity(file.stat()) and (not raw or raw.endswith(b'\n'))
messages=[json.loads(line) for line in raw.splitlines() if line.strip()]
meta=json.loads((file.parent/'metadata.json').read_text());assert meta['session_id']==root and meta.get('parent_id') is None
events_file=file.parent/'events.jsonl';event_raw=events_file.read_bytes() if events_file.exists() else b''
events=[json.loads(line) for line in event_raw.split(b'\n')[:-1] if line.strip()]
matches=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  cmd=(p/'cmdline').read_bytes().split(b'\0')
  if 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR' in env and any(x.endswith(b'/amplifier') or x==b'amplifier' for x in cmd):matches.append((p,env))
 except (OSError,ValueError):continue
assert len(matches)==1
p,env=matches[0]
status=None;context=ssl.create_default_context(cafile=env['SSL_CERT_FILE'])
if check_tls:
 proxy=env.get('HTTPS_PROXY') or env.get('https_proxy');opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}),urllib.request.HTTPSHandler(context=context))
 request=urllib.request.Request(env['LUNAROUTE_BASE_URL'].rstrip('/')+'/models',headers={'Authorization':'Bearer '+env['LUNAROUTE_API_KEY']})
 with opener.open(request,timeout=20) as response:status=response.status;response.read()
profile=[]
for relative in ['.amplifier/settings.yaml','.amplifier/bundles/default.yaml','.amplifier/keys.env']:
 source=pathlib.Path(env['HOME'])/relative;profile.append({'relative':relative,'sha256':hashlib.sha256(source.read_bytes()).hexdigest() if source.exists() else None})
assistants=[m for m in messages if m.get('role')=='assistant']
def text(m):
 c=m.get('content');return c if isinstance(c,str) else ''.join(p.get('text','') for p in (c or []) if isinstance(p,dict) and p.get('type')=='text')
print(json.dumps({'nativeRoot':root,'nativePid':int(p.name),'transcript':{'identity':identity(after),'sha256':hashlib.sha256(raw).hexdigest(),'completeEof':not raw or raw.endswith(b'\n'),'bytesBase64':base64.b64encode(raw).decode()},'eventsBytesBase64':base64.b64encode(event_raw).decode(),'metadata':meta,'completedTurns':sum(e.get('event')=='cleanup:store_end' for e in events),'toolEvents':sum(str(e.get('event','')).startswith('tool:') for e in events),'responses':[e.get('data') for e in events if e.get('event')=='llm:response'],'lastAssistantText':text(assistants[-1]) if assistants else '', 'profileFiles':profile,'httpsStatus':status,'tlsVerifyMode':context.verify_mode.value,'tlsCheckHostname':context.check_hostname}))
`

// Reads the currently owned native child and its exact hook-selected transcript.
// Raw bytes are saved only in the run's private artifact; reports use metadata.
const claudeNativeInspection = String.raw`
import pathlib,os,json,hashlib,ssl,urllib.parse,urllib.request,subprocess,sys,base64
root=sys.argv[1];required=sys.argv[2]=='true';selected=pathlib.Path('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude')
expected=hashlib.sha256(selected.read_bytes()).hexdigest();matches=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  if 'FRESHELL_CLAUDE_SIDECAR_ID' in env and hashlib.sha256((p/'exe').read_bytes()).hexdigest()==expected:matches.append((p,env))
 except (OSError,ValueError):continue
assert len(matches)==1
p,env=matches[0];hook=json.loads((pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])/'session-start.json').read_text());assert hook['native']['session_id']==root
ca=pathlib.Path(env.get('SSL_CERT_FILE') or env['NODE_EXTRA_CA_CERTS']);context=ssl.create_default_context(cafile=str(ca));proxy=env.get('HTTPS_PROXY') or env.get('https_proxy')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}),urllib.request.HTTPSHandler(context=context))
with opener.open(urllib.request.Request('https://api.anthropic.com/v1/models',headers={'anthropic-version':'2023-06-01','authorization':'Bearer '+env['CLAUDE_CODE_OAUTH_TOKEN']}),timeout=20) as r:status=r.status;r.read()
home=pathlib.Path(env.get('CLAUDE_CONFIG_DIR') or str(pathlib.Path(env['HOME'])/'.claude'));cwd=pathlib.Path(hook['native']['cwd']);profile=[]
for file in [home/'settings.json',cwd/'.claude/settings.json',cwd/'.claude/settings.local.json']:
 profile.append({'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else None})
transcript=None;file=pathlib.Path(hook['native']['transcript_path'])
if file.exists():
 with file.open('rb') as f:
  before=os.fstat(f.fileno());raw=f.read();after=os.fstat(f.fileno())
 identity=lambda s:[str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns),str(s.st_ctime_ns)]
 assert identity(before)==identity(after)==identity(file.stat()) and raw.endswith(b'\n')
 rows=[json.loads(line) for line in raw.splitlines() if line.strip()];assert all(row.get('sessionId',root)==root for row in rows)
 transcript={'identity':identity(after),'sha256':hashlib.sha256(raw).hexdigest(),'completeEof':True,'bytesBase64':base64.b64encode(raw).decode(),'rowCount':len(rows)}
assert not required or transcript is not None
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'nativePid':int(p.name),'nativeRoot':root,'hook':hook,'executableSha256':expected,'version':subprocess.check_output([str(selected),'--version'],text=True).strip(),'profileFiles':profile,'caSha256':hashlib.sha256(ca.read_bytes()).hexdigest(),'tlsVerifyMode':context.verify_mode.value,'tlsCheckHostname':context.check_hostname,'httpsStatus':status,'transcript':transcript}))
`

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runNativeFeasibility().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'runtime.native_feasibility.failed',
      reason: error instanceof Error ? error.message : 'unknown failure' })}\n`)
    process.exitCode = 1
  })
}
