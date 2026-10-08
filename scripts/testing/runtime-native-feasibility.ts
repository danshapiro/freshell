import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

// A finite experiment image can retain the pinned ELF behind this wrapper.
// Only the exact owned wrong-ID resume workspace gets the supported fork flag;
// ordinary modes and argv remain unchanged. This never fabricates native IDs.
export const nativeSdkResumeForkWrapper = String.raw`#!/usr/bin/python3
import hashlib,json,os,pathlib,re,sys,uuid
native=pathlib.Path('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude.native')
if not native.is_file() or native.is_symlink() or hashlib.sha256(native.read_bytes()).hexdigest()!='73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916':
 raise RuntimeError('pinned original SDK child differs')
args=sys.argv[1:]
owned=re.fullmatch(r'/tmp/f[a-z0-9]+/[a-f0-9]{8}-[a-f0-9]{3}/(freshclaude|kilroy)-wrong-id-workspace',os.getcwd())
roots=[]
if owned:
 for index,arg in enumerate(args):
  if arg=='--resume':
   if index+1>=len(args):raise RuntimeError('native resume argument missing')
   roots.append(args[index+1])
  elif arg.startswith('--resume='):roots.append(arg.split('=',1)[1])
if owned and roots:
 launch=json.loads(os.environ.get('FRESHELL_NATIVE_IDENTITY_LAUNCH','{}'))
 if len(roots)!=1 or not launch.get('launchNonce') or not launch.get('incarnationId'):
  raise RuntimeError('current owned SDK resume binding missing or ambiguous')
 root=roots[0];uuid.UUID(root)
 if launch.get('requestedNativeSessionId')!=root:raise RuntimeError('owned SDK requested resume root differs')
 if '--fork-session' not in args:args.append('--fork-session')
os.execv(str(native),[str(native),*args])
`

// Finite negative image only: use the real observed native acknowledgement,
// then fault exactly its projected ID before the existing Rust normalizer and
// native receiver. Never substitute these frames for positive identity proof.
export function nativeResumeRootInArgv(argv: readonly string[], root: string): boolean {
  const roots = argv.flatMap((arg, index) => arg === '--resume' ? [argv[index + 1]]
    : arg.startsWith('--resume=') ? [arg.slice('--resume='.length)] : [])
  return roots.length === 1 && roots[0] === root
}

export function stageSdkInitFieldFault(source: string): string {
  const original = String.raw`emit({ type: 'sdk.session.init', sessionId, cliSessionId: observation.nativeSessionId,
        cwd: observation.native.cwd, model: req.model, nativeIdentityEvidence: {
          launch, digest: observation.evidenceDigest, source: observation.native.source, queryGeneration: generation,
        } })`
  if (source.split(original).length !== 2) throw new Error('pinned native SDK init publisher differs')
  return source.replace(original, String.raw`const nativeInit = { type: 'sdk.session.init', sessionId, cliSessionId: observation.nativeSessionId,
        cwd: observation.native.cwd, model: req.model, nativeIdentityEvidence: {
          launch, digest: observation.evidenceDigest, source: observation.native.source, queryGeneration: generation,
        } }
      const fieldFault = /^\/tmp\/f[a-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{3}\/(freshclaude|kilroy)-(missing-native-id|placeholder-id)-workspace$/.exec(req.cwd || '')
      if (fieldFault) {
        const control = JSON.parse(await readFile(join(req.cwd, 'native-init-field-fault-control.json'), 'utf8'))
        if (req.resumeSessionId || launch?.requestedNativeSessionId !== null || !launch?.launchNonce || !launch?.incarnationId
          || control.mode !== fieldFault[1] || control.caseId !== fieldFault[2]
          || !observation.nativeSessionId || observation.nativeSessionId === sessionId) {
          throw new Error('owned native init field fault binding differs')
        }
        const actualNativeSessionId = nativeInit.cliSessionId
        if (fieldFault[2] === 'missing-native-id') delete nativeInit.cliSessionId
        else nativeInit.cliSessionId = sessionId
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(req.cwd, 'native-init-field-fault-observation.json'),
          JSON.stringify({ caseId: fieldFault[2], mode: fieldFault[1], actualNativeSessionId, frame: nativeInit }), { mode: 0o660 })
      }
      emit(nativeInit)`)
}

export function nativeSdkInitFieldFaultMatches(mode: NativeMode, caseId: string, receipt: any, namespace: any, refusals: any): boolean {
  if (!['freshclaude', 'kilroy'].includes(mode) || !['missing-native-id', 'placeholder-id'].includes(caseId)
    || receipt?.mode !== mode || receipt.caseId !== caseId || !namespace?.hook || !Array.isArray(refusals)) return false
  const launch = namespace.nativeLaunch, frame = receipt.frame
  const sameLaunch = (actual: any) => !!actual && !!launch
    && ['incarnationId', 'launchNonce', 'evidenceRevision', 'executionGeneration', 'requestedNativeSessionId']
      .every(key => actual[key] === launch[key])
  const root = receipt.actualNativeSessionId
  if (typeof root !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(root)
    || namespace.nativeRoot !== root || namespace.hook.native?.session_id !== root
    || namespace.hook.native?.source !== 'startup' || !sameLaunch(namespace.hook.launch)
    || !launch?.incarnationId || !launch.launchNonce || launch.requestedNativeSessionId !== null
    || !Number.isSafeInteger(launch.evidenceRevision) || launch.evidenceRevision < 0
    || !Number.isSafeInteger(launch.executionGeneration) || launch.executionGeneration < 1
    || frame?.type !== 'sdk.session.init' || typeof frame.sessionId !== 'string' || !frame.sessionId
    || frame.sessionId === root || namespace.hook.native.cwd !== frame.cwd) return false
  const evidenceMatches = (event: any) => sameLaunch(event?.nativeIdentityEvidence?.launch)
    && /^[a-f0-9]{64}$/i.test(namespace.hookSha256 ?? '')
    && event.nativeIdentityEvidence.digest === namespace.hookSha256
    && event.nativeIdentityEvidence.source === namespace.hook.native.source
    && Number.isSafeInteger(event.nativeIdentityEvidence.queryGeneration) && event.nativeIdentityEvidence.queryGeneration > 0
  const fieldMatches = (event: any) => caseId === 'missing-native-id'
    ? !Object.prototype.hasOwnProperty.call(event, 'cliSessionId')
    : event.cliSessionId === frame.sessionId && !/^[a-f0-9-]{36}$/i.test(event.cliSessionId)
  if (!evidenceMatches(frame) || !fieldMatches(frame)) return false
  const current = refusals.filter((record: any) => record?.event === 'host.native_identity.refused' && sameLaunch(record.launch))
  return current.length === 1 && current.every((record: any) => record.severity === 'warn'
    && record.reason === (caseId === 'missing-native-id' ? 'missing_cli_session_id' : 'local_placeholder_id')
    && record.provider === (mode === 'kilroy' ? 'kilroy' : 'claude')
    && record.normalizedEventType === 'freshAgent.session.init'
    && record.nativeEvidenceDigest === namespace.hookSha256
    && record.nativeEvidenceSource === namespace.hook.native.source
    && record.queryGeneration === frame.nativeIdentityEvidence.queryGeneration
    && record.nativeReceiverPublished === false && record.nativeReceiverContainsIdentity === false)
}

export function staleNativeSignalBindingMatches(captured: any, priorLaunch: any, currentLaunch: any, root: string): boolean {
  return captured.hooksDisabled === true && captured.hook?.native.session_id === root
    && captured.loaded?.native.session_id === root
    && JSON.stringify(captured.hook.launch) === JSON.stringify(priorLaunch)
    && JSON.stringify(captured.loaded.launch) === JSON.stringify(priorLaunch)
    && JSON.stringify(captured.nativeLaunch) === JSON.stringify(currentLaunch)
    && !!priorLaunch?.launchNonce && !!priorLaunch?.incarnationId
    && !!currentLaunch?.launchNonce && !!currentLaunch?.incarnationId
    && currentLaunch.launchNonce !== priorLaunch?.launchNonce
    && currentLaunch.incarnationId !== priorLaunch?.incarnationId
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

type NativeCheckpointSnapshot = { nativeRoot: string; transcript: {
  identity: string[]; sha256: string; bytesBase64: string; completeEof: boolean
} }
export function nativeCheckpointTranscriptRetained(before: NativeCheckpointSnapshot,
  after: NativeCheckpointSnapshot, toolUseID: string): boolean {
  try {
    if (!before.nativeRoot || before.nativeRoot !== after.nativeRoot || !toolUseID.startsWith('toolu_')
      || !before.transcript.completeEof || !after.transcript.completeEof
      || before.transcript.identity.length < 2 || after.transcript.identity.length < 2
      || before.transcript.identity[0] !== after.transcript.identity[0]
      || before.transcript.identity[1] !== after.transcript.identity[1]) return false
    const original = Buffer.from(before.transcript.bytesBase64, 'base64')
    const current = Buffer.from(after.transcript.bytesBase64, 'base64')
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
    if (!original.length || original.at(-1) !== 10 || current.at(-1) !== 10
      || digest(original) !== before.transcript.sha256 || digest(current) !== after.transcript.sha256
      || !current.subarray(0, original.length).equals(original)) return false
    const tail = current.subarray(original.length).toString('utf8')
    if (tail.includes('"tool_use_id":"' + toolUseID + '"')) return false
    // A current resumed hook may append its lifecycle rows. Neither a new
    // operation/checkpoint nor any tool outcome can precede the user decision.
    return tail.split('\n').filter(Boolean).every((line) => {
      const row = JSON.parse(line)
      return (!row.sessionId || row.sessionId === before.nativeRoot)
        && ((row.type === 'queue-operation' && ['enqueue', 'dequeue'].includes(row.operation))
          || (row.type === 'attachment' && row.attachment?.type === 'hook_success'))
    })
  } catch { return false }
}

export function nativeTwoToolBatchMatches(snapshot: NativeCheckpointSnapshot, commands: readonly string[]): boolean {
  try {
    const distinctCommands = new Set(commands)
    if (!snapshot.nativeRoot || !snapshot.transcript.completeEof || commands.length !== 2 || distinctCommands.size !== 2) return false
    const bytes = Buffer.from(snapshot.transcript.bytesBase64, 'base64')
    if (bytes.at(-1) !== 10 || createHash('sha256').update(bytes).digest('hex') !== snapshot.transcript.sha256) return false
    const batches = new Map<string, any[]>()
    for (const row of bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))) {
      if (row.type !== 'assistant') continue
      const tools = (Array.isArray(row.message?.content) ? row.message.content : []).filter((part: any) => part.type === 'tool_use')
      if (!tools.length) continue
      if (row.sessionId !== snapshot.nativeRoot || typeof row.message.id !== 'string' || !row.message.id
        || tools.some((tool: any) => typeof tool.id !== 'string' || !tool.id)) return false
      batches.set(row.message.id, [...(batches.get(row.message.id) ?? []), ...tools])
    }
    return [...batches.values()].some((tools) => tools.length === 2 && new Set(tools.map((tool) => tool.id)).size === 2
      && tools.every((tool) => tool.name === 'Bash' && distinctCommands.has(tool.input?.command))
      && new Set(tools.map((tool) => tool.input.command)).size === 2)
  } catch { return false }
}

type AmplifierProfileSnapshot = { nativeCwd: string; nativeSettingsSha256: string;
  profileFiles: { relative: string; sha256: string | null; bytesBase64?: string | null }[] }
