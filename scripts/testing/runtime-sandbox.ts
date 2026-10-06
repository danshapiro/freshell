import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { configuredProviderOnecliGrantFiles } from './runtime-amplifier-onecli.js'
import { RestrictedDockerBroker, type BrokerEvent, type BrokerReceipt } from './runtime-test-broker.js'

export const PHASE1_RUNTIME_IMAGE_TAG = 'ubuntu:24.04'
export const PHASE2_RUNTIME_IMAGE_TAG = 'freshell-managed-runtime:phase2'
export const CONTROL_PROTOCOL_VERSION = 2

export type RuntimeLimits = {
  cpuMilli: number
  memoryBytes: number
  swapBytes: number
  pidsMax: number
}

export type SupervisorInstance = {
  scenarioId: string
  containerId: string
  controlSocket: string
  controlSecret: string
  controlSecretFile: string
  runtimeRoot: string
  volumeName: string
  binaryKind: 'test' | 'release'
}

export type AdminError = {
  code: string
  message: string
}

export type AdminReply = {
  requestId: string
  result: { Ok?: any; Err?: AdminError }
}

export type AssertionRecord = {
  at: string
  caseId: string
  pass: boolean
  message: string
  evidence?: unknown
}

export type ProviderQualificationBuildRecord = {
  kind: 'production' | 'qualification_fixture'
  serverFeatures: string[]
  supervisorFeatures: string[]
  qualificationProviders: string[]
  serverBinary: string
  supervisorBinary: string
}

export type FreshAgentQualificationBuildRecord = {
  kind: 'production' | 'deterministic_fixture'
  serverFeatures: string[]
  sessionHostFeatures: string[]
  selectedModes: string[]
  fixtureModes: string[]
  serverBinary: string
  supervisorBinary: string
  sessionHostBinary: string
}

export function phase2BootstrapFiles(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const files = new Set<string>()
  const addRegularFile = (candidate: string | undefined) => {
    if (!candidate) return
    try {
      const resolved = fs.realpathSync(candidate)
      if (fs.statSync(resolved).isFile()) files.add(resolved)
    } catch {}
  }
  for (const key of [
    'FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE',
    'FRESHELL_MANAGED_CODEX_AUTH_FILE',
  ]) {
    addRegularFile(env[key]?.trim())
  }
  for (const provider of ['claude', 'codex', 'opencode', 'amplifier'] as const) {
    for (const grant of configuredProviderOnecliGrantFiles(provider, env)) files.add(grant)
  }
  return [...files]
}

export class RuntimeGateAssertionError extends Error {
  constructor(
    readonly caseId: string,
    message: string,
    readonly evidence?: unknown,
  ) {
    super(`[${caseId}] ${message}`)
  }
}

export class RuntimeGateBlockedError extends Error {
  constructor(
    readonly caseId: string,
    message: string,
    readonly evidence?: unknown,
  ) {
    super(`[${caseId}] BLOCKED: ${message}`)
  }
}

type Task2FixtureArtifact = { path: string; sha256: string }
type Task2FixtureArtifacts = {
  candidateSha: string
  imageDigest: string
  currentSupervisor: Task2FixtureArtifact
  currentHost: Task2FixtureArtifact
  currentServer: Task2FixtureArtifact
  legacySupervisor: Task2FixtureArtifact
  legacyHost: Task2FixtureArtifact
  legacyCreatorCommit: '7dbc7ef6b0b87e47ec8386e19115f5e440399898'
}


export class RuntimeHarness {
  private task2FiniteFixtures = false
  task2ServerBinary = ""
  readonly repoRoot: string
  readonly phase: 1 | 2 | 3 | 4 | 5
  readonly runId: string
  readonly candidateSha: string
  readonly testRoot: string
  readonly evidenceDir: string
  readonly buildDir: string
  readonly assertionsPath: string
  readonly lifecyclePath: string
  readonly incidentsDir: string
  readonly browserDir: string

  imageRef = ''
  broker!: RestrictedDockerBroker
  testSupervisorBinary = ''
  testHostBinary = ''
  releaseSupervisorBinary = ''
  releaseHostBinary = ''

  private readonly trackedContainers = new Set<string>()
  private readonly trackedSupervisorContainers = new Set<string>()
  private readonly trackedForeignContainers = new Set<string>()
  private readonly trackedVolumes = new Set<string>()
  private readonly assertions: AssertionRecord[] = []
  private brokerStarted = false

  constructor(repoRoot: string, runId = randomUUID(), phase: 1 | 2 | 3 | 4 | 5 = 1) {
    this.repoRoot = fs.realpathSync(repoRoot)
    this.phase = phase
    this.runId = runId
    this.candidateSha = git(this.repoRoot, ['rev-parse', 'HEAD']).trim()
    // A shared /tmp/frt can belong to another account on multi-user hosts.
    // Keep the short socket path while isolating each account's test runs.
    const userId = (process.getuid?.() ?? process.pid).toString(36)
    this.testRoot = path.join(os.tmpdir(), `f${userId}`, runId.slice(0, 12))
    this.evidenceDir = path.join(this.repoRoot, '.runtime-evidence', this.candidateSha, runId)
    this.buildDir = path.join(this.repoRoot, '.runtime-build', this.runId)
    this.assertionsPath = path.join(this.evidenceDir, 'assertions.jsonl')
    this.lifecyclePath = path.join(this.evidenceDir, 'lifecycle.jsonl')
    this.incidentsDir = path.join(this.evidenceDir, 'incidents')
    this.browserDir = path.join(this.evidenceDir, 'browser')
  }

  async prepare(): Promise<void> {
    fs.rmSync(this.testRoot, { recursive: true, force: true })
    fs.mkdirSync(this.testRoot, { recursive: true, mode: 0o700 })
    ensurePrivateDirectory(this.evidenceDir)
    ensurePrivateDirectory(this.incidentsDir)
    ensurePrivateDirectory(this.browserDir)
    if (this.phase === 1) {
      writePrivateJson(path.join(this.browserDir, 'not-applicable.json'), { reason: 'Phase 1 has no browser surface; the live gate exercises the supervisor/runtime IPC directly.' })
    }

    const sourceManifest = JSON.parse(fs.readFileSync(path.join(this.repoRoot, 'test/runtime/gate-manifest.json'), 'utf8'))
    writePrivateJson(path.join(this.evidenceDir, 'manifest.json'), { ...sourceManifest, execution: { candidateSha: this.candidateSha, runId: this.runId, startedAt: new Date().toISOString() } })
    const providerResults = this.phase === 1
      ? { phase: 'phase-1', externalProviders: 'not-applicable', fixtures: ['heartbeat', 'descendant_spawner', 'cpu_burner', 'memory_allocator', 'native_session', 'security_probe'] }
      : this.phase === 2
        ? { phase: 'phase-2', opencode: { status: 'pending-live-gate', version: '1.18.21', modelProvider: 'openai', model: 'openai/gpt-5.6-luna', freeTier: false }, workloadImage: 'pinned' }
        : this.phase === 3
          ? {
              phase: 'phase-3',
              deterministicFixture: { provider: 'native-session-fixture', status: 'pending-live-gate' },
              providers: {
                claude: { status: 'pending-receipt', requiredModel: 'haiku', reasoning: 'lowest' },
                opencode: { status: 'pending-receipt', version: '1.18.21', modelProvider: 'openai', model: 'openai/gpt-5.6-luna', freeTier: false },
                codex: { status: 'pending-receipt', version: '0.147.0', requiredModel: 'gpt-5.6-luna', reasoning: 'lowest' },
                amplifier: { status: 'pending-receipt', version: '0.1.1', commit: '1873aa980535c99a743b17172e4231833f6c8741' },
              },
            }
          : this.phase === 4
            ? {
                phase: 'phase-4',
                startupReconciliation: 'pending-live-gate',
                durableViewIntents: 'pending-live-gate',
                browserRehydration: 'pending-receipt',
                compatibilityFallback: 'pending-live-gate',
              }
            : {
                phase: 'phase-5',
                lossCertification: 'pending-live-gate',
                incidentBeforeCleanup: 'pending-live-gate',
                durableNotices: 'pending-browser-receipt',
                chaos: 'pending-live-gate',
                migrationRollback: 'pending-live-gate',
              }
    writePrivateJson(path.join(this.evidenceDir, 'provider-results.json'), providerResults)

    this.recordLifecycle('gate.prepare.started', { repoRoot: this.repoRoot, candidateSha: this.candidateSha, runId: this.runId })
    this.ensureRuntimeImage()
    this.buildBinaries()

    const realSocketPath = dockerSocketPath()
    const proxySocketPath = path.join(this.testRoot, 'broker', 'docker.sock')
    this.broker = new RestrictedDockerBroker({
      realSocketPath,
      proxySocketPath,
      runtimeRootPrefix: path.join(this.testRoot, 'r'),
      allowedHostBinaryPaths: new Set([this.testHostBinary, this.releaseHostBinary]),
      allowedImageRefs: new Set([this.imageRef]),
      allowTerminalWorkloads: this.phase >= 2,
      allowedWorkspaceRoots: new Set(this.phase >= 2 ? this.phase2WorkspaceRoots() : []),
      allowedProviderUserRoots: new Set(this.phase >= 2 ? this.phase2ProviderUserRoots() : []),
      allowedBootstrapFiles: new Set(this.phase >= 2 ? this.phase2BootstrapFiles() : []),
      testRunId: this.runId,
      logPath: path.join(this.evidenceDir, 'broker.jsonl'),
    })
    await this.broker.start()
    this.brokerStarted = true

    writePrivateJson(path.join(this.evidenceDir, 'ownership-before.json'), { brokerReceipts: [], trackedContainers: [] })
    writePrivateJson(path.join(this.evidenceDir, 'capabilities.json'), this.collectCapabilities())
    writePrivateJson(path.join(this.evidenceDir, 'build.json'), this.collectBuildInfo())
    this.recordLifecycle('gate.prepare.completed', { imageRef: this.imageRef, brokerSocket: proxySocketPath })
  }

