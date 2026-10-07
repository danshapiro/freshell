import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
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
  try {
    for (const caseId of nativeFeasibilityCases(input.selection)) {
      try {
        const original = await input.execute(caseId)
        originals.push(original)
        if (original.caseId !== caseId || original.ownerId !== input.ownerId
          || original.imageDigest !== input.imageDigest || original.candidateSha !== input.candidateSha
          || !original.nativeVersion || !/^[a-f0-9]{64}$/.test(original.executableSha256)
          || !/^[a-f0-9]{64}$/.test(original.profileSha256) || original.artifactReferences.length === 0
          || original.assertions.length === 0 || original.assertions.some((assertion) => !assertion.pass)) {
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
    artifacts: { supervisor: { path: string; sha256: string }; host: { path: string; sha256: string } }
    sourceFiles: { name: string; path: string; sha256: string }[]
  }
  const harness = new RuntimeHarness(process.cwd(), undefined, 1)
  try {
    const prepared = await harness.prepareNativeArtifacts({ candidateSha: manifest.candidateSha,
      imageDigest: manifest.imageDigest, supervisor: manifest.artifacts.supervisor, host: manifest.artifacts.host,
      sourceFiles: manifest.sourceFiles })
    harness.writeArtifact('native-selection.json', selection)
    const originals = await dispatchNativeFeasibility({ selection, imageDigest: manifest.imageDigest,
      candidateSha: manifest.candidateSha, ownerId: harness.runId,
      execute: async (caseId) => {
        try { return await executeManagedNativeCase(harness, prepared.files, selection, caseId) }
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
    const cleanup = await harness.cleanup()
    if (!cleanup.ok) throw new Error(`native owned cleanup failed: ${cleanup.errors.join('; ')}`)
  }
}

async function executeManagedNativeCase(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], selection: NativeSelection,
  caseId: string): Promise<NativeExperimentOriginal> {
  if (!['freshclaude', 'kilroy'].includes(selection.mode ?? '')
    || !['create', 'current-native-turn'].includes(caseId)) {
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
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const batch = await harness.adminOk(supervisor, { method: 'fresh_agent_read_events',
          params: { soulId, afterSequence: cursor, maxEvents: 100 } })
        harness.writeArtifact(`${scenario}-${label}-events-private.json`, [...events, ...batch.data.events])
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
  }
  const profileSha256 = createHash('sha256').update(JSON.stringify({ settings, nativeProfile: namespace.profileFiles })).digest('hex')
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha,
    imageDigest: harness.imageRef, nativeVersion: namespace.version, executableSha256: namespace.executableSha256,
    profileSha256, artifactReferences: [`${scenario}-launch.json`, `${scenario}-namespace.json`],
    assertions: [{ name: 'actual-current-native-observation-before-input',
      pass: observation.nativeSessionId === view.nativeSessionId && observation.incarnationId === view.incarnationId
        && observation.source === 'fresh_provider_handshake' && view.recoveryState === 'live' }] }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

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