export function amplifierNativeProfileRetained(before: AmplifierProfileSnapshot,
  after: AmplifierProfileSnapshot, workspace: string): boolean {
  const names = ['.amplifier/settings.yaml', '.amplifier/bundles/default.yaml', '.amplifier/keys.env']
  const valid = (snapshot: AmplifierProfileSnapshot) => snapshot.nativeCwd === workspace
    && /^[a-f0-9]{64}$/.test(snapshot.nativeSettingsSha256)
    && snapshot.profileFiles.length === names.length && names.every((relative) =>
      snapshot.profileFiles.filter((file) => file.relative === relative && /^[a-f0-9]{64}$/.test(file.sha256 ?? '')).length === 1)
  if (!valid(before) || !valid(after) || before.nativeSettingsSha256 !== after.nativeSettingsSha256) return false
  const bundle = (snapshot: AmplifierProfileSnapshot) => snapshot.profileFiles.find((file) => file.relative === names[1])!.sha256
  return bundle(before) === bundle(after)
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
  if (selection.provider === 'claude'
    && !manifest.sourceFiles.some((file) => file.name === 'claude/profile/native-startup-user.json')) {
    // Newly owned native UI preferences remove onboarding interaction only.
    // Permission/model policy stays in its ordinary native settings sources.
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'task004-terminal-native-profile-'))
    fs.chmodSync(directory, 0o700)
    const profilePath = path.join(directory, 'native-startup-user.json')
    const projects = Object.fromEntries(nativeFeasibilityCases(selection).map((caseId) =>
      [path.join(harness.testRoot, `claude-${caseId}-workspace`), { hasTrustDialogAccepted: true }]))
    fs.writeFileSync(profilePath, JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, projects }), { mode: 0o600 })
    manifest.sourceFiles.push({ name: 'claude/profile/native-startup-user.json', path: profilePath,
      sha256: createHash('sha256').update(fs.readFileSync(profilePath)).digest('hex') })
  }
  let paidPrerequisiteFailed = false
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
        const paidCase = selection.case === 'approval-checkpoint'
          || (selection.provider === 'claude' && ['exact-resume', 'fork-root', 'restoration-failure-after-hook'].includes(caseId))
        if (paidPrerequisiteFailed && paidCase) {
          throw new Error('prior native prerequisite failed; no further paid operation started')
        }
        try { return await executeManagedNativeCase(harness, prepared.files, selection, caseId, prepared.serverPath, servers) }
        catch (error) {
          if (selection.case === 'approval-checkpoint'
            || (selection.provider === 'claude' && caseId === 'create')) paidPrerequisiteFailed = true
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

export async function executeManagedNativeCase(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], selection: NativeSelection,
  caseId: string, serverPath?: string,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []): Promise<NativeExperimentOriginal> {
  if (selection.provider === 'claude' && ['create', 'wrong-root', 'fork-root', 'stale-shared-signal', 'disabled-hooks', 'trust-refusal', 'unwritable-signal', 'timeout', 'provider-exit', 'stop-cancellation', 'exact-resume', 'restoration-failure-after-hook', 'current-native-turn'].includes(caseId)) {
    return executeManagedTerminalClaude(harness, sources, caseId, serverPath, servers)
  }
  if (selection.provider === 'amplifier' && ['create', 'exact-resume', 'native-followup', 'current-native-turn'].includes(caseId)) {
    return executeManagedAmplifier(harness, sources, caseId, serverPath, servers)
  }
  if (!['freshclaude', 'kilroy'].includes(selection.mode ?? '')
    || !['create', 'exact-resume', 'current-native-turn', 'allow', 'deny', 'changed-tool', 'missing-tool',
      'changed-input', 'changed-profile', 'changed-root', 'stale-callback', 'crash-before-checkpoint',
      'multiple-tools', 'effect-before-observation', 'wrong-id', 'missing-native-id', 'placeholder-id', 'disabled-hooks',
      'timeout-50s', 'provider-exit', 'stop-cancellation', 'restoration-failure-after-hook'].includes(caseId)) {
    throw new Error(`actual native case has no qualified execution path: ${selection.mode ?? selection.provider}/${caseId}`)
  }
  const wrongId = caseId === 'wrong-id'
  const restorationFailure = caseId === 'restoration-failure-after-hook'
  const forkSource = sources.find(file => file.name === 'claude/native-fault/sdk-resume-fork.json')
  let sdkForkImage: any
  if (forkSource) {
    sdkForkImage = JSON.parse(fs.readFileSync(forkSource.path, 'utf8'))
    if (sdkForkImage.kind !== 'owned-sdk-resume-fork-fault-image' || sdkForkImage.imageDigest !== harness.imageRef
      || sdkForkImage.originalExecutableSha256 !== '73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916'
      || sdkForkImage.wrapperSha256 !== createHash('sha256').update(nativeSdkResumeForkWrapper).digest('hex')) {
      throw new Error('owned SDK native resume-fork fault image binding differs')
    }
  }
  if (wrongId && !sdkForkImage) throw new Error('owned SDK native resume-fork fault image required')
  const fieldFault = ['missing-native-id', 'placeholder-id'].includes(caseId)
  const fieldSource = sources.find(file => file.name === 'claude/native-fault/sdk-init-fields.json')
  let sdkFieldImage: any
  if (fieldSource) {
    sdkFieldImage = JSON.parse(fs.readFileSync(fieldSource.path, 'utf8'))
    const publisher = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../crates/freshell-claude-sidecar/index.mjs'), 'utf8')
    if (sdkFieldImage.kind !== 'owned-sdk-native-init-field-fault-image' || sdkFieldImage.imageDigest !== harness.imageRef
      || sdkFieldImage.originalExecutableSha256 !== '73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916'
      || sdkFieldImage.sdkVersion !== '0.3.237'
      || sdkFieldImage.originalPublisherSha256 !== createHash('sha256').update(publisher).digest('hex')
      || sdkFieldImage.patchedPublisherSha256 !== createHash('sha256').update(stageSdkInitFieldFault(publisher)).digest('hex')) {
      throw new Error('owned SDK native init-field fault image binding differs')
    }
  }
  if (fieldFault && !sdkFieldImage) throw new Error('owned SDK native init-field fault image required')
  const mode = selection.mode!
  const logicalProvider = mode === 'kilroy' ? 'kilroy' : 'claude'
  const family = 'claude'
  const references = (['env_file', 'ca_file'] as const).map((suffix) => {
    const source = sources.find((file) => file.name === `${family}/grants/${suffix}`)
    if (!source) throw new Error(`selected ${family} ${suffix} reference missing`)
    return { sourcePath: source.path, profile: suffix === 'env_file' ? 'claude_onecli_environment' : 'claude_onecli_ca_file' }
  })
  const scenario = `${mode}-${caseId}`
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release' })
  if (sdkForkImage) {
    const actual = JSON.parse(await harness.execOwnedContainerExact(supervisor.containerId, ['python3', '-c', String.raw`
import pathlib,hashlib,json
base=pathlib.Path('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai')
file=base/'claude-agent-sdk-linux-x64/claude'
print(json.dumps({'wrapperSha256':hashlib.sha256(file.read_bytes()).hexdigest(),'originalExecutableSha256':hashlib.sha256(pathlib.Path(str(file)+'.native').read_bytes()).hexdigest(),'sdkVersion':json.loads((base/'claude-agent-sdk/package.json').read_text())['version']}))
`]))
    harness.writeArtifact(`${scenario}-sdk-fault-image-private.json`, actual)
    if (actual.wrapperSha256 !== sdkForkImage.wrapperSha256 || actual.originalExecutableSha256 !== sdkForkImage.originalExecutableSha256
      || actual.sdkVersion !== '0.3.237') throw new Error('actual SDK native fault image differs before input')
  }
  if (sdkFieldImage) {
    const actual = JSON.parse(await harness.execOwnedContainerExact(supervisor.containerId, ['python3', '-c', String.raw`
import pathlib,hashlib,json
base=pathlib.Path('/opt/freshell-claude-sidecar')
print(json.dumps({'patchedPublisherSha256':hashlib.sha256((base/'index.mjs').read_bytes()).hexdigest(),'sdkVersion':json.loads((base/'node_modules/@anthropic-ai/claude-agent-sdk/package.json').read_text())['version']}))
`]))
    harness.writeArtifact(`${scenario}-sdk-init-field-image-private.json`, actual)
    if (actual.patchedPublisherSha256 !== sdkFieldImage.patchedPublisherSha256 || actual.sdkVersion !== '0.3.237') {
      throw new Error('actual SDK native init-field fault image differs before input')
    }
  }
  const workspace = path.join(harness.testRoot, scenario + '-workspace')
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  if (caseId === 'crash-before-checkpoint' || caseId === 'effect-before-observation') {
    const directory = path.join(workspace, '.claude'); fs.mkdirSync(directory, { mode: 0o770 }); fs.chmodSync(directory, 0o770)
    const afterEffect = caseId === 'effect-before-observation'
    const hook = path.join(directory, afterEffect ? 'pause-after-effect.py' : 'pause-before-checkpoint.py')
    const signal = path.join(workspace, afterEffect ? 'native-after-effect-before-observation.json' : 'native-before-checkpoint.json')
    const settings = { hooks: { [afterEffect ? 'PostToolUse' : 'PreToolUse']: [{ matcher: 'Bash', hooks: [{ type: 'command',
      command: `python3 '${hook}' '${signal}'`, timeout: 60 }] }] } }
    fs.writeFileSync(hook, "import sys,json,pathlib,time\nvalue=json.load(sys.stdin)\np=pathlib.Path(sys.argv[1])\np.write_text(json.dumps(value))\ntime.sleep(45)\nprint('{}')\n", { mode: 0o660 })
    fs.chmodSync(hook, 0o660)
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings), { mode: 0o660 })
    fs.chmodSync(path.join(directory, 'settings.json'), 0o660)
  }
  const startupFault = ['missing-native-id', 'placeholder-id', 'disabled-hooks', 'timeout-50s', 'provider-exit', 'stop-cancellation'].includes(caseId)
  if (startupFault && !fieldFault) {
    const local = path.join(workspace, '.claude'); fs.mkdirSync(local, { mode: 0o770 }); fs.chmodSync(local, 0o770)
    const file = path.join(local, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ disableAllHooks: true }), { mode: 0o660 }); fs.chmodSync(file, 0o660)
  }
  if (fieldFault) {
    const control = path.join(workspace, 'native-init-field-fault-control.json')
    fs.writeFileSync(control, JSON.stringify({ mode, caseId }), { mode: 0o660 }); fs.chmodSync(control, 0o660)
  }
  if (wrongId || restorationFailure) {
    const local = path.join(workspace, '.claude'); fs.mkdirSync(local, { mode: 0o770 }); fs.chmodSync(local, 0o770)
    const file = path.join(workspace, wrongId ? 'native-sdk-fork-observer.mjs' : 'native-sdk-restoration-observer.mjs')
    const hook = (wrongId ? terminalForkFaultHook : terminalRestorationFaultHook)
      .replace('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
        '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude' + (sdkForkImage ? '.native' : ''))
    fs.writeFileSync(file, hook, { mode: 0o660 }); fs.chmodSync(file, 0o660)
    const selected = path.join(local, 'settings.json')
    fs.writeFileSync(selected, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command',
      command: "node '" + file.replaceAll("'", "'\\''") + "'" }] }] } }), { mode: 0o660 }); fs.chmodSync(selected, 0o660)
  }
  const soulId = 'soul-' + randomUUID()
  const storeId = 'store-' + randomUUID()
  const settings = { model: 'claude-haiku-4-5-20251001', effort: 'low', permissionMode: 'default' }
  const request = { method: 'launch', params: { soulId, provider: logicalProvider, providerStoreId: storeId,
    creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: scenario,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    freshAgent: { sessionId: 'native-fresh-' + randomUUID(), provider: logicalProvider,
      sessionType: mode, runtimeVariant: 'claude-sdk-sidecar', providerStoreId: storeId,
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, ...settings,
      providerSecretReferences: references, providerLaunchContext: { preparation: { claude: { mcp_args: [] } }, config: [] } } } }
  harness.writeArtifact(`${scenario}-request.json`, request)
  if (startupFault) return executeManagedFreshStartupFault(harness, supervisor, request, caseId, scenario, settings, !!sdkForkImage)
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
      ['python3', '-c', claudeNativeInspection, view.nativeSessionId, String(requireTranscript), 'fresh', 'ordinary', ...(sdkForkImage ? ['sdk-fork-image'] : [])]))
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
  if (caseId === 'current-native-turn' || caseId === 'exact-resume' || wrongId || restorationFailure) {
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
    if (wrongId) {
      const control = path.join(workspace, 'native-fork-fault-control.json')
      const bytes = Buffer.from(before.transcript.bytesBase64, 'base64')
      fs.writeFileSync(control, JSON.stringify({ root: view.nativeSessionId, seedBytes: bytes.length,
        seedSha256: before.transcript.sha256 }), { mode: 0o660 }); fs.chmodSync(control, 0o660)
    }
    if (restorationFailure) {
      const mutation = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
        ['python3', '-c', claudeNativeRestorationFault, view.nativeSessionId, before.transcript.sha256,
          JSON.stringify(before.transcript.identity)]))
      harness.writeArtifact(`${scenario}-owned-before-load-mutation-private.json`, mutation)
      const malformedProbe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
      harness.writeArtifact(`${scenario}-malformed-before-load-store-probe.json`, malformedProbe)
      if (malformedProbe.data.kind !== 'reattach_ready' || mutation.uid !== 65534 || mutation.gid !== 0
        || mutation.beforeSha256 !== before.transcript.sha256 || mutation.changedAssistantRows < 1) {
        throw new Error('bounded SDK native loader fault did not retain the owned current store route')
      }
      const control = path.join(workspace, 'native-restoration-fault-control.json')
      fs.writeFileSync(control, JSON.stringify(mutation), { mode: 0o660 }); fs.chmodSync(control, 0o660)
    }
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const recovery = wrongId || restorationFailure ? await harness.adminRaw(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
      : await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact(`${scenario}-recovery.json`, recovery)
    if (wrongId) {
      const observedPath = path.join(workspace, 'native-fork-fault-observation.json')
      const fault = JSON.parse(fs.readFileSync(observedPath, 'utf8'))
      harness.writeArtifact(`${scenario}-fork-current-native-event-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-fork-current-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const nativeFork = fault.native.source === 'fork' && fault.native.session_id !== view.nativeSessionId
        && fault.launch.requestedNativeSessionId === view.nativeSessionId
        && fault.launch.incarnationId !== view.incarnationId && fault.launch.launchNonce !== namespace.hook.launch.launchNonce
        && fault.uid === 65534 && fault.gid === 0 && fault.nativeExecutableSha256 === namespace.executableSha256
        && fault.nativeArgv.includes('--fork-session') && nativeResumeRootInArgv(fault.nativeArgv, view.nativeSessionId)
      const retained = fault.originalPrefixSha256 === before.transcript.sha256
        && JSON.stringify(fault.identity) === JSON.stringify(before.transcript.identity.slice(0, 2))
      const blocked = recovery.result?.Ok?.data?.outcome === 'blocked' && current.length > 0
        && current.every((row: any) => row.launchState !== 'running' && row.nativeIdentityObservation?.incarnationId !== fault.launch.incarnationId)
      if (!nativeFork || !retained || !blocked) throw new Error('genuine SDK native wrong root was not contained before input')
      const input = await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: { soulId, text: 'Owned refused native fork probe. Do not use tools.' } })
      harness.writeArtifact(`${scenario}-fork-input-refusal.json`, input)
      if (!input.result?.Err) throw new Error('genuine SDK native wrong root admitted input')
      assertions.push({ name: 'actual-sdk-exact-resume-selected-different-native-root', pass: nativeFork },
        { name: 'original-native-root-volume-file-and-eof-retained', pass: retained },
        { name: 'different-native-root-blocked-running-observation-and-input', pass: blocked && !!input.result.Err })
    } else if (restorationFailure) {
      const file = path.join(workspace, 'native-restoration-fault-observation.json'), deadline = Date.now() + 6_000
      while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      const fault = JSON.parse(fs.readFileSync(file, 'utf8'))
      harness.writeArtifact(`${scenario}-restoration-fault-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-after-restoration-failure-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const contained = recovery.result?.Ok?.data?.outcome === 'blocked' && current.length > 0
        && current.every((row: any) => row.launchState !== 'running'
          && row.nativeIdentityObservation?.incarnationId !== fault.hook.launch.incarnationId)
      const currentHook = fault.hook.native.source === 'resume' && fault.hook.native.session_id === view.nativeSessionId
        && fault.hook.launch.requestedNativeSessionId === view.nativeSessionId
        && fault.hook.launch.launchNonce !== namespace.hook.launch.launchNonce && fault.hook.launch.incarnationId !== view.incarnationId
      const ownedFault = fault.beforeSha256 === before.transcript.sha256 && fault.beforeSha256 !== fault.afterSha256
        && fault.observedFaultPrefixSha256 === fault.afterSha256 && fault.changedAssistantRows > 0
        && fault.uid === 65534 && fault.gid === 0 && fault.nativeExecutableSha256 === namespace.executableSha256
      if (!contained || !currentHook || !ownedFault || fault.nativeExited !== true || fault.loadedSha256 !== null) {
        throw new Error('actual SDK native hook/restoration failure was not contained before input')
      }
      const input = await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: { soulId, text: 'Owned failed restoration probe. Do not use tools.' } })
      harness.writeArtifact(`${scenario}-after-restoration-failure-input-refusal.json`, input)
      if (!input.result?.Err) throw new Error('actual SDK native restoration failure admitted input')
      assertions.push({ name: 'genuine-current-sdk-resume-hook-before-native-restoration-failure', pass: currentHook && ownedFault },
        { name: 'native-restoration-exit-without-running-or-observed-identity', pass: contained && fault.nativeExited === true },
        { name: 'failed-sdk-native-restoration-refuses-ordinary-input', pass: !!input.result.Err })
    } else {
      if (recovery.data.outcome !== 'replaced' || recovery.data.view.nativeSessionId !== view.nativeSessionId
        || recovery.data.view.incarnationId === view.incarnationId || !recovery.data.view.nativeIdentityObservation
        || recovery.data.view.recoveryState !== 'live') throw new Error('native exact-root replacement failed')
      const after = await inspect(recovery.data.view.containerId, 'after-death', true)
      if (before.transcript.sha256 !== after.transcript.sha256 || before.transcript.identity[0] !== after.transcript.identity[0]
        || before.transcript.identity[1] !== after.transcript.identity[1]) throw new Error('native transcript lost original owned volume/file continuity')
      assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
        { name: 'replacement-new-incarnation-same-native-root', pass: recovery.data.outcome === 'replaced'
          && recovery.data.view.incarnationId !== view.incarnationId && recovery.data.view.nativeSessionId === view.nativeSessionId
          && recovery.data.view.nativeIdentityObservation.nativeSessionId === view.nativeSessionId },
        { name: 'original-owned-volume-transcript-continuity', pass: before.transcript.sha256 === after.transcript.sha256
          && before.transcript.identity[0] === after.transcript.identity[0] && before.transcript.identity[1] === after.transcript.identity[1] },
        { name: 'same-workspace-selected-native-profile', pass: JSON.stringify(before.profileFiles) === JSON.stringify(after.profileFiles) })
      if (caseId === 'current-native-turn') {
        const recalled = await nativeTurn('Reply with only the private marker from before. Do not use tools.', 'recall')
        const text = recalled.flatMap((event) => event.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('').trim()
        if (text !== marker) throw new Error('native restored context did not recall the private marker')
        if (recalled.some((event) => (event.content ?? []).some((part: any) => part.type === 'tool_use'))) throw new Error('native recall unexpectedly requested a tool')
        assertions.push({ name: 'actual-restored-context-private-marker-recall', pass: text === marker },
          { name: 'native-turns-requested-no-tools', pass: ![...seedEvents, ...recalled].some((event) =>
            (event.content ?? []).some((part: any) => part.type === 'tool_use')) })
      } else {
        assertions.push({ name: 'current-native-resume-observation-before-replacement-input', pass:
          after.hook.native.source === 'resume' && after.hook.native.session_id === view.nativeSessionId
          && recovery.data.view.nativeIdentityObservation.incarnationId === recovery.data.view.incarnationId })
      }
    }
  }
  if (selection.case === 'approval-checkpoint') {
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

async function executeManagedFreshStartupFault(harness: RuntimeHarness, supervisor: Awaited<ReturnType<RuntimeHarness['startSupervisor']>>,
  request: any, caseId: string, scenario: string, settings: unknown, sdkForkImage = false): Promise<NativeExperimentOriginal> {
  const soulId = request.params.soulId
  const began = Date.now()
  let finished = false, reply: any, error: unknown, namespace: any, receipt: any, fieldReceipt: any, refusals: any
  const fieldFault = ['missing-native-id', 'placeholder-id'].includes(caseId)
  const pending = harness.adminRaw(supervisor, request).then(
    (value) => { reply = value; finished = true },
    (failure) => { error = failure; finished = true },
  )
  await Promise.resolve()
  if (finished && error) throw error
  const attempts: string[] = []
  // Observe the actual selected child before its existing identity deadline.
  // A requested root and the sidecar create key never fill observed identity.
  const deadline = Date.now() + 6_000
  while (!finished && Date.now() < deadline) {
    receipt = harness.broker.receipts().find((owned) => owned.soulId === soulId)
    if (receipt) {
      try {
        if (fieldFault) {
          const file = path.join(request.params.freshAgent.cwd, 'native-init-field-fault-observation.json')
          if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 64 * 1024) throw new Error('owned native field receipt differs')
          fieldReceipt = JSON.parse(fs.readFileSync(file, 'utf8'))
        }
        namespace = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId,'65534:0',
          ['python3','-c',claudeNativeInspection,fieldFault ? fieldReceipt.actualNativeSessionId : request.params.nativeSessionId??'', 'false','fresh', fieldFault?'ordinary':caseId==='wrong-id'?'wrong-id':'disabled-hooks', ...(sdkForkImage ? ['sdk-fork-image'] : [])]))
        if (fieldFault) {
          const logs = harness.containerLogs(receipt.containerId)
          refusals = logs.split('\n').flatMap(line => {
            try { const record = JSON.parse(line); return record.event === 'host.native_identity.refused' ? [record] : [] }
            catch { return [] }
          })
          if (!nativeSdkInitFieldFaultMatches(request.params.freshAgent.sessionType, caseId, fieldReceipt, namespace, refusals)) {
            throw new Error('actual normalized SDK native field refusal unavailable')
          }
        }
        break
      } catch (failure) {attempts.push(String(failure))}
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  harness.writeArtifact(`${scenario}-pre-fault-capture-errors-private.json`,attempts)
  if (!namespace || !receipt) {
    await pending
    if (error) throw error
    harness.writeArtifact(`${scenario}-failed-launch.json`,reply)
    throw new Error('genuine current unobserved SDK child unavailable before startup fault')
  }
  harness.writeArtifact(`${scenario}-pre-fault-native-private.json`,namespace)
  if (fieldFault) harness.writeArtifact(`${scenario}-native-field-normalized-private.json`, { fieldReceipt, refusals })
  const hookSetting=caseId==='wrong-id'||fieldFault ? {} : JSON.parse(fs.readFileSync(path.join(request.params.freshAgent.cwd,'.claude/settings.json'),'utf8'))
  const actualNamespace=namespace.uid===65534 && namespace.gid===0 && namespace.caps==='0000000000000000'
    && namespace.readOnlyRoot && namespace.httpsStatus===200 && namespace.tlsVerifyMode===2 && namespace.tlsCheckHostname
    && namespace.version.startsWith('2.1.237') && namespace.nativeCwd===request.params.freshAgent.cwd
    && namespace.completedTurns===0 && namespace.toolEvents===0
  const nativeFault=fieldFault ? nativeSdkInitFieldFaultMatches(request.params.freshAgent.sessionType,caseId,fieldReceipt,namespace,refusals) : caseId==='wrong-id' ? !!namespace.hook && namespace.hook.native.session_id!==request.params.nativeSessionId
    && JSON.stringify(namespace.hook.launch)===JSON.stringify(namespace.nativeLaunch)
    : namespace.hook===null && namespace.nativeRoot===null && hookSetting.disableAllHooks===true
  if (!actualNamespace || !nativeFault) {await pending;throw new Error('genuine native SDK pin/profile/identity fault differs')}
  let fault: any
  if (caseId==='provider-exit') {
    if (finished)throw new Error('native startup settled before owned provider exit')
    await harness.killOwnedRuntimePidExact(receipt.containerId,namespace.nativePid,'TERM')
  } else if (caseId==='stop-cancellation') {
    if (finished)throw new Error('native startup settled before ordinary Stop')
    fault=await harness.adminOk(supervisor,harness.stopBody(soulId))
    harness.writeArtifact(`${scenario}-ordinary-stop.json`,fault)
  }
  await pending
  if (error)throw error
  const elapsedMs=Date.now() - began
  harness.writeArtifact(`${scenario}-launch.json`,reply)
  harness.writeArtifact(`${scenario}-timing.json`,{elapsedMs})
  const inventory=await harness.adminOk(supervisor,harness.inventoryBody())
  harness.writeArtifact(`${scenario}-current-inventory.json`,inventory)
  const current=inventory.data.filter((row:any)=>row.soulId===soulId)
  if (!reply.result?.Err || !current.length || current.some((row:any)=>row.launchState==='running'||row.nativeIdentityObservation)) {
    throw new Error('unobserved native fresh startup published Running or identity')
  }
  if (caseId==='timeout-50s' && (elapsedMs<50_000||elapsedMs>=60_000))throw new Error('actual SDK native timeout did not respect its existing50s bound')
  if (caseId==='provider-exit') {
    fault=JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId,'65534:0',
      ['python3','-c',"import pathlib,json,sys;print(json.dumps({'nativeExited':not (pathlib.Path('/proc')/sys.argv[1]/'exe').exists()}))",String(namespace.nativePid)]))
    harness.writeArtifact(`${scenario}-native-exit.json`,fault)
    if (!fault.nativeExited)throw new Error('owned native SDK writer remains after exit fault')
  }
  if (caseId==='stop-cancellation' && (fault.data?.outcome!=='verified_empty'||current.some((row:any)=>row.launchState!=='stopped'||row.desiredState!=='stopped'||row.recoveryState!=='stopped'))) {
    throw new Error('ordinary Stop did not confirm empty stopped native fresh runtime')
  }
  const input=await harness.adminRaw(supervisor,{method:'fresh_agent_send',params:{soulId,text:'Owned blocked startup probe. Do not use tools.'}})
  harness.writeArtifact(`${scenario}-input-refusal.json`,input)
  if (!input.result?.Err)throw new Error('unobserved native fresh startup admitted ordinary input')
  const original={caseId,ownerId:harness.runId,candidateSha:harness.candidateSha,imageDigest:harness.imageRef,
    nativeVersion:namespace.version,executableSha256:namespace.executableSha256,
    profileSha256:createHash('sha256').update(JSON.stringify({settings,nativeProfile:namespace.profileFiles})).digest('hex'),
    artifactReferences:[`${scenario}-pre-fault-native-private.json`,`${scenario}-launch.json`,`${scenario}-current-inventory.json`,`${scenario}-input-refusal.json`,
      ...(fieldFault ? [`${scenario}-native-field-normalized-private.json`, `${scenario}-sdk-init-field-image-private.json`] : [])],
    assertions:[{name:'actual-default-sdk-child-normal-uid-tls-current-launch',pass:actualNamespace},
      {name:'actual-native-startup-fault-remains-unobserved',pass:nativeFault},
      {name:'native-fault-refuses-running-current-observation-and-input',pass:!!input.result.Err},
      ...(caseId==='provider-exit'?[{name:'owned-native-writer-exited',pass:fault.nativeExited}]:[]),
      ...(caseId==='stop-cancellation'?[{name:'ordinary-stop-confirmed-empty-stopped-runtime',pass:fault.data?.outcome==='verified_empty' && current.every((row:any)=>row.launchState==='stopped'&&row.desiredState==='stopped'&&row.recoveryState==='stopped')}]:[]),
      ...(caseId==='timeout-50s'?[{name:'actual-existing50s-native-startup-bound',pass:elapsedMs>=50_000&&elapsedMs<60_000}]:[])]}
  harness.writeArtifact(`${scenario}-original.json`,original)
  return original
}