  async prepareTask2FixtureArtifacts(input: Task2FixtureArtifacts): Promise<void> {
    if (input.candidateSha !== this.candidateSha || !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)
      || input.legacyCreatorCommit !== '7dbc7ef6b0b87e47ec8386e19115f5e440399898'
      || !dockerIsRootless()) throw new Error('exact current/legacy artifacts and rootless Docker required')
    if (docker(['image', 'inspect', input.imageDigest, '--format', '{{.Id}}']).trim() !== input.imageDigest)
      throw new Error('immutable fixture image mismatch')
    const artifacts = [input.currentSupervisor, input.currentHost, input.legacySupervisor, input.legacyHost, input.currentServer]
    // Inputs must be prebuilt immutable private copies. Refuse symlinks and hash
    // before copying; hash each copy afterward to catch changed inputs.
    for (const artifact of artifacts) {
      const stat = fs.lstatSync(artifact.path)
      if (!path.isAbsolute(artifact.path) || fs.realpathSync(artifact.path) !== artifact.path
        || !stat.isFile() || (stat.mode & 0o222) !== 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex') !== artifact.sha256)
        throw new Error('immutable exact fixture binary required')
    }
    if (fs.existsSync(this.testRoot) || fs.existsSync(this.buildDir)) throw new Error('fixture run already exists')
    fs.mkdirSync(this.testRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.buildDir, { recursive: true, mode: 0o700 })
    for (const directory of [this.evidenceDir, this.incidentsDir, this.browserDir]) ensurePrivateDirectory(directory)
    const names = ['freshell-supervisor-test', 'freshell-session-host-test', 'task002-legacy-supervisor', 'task002-prefixed-session-host', 'task002-server']
    for (const [index, artifact] of artifacts.entries()) {
      const destination = path.join(this.buildDir, names[index]!)
      fs.copyFileSync(artifact.path, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, index === 1 || index === 3 ? 0o550 : 0o500)
      if (createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== artifact.sha256)
        throw new Error('fixture copy changed')
    }
    this.imageRef = input.imageDigest
    this.task2ServerBinary = path.join(this.buildDir, names[4]!)
    this.testSupervisorBinary = this.releaseSupervisorBinary = path.join(this.buildDir, names[0]!)
    this.testHostBinary = this.releaseHostBinary = path.join(this.buildDir, names[1]!)
    this.task2FiniteFixtures = true
    this.broker = new RestrictedDockerBroker({
      realSocketPath: dockerSocketPath(), proxySocketPath: path.join(this.testRoot, 'broker/docker.sock'),
      runtimeRootPrefix: path.join(this.testRoot, 'r'),
      allowedHostBinaryPaths: new Set([this.testHostBinary, path.join(this.buildDir, names[3]!)]),
      allowedImageRefs: new Set([this.imageRef]), allowTerminalWorkloads: true,
      allowedWorkspaceRoots: new Set([this.testRoot]), allowedProviderUserRoots: new Set(),
      allowTask2LegacyNegativeFixtures: true,
      allowedBootstrapFiles: new Set(), testRunId: this.runId, logPath: path.join(this.evidenceDir, 'broker.jsonl'),
    })
    await this.broker.start()
    this.brokerStarted = true
    this.writeArtifact('task002-artifacts.json', input)
  }

  /** Finite offline transfer qualification; no ambient homes/grants or broker. */
  async prepareTransfer(imageDigest: string): Promise<void> {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || !dockerIsRootless()) {
      throw new Error('transfer requires an exact immutable image and rootless Docker')
    }
    const inspected = docker(['image', 'inspect', imageDigest, '--format', '{{.Id}}']).trim()
    if (inspected !== imageDigest) throw new Error('transfer image identity mismatch')
    if (fs.existsSync(this.testRoot)) throw new Error('transfer scratch already exists')
    fs.mkdirSync(this.testRoot, { recursive: true, mode: 0o700 })
    ensurePrivateDirectory(this.evidenceDir)
    this.imageRef = imageDigest
    this.recordLifecycle('transfer.prepare.completed', { imageDigest, candidateSha: this.candidateSha })
  }

  startTransferProvider(stageBinary: string, schemaFile: string, migrationsFile: string, workspacePaths: readonly string[] = []): { containerId: string; volumeName: string } {
    for (const file of [stageBinary, schemaFile, migrationsFile]) {
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('exact transfer artifact file required')
    }
    const volumeName = `freshell-transfer-${this.runId.slice(0, 12)}-${randomUUID().slice(0, 8)}`
    docker(['volume', 'create', '--label', `com.freshell.runtime-test-run-id=${this.runId}`, volumeName])
    this.trackedVolumes.add(volumeName)
    // Trusted rootless volume initialization finishes before any provider
    // runs. Only the owned volume root changes; provider operations get no caps.
    const initializer = docker([
      'create', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges', '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      '--mount', `type=volume,source=${volumeName},target=/scratch`, this.imageRef,
      'python3', '-c', 'import os; p="/scratch/.freshell-transfer-owner"; f=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.write(f,b"owned-transfer-volume"); os.fsync(f); os.close(f); os.chown(p,65534,0); os.chmod("/scratch",0o700); os.chown("/scratch",65534,0)',
    ]).trim()
    if (!/^[a-f0-9]{64}$/.test(initializer)) throw new Error('invalid transfer initializer id')
    this.trackedContainers.add(initializer)
    docker(['start', '-a', initializer])
    const exitCode = Number(docker(['inspect', '--format', '{{.State.ExitCode}}', initializer]).trim())
    if (exitCode !== 0) throw new Error('owned volume initialization failed')
    const containerId = docker([
      'run', '-d', '--network', 'none', '--read-only', '--user', '65534:0', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', '1g', '--memory-swap', '1g', '--pids-limit', '128',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
      '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      '--mount', `type=volume,source=${volumeName},target=/scratch`,
      '--mount', `type=bind,source=${stageBinary},target=/opt/transfer-stage,readonly`,
      '--mount', `type=bind,source=${schemaFile},target=/opt/transfer-schema.sql,readonly`,
      '--mount', `type=bind,source=${migrationsFile},target=/opt/transfer-migrations.json,readonly`,
      '-e', 'HOME=/scratch/provider', '-e', 'XDG_DATA_HOME=/scratch/provider/.local/share',
      '-e', 'XDG_CONFIG_HOME=/scratch/provider/.config', '-e', 'XDG_CACHE_HOME=/scratch/provider/.cache',
      '-e', 'OPENCODE_DB=/scratch/provider/.local/share/opencode/opencode.db',
      '-e', 'OPENCODE_DISABLE_DEFAULT_PLUGINS=1', '-e', 'OPENCODE_DISABLE_MODELS_FETCH=1', '-e', 'OPENCODE_DISABLE_AUTOUPDATE=1',
      ...workspacePaths.flatMap((workspace) => {
        if (!path.isAbsolute(workspace) || fs.realpathSync(workspace) !== workspace || workspace === os.homedir()
          || workspace === '/' || workspace === '/scratch' || !fs.statSync(workspace).isDirectory()) throw new Error('exact qualified workspace required')
        return ['--mount', `type=bind,source=${workspace},target=${workspace},readonly`]
      }),
      '-w', '/scratch', this.imageRef, 'sleep', '600',
    ]).trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('invalid transfer provider id')
    this.trackedContainers.add(containerId)
    this.recordLifecycle('transfer.provider.started', { containerId, volumeName, imageDigest: this.imageRef, providerUid: 65534, providerGid: 0 })
    return { containerId, volumeName }
  }

  writeTransferRequest(containerId: string, fileName: string, value: unknown): void {
    if (!this.trackedContainers.has(containerId) || !/^[a-z0-9-]+\.json$/.test(fileName)) throw new Error('owned transfer request required')
    execFileSync('docker', ['exec', '-i', '--user', '65534:0', containerId, 'python3', '-c',
      'import os,sys; p="/scratch/"+sys.argv[1]; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); b=sys.stdin.buffer.read(1048577); assert len(b)<=1048576; os.write(f,b); os.fsync(f); os.close(f)', fileName,
    ], { input: JSON.stringify(value), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  }

  async copyTransferFileExact(containerId: string, sourceFile: string, destinationFile: string): Promise<void> {
    if (!this.trackedContainers.has(containerId) || !/^\/scratch\/[a-z0-9-]+\.(json|bin)$/.test(destinationFile)) throw new Error('exact owned transfer file required')
    const child = spawn('docker', ['exec', '-i', '--user', '65534:0', containerId, 'node', '-e',
      'const fs=require("node:fs");const f=fs.openSync(process.argv[1],"wx",0o600);let count=0;process.stdin.on("data",b=>{count+=b.length;if(count>8589934592)process.exit(1);fs.writeSync(f,b)});process.stdin.on("end",()=>{fs.fsyncSync(f);fs.closeSync(f)});', destinationFile,
    ], { cwd: this.repoRoot, stdio: ['pipe', 'ignore', 'pipe'], timeout: 300_000 })
    this.recordLifecycle('transfer.file.copy.started', { containerId, childPid: child.pid, sourceReference: sourceFile, destinationReference: destinationFile })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`owned transfer copy failed: ${code ?? signal}`)))
      child.stderr.resume()
    })
    const results = await Promise.allSettled([pipeline(fs.createReadStream(sourceFile), child.stdin), completion])
    if (results.some((result) => result.status === 'rejected')) throw new Error('owned transfer file copy failed')
    this.recordLifecycle('transfer.file.copy.complete', { containerId, destinationReference: destinationFile })
  }

  async captureTransferFileExact(containerId: string, sourceFile: string, destinationFile: string): Promise<void> {
    if (!this.trackedContainers.has(containerId) || !/^\/scratch\/(?:native-[a-zA-Z0-9_-]+\.json|native-private\.log)$/.test(sourceFile)) throw new Error('exact owned native artifact required')
    const child = spawn('docker', ['exec', '--user', '65534:0', containerId, 'node', '-e',
      'require("node:fs").createReadStream(process.argv[1]).pipe(process.stdout)', sourceFile,
    ], { cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`owned native capture failed: ${code ?? signal}`)))
      child.stderr.resume()
    })
    const results = await Promise.allSettled([pipeline(child.stdout, fs.createWriteStream(destinationFile, { mode: 0o600, flags: 'wx' })), completion])
    if (results.some((result) => result.status === 'rejected')) throw new Error('owned native artifact capture failed')
    this.recordLifecycle('transfer.native_artifact.captured', { containerId, sourceReference: sourceFile, destinationReference: destinationFile })
  }

  transferOwnedIds(): { containers: string[]; volumes: string[] } {
    return { containers: [...this.trackedContainers], volumes: [...this.trackedVolumes] }
  }

  verifyTransferCleanup(original: { containers: string[]; volumes: string[] }): void {
    // Successful inventory calls prove absence; daemon/transport failure is
    // never interpreted as a missing owned object.
    const containers = new Set(docker(['ps', '-aq', '--no-trunc']).trim().split('\n'))
    const volumes = new Set(docker(['volume', 'ls', '-q']).trim().split('\n'))
    if (original.containers.some((id) => containers.has(id)) || original.volumes.some((id) => volumes.has(id))) {
      throw new Error('owned transfer resources remain after cleanup')
    }
  }

  async cleanup(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = []
    for (const id of [...this.trackedSupervisorContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`supervisor ${id}: ${String(error)}`) }
    }
    for (const id of [...this.broker?.receiptIds?.() ?? []]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`managed runtime ${id}: ${String(error)}`) }
    }
    for (const id of [...this.trackedForeignContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`foreign sentinel ${id}: ${String(error)}`) }
    }
    for (const id of [...this.trackedContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`tracked container ${id}: ${String(error)}`) }
    }
    const providerVolumes = new Set((this.broker?.receipts?.() ?? []).map((receipt) => receipt.providerVolumeName).filter((value): value is string => !!value))
    for (const volume of providerVolumes) {
      try { docker(['volume', 'rm', volume]) } catch (error) { errors.push(`provider volume ${volume}: ${String(error)}`) }
    }
    for (const volume of [...this.trackedVolumes]) {
      try { docker(['volume', 'rm', volume]) } catch (error) { errors.push(`volume ${volume}: ${String(error)}`) }
    }
    if (this.brokerStarted) {
      try { await this.broker.close() } catch (error) { errors.push(`broker close: ${String(error)}`) }
      this.brokerStarted = false
    }
    // Build copies are unique to this run, so retries/concurrent gates never
    // overwrite an executable that another still-running container/process
    // has mapped. Remove them only after every receipt-owned runtime stopped.
    try { fs.rmSync(this.buildDir, { recursive: true, force: true }) } catch (error) { errors.push(`runtime build dir: ${String(error)}`) }
    const cleanup = {
      ok: errors.length === 0,
      errors,
      exactContainerIds: [...new Set([
        ...this.trackedSupervisorContainers,
        ...this.trackedForeignContainers,
        ...this.trackedContainers,
        ...this.broker?.receiptIds?.() ?? [],
      ])],
      volumes: [...this.trackedVolumes, ...providerVolumes],
      unsafeBrokerAttempts: this.broker?.unsafeAttempts?.() ?? [],
      completedAt: new Date().toISOString(),
    }
    ensurePrivateDirectory(this.evidenceDir)
    writePrivateJson(path.join(this.evidenceDir, 'cleanup.json'), cleanup)
    writePrivateJson(path.join(this.evidenceDir, 'ownership-after.json'), { brokerReceipts: this.broker?.receipts?.() ?? [], brokerEvents: this.broker?.eventsSnapshot?.() ?? [] })
    this.collectScenarioLifecycleLogs()
    return { ok: cleanup.ok, errors }
  }

  recordProviderQualificationBuild(record: ProviderQualificationBuildRecord): void {
    const buildPath = path.join(this.evidenceDir, 'build.json')
    const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'))
    const qualificationBuild = {
      kind: record.kind,
      serverFeatures: [...record.serverFeatures].sort(),
      supervisorFeatures: [...record.supervisorFeatures].sort(),
      qualificationProviders: [...record.qualificationProviders].sort(),
      binaries: {
        server: fileBuild(this.validateRunBuildBinary(record.serverBinary, 'qualification server')),
        supervisor: fileBuild(this.validateRunBuildBinary(record.supervisorBinary, 'qualification supervisor')),
      },
    }
    writePrivateJson(buildPath, { ...build, qualificationBuild })
  }

  recordFreshAgentQualificationBuild(record: FreshAgentQualificationBuildRecord): void {
    const buildPath = path.join(this.evidenceDir, 'build.json')
    const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'))
    const freshAgentQualificationBuild = {
      kind: record.kind,
      serverFeatures: [...record.serverFeatures].sort(),
      sessionHostFeatures: [...record.sessionHostFeatures].sort(),
      selectedModes: [...record.selectedModes],
      fixtureModes: [...record.fixtureModes],
      binaries: {
        server: fileBuild(this.validateRunBuildBinary(record.serverBinary, 'fresh-agent qualification server')),
        supervisor: fileBuild(this.validateRunBuildBinary(record.supervisorBinary, 'fresh-agent qualification supervisor')),
        sessionHost: fileBuild(this.validateRunBuildBinary(record.sessionHostBinary, 'fresh-agent qualification session host')),
      },
    }
    fs.writeFileSync(buildPath, JSON.stringify({
      ...build,
      freshAgentQualificationBuild,
      binaries: { ...build.binaries, ...freshAgentQualificationBuild.binaries },
    }, null, 2))
  }

  assert(caseId: string, condition: unknown, message: string, evidence?: unknown): asserts condition {
    const record: AssertionRecord = { at: new Date().toISOString(), caseId, pass: Boolean(condition), message, ...(evidence === undefined ? {} : { evidence }) }
    this.assertions.push(record)
    appendPrivateLine(this.assertionsPath, record)
    if (!condition) throw new RuntimeGateAssertionError(caseId, message, evidence)
  }

  recordLifecycle(event: string, data: unknown = {}): void {
    ensurePrivateDirectory(path.dirname(this.lifecyclePath))
    appendPrivateLine(this.lifecyclePath, { at: new Date().toISOString(), event, data })
  }

  writeIncident(name: string, value: unknown): void {
    ensurePrivateDirectory(this.incidentsDir)
    writePrivateJson(path.join(this.incidentsDir, `${sanitizeName(name)}.json`), value)
  }

  writeBrowserArtifact(name: string, value: unknown): string {
    ensurePrivateDirectory(this.browserDir)
    const target = path.join(this.browserDir, `${sanitizeName(name)}.json`)
    writePrivateJson(target, value)
    return target
  }

  /// A named top-level evidence artifact. The gate manifest declares which
  /// artifacts a run must contain; this is how a case contributes one.
  writeArtifact(fileName: string, value: unknown): string {
    const target = path.join(this.evidenceDir, sanitizeName(fileName))
    ensurePrivateDirectory(path.dirname(target))
    writePrivateJson(target, value)
    return target
  }

  writeProviderResults(value: unknown): void {
    writePrivateJson(path.join(this.evidenceDir, 'provider-results.json'), value)
  }

  writeSummary(summary: unknown): void {
    writePrivateJson(path.join(this.evidenceDir, 'summary.json'), summary)
  }

  scenarioPath(scenarioId: string): string {
    return path.join(this.testRoot, 'scenarios', sanitizeName(scenarioId))
  }

  async startSupervisor(options: {
    scenarioId: string
    volumeName?: string
    binaryKind?: 'test' | 'release'
    crashPoint?: string
    dbFailpoint?: string
    waitForHealth?: boolean
    reuseSecret?: boolean
    installationBudget?: RuntimeLimits
    projectBudget?: RuntimeLimits
    env?: Record<string, string>
    /** Exact harness-built supervisor binary; must live under this run's build directory. */
    binaryPath?: string
    /** Exact artifact-owned historical session host for legacy enclosure proof. */
    hostBinaryPath?: string
  }): Promise<SupervisorInstance> {
    const scenarioId = sanitizeName(options.scenarioId)
    const scenarioRoot = this.scenarioPath(scenarioId)
    const controlDir = path.join(scenarioRoot, 'control')
    // Linux Unix-domain sockets have a small sun_path budget. Runtime paths
    // include a long incarnation UUID plus `/host.sock`, so keep the durable
    // runtime root intentionally short and deterministic across restarts.
    const runtimeKey = `${scenarioId.slice(0, 6)}-${createHash('sha256').update(scenarioId).digest('hex').slice(0, 8)}`
    const runtimeRoot = path.join(this.testRoot, 'r', runtimeKey, 'x')
    fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
    const worstHostSocket = path.join(runtimeRoot, `incarnation-${'0'.repeat(36)}`, 'host.sock')
    if (Buffer.byteLength(worstHostSocket) >= 104) {
      throw new Error(`runtime host socket path budget exceeded (${Buffer.byteLength(worstHostSocket)} bytes): ${worstHostSocket}`)
    }
    const controlSecretFile = path.join(controlDir, 'secret')
    if (!fs.existsSync(controlSecretFile) || options.reuseSecret === false) {
      fs.writeFileSync(controlSecretFile, `${randomUUID()}${randomUUID()}${randomUUID()}`, { mode: 0o600 })
    }
    const controlSecret = fs.readFileSync(controlSecretFile, 'utf8').trim()
    const controlSocket = path.join(controlDir, 'supervisor.sock')
    const volumeName = options.volumeName ?? `freshell-p${this.phase}-${this.runId.slice(0, 8)}-${scenarioId}`
    if (!this.trackedVolumes.has(volumeName)) {
      docker(['volume', 'create', volumeName])
      this.trackedVolumes.add(volumeName)
    }
    const binaryKind = options.binaryKind ?? 'test'
    const defaultSupervisorBinary = binaryKind === 'test' ? this.testSupervisorBinary : this.releaseSupervisorBinary
    const supervisorBinary = options.binaryPath
      ? this.validateRunBuildBinary(options.binaryPath, 'supervisor')
      : defaultSupervisorBinary
    const hostBinary = options.hostBinaryPath
      ? this.validateRunBuildBinary(options.hostBinaryPath, 'host')
      : binaryKind === 'test' ? this.testHostBinary : this.releaseHostBinary
    const name = `freshell-p${this.phase}-supervisor-${this.runId.slice(0, 8)}-${scenarioId}-${randomUUID().slice(0, 8)}`
    const args = [
      'run', '-d', '--name', name, '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      // The supervisor is trusted control-plane test code. Rootful Docker
      // preserves the host runner uid on bind mounts, so uid-0 with CapDrop=ALL
      // cannot traverse this harness's 0700 testRoot or read its 0600 secret.
      // Add only DAC_OVERRIDE to keep the same private-file contract portable;
      // managed workload containers still use the stricter broker-enforced set.
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '-v', `${this.testRoot}:${this.testRoot}:rw`,
      '-v', `${this.buildDir}:${this.buildDir}:ro`,
      '-v', `${volumeName}:/var/lib/freshell-supervisor:rw`,
    ]
    if (this.phase >= 2) {
      for (const root of this.phase2WorkspaceRoots()) {
        if (root === this.testRoot || root === this.buildDir) continue
        args.push('-v', `${root}:${root}:ro`)
      }
    }
    if (this.phase >= 2) {
      for (const credentialFile of this.phase2BootstrapFiles()) {
        // The web/server side records this exact canonical HOST path in the
        // durable launch spec. A containerized supervisor must therefore see
        // the same path for validation; mount the single file, never its
        // parent directory/home.
        args.push('-v', `${credentialFile}:${credentialFile}:ro`)
      }
    }
    if (options.crashPoint) args.push('-e', `FRESHELL_RUNTIME_CRASH_POINT=${options.crashPoint}`)
    if (options.dbFailpoint) args.push('-e', `FRESHELL_RUNTIME_DB_FAILPOINT=${options.dbFailpoint}`)
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`)
    args.push(
      this.imageRef,
      supervisorBinary, 'serve',
      '--registry-root', '/var/lib/freshell-supervisor',
      '--control-socket', controlSocket,
      '--control-secret-file', controlSecretFile,
      '--docker-socket', this.broker.proxySocketPath,
      '--runtime-root', runtimeRoot,
      '--host-binary', hostBinary,
      '--image-ref', this.imageRef,
    )
    if (options.installationBudget) {
      args.push('--installation-budget-cpu-milli', String(options.installationBudget.cpuMilli), '--installation-budget-memory-bytes', String(options.installationBudget.memoryBytes), '--installation-budget-pids', String(options.installationBudget.pidsMax))
    }
    if (options.projectBudget) {
      args.push('--project-budget-cpu-milli', String(options.projectBudget.cpuMilli), '--project-budget-memory-bytes', String(options.projectBudget.memoryBytes), '--project-budget-pids', String(options.projectBudget.pidsMax))
    }
    args.push('--test-run-id', this.runId)
    const containerId = docker(args).trim()
    if (!/^[0-9a-f]{64}$/.test(containerId)) throw new Error(`supervisor docker run returned invalid id: ${containerId}`)
    this.trackedSupervisorContainers.add(containerId)
    this.trackedContainers.add(containerId)
    const instance: SupervisorInstance = { scenarioId, containerId, controlSocket, controlSecret, controlSecretFile, runtimeRoot, volumeName, binaryKind }
    this.recordLifecycle('supervisor.started', { scenarioId, containerId, binaryKind, crashPoint: options.crashPoint, dbFailpoint: options.dbFailpoint, volumeName })
    if (options.waitForHealth !== false) await this.waitForSupervisorHealth(instance)
    return instance
  }

  private validateRunBuildBinary(candidate: string, label: string): string {
    const resolved = fs.realpathSync(candidate)
    const buildRoot = `${fs.realpathSync(this.buildDir)}${path.sep}`
    if (!resolved.startsWith(buildRoot) || !fs.statSync(resolved).isFile()) {
      throw new Error(`${label} binary override must be a regular file under this run's build directory`)
    }
    return resolved
  }

  async waitForSupervisorHealth(instance: SupervisorInstance, timeoutMs = 12_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      if (!this.isContainerRunning(instance.containerId)) {
        const logs = this.containerLogs(instance.containerId)
        throw new Error(`supervisor ${instance.containerId} exited before health: ${logs}`)
      }
      if (fs.existsSync(instance.controlSocket)) {
        // Rootful Docker creates the bind-mounted UDS as container root, so
        // the non-root GitHub/CI harness cannot connect to its mode-0600
        // socket. Rootless Docker already maps container root to this user.
        // Bridge ownership only for this exact test-supervisor socket; the
        // managed runtime host sockets remain private to the supervisor.
        if (!dockerIsRootless()) {
          const uid = process.getuid?.() ?? 1000
          const gid = process.getgid?.() ?? 1000
          try { docker(['exec', instance.containerId, 'chown', `${uid}:${gid}`, instance.controlSocket]) } catch {}
        }
        try { return await this.adminOk(instance, { method: 'health' }) } catch (error) { lastError = error }
      }
      await sleep(50)
    }
    throw new Error(`supervisor health timeout: ${String(lastError)}`)
  }

  async adminRaw(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string } = {}): Promise<AdminReply> {
    return await this.adminEnvelopeRaw(instance, {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId: options.requestId ?? `request-${randomUUID()}`,
      role: 'web',
      auth: options.auth ?? instance.controlSecret,
      body,
    })
  }

  async adminSendAndDrop(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string } = {}): Promise<void> {
    const envelope = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId: options.requestId ?? `request-${randomUUID()}`,
      role: 'web',
      auth: options.auth ?? instance.controlSecret,
      body,
    }
    const payload = Buffer.from(JSON.stringify(envelope))
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(instance.controlSocket)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.write(frame, (error) => {
          if (error) return reject(error)
          socket.destroy()
          resolve()
        })
      })
    })
  }

  async adminEnvelopeRaw(instance: SupervisorInstance, envelope: Record<string, unknown>): Promise<AdminReply> {
    const payload = Buffer.from(JSON.stringify(envelope))
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return await unixRoundTrip(instance.controlSocket, frame) as AdminReply
  }

  async adminOversizedFrame(instance: SupervisorInstance, announcedBytes = 1024 * 1024 + 1): Promise<AdminReply> {
    const frame = Buffer.allocUnsafe(4)
    frame.writeUInt32BE(announcedBytes, 0)
    return await unixRoundTrip(instance.controlSocket, frame) as AdminReply
  }

  async adminOk(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string } = {}): Promise<any> {
    const reply = await this.adminRaw(instance, body, options)
    if (reply.result?.Err) {
      const error = new Error(`${reply.result.Err.code}: ${reply.result.Err.message}`) as Error & { runtimeError?: AdminError }
      error.runtimeError = reply.result.Err
      throw error
    }
    if (!('Ok' in (reply.result ?? {}))) throw new Error(`malformed supervisor reply: ${JSON.stringify(reply)}`)
    return reply.result.Ok
  }

  launchBody(params: {
    soulId: string
    limits?: RuntimeLimits
    fixture?: 'heartbeat' | 'descendant_spawner' | 'cpu_burner' | 'memory_allocator' | 'native_session' | 'security_probe'
    terminal?: Record<string, unknown>
    profile?: 'default_agent' | 'test_fixture' | 'custom'
    projectKey?: string
    nativeSessionId?: string
    expectedControlEpoch?: number
    provider?: string
    providerStoreId?: string
    creationSeedRef?: string
    viewIntent?: Record<string, unknown>
  }): any {
    const terminal = params.terminal
    return {
      method: 'launch',
      params: {
        soulId: params.soulId,
        provider: params.provider ?? (terminal ? 'shell' : 'phase1-fixture'),
        providerStoreId: params.providerStoreId ?? `store-${this.runId}`,
        creationSeedRef: params.creationSeedRef ?? `seed-${params.soulId}`,
        limits: params.limits ?? defaultLimits(),
        ...(params.profile ? { profile: params.profile } : {}),
        ...(params.projectKey ? { projectKey: params.projectKey } : {}),
        ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
        ...(terminal ? { terminal } : { fixture: params.fixture ?? 'heartbeat' }),
        ...(params.viewIntent ? { viewIntent: params.viewIntent } : {}),
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  terminalInputBody(soulId: string, data: string, expectedControlEpoch?: number): any {
    return { method: 'terminal_input', params: { soulId, data, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  terminalResizeBody(soulId: string, cols: number, rows: number, expectedControlEpoch?: number): any {
    return { method: 'terminal_resize', params: { soulId, cols, rows, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  terminalReadOutputBody(soulId: string, afterSeq = 0, maxBytes = 64 * 1024, expectedControlEpoch?: number): any {
    return { method: 'terminal_read_output', params: { soulId, afterSeq, maxBytes, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  freshAgentResolveBody(
    soulId: string,
    decisionId: string,
    decision: Record<string, unknown>,
    expectedControlEpoch?: number,
  ): any {
    return {
      method: 'fresh_agent_resolve',
      params: {
        soulId,
        decisionId,
        decision,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  runtimeMetricsBody(soulId: string, expectedControlEpoch?: number): any {
    return { method: 'runtime_metrics', params: { soulId, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  inventoryBody(): any {
    return { method: 'inventory' }
  }

  inventorySnapshotBody(): any {
    return { method: 'inventory_snapshot' }
  }

  pendingViewProjectionsBody(limit = 100, expectedControlEpoch?: number): any {
    return {
      method: 'pending_view_projections',
      params: { limit, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) },
    }
  }

  acknowledgeViewProjectionBody(eventId: string, expectedControlEpoch?: number): any {
    return {
      method: 'acknowledge_view_projection',
      params: { eventId, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) },
    }
  }

  updateViewVisibilityBody(params: {
    viewId: string
    visibility: 'visible' | 'detached' | 'hidden'
    expectedRevision: number
    expectedSoulIntentRevision: number
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'update_view_visibility',
      params: {
        viewId: params.viewId,
        visibility: params.visibility,
        expectedRevision: params.expectedRevision,
        expectedSoulIntentRevision: params.expectedSoulIntentRevision,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  upsertViewIntentBody(params: {
    soulId: string
    viewId?: string
    intent: Record<string, unknown>
    expectedRevision?: number
    expectedSoulIntentRevision: number
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'upsert_view_intent',
      params: {
        soulId: params.soulId,
        ...(params.viewId ? { viewId: params.viewId } : {}),
        intent: params.intent,
        ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
        expectedSoulIntentRevision: params.expectedSoulIntentRevision,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  updateLimitsBody(params: {
    soulId: string
    limits: RuntimeLimits
    expectedIntentRevision: number
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'update_limits',
      params: {
        soulId: params.soulId,
        limits: params.limits,
        expectedIntentRevision: params.expectedIntentRevision,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  probeRecoveryBody(soulId: string, expectedControlEpoch?: number): any {
    return { method: 'probe_recovery', params: { soulId, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  pendingNoticesBody(profileId: string, limit = 20, expectedControlEpoch?: number): any {
    return {
      method: 'pending_notices',
      params: {
        profileId,
        limit,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  noticeReceiptBody(params: {
    noticeId: string
    profileId: string
    state: 'rendered' | 'acknowledged' | 'dismissed'
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'notice_receipt',
      params: {
        noticeId: params.noticeId,
        profileId: params.profileId,
        state: params.state,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  incidentSummaryBody(incidentId: string, expectedControlEpoch?: number): any {
    return {
      method: 'incident_summary',
      params: {
        incidentId,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  runtimeMetricsSnapshotBody(): any {
    return { method: 'metrics_snapshot' }
  }

  migrationPlanBody(params: {
    requestedMode: 'legacy' | 'managed-opt-in' | 'managed-default'
    apply?: boolean
    backupPath?: string
    legacyMetadataPath?: string
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'migration_plan',
      params: {
        requestedMode: params.requestedMode,
        apply: params.apply ?? false,
        ...(params.backupPath ? { backupPath: params.backupPath } : {}),
        ...(params.legacyMetadataPath ? { legacyMetadataPath: params.legacyMetadataPath } : {}),
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  repairAuditBody(apply = false, expectedControlEpoch?: number): any {
    return {
      method: 'repair_audit',
      params: {
        apply,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  recoverBody(
    soulId: string,
    trigger: 'provider_exit' | 'host_unreachable' | 'startup_reconcile' | 'manual_retry' | 'retry_exhausted' | 'explicit_request' = 'explicit_request',
    expectedControlEpoch?: number,
    expectedIntentRevision?: number,
  ): any {
    return {
      method: 'recover',
      params: {
        soulId,
        trigger,
        ...(expectedIntentRevision === undefined ? {} : { expectedIntentRevision }),
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  stopBody(soulId: string, expectedControlEpoch?: number, expectedIntentRevision?: number): any {
    return {
      method: 'stop',
      params: {
        soulId,
        ...(expectedIntentRevision === undefined ? {} : { expectedIntentRevision }),
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  runtimeDir(instance: SupervisorInstance, incarnationId: string): string {
    return path.join(instance.runtimeRoot, incarnationId)
  }

  async nativeFixtureCall(instance: SupervisorInstance, incarnationId: string, body: Record<string, unknown>): Promise<any> {
    const socketPath = path.join(this.runtimeDir(instance, incarnationId), 'native.sock')
    await this.waitForFile(socketPath)
    const payload = Buffer.from(JSON.stringify(body))
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return await unixRoundTrip(socketPath, frame)
  }

  startWebLifetimeSentinel(scenarioId: string): string {
    const id = docker([
      'run', '-d', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--label', 'project=freshell',
      '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      this.imageRef, 'sleep', 'infinity',
    ]).trim()
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`web lifetime sentinel returned invalid id: ${id}`)
    this.trackedContainers.add(id)
    this.recordLifecycle('web_lifetime_sentinel.started', { scenarioId, containerId: id })
    return id
  }

  stopTrackedContainerExact(containerId: string): void {
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['stop', '-t', '1', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker stop failed for tracked container ${containerId}`)
  }

  killTrackedContainerExact(containerId: string): void {
    if (!this.trackedContainers.has(containerId)) throw new Error(`refusing to kill untracked container ${containerId}`)
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['kill', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker kill failed for tracked container ${containerId}`)
  }

  ownedContainerHostPidExact(containerId: string): number {
    if (!this.trackedContainers.has(containerId) && !this.broker.receiptIds().has(containerId)) {
      throw new Error(`refusing to inspect host PID for unowned container ${containerId}`)
    }
    const raw = docker(['inspect', '--format', '{{.State.Pid}}', containerId]).trim()
    const pid = Number(raw)
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`owned container ${containerId} has invalid host PID ${raw}`)
    return pid
  }

  restartOwnedRuntimeExact(containerId: string): void {
    if (!this.broker.receiptIds().has(containerId)) throw new Error(`refusing to restart non-receipt container ${containerId}`)
    const result = spawnSync('docker', ['restart', '-t', '1', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker restart failed for owned runtime ${containerId}`)
  }

  stopOwnedRuntimeExact(containerId: string): void {
    if (!this.broker.receiptIds().has(containerId)) throw new Error(`refusing to stop non-receipt container ${containerId}`)
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['stop', '-t', '1', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker stop failed for owned runtime ${containerId}`)
  }

  killOwnedRuntimeExact(containerId: string): void {
    if (!this.broker.receiptIds().has(containerId)) throw new Error(`refusing to kill non-receipt container ${containerId}`)
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['kill', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker kill failed for owned runtime ${containerId}`)
  }

  killOwnedRuntimePidExact(containerId: string, pid: number, signal: 'TERM' | 'KILL' = 'KILL'): void {
    if (!this.broker.receiptIds().has(containerId)) {
      throw new Error(`refusing to signal a pid in non-receipt container ${containerId}`)
    }
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(`refusing to signal unsafe runtime pid ${pid}`)
    }
    if (!this.isContainerRunning(containerId)) return
    // Runtime workers run as the provider UID. The rootless container host
    // has no CAP_KILL for that UID, so signal from the same user namespace.
    const result = spawnSync('docker', [
      'exec', '--user', '65534:0', containerId, 'kill', `-${signal}`, String(pid),
    ], {
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      throw new Error(result.stderr || `docker exec kill failed for owned runtime ${containerId} pid ${pid}`)
    }
  }

  execOwnedContainerExact(containerId: string, command: string[]): string {
    if (!this.broker.receiptIds().has(containerId) && !this.trackedContainers.has(containerId)) {
      throw new Error(`refusing to exec non-owned container ${containerId}`)
    }
    return execFileSync('docker', ['exec', containerId, ...command], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  }

  execOwnedContainerAsExact(containerId: string, user: string, command: string[]): string {
    if (!this.trackedContainers.has(containerId) && !this.broker?.receiptIds().has(containerId)) {
      throw new Error(`refusing to exec non-owned container ${containerId}`)
    }
    if (!/^\d+:\d+$/.test(user)) throw new Error(`invalid numeric docker exec user ${user}`)
    return execFileSync('docker', ['exec', '--user', user, containerId, ...command], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  }

  execTransferProviderExact(containerId: string, command: string[]): string {
    if (!this.trackedContainers.has(containerId)) throw new Error('owned finite transfer container required')
    return execFileSync('docker', ['exec', '--user', '65534:0', containerId, ...command], {
      encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    })
  }

  topOwnedContainerExact(containerId: string, psArgs: string[] = ['-eo', 'pid,ppid,sid,comm']): string {
    if (!this.broker.receiptIds().has(containerId) && !this.trackedContainers.has(containerId)) {
      throw new Error(`refusing to inspect non-owned container ${containerId}`)
    }
    return execFileSync('docker', ['top', containerId, ...psArgs], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  }

  async waitForFile(filePath: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fs.existsSync(filePath)) return
      await sleep(50)
    }
    throw new Error(`file did not appear: ${filePath}`)
  }

  async waitForContainerExit(containerId: string, timeoutMs = 12_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.isContainerRunning(containerId)) return
      await sleep(75)
    }
    throw new Error(`container remained running: ${containerId}`)
  }

  // Finite Task2 fault injection only. These enclosures are CREATED, never
  // started, and cannot become broker replacement or provider-writer receipts.
  createTask2LegacyNegativeContainerExact(
    originalId: string,
    fault: 'extra_mount' | 'missing_tmpfs' | 'missing_binary' | 'foreign_binary',
  ): string {
    const receipt = this.broker.receipts().find(row => row.containerId === originalId)
    if (!this.task2FiniteFixtures || !dockerIsRootless() || !receipt
      || !['extra_mount', 'missing_tmpfs', 'missing_binary', 'foreign_binary'].includes(fault)
      || !/^[a-f0-9]{64}$/.test(originalId)) throw new Error('owned finite legacy fixture required')
    const original = this.inspectContainer(originalId)
    const config = original.Config, host = original.HostConfig
    const labels = config.Labels
    const expectedLabels = { project: 'freshell', 'com.freshell.managed': 'true',
      'com.freshell.runtime-test-run-id': this.runId, 'com.freshell.soul-id': receipt.soulId,
      'com.freshell.incarnation-id': receipt.incarnationId }
    this.writeArtifact('task2-legacy-physical-shape.json', { idMatches: original.Id === originalId, imageReceiptMatches: original.Image === receipt.imageRef, imageAllowed: original.Image === this.imageRef, running: original.State.Running, labelsMatch: Object.entries(expectedLabels).every(([key, value]) => labels[key] === value), installationPresent: !!labels['com.freshell.installation-id'], readonlyRoot: host.ReadonlyRootfs, privileged: host.Privileged, pidMode: host.PidMode, networkMode: host.NetworkMode, restartPolicy: host.RestartPolicy, capDrop: host.CapDrop, capAdd: host.CapAdd, securityOpt: host.SecurityOpt, tmpfs: Object.keys(host.Tmpfs), receiptSourcesPresent: !!receipt.hostBinaryPath && !!receipt.workspacePath && !!receipt.providerVolumeName, commandPrefix: config.Cmd?.[0], entrypoint: config.Entrypoint })
    if (original.Id !== originalId || original.Image !== receipt.imageRef || original.Image !== this.imageRef
      || original.State.Running !== true || !labels['com.freshell.installation-id']
      || Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)
      || host.ReadonlyRootfs !== true || host.Privileged || host.PidMode
      || host.NetworkMode !== 'bridge' || !['no', 'unless-stopped'].includes(host.RestartPolicy.Name) || host.RestartPolicy.MaximumRetryCount !== 0
      || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL'])
      || JSON.stringify([...host.CapAdd].map((cap: string) => cap.replace(/^CAP_/, '')).sort())
        !== JSON.stringify(['CHOWN', 'SETGID', 'SETUID'])
      || JSON.stringify(host.SecurityOpt.map((option: string) => option.replace(/:true$/, ''))) !== JSON.stringify(['no-new-privileges'])
      || JSON.stringify(Object.keys(host.Tmpfs).sort()) !== JSON.stringify(['/run/opencode-tmp', '/tmp'])
      || !receipt.hostBinaryPath || !receipt.workspacePath || !receipt.providerVolumeName
      || !Array.isArray(config.Cmd) || config.Cmd[0] !== '/runtime/freshell-session-host'
      || (config.Entrypoint?.length ?? 0) > 1) throw new Error('exact owned legacy enclosure differs')
    const expectedBinds = [
      `${receipt.hostBinaryPath}:/runtime/freshell-session-host:ro`, `${receipt.runtimeDir}:/run/freshell:rw`,
      `${receipt.providerVolumeName}:/home/freshell/provider:rw`, `${receipt.workspacePath}:${receipt.workspacePath}:rw`,
    ]
    if (JSON.stringify([...host.Binds].sort()) !== JSON.stringify(expectedBinds.sort()))
      throw new Error('legacy fixture gained configuration, secret, or foreign mounts')
    for (const source of [receipt.runtimeDir, receipt.workspacePath]) {
      if (!source.startsWith(`${this.testRoot}${path.sep}`) || fs.realpathSync(source) !== source)
        throw new Error('fixture source is outside the owned scratch root')
    }
    if (receipt.hostBinaryPath !== path.join(this.buildDir, 'task002-prefixed-session-host'))
      throw new Error('actual old creator binary mount required')
    const binds: string[] = [...host.Binds]
    const tmpfs: Record<string, string> = { ...host.Tmpfs }
    const binaryIndex = binds.indexOf(`${receipt.hostBinaryPath}:/runtime/freshell-session-host:ro`)
    if (fault === 'extra_mount') binds.push(`${receipt.workspacePath}:/run/task002-extra:ro`)
    if (fault === 'missing_tmpfs') delete tmpfs['/run/opencode-tmp']
    if (fault === 'missing_binary') binds.splice(binaryIndex, 1)
    if (fault === 'foreign_binary') {
      if (this.testHostBinary !== path.join(this.buildDir, 'freshell-session-host-test')
        || fs.realpathSync(this.testHostBinary) !== this.testHostBinary)
        throw new Error('owned current fixture binary required')
      binds[binaryIndex] = `${this.testHostBinary}:/runtime/freshell-session-host:ro`
    }
    const args = ['create', '--name', `task002-negative-${this.runId}-${fault}`, '--read-only',
      '--network', host.NetworkMode, '--restart', host.RestartPolicy.Name, '--cap-drop', 'ALL',
      '--cpus', String(host.NanoCpus / 1_000_000_000), '--memory', String(host.Memory),
      '--memory-swap', String(host.MemorySwap), '--pids-limit', String(host.PidsLimit)]
    for (const cap of host.CapAdd) args.push('--cap-add', cap)
    for (const option of host.SecurityOpt) args.push('--security-opt', option)
    for (const entry of host.ExtraHosts ?? []) args.push('--add-host', entry)
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
    args.push('--label', `com.freshell.task2-negative=${fault}`)
    for (const entry of config.Env ?? []) args.push('--env', entry)
    for (const bind of binds) args.push('--volume', bind)
    for (const [destination, options] of Object.entries(tmpfs)) args.push('--tmpfs', `${destination}:${options}`)
    if (config.User) args.push('--user', config.User)
    if (config.WorkingDir) args.push('--workdir', config.WorkingDir)
    args.push('--entrypoint', config.Entrypoint?.[0] ?? '', original.Image, ...config.Cmd)
    const id = docker(args).trim()
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('negative create did not return an exact full ID')
    this.trackedContainers.add(id) // before inspect/admission so failure still cleans this exact ID
    try {
      const bad = this.inspectContainer(id)
      const preservedHostFields = ['NetworkMode', 'PidMode', 'Privileged', 'ReadonlyRootfs', 'NanoCpus',
        'Memory', 'MemorySwap', 'PidsLimit', 'CapDrop', 'CapAdd', 'SecurityOpt', 'ExtraHosts', 'RestartPolicy']
      const preservedHostMismatch = preservedHostFields.filter(key => {
        const normalized = (value: unknown) => ['CapAdd', 'CapDrop'].includes(key) && Array.isArray(value)
          ? value.map((cap: string) => cap.replace(/^CAP_/, '')).sort() : value
        return JSON.stringify(normalized(bad.HostConfig[key])) !== JSON.stringify(normalized(host[key]))
      })
      if (bad.State.Running || bad.State.Status !== 'created' || bad.State.Pid !== 0
        || bad.Id !== id || bad.Image !== original.Image || bad.HostConfig.ReadonlyRootfs !== true
        || preservedHostMismatch.length !== 0
        || JSON.stringify([...bad.HostConfig.Binds].sort()) !== JSON.stringify([...binds].sort())
        || JSON.stringify(bad.HostConfig.Tmpfs) !== JSON.stringify(tmpfs)
        || JSON.stringify(bad.Config.Env) !== JSON.stringify(config.Env)
        || JSON.stringify(bad.Config.Cmd) !== JSON.stringify(config.Cmd))
        throw new Error(`never-started negative fixture shape differs (host fields: ${preservedHostMismatch.join(',')}; binds: ${JSON.stringify([...bad.HostConfig.Binds].sort()) === JSON.stringify([...binds].sort())}; tmpfs: ${JSON.stringify(bad.HostConfig.Tmpfs) === JSON.stringify(tmpfs)}; env: ${JSON.stringify(bad.Config.Env) === JSON.stringify(config.Env)}; command: ${JSON.stringify(bad.Config.Cmd) === JSON.stringify(config.Cmd)})`)
      this.broker.admitTask2LegacyNegativeInspection(bad, original)
      this.recordLifecycle('task2.legacy_negative.created', { severity: 'info', fault, containerId: id, ownerContainerId: originalId })
      return id
    } catch (error) {
      this.removeTask2LegacyNegativeContainerExact(id)
      throw error
    }
  }

  removeTask2LegacyNegativeContainerExact(containerId: string): void {
    if (!this.task2FiniteFixtures || !this.trackedContainers.has(containerId) || !/^[a-f0-9]{64}$/.test(containerId))
      throw new Error('tracked finite negative enclosure required')
    const inspected = this.inspectContainer(containerId)
    if (inspected.Id !== containerId || inspected.State.Running || inspected.State.Status !== 'created'
      || inspected.Config.Labels['com.freshell.runtime-test-run-id'] !== this.runId
      || !['extra_mount', 'missing_tmpfs', 'missing_binary', 'foreign_binary'].includes(inspected.Config.Labels['com.freshell.task2-negative']))
      throw new Error('negative cleanup ownership or never-started state differs')
    this.broker.forgetTask2LegacyNegativeInspection(containerId)
    docker(['rm', containerId]) // no force; no start/stop/kill authority
    this.trackedContainers.delete(containerId)
  }
  inspectContainer(containerId: string): any {
    const output = docker(['inspect', containerId])
    return JSON.parse(output)[0]
  }

  isContainerRunning(containerId: string): boolean {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerId], { encoding: 'utf8' })
    if (result.status !== 0) return false
    return result.stdout.trim() === 'true'
  }

  containerLogs(containerId: string): string {
    const result = spawnSync('docker', ['logs', containerId], { encoding: 'utf8' })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-20_000)
  }

  stopSupervisorExact(instance: SupervisorInstance): void {
    if (this.isContainerRunning(instance.containerId)) {
      const result = spawnSync('docker', ['stop', '-t', '2', instance.containerId], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr || `docker stop failed for ${instance.containerId}`)
    }
  }

  removeContainerExact(containerId: string): void {
    const inspect = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' })
    if (inspect.status !== 0) return
    const result = spawnSync('docker', ['rm', '-f', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker rm failed for ${containerId}`)
    this.trackedContainers.delete(containerId)
    this.trackedSupervisorContainers.delete(containerId)
    this.trackedForeignContainers.delete(containerId)
  }

  createForeignSentinel(options: { scenarioId: string; installationId?: string }): string {
    const scenarioRoot = this.scenarioPath(options.scenarioId)
    fs.mkdirSync(scenarioRoot, { recursive: true })
    const name = `freshell-foreign-${this.runId.slice(0, 8)}-${randomUUID().slice(0, 8)}`
    const id = docker([
      'run', '-d', '--name', name, '--label', `com.freshell.runtime-test-run-id=${this.runId}`, '--network', 'none',
      '--label', 'com.freshell.managed=true',
      '--label', `com.freshell.installation-id=${options.installationId ?? `installation-${randomUUID()}`}`,
      '--label', `com.freshell.soul-id=soul-${randomUUID()}`,
      '--label', `com.freshell.incarnation-id=incarnation-${randomUUID()}`,
      '-e', `FRESHELL_CODEX_SIDECAR_ID=codex-sidecar-${randomUUID()}`,
      '-v', `${scenarioRoot}:${scenarioRoot}:rw`, '-w', scenarioRoot,
      this.imageRef, 'sleep', '600',
    ]).trim()
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`foreign sentinel invalid id: ${id}`)
    this.trackedForeignContainers.add(id)
    this.trackedContainers.add(id)
    this.recordLifecycle('foreign_sentinel.started', { id, scenarioId: options.scenarioId })
    return id
  }

  brokerReceiptsSince(before: Set<string>): BrokerReceipt[] {
    return this.broker.receipts().filter((receipt) => !before.has(receipt.containerId))
  }

  brokerEventsFor(containerId: string): BrokerEvent[] {
    return this.broker.destructiveRequestsFor(containerId)
  }

  runSandboxed(command: string): string {
    return execFileSync('bash', ['scripts/sandbox-test.sh', '--runtime-suite', command], { cwd: this.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  }

  runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
    return execFileSync(command, args, { cwd: options.cwd ?? this.repoRoot, env: { ...process.env, ...options.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  }

  private ensureRuntimeImage(): void {
    const tag = this.phase === 1 ? PHASE1_RUNTIME_IMAGE_TAG : PHASE2_RUNTIME_IMAGE_TAG
    let inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
    if (this.phase === 1) {
      if (inspect.status !== 0) {
        docker(['pull', tag])
        inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
      }
    } else {
      // Always invoke the Phase 2 build so Docker validates the current
      // Dockerfile/provider pins. Layer caching keeps unchanged rebuilds cheap.
      // BuildKit provenance captures the whole context digest, including files
      // the image never copies, and therefore changes the manifest-list ID for
      // an otherwise identical workload image. Disable attestations here so
      // the exact image identity is a reproducible digest of the image itself.
      execFileSync('docker', [
        'build',
        '--pull=false',
        '--provenance=false',
        '--sbom=false',
        '-f',
        'docker/runtime/Dockerfile',
        '-t',
        tag,
        '.',
      ], { cwd: this.repoRoot, stdio: 'inherit' })
      inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
    }
    this.imageRef = inspect.stdout.trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(this.imageRef)) throw new Error(`runtime image is not pinned: ${this.imageRef}`)
  }

  private phase2BootstrapFiles(): string[] {
    if (this.task2FiniteFixtures) return []
    return phase2BootstrapFiles()
  }

  private phase2WorkspaceRoots(): string[] {
    if (this.task2FiniteFixtures) return [this.testRoot]
    const roots = new Set<string>([this.repoRoot, this.testRoot])
    try {
      const common = git(this.repoRoot, ['rev-parse', '--git-common-dir']).trim()
      roots.add(fs.realpathSync(path.isAbsolute(common) ? common : path.join(this.repoRoot, common)))
    } catch {}
    return [...roots]
  }

  private phase2ProviderUserRoots(): string[] {
    if (this.task2FiniteFixtures) return []
    const roots: string[] = []
    for (const relative of ['.claude', '.codex', '.config/opencode', '.amplifier']) {
      try {
        const root = fs.realpathSync(path.join(os.homedir(), relative))
        if (fs.statSync(root).isDirectory()) roots.push(root)
      } catch {}
    }
    return roots
  }

  private buildBinaries(): void {
    fs.mkdirSync(this.buildDir, { recursive: true })
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    execFileSync(mise, ['exec', 'rust@1.96', '--', 'cargo', 'build', '-p', 'freshell-supervisor', '-p', 'freshell-session-host', '--features', 'freshell-supervisor/runtime-test-faults,freshell-session-host/fresh-agent-fixtures'], { cwd: this.repoRoot, stdio: 'inherit' })
    this.testSupervisorBinary = path.join(this.buildDir, 'freshell-supervisor-test')
    this.testHostBinary = path.join(this.buildDir, 'freshell-session-host-test')
    fs.copyFileSync(path.join(this.repoRoot, 'target/debug/freshell-supervisor'), this.testSupervisorBinary)
    fs.copyFileSync(path.join(this.repoRoot, 'target/debug/freshell-session-host'), this.testHostBinary)
    fs.chmodSync(this.testSupervisorBinary, 0o755)
    fs.chmodSync(this.testHostBinary, 0o755)

    execFileSync(mise, ['exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-supervisor', '-p', 'freshell-session-host'], { cwd: this.repoRoot, stdio: 'inherit' })
    this.releaseSupervisorBinary = path.join(this.buildDir, 'freshell-supervisor-release')
    this.releaseHostBinary = path.join(this.buildDir, 'freshell-session-host-release')
    fs.copyFileSync(path.join(this.repoRoot, 'target/release/freshell-supervisor'), this.releaseSupervisorBinary)
    fs.copyFileSync(path.join(this.repoRoot, 'target/release/freshell-session-host'), this.releaseHostBinary)
    fs.chmodSync(this.releaseSupervisorBinary, 0o755)
    fs.chmodSync(this.releaseHostBinary, 0o755)
  }

  private collectCapabilities(): unknown {
    const info = JSON.parse(docker(['info', '--format', '{{json .}}']))
    return {
      docker: {
        serverVersion: info.ServerVersion,
        cgroupDriver: info.CgroupDriver,
        cgroupVersion: info.CgroupVersion,
        memoryLimit: info.MemoryLimit,
        swapLimit: info.SwapLimit,
        cpuCfsQuota: info.CpuCfsQuota,
        pidsLimit: info.PidsLimit,
        securityOptions: info.SecurityOptions,
      },
      realDockerSocket: dockerSocketPath(),
      brokerSocket: this.broker.proxySocketPath,
      runtimeImage: this.imageRef,
    }
  }

  private collectBuildInfo(): unknown {
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    const rustc = execFileSync(mise, ['exec', 'rust@1.96', '--', 'rustc', '--version'], { encoding: 'utf8' }).trim()
    return {
      candidateSha: this.candidateSha,
      runtimeImage: this.imageRef,
      rustc,
      node: process.version,
      docker: docker(['version', '--format', 'client={{.Client.Version}} server={{.Server.Version}}']).trim(),
      binaries: {
        testSupervisor: fileBuild(this.testSupervisorBinary),
        testHost: fileBuild(this.testHostBinary),
        releaseSupervisor: fileBuild(this.releaseSupervisorBinary),
        releaseHost: fileBuild(this.releaseHostBinary),
      },
    }
  }

  private collectScenarioLifecycleLogs(): void {
    const runtimeNamespace = path.join(this.testRoot, 'r')
    if (!fs.existsSync(runtimeNamespace)) return
    for (const scenario of fs.readdirSync(runtimeNamespace)) {
      const log = path.join(runtimeNamespace, scenario, 'evidence', 'lifecycle.jsonl')
      if (!fs.existsSync(log)) continue
      for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
        appendPrivateLine(this.lifecyclePath, { at: new Date().toISOString(), event: 'supervisor.lifecycle', data: { scenario, raw: JSON.parse(line) } })
      }
    }
  }
}

export function defaultLimits(): RuntimeLimits {
  return { cpuMilli: 500, memoryBytes: 128 * 1024 * 1024, swapBytes: 0, pidsMax: 64 }
}

export function newSoul(): string {
  return `soul-${randomUUID()}`
}

export function newRequest(): string {
  return `request-${randomUUID()}`
}

let dockerRootlessCache: boolean | undefined

function dockerIsRootless(): boolean {
  if (dockerRootlessCache !== undefined) return dockerRootlessCache
  try {
    const options = JSON.parse(docker(['info', '--format', '{{json .SecurityOptions}}'])) as string[]
    dockerRootlessCache = options.some((value) => /rootless/i.test(value))
  } catch {
    dockerRootlessCache = false
  }
  return dockerRootlessCache
}

export function dockerSocketPath(): string {
  const configured = process.env.DOCKER_HOST
  if (configured?.startsWith('unix://')) return configured.slice('unix://'.length)
  if (configured?.startsWith('unix:')) return configured.slice('unix:'.length)
  return path.join('/run/user', String(process.getuid?.() ?? 1000), 'docker.sock')
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/// Bound on one gate → supervisor control round trip.
///
/// A wedged supervisor must produce a FAIL with evidence, never an
/// indefinitely hanging gate: a run that never returns cannot be reviewed,
/// cannot clean up its own containers, and cannot be told apart from a slow
/// one. Generous by design — this catches deadlock, not slowness.
export const CONTROL_ROUND_TRIP_TIMEOUT_MS = Number(
  process.env.FRESHELL_RUNTIME_CONTROL_TIMEOUT_MS ?? 120_000,
)

function unixRoundTrip(
  socketPath: string,
  frame: Buffer,
  timeoutMs = CONTROL_ROUND_TRIP_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const chunks: Buffer[] = []
    let expected: number | undefined
    let done = false
    let timer: NodeJS.Timeout
    const fail = (error: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    timer = setTimeout(() => {
      fail(new Error(`control round trip exceeded ${timeoutMs}ms: ${socketPath}`))
    }, timeoutMs)
    // A pending timer must never keep the gate process alive on its own.
    timer.unref?.()
    socket.once('error', fail)
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      if (expected === undefined && bytes.length >= 4) expected = bytes.readUInt32BE(0)
      if (expected !== undefined && bytes.length >= expected + 4) {
        try {
          const parsed = JSON.parse(bytes.subarray(4, 4 + expected).toString('utf8'))
          done = true
          clearTimeout(timer)
          socket.destroy()
          resolve(parsed)
        } catch (error) { fail(error) }
      }
    })
    socket.once('close', () => {
      if (!done) fail(new Error(`control socket closed before a complete reply: ${socketPath}`))
    })
    socket.once('connect', () => socket.write(frame))
  })
}

function fileBuild(filePath: string): unknown {
  const bytes = fs.readFileSync(filePath)
  const stat = fs.statSync(filePath)
  return { path: filePath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: stat.size }
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120)
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

function writePrivateJson(filePath: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function appendPrivateLine(filePath: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