async function executeManagedTerminalClaude(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], caseId: string, serverPath?: string,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []): Promise<NativeExperimentOriginal> {
  const restorationFailure = caseId === 'restoration-failure-after-hook'
  const forkRoot = caseId === 'fork-root'
  const resumes = ['exact-resume', 'current-native-turn', 'fork-root', 'restoration-failure-after-hook'].includes(caseId)
  const nativeTimeout = caseId === 'timeout'
  const trustRefusal = caseId === 'trust-refusal'
  const unwritableSignal = caseId === 'unwritable-signal'
  const providerExit = caseId === 'provider-exit'
  const stopCancellation = caseId === 'stop-cancellation'
  const staleSignal = caseId === 'stale-shared-signal'
  const startupFault = providerExit || stopCancellation
  const pendingFault = startupFault || staleSignal
  let priorSignals: any
  if (staleSignal) {
    // Obtain genuine current native bytes in this owned rig, then close their
    // sole writer before presenting them to a different launch as a fault.
    await executeManagedTerminalClaude(harness, sources, 'create', serverPath, servers)
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(harness.evidenceDir, name), 'utf8'))
    const priorView = read('claude-create-current-view.json')
    priorSignals = read('claude-create-signal-native-private.json').processes.find((row: any) =>
      row.launch?.incarnationId === priorView.incarnationId)
    if (!priorSignals || priorSignals.signals.length !== 2 || priorSignals.signals.some((row: any) => !row.bytesBase64 || !row.sha256)) {
      throw new Error('genuine owned prior-launch native signals missing')
    }
    harness.killOwnedRuntimeExact(priorView.containerId)
    await harness.waitForContainerExit(priorView.containerId)
  }
  const hooksDisabled = caseId === 'disabled-hooks' || nativeTimeout || pendingFault
  if (resumes && !serverPath) throw new Error('actual terminal recovery requires the owned real server artifact')
  const grants = (['env_file', 'ca_file'] as const).map((suffix) => {
    const file = sources.find((source) => source.name === `claude/grants/${suffix}`)
    if (!file) throw new Error(`selected terminal Claude ${suffix} reference missing`)
    return { sourcePath: file.path, profile: suffix === 'env_file' ? 'claude_onecli_environment' : 'claude_onecli_ca_file' }
  })
  const preferences = sources.find((source) => source.name === 'claude/profile/native-startup-user.json')
  if (!preferences) throw new Error('owned native terminal startup preferences missing')
  const scenario = `claude-${caseId}`
  const workspace = path.join(harness.testRoot, `${scenario}-workspace`)
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  // Select the same ordinary user file on create and controller reissue.
  // The supported config directory keeps preferences in that selected root.
  const home = path.join(harness.testRoot, 'native-source/claude', scenario)
  const userRoot = path.join(home, '.claude')
  const preferencePath = path.join(userRoot, '.claude.json')
  fs.mkdirSync(userRoot, { recursive: true, mode: 0o700 })
  fs.copyFileSync(preferences.path, preferencePath)
  fs.chmodSync(preferencePath, 0o600)
  if (restorationFailure || forkRoot) {
    const local = path.join(workspace, '.claude'); fs.mkdirSync(local, { mode: 0o770 }); fs.chmodSync(local, 0o770)
    const hookPath = path.join(workspace, forkRoot ? 'native-fork-fault.mjs' : 'native-restoration-fault.mjs')
    fs.writeFileSync(hookPath, forkRoot ? terminalForkFaultHook : terminalRestorationFaultHook, { mode: 0o660 }); fs.chmodSync(hookPath, 0o660)
    fs.writeFileSync(path.join(local, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command', command: "node '" + hookPath.replaceAll("'", "'\\''") + "'",
    }] }] } }), { mode: 0o660 })
    fs.chmodSync(path.join(local, 'settings.json'), 0o660)
  }
  if (trustRefusal) {
    const profile = JSON.parse(fs.readFileSync(preferencePath, 'utf8'))
    profile.projects ??= {}; profile.projects[workspace] ??= {}
    profile.projects[workspace].hasTrustDialogAccepted = false
    fs.writeFileSync(preferencePath, JSON.stringify(profile), { mode: 0o600 })
  }
  if (hooksDisabled) fs.writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify({ disableAllHooks: true }), { mode: 0o600 })
  if (unwritableSignal) {
    const hookPath = path.join(workspace, 'native-unwritable-signal.sh')
    fs.writeFileSync(hookPath, 'set -eu\nmkdir -p -- "$FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR"\nchmod 500 -- "$FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR"\nprintf \'%s\\n\' \'{}\'\n', { mode: 0o660 })
    fs.chmodSync(hookPath, 0o660)
    const command = "sh '" + hookPath.replaceAll("'", "'\\''") + "'"
    fs.writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command }] }],
    } }), { mode: 0o600 })
  }
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release',
    env: { HOME: home, FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'claude' } })
  const soulId = 'soul-' + randomUUID()
  const nativeRoot = staleSignal ? JSON.parse(Buffer.from(priorSignals.signals.find((row: any) => row.name === 'session-start.json').bytesBase64, 'base64').toString('utf8')).native.session_id : randomUUID()
  const actualRoot = caseId === 'wrong-root' ? randomUUID() : nativeRoot
  let managedPreparation: any
  if (resumes) {
    const { RustServer } = await import('../../test/e2e-browser/helpers/rust-server.js')
    const server = new RustServer({ homeDir: home, preserveHomeOnStop: true,
      env: { FRESHELL_BIND_HOST: '0.0.0.0', FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: supervisor.controlSecretFile,
        FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'claude',
        FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE: grants[0]!.sourcePath,
        FRESHELL_MANAGED_CLAUDE_ONECLI_CA_FILE: grants[1]!.sourcePath },
      stripEnvPrefixes: ['GEMINI_', 'GOOGLE_API_KEY', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'LUNAROUTE_'],
      setupHome: async (selectedHome) => {
        const config = path.join(selectedHome, '.freshell'); fs.mkdirSync(config, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ version: 1, settings: {
          defaultCwd: workspace, codingCli: { enabledProviders: ['claude'], providers: { claude: { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low' } } },
        } }), { mode: 0o600 })
      } })
    const owned = { server, scope: scenario, pid: undefined as number | undefined }; servers.push(owned)
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = serverPath
    try {
      const info = await server.start(); owned.pid = info.pid
      harness.writeArtifact(`${scenario}-server-private.json`, { ...info, ...server.processEvidence(),
        executableSha256: createHash('sha256').update(fs.readFileSync(serverPath!)).digest('hex') })
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    managedPreparation = await new Promise((resolve, reject) => {
      const socket = createConnection(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock'))
      const chunks: Buffer[] = []
      socket.setTimeout(5_000, () => socket.destroy(new Error('actual native capability issue timed out')))
      socket.once('connect', () => socket.end(JSON.stringify({ action: 'issue', controlSecret: supervisor.controlSecret,
        soulId, incarnationId: null, grantId: null, provider: 'claude', tuiSource: null, workspace, cwd: workspace })))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('actual native capability issue failed')) }
      })
    })
    harness.writeArtifact(`${scenario}-managed-preparation-private.json`, managedPreparation)
    if (!managedPreparation.context?.mcpCapability || !managedPreparation.secretReferences?.length) {
      throw new Error('actual native managed capability/preparation missing')
    }
  }
  const settings = JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'sh -lc \'d="$HOME/.freshell/session-signals/claude"; n=$(date +%s%N 2>/dev/null); case "$n" in *[!0-9]*|"") n="$(date +%s)000000000";; esac; f="$d/${FRESHELL_TERMINAL_ID:-unknown}__$n-$$"; mkdir -p "$d" && cat > "$f.tmp" && mv "$f.tmp" "$f.json"\' 2>/dev/null || true' }] }],
    Stop: [{ hooks: [{ type: 'command', command: "printf '%s\\n' '{\"terminalSequence\":\"\\u0007\"}'" }] }],
  } })
  const request = { method: 'launch', params: { soulId, provider: 'claude', providerStoreId: 'store-' + randomUUID(),
    nativeSessionId: nativeRoot, creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: scenario,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    terminal: { terminalId: 'native-terminal-' + randomUUID(), streamId: 'native-stream-' + randomUUID(),
      mode: 'claude', program: 'claude', args: ['--settings', settings, '--session-id', actualRoot,
        '--model', 'claude-haiku-4-5-20251001', '--effort', 'low', ...(forkRoot ? ['--fork-session'] : [])],
      env: { HOME: '/home/freshell/provider', CLAUDE_CONFIG_DIR: '/home/freshell/provider/.claude', TERM: 'xterm-256color' },
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, cols: 100, rows: 30, projectKey: scenario,
      providerModel: 'claude-haiku-4-5-20251001', providerReasoningEffort: 'low', providerSecretReferences: managedPreparation?.secretReferences ?? grants,
      providerLaunchContext: managedPreparation?.context ?? { preparation: { claude: { mcp_args: [] } }, config: [{ root: 'user_provider',
        relativePath: '.claude.json', providerRelativePath: '.claude/.claude.json', format: 'json' },
        ...(hooksDisabled || unwritableSignal ? [{ root: 'user_provider', relativePath: 'settings.json', providerRelativePath: '.claude/settings.json', format: 'json' }] : [])] } } } }
  harness.writeArtifact(`${scenario}-request.json`, request)
  const inspectTerminalNative = async (containerId: string) => JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
    ['python3', '-c', claudeNativeInspection, actualRoot, 'false', 'terminal', ...(hooksDisabled ? ['disabled-hooks'] : trustRefusal ? ['trust-refusal'] : unwritableSignal ? ['unwritable-signal'] : [])]))
  const wrongRoot = caseId === 'wrong-root'
  const startupRefusal = wrongRoot || hooksDisabled || trustRefusal || unwritableSignal
  const refusalReason = staleSignal ? 'stale shared native signals' : unwritableSignal ? 'unwritable current native signal directory' : trustRefusal ? 'unaccepted native trust' : nativeTimeout ? 'native startup timeout'
    : providerExit ? 'exited native provider' : stopCancellation ? 'cancelled native startup'
      : hooksDisabled ? 'disabled native hooks' : 'wrong current native root'
  const launchStartedAt = Date.now()
  let beforeFault: any
  let faultResult: any
  let result: any
  if (pendingFault) {
    let finished = false
    let launchError: unknown
    const launch = harness.adminRaw(supervisor, request).then(
      (reply) => { result = reply; finished = true },
      (error) => { launchError = error; finished = true },
    )
    await Promise.resolve()
    if (finished && launchError) throw launchError
    const deadline = Date.now() + 6_000
    let receipt: ReturnType<typeof harness.broker.receipts>[number] | undefined
    const captureErrors: string[] = []
    while (!finished && Date.now() < deadline) {
      receipt = harness.broker.receipts().find((owned) => owned.soulId === soulId)
      if (receipt) {
        try {
          beforeFault = await inspectTerminalNative(receipt.containerId)
          break
        } catch (error) { captureErrors.push(String(error)) }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    harness.writeArtifact(`${scenario}-before-fault-attempts-private.json`, captureErrors)
    if (!beforeFault || !receipt || finished || beforeFault.hook || beforeFault.loaded
      || !Number.isSafeInteger(beforeFault.nativePid) || beforeFault.nativePid <= 1
      || beforeFault.uid !== 65534 || beforeFault.gid !== 0 || beforeFault.caps !== '0000000000000000'
      || !beforeFault.readOnlyRoot || beforeFault.httpsStatus !== 200 || beforeFault.tlsVerifyMode !== 2 || !beforeFault.tlsCheckHostname
      || beforeFault.hooksDisabled !== true || !beforeFault.version.startsWith('2.1.263')
      || beforeFault.nativeCwd !== workspace || beforeFault.nativeArgv?.[beforeFault.nativeArgv.indexOf('--model') + 1] !== 'claude-haiku-4-5-20251001') {
      await launch
      harness.writeArtifact(`${scenario}-unexpected-launch-private.json`, { result, error: String(launchError ?? '') })
      throw new Error('actual unobserved native child unavailable before startup fault')
    }
    harness.writeArtifact(`${scenario}-before-fault-native-private.json`, beforeFault)
    if (staleSignal) {
      faultResult = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId, '65534:0', ['python3', '-c', String.raw`
import pathlib,os,json,hashlib,base64,sys
pid=sys.argv[1];prior=json.loads(sys.argv[2]);p=pathlib.Path('/proc')/pid
env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
current=json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']);directory=pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])
assert current['launchNonce']!=prior['launch']['launchNonce'] and current['incarnationId']!=prior['launch']['incarnationId']
assert directory.parent==pathlib.Path('/home/freshell/provider/.freshell/native-identity') and directory.name==current['launchNonce']
directory.mkdir(parents=True,exist_ok=True)
for row in prior['signals']:
 assert row['name'] in ['session-start.json','statusline-loaded.json']
 raw=base64.b64decode(row['bytesBase64']);assert len(raw)<=65536 and hashlib.sha256(raw).hexdigest()==row['sha256']
 parsed=json.loads(raw);assert parsed['launch']==prior['launch']
 target=directory/row['name'];assert not target.exists();target.write_bytes(raw)
print(json.dumps({'priorLaunch':prior['launch'],'currentLaunch':current,'signalSha256':[hashlib.sha256((directory/row['name']).read_bytes()).hexdigest() for row in prior['signals']]}))
`, String(beforeFault.nativePid), JSON.stringify(priorSignals)]))
      harness.writeArtifact(`${scenario}-stale-signal-injection-private.json`, faultResult)
    } else if (providerExit) harness.killOwnedRuntimePidExact(receipt.containerId, beforeFault.nativePid, 'TERM')
    else {
      faultResult = await harness.adminOk(supervisor, harness.stopBody(soulId))
      harness.writeArtifact(`${scenario}-ordinary-stop.json`, faultResult)
    }
    await launch
    if (launchError) throw launchError
    if (providerExit) {
      const deadline = Date.now() + 3_000
      do {
        faultResult = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId, '65534:0',
          ['python3', '-c', "import pathlib,json,sys;print(json.dumps({'nativeExited':not (pathlib.Path('/proc')/sys.argv[1]/'exe').exists()}))", String(beforeFault.nativePid)]))
        if (faultResult.nativeExited) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
      harness.writeArtifact(`${scenario}-native-exit.json`, faultResult)
    }
  } else {
    try { result = startupRefusal ? await harness.adminRaw(supervisor, request) : await harness.adminOk(supervisor, request) }
    catch (error) {
      if (restorationFailure) {
        const receipt = harness.broker.receipts().find((owned) => owned.soulId === soulId)
        if (receipt) {
          try {
            harness.writeArtifact(`${scenario}-failed-startup-terminal-private.json`, await harness.adminRaw(supervisor,
              harness.terminalReadOutputBody(soulId)))
            harness.writeArtifact(`${scenario}-failed-startup-native-private.json`, JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId,
              '65534:0', ['python3', '-c', String.raw`
import pathlib,hashlib,json,os
selected=pathlib.Path('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');expected=hashlib.sha256(selected.read_bytes()).hexdigest();rows=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if hashlib.sha256((p/'exe').read_bytes()).hexdigest()!=expected:continue
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  directory=pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])
  rows.append({'nativePid':int(p.name),'executableSha256':expected,'nativeCwd':str((p/'cwd').resolve()),'launch':json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']),
   'hook':json.loads((directory/'session-start.json').read_text()) if (directory/'session-start.json').exists() else None,
   'loaded':json.loads((directory/'statusline-loaded.json').read_text()) if (directory/'statusline-loaded.json').exists() else None})
 except (OSError,ValueError):continue
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'processes':rows}))
`])))
          } catch (captureError) { harness.writeArtifact(`${scenario}-failed-startup-capture-error.json`, { reason: String(captureError) }) }
        }
      }
      throw error
    }
  }
  const launchElapsedMs = Date.now() - launchStartedAt
  harness.writeArtifact(`${scenario}-launch.json`, result)
  harness.writeArtifact(`${scenario}-launch-timing.json`, { elapsedMs: launchElapsedMs })
  let view: any
  if (startupRefusal) {
    const failure = `${refusalReason} published a running launch`
    if (result.result?.Err?.code !== (stopCancellation ? 'STALE_INTENT_REVISION' : 'RECOVERY_BLOCKED')) throw new Error(failure)
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    view = inventory.data.find((row: any) => row.soulId === soulId)
    if (view?.launchState !== (stopCancellation ? 'stopped' : 'starting') || view.nativeIdentityObservation) throw new Error(failure)
  } else view = result.data.view
  const deadline = Date.now() + 50_000
  while (!startupRefusal && !view.nativeIdentityObservation && Date.now() < deadline) {
    harness.writeArtifact(`${scenario}-terminal-output-private.json`, await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
    // Refresh asynchronous PTY evidence through the existing host snapshot
    // probe before reading the registry's stored observation.
    harness.writeArtifact(`${scenario}-store-probe.json`, await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId)))
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    view = inventory.data.find((row: any) => row.soulId === soulId)
    if (!view) throw new Error('owned terminal Claude view disappeared')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  harness.writeArtifact(`${scenario}-current-view.json`, view)
  const nativeSignals = startupFault ? { beforeFault, faultResult } : JSON.parse(await harness.execOwnedContainerAsExact(view.containerId,
    '65534:0', ['python3', '-c', String.raw`
import pathlib,json,os,hashlib,base64
selected=pathlib.Path('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
expected=hashlib.sha256(selected.read_bytes()).hexdigest();processes=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if hashlib.sha256((p/'exe').read_bytes()).hexdigest()!=expected:continue
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  directory=env.get('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR');signals=[]
  for name in ['session-start.json','statusline-loaded.json']:
   try:
    f=pathlib.Path(directory)/name if directory else None
    raw=f.read_bytes() if f else None
    if raw is not None and len(raw)>65536:signals.append({'name':name,'error':'oversized'});continue
    signals.append({'name':name,'bytesBase64':base64.b64encode(raw).decode() if raw is not None else None,'sha256':hashlib.sha256(raw).hexdigest() if raw is not None else None})
   except OSError as e:signals.append({'name':name,'errno':e.errno})
  processes.append({'pid':int(p.name),'executableSha256':expected,'launch':json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']) if env.get('FRESHELL_NATIVE_IDENTITY_LAUNCH') else None,'signalDir':directory,'signals':signals})
 except (OSError,ValueError):continue
print(json.dumps({'readerUid':os.getuid(),'readerGid':os.getgid(),'processes':processes}))
`]))
  harness.writeArtifact(`${scenario}-signal-native-private.json`, nativeSignals)
  const observation = view.nativeIdentityObservation
  const currentObservation = !!observation && view.recoveryState === 'live' && observation.source === 'claude_native_event'
    && observation.nativeSessionId === nativeRoot && view.nativeSessionId === nativeRoot
    && observation.incarnationId === view.incarnationId
  if (startupRefusal ? !!observation : !currentObservation) throw new Error('terminal Claude current post-load observation missing')
  const namespace = staleSignal ? await inspectTerminalNative(view.containerId) : beforeFault ?? await inspectTerminalNative(view.containerId)
  harness.writeArtifact(`${scenario}-namespace-native-private.json`, namespace)
  const noCallbacks = hooksDisabled || trustRefusal || unwritableSignal
  const selectedModel = noCallbacks ? namespace.nativeArgv?.[namespace.nativeArgv.indexOf('--model') + 1] : namespace.loaded?.native?.model?.id
  const selectedCwd = noCallbacks ? namespace.nativeCwd : namespace.loaded?.native?.workspace?.current_dir
  const staleMatches = (captured: any) => staleNativeSignalBindingMatches(captured, priorSignals.launch, faultResult.currentLaunch, nativeRoot)
  const loaderMatches = staleSignal ? staleMatches(namespace) : noCallbacks
    ? namespace.hook === null && namespace.loaded === null
      && (trustRefusal ? namespace.nativePreferences?.workspaceTrust === false : unwritableSignal
        ? namespace.signalWritable === false && namespace.signalMode === '0o500' && namespace.hooksDisabled !== true
        : namespace.hooksDisabled === true)
    : namespace.loaded?.native?.version === '2.1.263' && namespace.loaded.native.session_id === actualRoot
      && JSON.stringify(namespace.loaded.launch) === JSON.stringify(namespace.hook.launch)
  if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000'
    || !namespace.readOnlyRoot || namespace.httpsStatus !== 200 || namespace.tlsVerifyMode !== 2 || !namespace.tlsCheckHostname
    || !namespace.version.startsWith('2.1.263') || !loaderMatches
    || selectedModel !== 'claude-haiku-4-5-20251001' || selectedCwd !== workspace) {
    throw new Error('actual terminal Claude pin/profile/namespace/TLS differs')
  }
  if (nativeTimeout && (launchElapsedMs < 8_000 || launchElapsedMs >= 50_000)) throw new Error('native startup timeout did not respect its bounded wait')
  if (!startupRefusal) {
    // Exercise the ordinary output/store path before starting a paid seed.
    // Input ACKs cannot hide a dispatcher or store failure at this boundary.
    harness.writeArtifact(`${scenario}-pre-input-terminal-private.json`, await harness.adminOk(supervisor,
      harness.terminalReadOutputBody(soulId)))
    harness.writeArtifact(`${scenario}-pre-input-store-probe.json`, await harness.adminOk(supervisor,
      harness.probeRecoveryBody(soulId)))
  }
  const assertions = startupRefusal ? [{ name: staleSignal ? 'genuine-prior-launch-shared-signals-refused-before-running-and-input' : unwritableSignal ? 'actual-native-signal-write-refused-before-running-and-input' : trustRefusal ? 'actual-native-trust-refused-before-running-and-input'
    : nativeTimeout ? 'bounded-actual-native-startup-timeout-before-running-and-input'
      : providerExit ? 'actual-native-provider-exit-refused-before-running-and-input'
        : stopCancellation ? 'ordinary-stop-cancels-native-startup-before-running-and-input'
          : hooksDisabled ? 'actual-disabled-native-hooks-refused-before-running-and-input' : 'wrong-current-native-root-refused-before-running-and-input', pass: false }]
    : [{ name: 'actual-terminal-current-native-post-load-observation-before-input', pass:
      observation.nativeSessionId === namespace.loaded.native.session_id && observation.incarnationId === view.incarnationId }]
  if (startupRefusal) {
    if (trustRefusal) {
      const output = await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId))
      harness.writeArtifact(`${scenario}-native-trust-terminal-private.json`, output)
      if (!/trust/i.test(output.data.frames.map((frame: any) => frame.data).join(''))) throw new Error('actual native trust prompt unavailable')
    }
    const rejected = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned blocked startup probe. Do not use tools.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, rejected)
    const after = startupFault ? namespace : await inspectTerminalNative(view.containerId)
    harness.writeArtifact(`${scenario}-after-refused-input-native-private.json`, after)
    // No Running incarnation exists, so the ordinary input route has no
    // admissible target. Inspect actual provider state separately.
    const nativeStateSafe = startupFault ? namespace.completedTurns === 0 && namespace.toolEvents === 0
      : JSON.stringify(namespace.transcript) === JSON.stringify(after.transcript)
        && (staleSignal ? staleMatches(after) && after.completedTurns === 0 && after.toolEvents === 0
          : noCallbacks ? (!after.hook && !after.loaded && (trustRefusal ? after.nativePreferences?.workspaceTrust === false
          : unwritableSignal ? after.signalWritable === false && after.signalMode === '0o500' && after.hooksDisabled !== true : after.hooksDisabled === true)
          && after.completedTurns === 0 && after.toolEvents === 0)
          : (actualRoot !== nativeRoot && namespace.hook.native.session_id === actualRoot
            && after.loaded.native.context_window.total_input_tokens === 0 && after.loaded.native.context_window.total_output_tokens === 0))
    assertions[0]!.pass = !observation
      && view.launchState === (stopCancellation ? 'stopped' : 'starting') && rejected.result?.Err?.code === 'UNKNOWN_SOUL'
      && nativeStateSafe
    if (!assertions[0]!.pass) throw new Error(`${refusalReason} released ordinary input or changed native state`)
    if (startupFault) {
      const closed = providerExit ? faultResult.nativeExited === true
        : faultResult.data.outcome === 'verified_empty' && view.recoveryState === 'stopped' && view.desiredState === 'stopped'
      if (!closed) throw new Error('owned native startup fault did not close its process or Stop transaction')
      assertions.push({ name: providerExit ? 'exact-owned-native-pid-exited' : 'ordinary-stop-verified-empty-and-stopped-intent', pass: closed })
    }
  }
  if (resumes) {
    const inspect = async (containerId: string, label: string) => {
      const current = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
        ['python3', '-c', claudeNativeInspection, actualRoot, 'false', 'terminal']))
      harness.writeArtifact(`${scenario}-${label}-native-private.json`, current)
      return current
    }
    // Count completed native model IDs, never the transport's input ACK.
    const turn = async (containerId: string, text: string, label: string) => {
      const before = await inspect(containerId, label + '-before-input')
      // Keep paste content and the submit key as distinct ordinary gestures;
      // a bulk text/CR packet can remain in the native TUI's paste buffer.
      harness.writeArtifact(`${scenario}-${label}-paste-dispatch.json`, await harness.adminOk(supervisor,
        harness.terminalInputBody(soulId, '\x1b[200~' + text + '\x1b[201~')))
      await new Promise((resolve) => setTimeout(resolve, 100))
      harness.writeArtifact(`${scenario}-${label}-dispatch.json`, await harness.adminOk(supervisor,
        harness.terminalInputBody(soulId, '\r')))
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const current = await inspect(containerId, label)
        harness.writeArtifact(`${scenario}-${label}-terminal-private.json`, await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
        if (current.toolEvents > before.toolEvents) throw new Error('ordinary terminal Claude seed unexpectedly requested a tool')
        if (current.completedTurns > before.completedTurns && current.transcript?.completeEof) return current
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error('bounded ordinary terminal Claude turn deadline exceeded')
    }
    const marker = 'owned-memory-' + randomUUID()
    const seed = await turn(view.containerId, `Remember this private marker: ${marker}. Reply stored. Do not use tools.`, 'seed')
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-completed-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed terminal Claude store not readable before death')
    if (forkRoot) {
      const controlPath = path.join(workspace, 'native-fork-fault-control.json')
      fs.writeFileSync(controlPath, JSON.stringify({ root: nativeRoot, seedSha256: seed.transcript.sha256,
        seedBytes: Buffer.from(seed.transcript.bytesBase64, 'base64').length, identity: seed.transcript.identity.slice(0, 2) }), { mode: 0o660 })
      fs.chmodSync(controlPath, 0o660)
    }
    if (restorationFailure) {
      const mutation = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0', ['python3', '-c', claudeNativeRestorationFault, nativeRoot, seed.transcript.sha256, JSON.stringify(seed.transcript.identity)]))
      harness.writeArtifact(`${scenario}-owned-before-load-mutation-private.json`, mutation)
      const malformedProbe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
      harness.writeArtifact(`${scenario}-malformed-before-load-store-probe.json`, malformedProbe)
      if (malformedProbe.data.kind !== 'reattach_ready' || mutation.uid !== 65534 || mutation.gid !== 0
        || mutation.beforeSha256 !== seed.transcript.sha256 || mutation.changedAssistantRows < 1) {
        throw new Error('bounded native loader fault did not retain the owned current store route')
      }
      const controlPath = path.join(workspace, 'native-restoration-fault-control.json')
      fs.writeFileSync(controlPath, JSON.stringify(mutation), { mode: 0o660 }); fs.chmodSync(controlPath, 0o660)
    }
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const recovery = restorationFailure || forkRoot ? await harness.adminRaw(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
      : await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact(`${scenario}-recovery.json`, recovery)
    if (forkRoot) {
      const faultPath = path.join(workspace, 'native-fork-fault-observation.json')
      const deadline = Date.now() + 3_000
      while (!fs.existsSync(faultPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      const fault = JSON.parse(fs.readFileSync(faultPath, 'utf8'))
      harness.writeArtifact(`${scenario}-fork-native-event-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-fork-current-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const contained = recovery.result?.Ok?.data?.outcome === 'blocked' && current.every((row: any) =>
        row.launchState !== 'running' && row.nativeIdentityObservation?.incarnationId !== fault.launch.incarnationId)
      const currentNativeFork = fault.native.source === 'fork' && fault.native.session_id !== nativeRoot
        && fault.launch.requestedNativeSessionId === nativeRoot
        && fault.launch.incarnationId !== view.incarnationId && fault.launch.launchNonce !== namespace.hook.launch.launchNonce
        && fault.uid === 65534 && fault.gid === 0 && fault.nativeExecutableSha256 === namespace.executableSha256
        && fault.nativeArgv.includes('--fork-session') && fault.nativeArgv.includes('--resume')
      const originalRetained = fault.originalPrefixSha256 === seed.transcript.sha256
        && JSON.stringify(fault.identity) === JSON.stringify(seed.transcript.identity.slice(0, 2))
      if (!contained || !currentNativeFork || !originalRetained) throw new Error('actual native fork root was not contained before input')
      const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned blocked native fork probe. Do not use tools.\r'))
      harness.writeArtifact(`${scenario}-fork-input-refusal.json`, input)
      if (!input.result?.Err) throw new Error('actual native fork admitted ordinary input')
      assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
        { name: 'genuine-native-exact-resume-fork-selected-a-different-root', pass: currentNativeFork },
        { name: 'original-owned-root-file-retained-across-refused-fork', pass: originalRetained },
        { name: 'native-fork-refused-running-and-current-observation', pass: contained },
        { name: 'native-fork-refused-ordinary-input', pass: !!input.result?.Err })
    } else if (restorationFailure) {
      const faultPath = path.join(workspace, 'native-restoration-fault-observation.json')
      const deadline = Date.now() + 6_000
      while (!fs.existsSync(faultPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      const fault = JSON.parse(fs.readFileSync(faultPath, 'utf8'))
      harness.writeArtifact(`${scenario}-restoration-fault-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-after-restoration-failure-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const contained = recovery.result?.Ok?.data?.outcome === 'blocked'
        && current.every((row: any) => row.launchState !== 'running'
          && row.nativeIdentityObservation?.incarnationId !== fault.hook.launch.incarnationId)
      if (!contained) throw new Error('native restoration fault published Running; no input probe dispatched')
      const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned failed restoration input probe. Do not use tools.\r'))
      harness.writeArtifact(`${scenario}-after-restoration-failure-input-refusal.json`, input)
      const inputRefused = !!input.result?.Err
      const nativeExitedUnloaded = fault.nativeExited === true && fault.loadedSha256 === null
      const currentHook = fault.hook.native.source === 'resume' && fault.hook.native.session_id === nativeRoot
        && fault.hook.launch.requestedNativeSessionId === nativeRoot
        && fault.hook.launch.launchNonce !== namespace.hook.launch.launchNonce
        && fault.hook.launch.incarnationId !== view.incarnationId
      const ownedFault = fault.beforeSha256 === seed.transcript.sha256 && fault.beforeSha256 !== fault.afterSha256
        && fault.observedFaultPrefixSha256 === fault.afterSha256
        && fault.changedAssistantRows >= 1 && fault.uid === 65534 && fault.gid === 0
        && fault.nativeExecutableSha256 === namespace.executableSha256
      if (!contained || !inputRefused || !nativeExitedUnloaded || !currentHook || !ownedFault) {
        throw new Error('actual native hook/restoration failure was not contained before input')
      }
      assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
        { name: 'genuine-current-resume-hook-before-native-restoration-failure', pass: currentHook && ownedFault },
        { name: 'native-restoration-exit-without-loaded-context-or-running-publication', pass: nativeExitedUnloaded && contained },
        { name: 'failed-native-restoration-refuses-ordinary-input', pass: inputRefused })
    } else {
    const replacement = recovery.data.view
    if (recovery.data.outcome !== 'replaced' || replacement.incarnationId === view.incarnationId
      || replacement.nativeSessionId !== nativeRoot || replacement.recoveryState !== 'live'
      || replacement.nativeIdentityObservation?.source !== 'claude_native_event'
      || replacement.nativeIdentityObservation?.nativeSessionId !== nativeRoot) throw new Error('terminal Claude exact-root replacement failed')
    const restored = await inspect(replacement.containerId, 'after-death')
    const retainedTranscript = seed.transcript.sha256 === restored.transcript?.sha256
      && seed.transcript.identity[0] === restored.transcript?.identity[0]
      && seed.transcript.identity[1] === restored.transcript?.identity[1]
    if (!retainedTranscript) throw new Error('terminal Claude original owned transcript continuity lost')
    const retainedProfile = JSON.stringify(seed.profileFiles.slice(0, 3)) === JSON.stringify(restored.profileFiles.slice(0, 3))
      && JSON.stringify(seed.nativePreferences) === JSON.stringify(restored.nativePreferences)
      && restored.loaded.native.model.id === 'claude-haiku-4-5-20251001' && restored.loaded.native.workspace.current_dir === workspace
    if (!retainedProfile || restored.hook.native.source !== 'resume' || restored.hook.native.session_id !== nativeRoot
      || restored.loaded.launch.incarnationId !== replacement.incarnationId || restored.hook.launch.launchNonce === namespace.hook.launch.launchNonce) {
      throw new Error('terminal Claude current exact-resume profile/loader differs')
    }
    assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
      { name: 'replacement-new-incarnation-same-native-root', pass: replacement.incarnationId !== view.incarnationId && replacement.nativeSessionId === nativeRoot },
      { name: 'original-owned-volume-transcript-continuity', pass: retainedTranscript },
      { name: 'same-workspace-selected-native-profile', pass: retainedProfile },
      { name: 'current-native-resume-observation-before-replacement-input', pass: restored.hook.native.source === 'resume' && restored.hook.native.session_id === nativeRoot })
    if (caseId === 'current-native-turn') {
      const recalled = await turn(replacement.containerId, 'Reply with only the private marker from before. Do not use tools.', 'recall')
      if (recalled.lastAssistantText.trim() !== marker || recalled.toolEvents !== 0) throw new Error('terminal Claude native restored context/tool-free recall differs')
      assertions.push({ name: 'actual-restored-context-private-marker-recall', pass: recalled.lastAssistantText.trim() === marker },
        { name: 'native-turns-requested-no-tools', pass: seed.toolEvents === 0 && recalled.toolEvents === 0 })
    }
    }
  }
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef,
    nativeVersion: namespace.version, executableSha256: namespace.executableSha256,
    profileSha256: createHash('sha256').update(JSON.stringify({ preferences: preferences.sha256, profileFiles: namespace.profileFiles,
      model: selectedModel, workspace })).digest('hex'),
    artifactReferences: [`${scenario}-launch.json`, `${scenario}-namespace-native-private.json`],
    assertions: [...assertions,
    { name: 'actual-terminal-global-pin-distinct-from-sdk-child', pass: namespace.version.startsWith('2.1.263')
      && (noCallbacks || namespace.loaded.native.version === '2.1.263') },
    { name: 'actual-terminal-selected-model-workspace-profile', pass: selectedModel === 'claude-haiku-4-5-20251001' && selectedCwd === workspace }] }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

async function executeManagedAmplifier(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], caseId: string, serverPath: string | undefined,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[]): Promise<NativeExperimentOriginal> {
  const scenario = `amplifier-${caseId}`
  const resumes = ['exact-resume', 'native-followup', 'current-native-turn'].includes(caseId)
  const followup = caseId === 'native-followup' || caseId === 'current-native-turn'
  if (resumes && !serverPath) throw new Error('actual terminal recovery requires the owned real server artifact')
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
  const workspace = path.join(harness.testRoot, scenario + '-workspace')
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release',
    env: { HOME: home, FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'amplifier' } })
  const soulId = 'soul-' + randomUUID()
  const nativeRoot = randomUUID()
  let managedPreparation: any
  if (resumes && serverPath) {
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
      harness.writeArtifact(`${scenario}-native-server-private.json`, { ...info, ...server.processEvidence(),
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
    harness.writeArtifact(`${scenario}-native-managed-preparation-private.json`, managedPreparation)
    if (!managedPreparation.context?.mcpCapability || !managedPreparation.secretReferences?.length) {
      throw new Error('actual native managed capability/preparation missing')
    }
  }
  const request = { method: 'launch', params: { soulId, provider: 'amplifier', providerStoreId: 'store-' + randomUUID(),
    nativeSessionId: nativeRoot,
    creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: `${scenario}-native-create`,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    terminal: { terminalId: 'native-terminal-' + randomUUID(), streamId: 'native-stream-' + randomUUID(),
      mode: 'amplifier', program: 'amplifier', args: ['session', 'resume', '--full-history', nativeRoot],
      resumeSessionId: nativeRoot, env: { HOME: '/home/freshell/provider', PROMPT_TOOLKIT_NO_CPR: '1' },
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, cols: 100, rows: 30,
      projectKey: `${scenario}-native-create`, providerModel: 'glm-5.3', providerReasoningEffort: 'low',
      providerSecretReferences: managedPreparation?.secretReferences ?? grants,
      providerLaunchContext: managedPreparation?.context ?? { preparation: { amplifier: { bundle: 'default', resume_args: [] } },
        config: profile.map((file) => ({ root: 'user_provider', relativePath: file.relative,
          providerRelativePath: '.amplifier/' + file.relative, format: 'yaml' })) } } } }
  harness.writeArtifact(`${scenario}-request.json`, request)
  const result = await harness.adminOk(supervisor, request)
  harness.writeArtifact(`${scenario}-launch.json`, result)
  let view = result.data.view
  const deadline = Date.now() + 50_000
  while (!view.nativeIdentityObservation && Date.now() < deadline) {
    harness.writeArtifact(`${scenario}-terminal-private.json`,
      await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
    harness.writeArtifact(`${scenario}-store-probe.json`,
      await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId)))
    try {
      const signal = await harness.execOwnedContainerAsExact(view.containerId, '65534:0', ['python3', '-c',
        "import pathlib,json; signals=[]\nfor p in pathlib.Path('/proc').iterdir():\n if not p.name.isdigit():continue\n try:\n  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(bytes([0])) if b'=' in v)\n  if 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR' in env:signals.append(pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])/'amplifier-loaded-context.json')\n except (OSError,ValueError):continue\nassert len(set(signals))==1\nprint(next(iter(set(signals))).read_text())"])
      fs.writeFileSync(path.join(harness.evidenceDir, `${scenario}-native-signal-original.json`), signal, { mode: 0o600 })
    } catch { /* The producer may not yet have completed load/context restore. */ }
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    view = inventory.data.find((row: any) => row.soulId === soulId)
    if (!view) throw new Error('owned Amplifier view disappeared')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const observation = view.nativeIdentityObservation
  harness.writeArtifact(`${scenario}-current-view.json`, view)
  if (!observation || !view.nativeSessionId || view.recoveryState !== 'live'
    || observation.nativeSessionId !== view.nativeSessionId || observation.incarnationId !== view.incarnationId
    || observation.source !== 'amplifier_native_loaded_context') throw new Error('current managed Amplifier no-input acknowledgement missing')
  const namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
    ['/opt/amplifier-src/.venv/bin/python', '-c',
      "import os,json,pathlib,hashlib,importlib.metadata as m; p=pathlib.Path('/opt/amplifier-src/.venv/bin/amplifier'); producer=pathlib.Path('/opt/amplifier-src/amplifier_app_cli/freshell_native_resume.py'); print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'executableSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'producerSha256':hashlib.sha256(producer.read_bytes()).hexdigest(),'cliVersion':m.version('amplifier-app-cli'),'coreVersion':m.version('amplifier-core')}))"]))
  harness.writeArtifact(`${scenario}-namespace.json`, namespace)
  if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000'
    || !namespace.readOnlyRoot || namespace.cliVersion !== '0.1.1' || namespace.coreVersion !== '1.6.0') {
    throw new Error('actual managed Amplifier namespace/package differs')
  }
  const assertions = [{ name: 'actual-native-loaded-context-before-zero-input', pass: observation.source === 'amplifier_native_loaded_context'
    && observation.nativeSessionId === view.nativeSessionId && observation.incarnationId === view.incarnationId }]
  if (resumes) {
    const signalFile = path.join(harness.evidenceDir, `${scenario}-native-signal-original.json`)
    const signal = JSON.parse(fs.readFileSync(signalFile, 'utf8'))
    const transcriptPath = signal.native.load.transcript.path
    const inspect = async (containerId: string, label: string) => {
      const snapshot = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
        ['/opt/amplifier-src/.venv/bin/python', '-c', amplifierNativeInspection, transcriptPath, nativeRoot, String(label === 'startup')]))
      harness.writeArtifact(`${scenario}-${label}-native-private.json`, snapshot)
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
      harness.writeArtifact(`${scenario}-${label}-dispatch.json`, receipt)
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const current = await inspect(containerId, label)
        harness.writeArtifact(`${scenario}-${label}-terminal-private.json`,
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
    harness.writeArtifact(`${scenario}-turn-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed Amplifier native store not readable before death')
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact(`${scenario}-turn-recovery.json`, recovery)
    const replacement = recovery.data.view
    if (recovery.data.outcome !== 'replaced' || replacement.incarnationId === view.incarnationId
      || replacement.nativeSessionId !== nativeRoot || replacement.recoveryState !== 'live'
      || replacement.nativeIdentityObservation?.source !== 'amplifier_native_loaded_context'
      || replacement.nativeIdentityObservation?.nativeSessionId !== nativeRoot) throw new Error('Amplifier exact-root replacement failed')
    const restored = await inspect(replacement.containerId, 'after-death')
    if (seed.transcript.sha256 !== restored.transcript.sha256
      || seed.transcript.identity[0] !== restored.transcript.identity[0]
      || seed.transcript.identity[1] !== restored.transcript.identity[1]) throw new Error('original Amplifier owned transcript continuity lost')
    assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
      { name: 'replacement-new-incarnation-same-native-root', pass: replacement.incarnationId !== view.incarnationId && replacement.nativeSessionId === nativeRoot },
      { name: 'original-owned-volume-transcript-continuity', pass: seed.transcript.sha256 === restored.transcript.sha256
        && seed.transcript.identity[0] === restored.transcript.identity[0] && seed.transcript.identity[1] === restored.transcript.identity[1] },
      { name: 'same-workspace-selected-native-profile', pass: amplifierNativeProfileRetained(seed, restored, workspace) },
      { name: 'current-native-resume-before-replacement-input', pass: replacement.nativeIdentityObservation.incarnationId === replacement.incarnationId
        && replacement.nativeIdentityObservation.source === 'amplifier_native_loaded_context' })
    if (followup) {
      const recalled = await turn(replacement.containerId,
        'Reply with only the private marker from before. Do not use tools.', 'recall')
      if (recalled.lastAssistantText.trim() !== marker || recalled.metadata.model !== 'glm-5.3') {
        throw new Error('native Amplifier restored context or selected model differs')
      }
      assertions.push({ name: 'actual-restored-context-private-marker-recall', pass: recalled.lastAssistantText.trim() === marker },
        { name: 'native-turns-requested-no-tools', pass: seed.toolEvents === 0 && recalled.toolEvents === 0 })
    }
  }
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef,
    nativeVersion: `amplifier-app-cli ${namespace.cliVersion}; amplifier-core ${namespace.coreVersion}`,
    executableSha256: namespace.executableSha256,
    profileSha256: createHash('sha256').update(JSON.stringify(profile.map((file) => ({ relative: file.relative, sha256: file.sha256 })))).digest('hex'),
    artifactReferences: [`${scenario}-current-view.json`, `${scenario}-native-signal-original.json`, `${scenario}-namespace.json`],
    assertions }
  harness.writeArtifact(`amplifier-${caseId}-original.json`, original)
  return original
}

export async function executeManagedNativeApproval(input: {
  harness: RuntimeHarness; supervisor: any; soulId: string; workspace: string; view: any; scenario: string
  decision: string; inspect: (containerId: string, label: string, requireTranscript: boolean) => Promise<any>
}): Promise<{ name: string; pass: boolean }[]> {
  const { harness, supervisor, soulId, workspace, view, scenario, inspect } = input
  const effectPath = path.join(workspace, 'owned-native-effect.jsonl')
  const effectPaths = input.decision === 'multiple-tools' ? [effectPath, path.join(workspace, 'second-owned-native-effect.jsonl')] : [effectPath]
  if (effectPaths.some((file) => fs.existsSync(file))) throw new Error('native effect oracle must be new')
  const command = `printf 'effect\\n' >> '${effectPath}'`
  const commands = effectPaths.map((file) => `printf 'effect\\n' >> '${file}'`)
  const effectCount = () => effectPaths.reduce((count, file) => {
    if (!fs.existsSync(file)) return count
    const bytes = fs.readFileSync(file, 'utf8')
    if (!/^(effect\n)+$/.test(bytes)) throw new Error('native effect oracle contains unexpected bytes')
    return count + bytes.split('\n').length - 1
  }, 0)
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
      if (events.some((event: any) => event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.result')) {
        throw new Error(`native turn completed without required ${label}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`bounded native ${label} deadline exceeded`)
  }
  const isCard = (event: any) => event.kind === 'permission_requested' && !!event.data.payload.nativeCheckpoint
  harness.writeArtifact(`${scenario}-operation.json`, { command, effectPath })
  await harness.adminOk(supervisor, { method: 'fresh_agent_send', params: { soulId,
    text: input.decision === 'multiple-tools'
      ? `Run these two independent harmless Bash commands in parallel, using one Bash tool call for each command: ${commands[0]} and ${commands[1]}. Send both tool calls together in the same assistant message. Do not combine commands, ask questions, or use other tools. After both results, reply done.`
      : `Use the Bash tool exactly once with this exact command: ${command}. Do not use other tools or another command. After its result, reply done.` } })
  if (['crash-before-checkpoint', 'multiple-tools', 'effect-before-observation'].includes(input.decision)) {
    let originalOperation: any
    let effectDecision: any
    if (input.decision === 'crash-before-checkpoint') {
      const paused = path.join(workspace, 'native-before-checkpoint.json')
      await harness.waitForFile(paused, 90_000)
      originalOperation = JSON.parse(fs.readFileSync(paused, 'utf8'))
      if (originalOperation.session_id !== view.nativeSessionId || originalOperation.tool_name !== 'Bash'
        || originalOperation.tool_input?.command !== command || !originalOperation.tool_use_id?.startsWith('toolu_')) {
        throw new Error('real native pre-checkpoint hook did not park the intended operation')
      }
    } else if (input.decision === 'multiple-tools') {
      originalOperation = await wait((event) => event.kind === 'permission_requested'
        && !event.data.payload.nativeCheckpoint, 'ordinary native multi-tool permission')
      const deadline = Date.now() + 3_000
      let native = await inspect(view.containerId, 'actual-two-tool-batch', true)
      while (!nativeTwoToolBatchMatches(native, commands) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        native = await inspect(view.containerId, 'actual-two-tool-batch', true)
      }
      if (!nativeTwoToolBatchMatches(native, commands)) throw new Error('actual native multi-tool batch differs')
    } else {
      const current = (await wait(isCard, 'current native ask before effect')).data
      effectDecision = current
      const payload = current.payload
      if (payload.tool?.name !== 'Bash' || payload.tool.input?.command !== command
        || payload.nativeCheckpoint.nativeSessionId !== view.nativeSessionId
        || payload.nativeCheckpoint.toolUseID !== payload.toolUseID || effectCount() !== 0) {
        throw new Error('original current native operation differs before effect')
      }
      // Resolve the actual current native ask, then deliberately stop reading
      // normalized outcomes. The supported PostToolUse hook parks only after
      // the native command has executed, before its result is observed.
      const receipt = await harness.adminOk(supervisor, harness.freshAgentResolveBody(soulId, current.decision_id,
        { behavior: 'allow', updatedInput: payload.tool.input }))
      harness.writeArtifact(`${scenario}-current-allow-dispatch.json`, receipt)
      const paused = path.join(workspace, 'native-after-effect-before-observation.json')
      await harness.waitForFile(paused, 90_000)
      originalOperation = JSON.parse(fs.readFileSync(paused, 'utf8'))
      if (originalOperation.hook_event_name !== 'PostToolUse' || originalOperation.session_id !== view.nativeSessionId
        || originalOperation.tool_name !== 'Bash' || originalOperation.tool_use_id !== payload.toolUseID
        || originalOperation.tool_input?.command !== command || effectCount() !== 1) {
        throw new Error('actual native post-effect hook did not park the original completed effect')
      }
    }
    const before = await inspect(view.containerId, 'native-edge-before-death', true)
    harness.writeArtifact(`${scenario}-original-native-operation-private.json`, originalOperation)
    const rows = Buffer.from(before.transcript.bytesBase64, 'base64').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    if (input.decision !== 'effect-before-observation' && (effectCount() !== 0
      || rows.some((row) => row.type === 'attachment' && row.attachment?.type === 'hook_deferred_tool'))) {
      throw new Error('actual crash/batch operation already produced an effect or deferred checkpoint')
    }
    if (input.decision === 'effect-before-observation') {
      if (rows.some((row) => row.type === 'user' && Array.isArray(row.message?.content)
        && row.message.content.some((block: any) => block.type === 'tool_result' && block.tool_use_id === originalOperation.tool_use_id))) {
        throw new Error('post-effect native outcome was already published')
      }
      const files = await captureCheckpointState(view.containerId, 'effect-before-observation')
      const record = JSON.parse(Buffer.from(files.find((file) => file.readerUid === 65534).bytesBase64, 'base64').toString('utf8'))
      if (record.phase !== 'dispatching' || record.nativeSessionId !== view.nativeSessionId
        || record.toolUseID !== originalOperation.tool_use_id) throw new Error('native effect has no durable ambiguous dispatch fence')
      const actor = JSON.parse(Buffer.from(files.find((file) => file.readerUid === 0).bytesBase64, 'base64').toString('utf8'))
      const resolved = actor.decisions[effectDecision.decision_id]
      const responseDigest = createHash('sha256').update(JSON.stringify({ behavior: 'allow',
        updatedInput: effectDecision.payload.tool.input })).digest('hex')
      if (resolved?.state !== 'resolved' || resolved.responseDigest !== responseDigest) {
        throw new Error('native effect lacks its original durably acknowledged decision')
      }
    }
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-native-edge-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('actual native edge store is unreadable before death')
    await harness.killOwnedRuntimeExact(view.containerId); await harness.waitForContainerExit(view.containerId)
    const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact(`${scenario}-native-edge-recovery.json`, recovery)
    if (recovery.data.outcome !== 'replaced' || recovery.data.view.incarnationId === view.incarnationId
      || recovery.data.view.nativeSessionId !== view.nativeSessionId || recovery.data.view.recoveryState !== 'live'
      || !recovery.data.view.nativeIdentityObservation) throw new Error('actual native edge replacement did not preserve its root/current gate')
    let refused
    if (input.decision === 'effect-before-observation') {
      await inspect(recovery.data.view.containerId, 'native-edge-after-effect-recovery', true)
      // Original dispatch acknowledgements precede this new event cursor.
      // An identical resolved decision may return its durable cached success;
      // only an actual new native dispatch would constitute replay.
      const baseline = await harness.adminOk(supervisor, { method: 'fresh_agent_read_events',
        params: { soulId, afterSequence: cursor, maxEvents: 128 } })
      harness.writeArtifact(`${scenario}-effect-recovery-event-baseline-private.json`, baseline)
      cursor = baseline.data.head
      if (baseline.data.events.some((row: any) => row.event.kind === 'permission_requested')) {
        throw new Error('ambiguous effect revived a native permission callback')
      }
      refused = await harness.adminRaw(supervisor, harness.freshAgentResolveBody(soulId, effectDecision.decision_id,
        { behavior: 'allow', updatedInput: effectDecision.payload.tool.input }))
      harness.writeArtifact(`${scenario}-ambiguous-decision-refused.json`, refused)
      const completedCacheReply = refused.result?.Ok?.kind === 'fresh_agent_command'
        && refused.result.Ok.data?.state === 'completed'
      if (!refused.result?.Err && !completedCacheReply) throw new Error('old native decision has no refusal or identical completed cache reply')
    } else {
      await inspect(recovery.data.view.containerId, 'native-edge-after-death-before-input', true)
      refused = await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: { soulId,
        text: 'Do not perform any tools. Report whether the unfinished original operation is blocked.' } })
      harness.writeArtifact(`${scenario}-native-edge-input-dispatch.json`, refused)
      if (!refused.result?.Err) {
        // The Admin reply acknowledges a sidecar write. Its actual native
        // admission refusal arrives on the normalized provider event stream.
        await wait((event) => event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.error'
          && event.data.payload.event.message?.includes('ordinary input is blocked'), 'actual unfinished-operation input refusal')
      }
      await inspect(recovery.data.view.containerId, 'native-edge-after-refused-input', true)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const current = await harness.adminOk(supervisor, { method: 'fresh_agent_read_events', params: { soulId, afterSequence: cursor, maxEvents: 128 } })
    const cards = current.data.events.filter((row: any) => row.event.kind === 'permission_requested')
    if (input.decision === 'effect-before-observation' && current.data.events.some((row: any) =>
      row.event.kind === 'provider' && row.event.data.payload.event?.type === 'freshAgent.permission.dispatch')) {
      throw new Error('native decision dispatched again after its effect')
    }
    const expected = input.decision === 'effect-before-observation' ? 1 : 0
    harness.writeArtifact(`${scenario}-native-edge-outcome-private.json`, { recovery, refused, current, effectCount: effectCount() })
    if (cards.length || effectCount() !== expected) throw new Error('uncheckpointed or completed native operation revived a callback or repeated an effect')
    return [{ name: 'actual-native-operation-before-exact-enclosure-death', pass: !!originalOperation },
      { name: 'replacement-current-native-root-new-incarnation', pass: recovery.data.view.incarnationId !== view.incarnationId
        && recovery.data.view.nativeIdentityObservation.nativeSessionId === view.nativeSessionId },
      { name: 'no-resurrected-native-permission-callback', pass: cards.length === 0 },
      { name: 'independent-native-effect-count', pass: effectCount() === expected }]
  }
  const old = (await wait(isCard, 'durable checkpoint/current ask')).data
  harness.writeArtifact(`${scenario}-old-card-private.json`, old)
  const oldPayload = old.payload
  if (oldPayload.tool?.name !== 'Bash' || oldPayload.tool.input?.command !== command
    || oldPayload.nativeCheckpoint.nativeSessionId !== view.nativeSessionId
    || oldPayload.nativeCheckpoint.toolUseID !== oldPayload.toolUseID || effectCount() !== 0) {
    throw new Error('original native solo checkpoint/effect oracle differs')
  }
  async function captureCheckpointState(containerId: string, label: string) {
    const files = []
    for (const [uid, file] of [['0:0', '/run/freshell-host-actor/fresh-agent-state.json'],
      ['65534:0', `/home/freshell/provider/.freshell/native-checkpoints/claude/${view.nativeSessionId}.json`]]) {
      const source = await harness.execOwnedContainerAsExact(containerId, uid!, ['python3', '-c',
        "import pathlib,json,base64,hashlib,sys;file=pathlib.Path(sys.argv[1]);raw=file.read_bytes();assert len(raw)<=32*1024*1024;json.loads(raw);print(json.dumps({'path':str(file),'sha256':hashlib.sha256(raw).hexdigest(),'bytesBase64':base64.b64encode(raw).decode(),'readerUid':__import__('os').getuid()}))", file!])
      files.push(JSON.parse(source))
    }
    harness.writeArtifact(`${scenario}-${label}-checkpoint-state-private.json`, { nativeRoot: view.nativeSessionId, files })
    return files
  }
  const before = await inspect(view.containerId, 'checkpoint-before-death', true)
  await captureCheckpointState(view.containerId, 'before-death')
  const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
  harness.writeArtifact(`${scenario}-approval-store-probe.json`, probe)
  if (probe.data.kind !== 'reattach_ready') throw new Error('native checkpoint store not readable before death')
  const sourceFault = ['changed-tool', 'missing-tool', 'changed-profile', 'changed-root'].includes(input.decision)
  if (sourceFault) {
    if (input.decision === 'changed-profile') {
      const directory = path.join(workspace, '.claude'); fs.mkdirSync(directory, { recursive: true, mode: 0o770 })
      fs.chmodSync(directory, 0o770)
      fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }), { mode: 0o660 })
      fs.chmodSync(path.join(directory, 'settings.json'), 0o660)
    } else {
      const mutation = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
        ['python3', '-c', claudeCheckpointSourceFault, before.hook.native.transcript_path,
          view.nativeSessionId, oldPayload.toolUseID, input.decision]))
      harness.writeArtifact(`${scenario}-source-fault-private.json`, mutation)
    }
  }
  await harness.killOwnedRuntimeExact(view.containerId)
  await harness.waitForContainerExit(view.containerId)
  const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
  harness.writeArtifact(`${scenario}-approval-recovery.json`, recovery)
  const currentView = recovery.data.view
  if (sourceFault) {
    const replies = []
    if (currentView?.recoveryState === 'live') {
      replies.push(await harness.adminRaw(supervisor, harness.freshAgentResolveBody(soulId, old.decision_id,
        { behavior: 'allow', updatedInput: oldPayload.tool.input })))
      replies.push(await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: {
        soulId, text: 'Do not perform any tools. Report whether the interrupted original operation is blocked.' } }))
      if (!replies[0]?.result?.Err) throw new Error('changed native source/profile accepted an orphan decision')
      if (!replies[1]?.result?.Err) await wait((event) => event.kind === 'provider'
        && event.data.payload.event?.type === 'freshAgent.error'
        && event.data.payload.event.message?.includes('ordinary input is blocked'), 'actual changed-source input refusal')
    } else if (currentView?.recoveryState !== 'blocked') {
      throw new Error('changed native source/profile has no explicit recovery disposition')
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const batch = currentView?.recoveryState === 'live' ? await harness.adminOk(supervisor, { method: 'fresh_agent_read_events',
      params: { soulId, afterSequence: cursor, maxEvents: 128 } }) : null
    harness.writeArtifact(`${scenario}-negative-native-disposition-private.json`, { recovery, replies, batch, effectCount: effectCount() })
    if (effectCount() !== 0 || batch?.data.events.some((row: any) => isCard(row.event))) {
      throw new Error('changed native source/profile replayed or revived the original operation')
    }
    return [{ name: 'actual-native-checkpoint-before-source-fault', pass: oldPayload.nativeCheckpoint.toolUseID === oldPayload.toolUseID },
      { name: 'changed-native-source-or-profile-refuses-original-operation', pass: currentView?.recoveryState === 'blocked'
        || (!!replies[0]?.result?.Err && (!!replies[1]?.result?.Err || observed.some((event) => event.kind === 'provider'
          && event.data.payload.event?.type === 'freshAgent.error' && event.data.payload.event.message?.includes('ordinary input is blocked')))) },
      { name: 'no-resurrected-native-permission-callback', pass: currentView?.recoveryState !== 'live'
        || !batch?.data.events.some((row: any) => isCard(row.event)) },
      { name: 'independent-native-effect-count', pass: effectCount() === 0 }]
  }
  if (recovery.data.outcome !== 'replaced' || currentView.incarnationId === view.incarnationId
    || currentView.nativeSessionId !== view.nativeSessionId || currentView.recoveryState !== 'live'
    || currentView.nativeIdentityObservation?.nativeSessionId !== view.nativeSessionId) throw new Error('native approval replacement not currently live on same root')
  await captureCheckpointState(currentView.containerId, 'after-replacement')
  const current = (await wait(isCard, 'rebound current native ask')).data
  harness.writeArtifact(`${scenario}-current-card-private.json`, current)
  const currentPayload = current.payload
  if (current.decision_id !== old.decision_id || currentPayload.nativeRequestId === oldPayload.nativeRequestId
    || JSON.stringify(currentPayload.nativeCheckpoint) !== JSON.stringify(oldPayload.nativeCheckpoint)
    || currentPayload.nativeBinding?.launch.incarnationId !== currentView.incarnationId
    || effectCount() !== 0) throw new Error('same native operation did not rebind to a fresh current request')
  const after = await inspect(currentView.containerId, 'checkpoint-after-death', true)
  if (!nativeCheckpointTranscriptRetained(before, after, oldPayload.toolUseID)) {
    throw new Error('original native checkpoint changed across owned enclosure death')
  }
  const refusalAssertions = []
  if (input.decision === 'changed-input' || input.decision === 'stale-callback') {
    const invalid = input.decision === 'changed-input'
      ? harness.freshAgentResolveBody(soulId, current.decision_id, { behavior: 'allow',
        updatedInput: { ...currentPayload.tool.input, command: command + '; true' } })
      : harness.freshAgentResolveBody(soulId, oldPayload.nativeRequestId, { behavior: 'allow', updatedInput: oldPayload.tool.input })
    const rejected = await harness.adminRaw(supervisor, invalid)
    harness.writeArtifact(`${scenario}-invalid-current-decision.json`, rejected)
    if (!rejected.result?.Err || effectCount() !== 0) throw new Error('changed input or old native callback was accepted')
    const retained = await inspect(currentView.containerId, 'after-invalid-decision', true)
    if (!nativeCheckpointTranscriptRetained(before, retained, oldPayload.toolUseID)) throw new Error('refused decision consumed the native checkpoint')
    refusalAssertions.push({ name: 'invalid-current-native-decision-refused-before-effect', pass: !!rejected.result.Err && effectCount() === 0 })
  }
  const allowed = input.decision === 'allow'
  const expectedEffectCount = allowed ? 1 : 0
  const decision = allowed ? { behavior: 'allow', updatedInput: currentPayload.tool.input }
    : { behavior: 'deny', message: 'The user declined this operation. Do not retry it or use any other tools. End this turn now with a short acknowledgment.' }
  const receipt = await harness.adminOk(supervisor, harness.freshAgentResolveBody(soulId, current.decision_id, decision))
  harness.writeArtifact(`${scenario}-approval-dispatch.json`, receipt)
  const terminal = await wait((event) => event.kind === 'permission_requested'
    || (event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.result'), 'native completion')
  if (terminal.kind === 'permission_requested') {
    await inspect(currentView.containerId, 'unexpected-next-operation', true)
    await captureCheckpointState(currentView.containerId, 'unexpected-next-operation')
    harness.writeArtifact(`${scenario}-unexpected-next-operation-private.json`, { originalToolUseID: oldPayload.toolUseID,
      nextOperation: terminal.data, effectCount: effectCount() })
    throw new Error('native model requested another operation after the bounded original decision')
  }
  const result = terminal.data.payload.event
  const toolResults = observed.filter((event) => event.kind === 'provider'
    && event.data.payload.event?.type === 'freshAgent.tool.result').flatMap((event) => event.data.payload.event.content ?? [])
  const toolResult = toolResults.find((part: any) => part.tool_use_id === oldPayload.toolUseID)
  const count = effectCount()
  harness.writeArtifact(`${scenario}-approval-outcome.json`, { nativeRoot: result.nativeSessionId,
    originalToolUseId: oldPayload.toolUseID, inputDigest: oldPayload.nativeCheckpoint.inputDigest,
    oldNativeRequestId: oldPayload.nativeRequestId, currentNativeRequestId: currentPayload.nativeRequestId,
    nativeToolResultIsError: toolResult?.is_error, nativeResultIsError: result.isError, effectCount: count })
  if (result.nativeSessionId !== view.nativeSessionId || !toolResult
    || toolResult.is_error !== !allowed || count !== expectedEffectCount) {
    throw new Error('correlated original native outcome/effect differs from decision')
  }
  return [...refusalAssertions, { name: 'same-native-operation-new-current-request-after-death',
    pass: currentPayload.nativeRequestId !== oldPayload.nativeRequestId && current.decision_id === old.decision_id },
    { name: 'native-checkpoint-original-volume-continuity',
      pass: nativeCheckpointTranscriptRetained(before, after, oldPayload.toolUseID) },
    { name: 'correlated-native-tool-result', pass: toolResult.tool_use_id === oldPayload.toolUseID
      && toolResult.is_error === !allowed },
    { name: 'independent-native-effect-count', pass: count === expectedEffectCount }]
}

// Intentional corruption of the already genuine, privately captured operation
// in this run's synthetic native store. No checkpoint row or effect is created.
const claudeCheckpointSourceFault = String.raw`
import pathlib,json,sys,hashlib,os
p=pathlib.Path(sys.argv[1]);root,tool,fault=sys.argv[2:];raw=p.read_bytes();rows=[json.loads(line) for line in raw.splitlines()]
assert raw.endswith(b'\n') and fault in ['changed-tool','missing-tool','changed-root']
matches=[r for r in rows if r.get('type')=='assistant' and any(b.get('type')=='tool_use' and b.get('id')==tool for b in r.get('message',{}).get('content',[]))]
assert len(matches)==1 and matches[0]['sessionId']==root
row=matches[0];blocks=row['message']['content'];operation=next(b for b in blocks if b.get('type')=='tool_use' and b.get('id')==tool)
if fault=='changed-tool':operation['name']='Read'
elif fault=='missing-tool':row['message']['content']=[b for b in blocks if b is not operation]
else:row['sessionId']='00000000-0000-4000-8000-000000000004'
changed=b''.join(json.dumps(r,separators=(',',':')).encode()+b'\n' for r in rows)
with p.open('wb') as f:f.write(changed);f.flush();os.fsync(f.fileno())
print(json.dumps({'fault':fault,'originalSha256':hashlib.sha256(raw).hexdigest(),'currentSha256':hashlib.sha256(changed).hexdigest(),'originalBytes':len(raw),'currentBytes':len(changed),'nativeRoot':root,'originalToolUseID':tool}))
`

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
 source=pathlib.Path(env['HOME'])/relative;body=source.read_bytes() if source.exists() else None;profile.append({'relative':relative,'sha256':hashlib.sha256(body).hexdigest() if body is not None else None,'bytesBase64':base64.b64encode(body).decode() if body is not None else None})
native_cwd=os.readlink(p/'cwd');os.environ.clear();os.environ.update(env);os.chdir(native_cwd)
from amplifier_app_cli.key_manager import KeyManager
from amplifier_app_cli.lib.settings import AppSettings
from amplifier_app_cli.runtime.config import expand_env_vars
import yaml
KeyManager();settings=AppSettings();settings_files=[]
for source in [settings.paths.global_settings,settings.paths.project_settings,settings.paths.local_settings]:
 body=source.read_bytes() if source.exists() else None
 if body is not None:assert isinstance(yaml.safe_load(body) or {},dict)
 settings_files.append({'path':str(source),'bytesBase64':base64.b64encode(body).decode() if body is not None else None})
native_settings_sha=hashlib.sha256(json.dumps(expand_env_vars(settings.get_merged_settings()),sort_keys=True,separators=(',',':')).encode()).hexdigest()
assistants=[m for m in messages if m.get('role')=='assistant']
def text(m):
 c=m.get('content');return c if isinstance(c,str) else ''.join(p.get('text','') for p in (c or []) if isinstance(p,dict) and p.get('type')=='text')
print(json.dumps({'nativeRoot':root,'nativePid':int(p.name),'transcript':{'identity':identity(after),'sha256':hashlib.sha256(raw).hexdigest(),'completeEof':not raw or raw.endswith(b'\n'),'bytesBase64':base64.b64encode(raw).decode()},'eventsBytesBase64':base64.b64encode(event_raw).decode(),'metadata':meta,'completedTurns':sum(e.get('event')=='cleanup:store_end' for e in events),'toolEvents':sum(str(e.get('event','')).startswith('tool:') for e in events),'responses':[e.get('data') for e in events if e.get('event')=='llm:response'],'lastAssistantText':text(assistants[-1]) if assistants else '', 'profileFiles':profile,'nativeCwd':native_cwd,'nativeSettingsSha256':native_settings_sha,'nativeSettingsFiles':settings_files,'httpsStatus':status,'tlsVerifyMode':context.verify_mode.value,'tlsCheckHostname':context.check_hostname}))
`

// Reads the currently owned native child and its exact hook-selected transcript.
// Raw bytes are saved only in the run's private artifact; reports use metadata.
export const terminalForkFaultHook = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
let input='';for await(const chunk of process.stdin)input+=chunk
const native=JSON.parse(input)
if(native.source==='fork') {
 const workspace=process.cwd(),control=JSON.parse(fs.readFileSync(path.join(workspace,'native-fork-fault-control.json'),'utf8'))
 const launch=JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH)
 if(launch.requestedNativeSessionId!==control.root || native.cwd!==workspace) throw new Error('owned native fork binding mismatch')
 if(!native.session_id || native.session_id===control.root) throw new Error('actual native fork root missing')
 const selected='/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',nativeExecutableSha256=digest(fs.readFileSync(selected))
 const pids=fs.readdirSync('/proc').filter(id=>/^\d+$/.test(id)).filter(id=>{try{return digest(fs.readFileSync('/proc/'+id+'/exe'))===nativeExecutableSha256}catch{return false}})
 if(pids.length!==1)throw new Error('current native fork writer ambiguous')
 const pid=pids[0],nativeArgv=fs.readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean)
 const file=path.resolve(path.dirname(native.transcript_path),control.root+'.jsonl'),store=path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME,'.claude'),'projects')+path.sep
 if(!file.startsWith(store) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())throw new Error('unowned original fork store refused')
 const before=fs.statSync(file),original=fs.readFileSync(file),after=fs.statSync(file)
 if(before.dev!==after.dev || before.ino!==after.ino || original.at(-1)!==10)throw new Error('native original fork store changed during capture')
 fs.writeFileSync(path.join(workspace,'native-fork-fault-observation.json'),JSON.stringify({native,launch,nativePid:Number(pid),nativeExecutableSha256,nativeArgv,
  uid:process.getuid(),gid:process.getgid(),originalPrefixSha256:digest(original.subarray(0,control.seedBytes)),identity:[String(after.dev),String(after.ino)]}),{mode:0o664})
}
process.stdout.write('{}\n')
`

export const claudeNativeRestorationFault = String.raw`
import pathlib,json,hashlib,os,sys
root=sys.argv[1];expected=sys.argv[2];identity=json.loads(sys.argv[3]);home=pathlib.Path('/home/freshell/provider/.claude/projects')
files=list(home.glob('*/'+root+'.jsonl'));assert len(files)==1 and files[0].is_file() and not files[0].is_symlink()
file=files[0];before=file.stat();raw=file.read_bytes();assert raw.endswith(b'\n') and hashlib.sha256(raw).hexdigest()==expected
assert [str(before.st_dev),str(before.st_ino)]==identity[:2]
rows=[json.loads(line) for line in raw.splitlines()];changed=0
for row in rows:
 if row.get('type')=='assistant':
  assert row.get('sessionId')==root and isinstance(row.get('message',{}).get('content'),list)
  assert not any(part.get('type')=='tool_use' for part in row['message']['content'])
  row['message']['content']='owned malformed native assistant';changed+=1
assert changed>0
modified=b''.join((json.dumps(row,separators=(',',':'))+'\n').encode() for row in rows)
with file.open('r+b') as handle:handle.write(modified);handle.truncate();handle.flush();os.fsync(handle.fileno())
after=file.stat();assert before.st_dev==after.st_dev and before.st_ino==after.st_ino
print(json.dumps({'root':root,'beforeSha256':hashlib.sha256(raw).hexdigest(),'afterSha256':hashlib.sha256(file.read_bytes()).hexdigest(),
 'afterBytes':after.st_size,'changedAssistantRows':changed,'identity':[str(after.st_dev),str(after.st_ino)],'uid':os.getuid(),'gid':os.getgid()}))
`

export const terminalRestorationFaultHook = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
if(process.argv[2]==='--observe') {
 const config=JSON.parse(process.argv[3]);const deadline=Date.now()+5000
 while(Date.now()<deadline) {
  const present=fs.existsSync('/proc/'+config.nativePid+'/exe')
  const loaded=path.join(config.signalDirectory,'statusline-loaded.json')
  if(!present || fs.existsSync(loaded)) {
   const observation={...config, nativeExited:!present, loadedSha256:fs.existsSync(loaded)?digest(fs.readFileSync(loaded)):null}
   fs.writeFileSync(config.observationPath,JSON.stringify(observation),{mode:0o664});break
  }
  await pause(10)
 }
} else {
 let input='';for await(const chunk of process.stdin)input+=chunk
 const native=JSON.parse(input)
 if(native.source==='resume') {
  const workspace=process.cwd(), control=JSON.parse(fs.readFileSync(path.join(workspace,'native-restoration-fault-control.json'),'utf8'))
  const launch=JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH)
  if(native.session_id!==control.root || launch.requestedNativeSessionId!==control.root || native.cwd!==workspace) throw new Error('owned native resume binding mismatch')
  const signalDirectory=process.env.FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR
  const signal=path.join(signalDirectory,'session-start.json'),deadline=Date.now()+3000
  while(!fs.existsSync(signal) && Date.now()<deadline) await pause(10)
  const hook=JSON.parse(fs.readFileSync(signal,'utf8'))
  if(JSON.stringify(hook.launch)!==JSON.stringify(launch) || hook.native.session_id!==control.root || hook.native.source!=='resume') throw new Error('current genuine native hook missing')
  const transcript=path.resolve(native.transcript_path),store=path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME,'.claude'),'projects')+path.sep
  if(!transcript.startsWith(store) || path.basename(transcript)!==control.root+'.jsonl' || !fs.lstatSync(transcript).isFile()) throw new Error('unowned transcript fault refused')
  const original=fs.readFileSync(transcript)
  if(original.at(-1)!==10 || digest(original.subarray(0,control.afterBytes))!==control.afterSha256) throw new Error('owned malformed native source changed')
  const selected='/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
  const nativeExecutableSha256=digest(fs.readFileSync(selected))
  const pids=fs.readdirSync('/proc').filter(id=>/^\d+$/.test(id)).filter(id=>{try{return digest(fs.readFileSync('/proc/'+id+'/exe'))===nativeExecutableSha256}catch{return false}})
  if(pids.length!==1)throw new Error('current native writer ambiguous')
  const config={hook,signalDirectory,nativePid:Number(pids[0]),nativeExecutableSha256,uid:process.getuid(),gid:process.getgid(),
   beforeSha256:control.beforeSha256,afterSha256:control.afterSha256,observedFaultPrefixSha256:digest(original.subarray(0,control.afterBytes)),changedAssistantRows:control.changedAssistantRows,
   observationPath:path.join(workspace,'native-restoration-fault-observation.json')}
  const observer=spawn(process.execPath,[fileURLToPath(import.meta.url),'--observe',JSON.stringify(config)],{stdio:'ignore'})
  observer.unref()
 }
 process.stdout.write('{}\n')
}
`

const claudeNativeInspection = String.raw`
import pathlib,os,json,hashlib,ssl,urllib.parse,urllib.request,subprocess,sys,base64
root=sys.argv[1];required=sys.argv[2]=='true';terminal=len(sys.argv)>3 and sys.argv[3]=='terminal'
missing_callbacks=len(sys.argv)>4 and sys.argv[4] in (['disabled-hooks','trust-refusal','unwritable-signal'] if terminal else ['disabled-hooks'])
wrong_root=not terminal and len(sys.argv)>4 and sys.argv[4]=='wrong-id'
sdk_fork_image=not terminal and len(sys.argv)>5 and sys.argv[5]=='sdk-fork-image'
selected=pathlib.Path('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' if terminal else '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'+('.native' if sdk_fork_image else ''))
expected=hashlib.sha256(selected.read_bytes()).hexdigest();matches=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  if 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR' in env and (terminal or 'FRESHELL_CLAUDE_SIDECAR_ID' in env) and hashlib.sha256((p/'exe').read_bytes()).hexdigest()==expected:matches.append((p,env))
 except (OSError,ValueError):continue
assert len(matches)==1
p,env=matches[0];signal_dir=pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR']);hook_file=signal_dir/'session-start.json';loaded_file=signal_dir/'statusline-loaded.json'
hook=None if missing_callbacks and not hook_file.exists() else json.loads(hook_file.read_text())
assert hook is None and missing_callbacks or hook is not None and (wrong_root or hook['native']['session_id']==root)
loaded=None if not terminal or missing_callbacks and not loaded_file.exists() else json.loads(loaded_file.read_text())
ca=pathlib.Path(env.get('SSL_CERT_FILE') or env['NODE_EXTRA_CA_CERTS']);context=ssl.create_default_context(cafile=str(ca));proxy=env.get('HTTPS_PROXY') or env.get('https_proxy')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}),urllib.request.HTTPSHandler(context=context))
with opener.open(urllib.request.Request('https://api.anthropic.com/v1/models',headers={'anthropic-version':'2023-06-01','authorization':'Bearer '+env['CLAUDE_CODE_OAUTH_TOKEN']}),timeout=20) as r:status=r.status;r.read()
home=pathlib.Path(env.get('CLAUDE_CONFIG_DIR') or str(pathlib.Path(env['HOME'])/'.claude'));cwd=pathlib.Path(hook['native']['cwd']) if hook else (p/'cwd').resolve();profile=[]
native_argv=[v.decode() for v in (p/'cmdline').read_bytes().split(b'\0') if v]
settings=json.loads((home/'settings.json').read_text()) if (home/'settings.json').exists() else {}
files=[home/'settings.json',cwd/'.claude/settings.json',cwd/'.claude/settings.local.json']
if terminal:files.append(home/'.claude.json')
for file in files:
 profile.append({'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else None})
transcript=None;rows=[];candidates=list(home.glob('projects/**/'+root+'.jsonl')) if not hook else []
assert len(candidates)<=1
file=pathlib.Path(hook['native']['transcript_path']) if hook else (candidates[0] if candidates else None)
if file is not None and file.exists():
 with file.open('rb') as f:
  before=os.fstat(f.fileno());raw=f.read();after=os.fstat(f.fileno())
 identity=lambda s:[str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns),str(s.st_ctime_ns)]
 assert identity(before)==identity(after)==identity(file.stat()) and (not raw or raw.endswith(b'\n'))
 rows=[json.loads(line) for line in raw.splitlines() if line.strip()];assert all(row.get('sessionId',root)==root for row in rows)
 transcript={'identity':identity(after),'sha256':hashlib.sha256(raw).hexdigest(),'completeEof':True,'bytesBase64':base64.b64encode(raw).decode(),'rowCount':len(rows)}
assert not required or transcript is not None
assistants=[row for row in rows if row.get('type')=='assistant'];tool_events=sum(part.get('type')=='tool_use' for row in assistants for part in row.get('message',{}).get('content',[]) if isinstance(part,dict))
completed_ids={row['message']['id'] for row in assistants if row.get('message',{}).get('stop_reason')=='end_turn' and row['message'].get('id')}
last_text=''.join(part.get('text','') for part in (assistants[-1].get('message',{}).get('content',[]) if assistants else []) if isinstance(part,dict) and part.get('type')=='text')
preferences=json.loads((home/'.claude.json').read_text()) if terminal else None
native_preferences={key:preferences.get(key) for key in ['theme','hasCompletedOnboarding']} if preferences else None
if native_preferences is not None:native_preferences['workspaceTrust']=preferences.get('projects',{}).get(str(cwd),{}).get('hasTrustDialogAccepted')
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'nativePid':int(p.name),'nativeRoot':hook['native']['session_id'] if hook else None,'hook':hook,'hookSha256':hashlib.sha256(hook_file.read_bytes()).hexdigest() if hook else None,'loaded':loaded,'hooksDisabled':settings.get('disableAllHooks'),'nativeLaunch':json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']),'signalDirectory':str(signal_dir),'signalWritable':os.access(signal_dir,os.W_OK),'signalMode':oct(signal_dir.stat().st_mode&0o777) if signal_dir.exists() else None,'nativeArgv':native_argv,'nativeCwd':str((p/'cwd').resolve()),'executableSha256':expected,'version':subprocess.check_output([str(selected),'--version'],text=True).strip(),'profileFiles':profile,'nativePreferences':native_preferences,'completedTurns':len(completed_ids),'toolEvents':tool_events,'lastAssistantText':last_text,'caSha256':hashlib.sha256(ca.read_bytes()).hexdigest(),'tlsVerifyMode':context.verify_mode.value,'tlsCheckHostname':context.check_hostname,'httpsStatus':status,'transcript':transcript}))
`

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runNativeFeasibility().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'runtime.native_feasibility.failed',
      reason: error instanceof Error ? error.message : 'unknown failure' })}\n`)
    process.exitCode = 1
  })
}
