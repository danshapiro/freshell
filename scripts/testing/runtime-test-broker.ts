import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { TASK007_BATCH_STORE_PROBE } from './runtime-sandbox.js'

const DOCKER_API_PREFIX = '/v1.47'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const INDEXED_TMPFS_OPTIONS = 'size=64m,mode=0700,uid=65534,gid=0,nr_inodes=1024,nosuid,nodev,noexec'
const CLAUDE_SOURCE_FLAVORS = new Set(['claude', 'kilroy'])

class PreparedInputTargetError extends Error {
  constructor(readonly targetPath: string, readonly preparationStageRoot: string) {
    super('prepared input target is outside selected fixture roots')
  }
}

export function diagnosticPath(value: string): string | undefined {
  return value.length <= 4096 && path.isAbsolute(value) && path.normalize(value) === value
    && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined
}

function indexedLabels(input: PreparedInputAuthorization): Record<string, string> {
  return {
    'com.freshell.managed-inputs': 'true',
    'com.freshell.installation-id': input.installationId,
    'com.freshell.soul-id': input.soulId,
    'com.freshell.incarnation-id': input.incarnationId,
    'com.freshell.input-generation': input.generationId,
  }
}

function equalRecord(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
  const record = actual as Record<string, unknown>
  return Object.keys(record).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => record[key] === value)
}

function ownedHelperLabels(actual:Record<string,unknown> | undefined,expected:Record<string,unknown>):boolean {
  return !!actual && Object.entries(expected).every(([key,value])=>actual[key]===value)
    && Object.entries(actual).filter(([key])=>key.startsWith('com.freshell.') || key.startsWith('freshell.') || key==='project')
      .every(([key,value])=>expected[key]===value)
}

function privateHelperEnvironment(value: unknown, home: boolean): boolean {
  if (!Array.isArray(value) || value.length > 128) return false
  const names = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') return false
    const separator = entry.indexOf('=')
    const name = entry.slice(0, separator)
    const contents = entry.slice(separator + 1)
    const expected = name === 'HOME' && home ? '/home/freshell/provider' : ''
    if (separator < 1 || !/^[a-zA-Z0-9_]{1,128}$/.test(name)
      || names.has(name) || contents !== expected) return false
    names.add(name)
  }
  return !home || names.has('HOME')
}

function mappedProviderDestination(value: string): boolean {
  const home = '/home/freshell/provider'
  if (!isStrictDescendant(value, home)) return false
  // Ordinary selected inputs cannot alias the provider's native stores.
  return !['.claude/projects', '.codex/sessions', '.amplifier/projects', '.local/share/opencode']
    .some(relative => value === `${home}/${relative}` || isStrictDescendant(value, `${home}/${relative}`))
}

function preparedMountsMatch(actual: unknown[], input: PreparedInputAuthorization): boolean {
  const expected: Record<string, unknown>[] = input.configurationBinds.map((bind) => ({
    Type: 'bind', Source: path.join(input.stageRoot, bind.sourceRelativePath), Target: bind.effectiveDestination, ReadOnly: true,
  }))
  expected.push(...input.resourceMounts.map((mount) => ({
    Type: 'volume', Source: input.providerVolumeName, Target: mount.effectiveDestination,
    ReadOnly: mount.kind === 'file' && mount.writable !== true,
    VolumeOptions: { NoCopy: true, Subpath: mount.providerRelativePath },
  })))
  if (input.indexedFiles) {
    expected.push(...input.indexedFiles.aliases.map((alias) => ({
      Type: 'volume', Source: input.indexedFiles!.volumeName, Target: alias.effectiveDestination, ReadOnly: true,
      VolumeOptions: { NoCopy: true, Subpath: `files/source-${alias.sourceId}` },
    })))
    expected.push(...input.indexedSecretSources.map((source) => ({
      Type: 'volume', Source: input.indexedFiles!.volumeName, Target: `/run/freshell-secrets/provider-${source.grantIndex}`, ReadOnly: true,
      VolumeOptions: { NoCopy: true, Subpath: `files/source-${source.sourceId}` },
    })))
  }
  if (actual.length !== expected.length) return false
  const remaining = new Map(expected.map((mount) => [mount.Target, mount]))
  for (const value of actual) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const mount = value as Record<string, any>
    const wanted = remaining.get(mount.Target)
    if (!wanted || Object.keys(mount).some((key) => !['Type','Source','Target','ReadOnly','VolumeOptions'].includes(key))
      || ['Type','Source','Target','ReadOnly'].some((key) => mount[key] !== wanted[key])) return false
    if (wanted.Type === 'volume') {
      const options = mount.VolumeOptions
      const wantedOptions = wanted.VolumeOptions as Record<string, unknown>
      if (!options || Object.keys(options).length !== 2 || options.NoCopy !== true || options.Subpath !== wantedOptions.Subpath) return false
    } else if (mount.VolumeOptions !== undefined) return false
    remaining.delete(mount.Target)
  }
  return remaining.size === 0
}

const CLEANUP_DRAIN_MS = 5_000

export type BrokerSettlementFailure = {
  method: string
  url: string
  reason: string
  allocationUnknown: boolean
}

export type BrokerReceipt = {
  containerId: string
  installationId?: string
  createdAt: string
  requestDigest: string
  incarnationId: string
  soulId: string
  imageRef: string
  runtimeDir: string
  providerVolumeName?: string
  workspacePath?: string
  hostBinaryPath?: string
}

export type BrokerEvent = {
  at: string
  severity: 'info' | 'warn'
  method: string
  url: string
  decision: 'forward' | 'block' | 'inject_failure'
  reason?: string
  containerId?: string
  ownerContainerId?: string
  helperName?: string
  requestDigest?: string
  providerVolumeName?: string
  targetPath?: string
  preparationStageRoot?: string
  selectedWorkspaceRoots?: string[]
  selectedProviderInputRoots?: string[]
  allocationUnknown?: boolean
  destructive: boolean
  unsafeAttempt: boolean
}

export type RestrictedDockerBrokerPolicy = {
  realSocketPath: string
  proxySocketPath: string
  runtimeRootPrefix: string
  allowedHostBinaryPaths: Set<string>
  allowedImageRefs: Set<string>
  allowTerminalWorkloads?: boolean
  allowTask2LegacyNegativeFixtures?: boolean
  allowedWorkspaceRoots?: Set<string>
  allowedProviderInputRoots?: Set<string>
  allowedProviderUserRoots?: Set<string>
  allowedBootstrapFiles?: Set<string>
  allowedHostGatewayAddresses?: Set<string>
  allowedOperatorHomeRoots?: Set<string>
  initialProviderVolumeLookup?: (volumeName: string) => InitialProviderVolumeAuthorization | undefined
  testRunId: string
  logPath: string
}

export type PreparedInputAuthorization = {
  installationId: string
  soulId: string
  incarnationId: string
  imageRef: string
  hostBinaryPath: string
  providerVolumeName: string
  stageRoot: string
  generationId: string
  configurationBinds: { sourceRelativePath: string; effectiveDestination: string }[]
  resourceMounts: { providerRelativePath: string; effectiveDestination: string; kind: 'file' | 'directory'; writable?: boolean }[]
  indexedFiles?: { volumeName: string; aliases: { sourceId: number; effectiveDestination: string }[] }
  indexedSecretSources: { grantIndex: number; sourceId: number }[]
}

export type InitialProviderVolumeAuthorization = {
  installationId:string
  soulId:string
  providerVolumeName:string
  imageRef:string
  hostBinaryPath:string
  binarySha256:string
  daemonId:string
}

/** Selected ordinary metadata for the fixed initial or retained Claude candidate. */
export type ClaudeCandidateAuthorization = InitialProviderVolumeAuthorization & {
  reservationId: string
  requestId: string
  generationId: string
  stageRoot: string
  workspacePath: string
  cwd: string
  gitCommonDir?: string
  manifestRelativePath: string
  configurationBinds: { sourceRelativePath: string; effectiveDestination: string }[]
  resourceMounts: { stageRelativePath: string; providerRelativePath: string; effectiveDestination: string; kind: 'file' | 'directory' }[]
  retained?: Pick<ClaudeCandidateAuthorization, 'generationId' | 'stageRoot' | 'configurationBinds' | 'resourceMounts'> & { attemptId: string }
}

function claudeGitCommonMounts(input: Pick<ClaudeCandidateAuthorization, 'workspacePath' | 'gitCommonDir'>): Record<string, any>[] {
  return input.gitCommonDir && input.gitCommonDir !== input.workspacePath && !isStrictDescendant(input.gitCommonDir, input.workspacePath)
    ? [{ Type: 'bind', Source: input.gitCommonDir, Target: input.gitCommonDir, ReadOnly: true }]
    : []
}

function candidateVolumeName(input: ClaudeCandidateAuthorization): string {
  return `freshell-claude-candidate-${input.requestId}`
}
function candidateLabels(input: ClaudeCandidateAuthorization, runId: string): Record<string, string> {
  return { 'com.freshell.installation-id': input.installationId, 'com.freshell.soul-id': input.soulId,
    'com.freshell.runtime-test-run-id': runId, 'com.freshell.source-request-id': input.requestId,
    'com.freshell.source-binary-sha256': input.binarySha256, 'com.freshell.input-generation': input.generationId,
    ...(input.retained ? { 'com.freshell.source-recovery-attempt-id': input.retained.attemptId } : { 'com.freshell.source-reservation-id': input.reservationId }), 'com.freshell.claude-candidate': 'ordinary' }
}

type DockerResponse = {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/** The short-lived helpers whose create can be held by a test. */
const DELAYABLE_HELPER_PREFIXES = ['freshell-claude-source-', 'freshell-claude-candidate-reader-', 'freshell-mountpoints-'] as const

export type HelperCreateDelay = { prefix: typeof DELAYABLE_HELPER_PREFIXES[number]; delayMs: number; count: number }

/**
 * Parse `FRESHELL_TEST_BROKER_DELAY_HELPER_CREATE` (`<prefix>:<delayMs>[:<count>]`,
 * e.g. `freshell-claude-source-:30000:1`): hold that many helper creates for
 * that long before forwarding them, as a Docker create stalled behind a
 * host-wide writeback is answered late.
 */
export function parseHelperCreateDelay(value: string | undefined): HelperCreateDelay | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const [prefix, delay, count = '1', ...rest] = value.trim().split(':')
  const delayMs = Number(delay), times = Number(count)
  if (rest.length > 0 || !DELAYABLE_HELPER_PREFIXES.includes(prefix as HelperCreateDelay['prefix'])
    || !Number.isInteger(delayMs) || delayMs < 1 || delayMs > 600_000
    || !Number.isInteger(times) || times < 1 || times > 100) {
    throw new Error(`invalid helper create delay ${JSON.stringify(value)}: expected <${DELAYABLE_HELPER_PREFIXES.join('|')}>:<delayMs>[:<count>]`)
  }
  return { prefix: prefix as HelperCreateDelay['prefix'], delayMs, count: times }
}

type TransportPhases = {
  socketAssignedMs: number | null; socketConnectMs: number | null; requestFinishedMs: number | null
  responseHeadersMs: number | null; responseEndMs: number | null
  reusedSocket: boolean; socketConnectingAtAssignment: boolean | null
}

export class RestrictedDockerBroker {
  private readonly claudeCandidates = new Map<string, ClaudeCandidateAuthorization>()
  private readonly candidateVolumes = new Set<string>()
  private readonly initialProviderVolumes = new Map<string,InitialProviderVolumeAuthorization>()
  private readonly initialReservations = new Map<string, { reservationId: string; incarnationId: string }>()
  private readonly preparedInputs = new Map<string, PreparedInputAuthorization>()
  private readonly inputVolumes = new Set<string>()
  private readonly inputPublishers = new Map<string, {
    input: PreparedInputAuthorization
    expected: Record<string, any>
    containerId?: string
  }>()
  private readonly task2LegacyNegativeInspectionOwners = new Map<string, string>()
  private readonly knownContainerIds = new Set<string>()
  private readonly receiptsById = new Map<string, BrokerReceipt>()
  private readonly historyHelpers = new Map<string, { owner: BrokerReceipt; containerId?: string; kind: 'history' | 'auth' | 'repair' }>()
  private readonly claudeSourceHelpers = new Map<string, { expected: Record<string, any>; containerId?: string }>()
  private readonly events: BrokerEvent[] = []
  private server?: http.Server
  private readonly pendingRequests = new Set<Promise<void>>()
  private readonly incomingRequests = new Set<IncomingMessage>()
  private readonly upstreamRequests = new Set<http.ClientRequest>()
  private readonly settlementFailures: BrokerSettlementFailure[] = []
  private draining = false
  private drainExpired = false
  private stopFailuresRemaining = 0
  private inputPublicationBeforeCreateFailure = false
  private readonly helperCreateDelays: HelperCreateDelay[] = []
  private readonly heldHelperCreates = new Set<() => void>()
  private transportSequence = 0

  constructor(private readonly policy: RestrictedDockerBrokerPolicy) {}

  authorizeClaudeCandidate(input: ClaudeCandidateAuthorization): void {
    this.registerClaudeCandidate(input)
  }

  private registerClaudeCandidate(input: ClaudeCandidateAuthorization, published = false): void {
    this.validateClaudeCandidateAuthorization(input, published)
    const key = candidateVolumeName(input), previous = this.claudeCandidates.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(input)) throw new Error('Claude candidate request changed')
    if (!previous && this.claudeCandidates.size >= 6) throw new Error('closed Claude fixture exceeds its two routes and two replans')
    this.claudeCandidates.set(key, structuredClone(input))
  }

  private validateClaudeCandidateAuthorization(input: ClaudeCandidateAuthorization, published = false): void {
    const initial = this.initialProviderVolumes.get(input.providerVolumeName)
    const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
    const fixture = path.dirname(this.policy.runtimeRootPrefix)
    const relative = path.relative(fixture, input.stageRoot)
    const destination = (value: string, publishedResource = false) => typeof value === 'string' && path.isAbsolute(value)
      && path.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value)
      && (value === input.workspacePath || isStrictDescendant(value, input.workspacePath)
        || mappedProviderDestination(value)
        || this.isAllowedProviderInputPath(value)
        // The owned controller publication already selected and froze ordinary
        // ancestor policy files and their imports. These are exact container
        // destinations; their sources remain generation-owned stage units.
        || (publishedResource && !value.startsWith('/home/freshell/provider/'))
        || [...this.policy.allowedProviderUserRoots ?? []].some((root) => value === root || isStrictDescendant(value, root)))
    const unit = (value: string, prefix: string, file = false) => typeof value === 'string'
      && new RegExp(`^${prefix}/[a-zA-Z0-9_-]{1,128}${file ? '/source' : ''}$`).test(value)
    if (!initial || !['installationId','soulId','imageRef','hostBinaryPath','binarySha256','daemonId'].every((key) => input[key as keyof InitialProviderVolumeAuthorization] === initial[key as keyof InitialProviderVolumeAuthorization])
      || !uuid(input.requestId) || !uuid(input.reservationId) || !input.generationId.startsWith('grant-') || !uuid(input.generationId.slice(6))
      || relative !== `scenarios/${relative.split('/')[1]}/control/provider-roots/${input.generationId}`
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(relative.split('/')[1] ?? '')
      || !this.isAllowedWorkspacePath(input.workspacePath) || !destination(input.cwd)
      || !(input.cwd === input.workspacePath || isStrictDescendant(input.cwd, input.workspacePath))
      || (input.gitCommonDir !== undefined && (!path.isAbsolute(input.gitCommonDir) || path.normalize(input.gitCommonDir) !== input.gitCommonDir
        || /[\x00-\x1f\x7f]/.test(input.gitCommonDir) || !(input.gitCommonDir === input.workspacePath || isStrictDescendant(input.gitCommonDir, input.workspacePath)
          || isStrictDescendant(input.gitCommonDir, fixture) || this.policy.allowedWorkspaceRoots?.has(input.gitCommonDir))))
      || input.manifestRelativePath !== '.freshell/input-manifest.json'
      || !Array.isArray(input.configurationBinds) || !Array.isArray(input.resourceMounts)
      || Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new Error('initial Claude candidate is outside this fixture request')
    if (input.retained && (typeof input.retained.attemptId !== 'string' || !input.retained.attemptId.startsWith('recovery-') || !uuid(input.retained.attemptId.slice(9))
      || typeof input.retained.generationId !== 'string' || !input.retained.generationId.startsWith('grant-') || !uuid(input.retained.generationId.slice(6))
      || input.retained.generationId === input.generationId || input.retained.stageRoot !== path.join(path.dirname(input.stageRoot),input.retained.generationId)
      || !Array.isArray(input.retained.configurationBinds) || !Array.isArray(input.retained.resourceMounts))) throw new Error('retained Claude candidate is outside its frozen generation')
    for (const profile of [input,...(input.retained ? [input.retained] : [])]) {
      const targets = new Set<string>()
      // Retained logical origins are metadata only: the helper receives their
      // frozen stage files, rather than mounts at those original destinations.
      const claim = (value: string, publishedResource = false) => {
        const valid = profile === input ? destination(value, publishedResource) : typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value)
        if (!valid || targets.has(value)) throw new Error('Claude candidate selected target is invalid')
        targets.add(value)
      }
      for (const bind of profile.configurationBinds) {
        if (!unit(bind.sourceRelativePath, '\\.freshell/templates')) throw new Error('Claude candidate template source is invalid')
        claim(bind.effectiveDestination)
      }
      for (const mount of profile.resourceMounts) {
        if (!['file','directory'].includes(mount.kind)
          || !unit(mount.stageRelativePath, '\\.freshell/resource-units', mount.kind === 'file')
          || !unit(mount.providerRelativePath, '\\.freshell/provider-roots', mount.kind === 'file')) throw new Error('Claude candidate resource source is invalid')
        claim(mount.effectiveDestination, published)
      }
    }
  }



  authorizeInitialProviderVolume(input:InitialProviderVolumeAuthorization):void {
    const stable=`freshell-provider-${createHash('sha256').update(`${input.installationId}\0${input.soulId}`).digest('hex').slice(0,24)}`
    if (input.providerVolumeName!==stable || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.installationId)
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.soulId) || !/^[a-f0-9]{64}$/.test(input.binarySha256)
      || !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.daemonId)
      || !this.policy.allowedHostBinaryPaths.has(input.hostBinaryPath) || !this.policy.allowedImageRefs.has(input.imageRef)) {
      throw new Error('initial provider source is outside this fixture run')
    }
    const previous=this.initialProviderVolumes.get(stable)
    if (previous && !equalRecord(input,previous)) throw new Error('initial provider source ownership changed')
    this.initialProviderVolumes.set(stable,{...input})
  }

  initialProviderVolumeCreations(): InitialProviderVolumeAuthorization[] {
    return [...this.initialReservations.keys()].flatMap(name => {
      const owner = this.initialProviderVolumes.get(name)
      return owner ? [{ ...owner }] : []
    })
  }

  authorizePreparedInputs(input: PreparedInputAuthorization): void {
    const safeId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    const relative = path.relative(path.dirname(this.policy.runtimeRootPrefix), input.stageRoot)
    if (!safeId(input.installationId) || !safeId(input.soulId) || !safeId(input.incarnationId)
      || !/^grant-[a-zA-Z0-9-]{1,122}$/.test(input.generationId)
      || !new RegExp(`^scenarios/[^/]+/control/provider-roots/${input.generationId}$`).test(relative)
      || !this.policy.allowedHostBinaryPaths.has(input.hostBinaryPath)
      || !this.policy.allowedImageRefs.has(input.imageRef)
      || !/^freshell-provider-[a-f0-9]{24}$/.test(input.providerVolumeName)) {
      throw new Error('prepared input owner/stage is outside this fixture run')
    }
    if (Buffer.byteLength(JSON.stringify(input)) >= 1024 * 1024) throw new Error('prepared input metadata exceeds control profile')
    const unit = (value: string, prefix: string) => value.startsWith(prefix)
      && /^[a-zA-Z0-9_-]{1,128}$/.test(value.slice(prefix.length))
    const candidate = [...this.claudeCandidates.values()].find(candidate =>
      ['installationId', 'soulId', 'imageRef', 'hostBinaryPath', 'providerVolumeName', 'stageRoot', 'generationId']
        .every(key => candidate[key as keyof ClaudeCandidateAuthorization] === input[key as keyof PreparedInputAuthorization]))
    const destination = (value: string, selected = false) => path.isAbsolute(value) && path.normalize(value) === value
      && !/[\x00-\x1f\x7f]/.test(value)
      && (this.isAllowedWorkspacePath(value)
        || this.isAllowedProviderInputPath(value)
        || mappedProviderDestination(value)
        || selected
        || [...this.policy.allowedProviderUserRoots ?? []].some((root) => value === root || isStrictDescendant(value, root)))
    const targets = new Set<string>()
    const claim = (value: string, selected = false) => {
      if (!destination(value, selected)) throw new PreparedInputTargetError(value, input.stageRoot)
      if (targets.has(value)) throw new Error('prepared input target is duplicated')
      targets.add(value)
    }
    for (const bind of input.configurationBinds) {
      if (!unit(bind.sourceRelativePath, '.freshell/templates/')) throw new Error('prepared template source is invalid')
      claim(bind.effectiveDestination, candidate?.configurationBinds.some(selected => selected.sourceRelativePath === bind.sourceRelativePath
        && selected.effectiveDestination === bind.effectiveDestination))
    }
    for (const mount of input.resourceMounts) {
      const relative=mount.kind==='file' && mount.providerRelativePath.endsWith('/source') ? mount.providerRelativePath.slice(0,-'/source'.length) : mount.providerRelativePath;
      if (!unit(relative, '.freshell/provider-roots/') || (mount.kind==='file' && !mount.providerRelativePath.endsWith('/source'))
        || !['file', 'directory'].includes(mount.kind)
        || (mount.writable !== undefined && typeof mount.writable !== 'boolean')
        || (mount.kind !== 'file' && mount.writable === true)) throw new Error('prepared resource source is invalid')
      claim(mount.effectiveDestination, mount.writable !== true && candidate?.resourceMounts.some(selected => selected.providerRelativePath === mount.providerRelativePath
        && selected.kind === mount.kind && selected.effectiveDestination === mount.effectiveDestination))
    }
    if (input.indexedFiles) {
      const expected = `freshell-inputs-${createHash('sha256').update(`${input.soulId}\0${input.generationId}`).digest('hex').slice(0,24)}`
      if (input.indexedFiles.volumeName !== expected || input.indexedFiles.aliases.length > 256 || input.indexedSecretSources.length > 128) throw new Error('prepared indexed volume identity/profile is invalid')
      for (const alias of input.indexedFiles.aliases) {
        if (!Number.isInteger(alias.sourceId) || alias.sourceId < 0 || alias.sourceId >= 128) throw new Error('prepared indexed source id is invalid')
        claim(alias.effectiveDestination)
      }
    } else if (input.indexedSecretSources.length) throw new Error('prepared private source has no indexed volume')
    const indexes = new Set<number>()
    for (const index of input.indexedSecretSources) {
      if (!Number.isInteger(index.grantIndex) || index.grantIndex < 0 || index.grantIndex >= 132
        || !Number.isInteger(index.sourceId) || index.sourceId < 0 || index.sourceId >= 128 || indexes.has(index.grantIndex)) throw new Error('prepared private input index is invalid')
      indexes.add(index.grantIndex)
    }
    const key = `${input.installationId}\0${input.soulId}\0${input.incarnationId}\0${input.generationId}`
    const previous = this.preparedInputs.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(input)) throw new Error('prepared input generation changed; reconcile before replacement')
    this.preparedInputs.set(key, structuredClone(input))
  }

  get proxySocketPath(): string {
    return this.policy.proxySocketPath
  }

  receipts(): BrokerReceipt[] {
    return [...this.receiptsById.values()]
  }

  receiptIds(): Set<string> {
    return new Set([...this.knownContainerIds, ...[...this.historyHelpers.values(),...this.inputPublishers.values(),...this.claudeSourceHelpers.values()].flatMap((helper) => helper.containerId ? [helper.containerId] : [])])
  }

  /** Every Claude candidate scratch volume this proxy forwarded a create
    * for (a lost acknowledgement included). Its proxied DELETE keeps the
    * exact ownership check, so cleanup can remove what a supervisor left. */
  candidateVolumeNames(): string[] {
    return [...this.candidateVolumes]
  }
  historyHelperNames(): string[] { return [...this.historyHelpers.keys(), ...this.inputPublishers.keys(), ...this.claudeSourceHelpers.keys()] }

  eventsSnapshot(): BrokerEvent[] {
    return [...this.events]
  }

  unsafeAttempts(): BrokerEvent[] {
    return this.events.filter((event) => event.unsafeAttempt)
  }

  destructiveRequestsFor(containerId: string): BrokerEvent[] {
    return this.events.filter((event) => event.destructive && event.containerId === containerId)
  }

  failNextInputPublicationBeforeCreate(): void { this.inputPublicationBeforeCreateFailure = true }

  // Test-only inspector admission; these IDs confer no runtime mutation rights
  // and deliberately never join receiptIds()/receipts()/knownContainerIds.
  admitTask2LegacyNegativeInspection(inspected: Record<string, any>, original: Record<string, any>): void {
    const ownerId = original.Id
    const owner = this.receiptsById.get(ownerId), id = inspected.Id
    const labels = inspected.Config?.Labels ?? {}
    const originalLabels = original.Config?.Labels ?? {}
    if (!this.policy.allowTask2LegacyNegativeFixtures || !owner || !/^[a-f0-9]{64}$/.test(id)
      || this.knownContainerIds.has(id) || this.task2LegacyNegativeInspectionOwners.has(id)
      || inspected.Image !== owner.imageRef || inspected.State?.Status !== 'created'
      || inspected.State?.Running !== false || inspected.State?.Pid !== 0
      || labels['com.freshell.runtime-test-run-id'] !== this.policy.testRunId
      || labels['com.freshell.managed'] !== 'true' || labels.project !== 'freshell'
      || labels['com.freshell.soul-id'] !== owner.soulId
      || labels['com.freshell.incarnation-id'] !== owner.incarnationId
      || original.Image !== owner.imageRef
      || originalLabels['com.freshell.soul-id'] !== owner.soulId
      || originalLabels['com.freshell.incarnation-id'] !== owner.incarnationId
      || originalLabels['com.freshell.runtime-test-run-id'] !== this.policy.testRunId
      || !originalLabels['com.freshell.installation-id']
      || labels['com.freshell.installation-id'] !== originalLabels['com.freshell.installation-id']
      || !['extra_mount', 'missing_tmpfs', 'missing_binary', 'foreign_binary'].includes(labels['com.freshell.task2-negative']))
      throw new Error('exact never-started Task2 negative inspector fixture required')
    this.task2LegacyNegativeInspectionOwners.set(id, ownerId)
  }

  forgetTask2LegacyNegativeInspection(containerId: string): void {
    this.task2LegacyNegativeInspectionOwners.delete(containerId)
  }
  failNextStop(count = 1): void {
    this.stopFailuresRemaining = Math.max(0, count)
  }

  /** Hold the next `count` creates of helpers named `prefix*` for `delayMs`
    * before forwarding them, so Docker makes each helper after its caller's
    * deadline, as a create stalled behind a host-wide writeback does. */
  delayHelperCreates(delay: HelperCreateDelay): void {
    this.helperCreateDelays.push({ ...delay })
  }

  private async holdHelperCreate(method: string, url: string, name: string): Promise<void> {
    const delay = this.helperCreateDelays.find(candidate => candidate.count > 0 && name.startsWith(candidate.prefix))
    if (!delay) return
    delay.count -= 1
    this.record({ method, url, decision: 'inject_failure', reason: `configured slow helper create (${delay.delayMs}ms)`,
      destructive: false, unsafeAttempt: false, helperName: name })
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer)
        this.heldHelperCreates.delete(cancel)
        this.settlementFailures.push({ method, url, reason: 'cleanup_deadline_before_forward', allocationUnknown: false })
        reject(new Error('cleanup_deadline_before_forward'))
      }
      const timer = setTimeout(() => {
        this.heldHelperCreates.delete(cancel)
        resolve()
      }, delay.delayMs)
      this.heldHelperCreates.add(cancel)
      if (this.drainExpired) cancel()
    })
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.policy.proxySocketPath), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(this.policy.logPath), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(this.policy.logPath), 0o700)
    fs.rmSync(this.policy.proxySocketPath, { force: true })
    this.server = http.createServer((request, response) => {
      const cleanupVolume = request.url?.match(/^\/v1\.47\/volumes\/(freshell-inputs-[a-f0-9]{24})$/)?.[1]
      const cleanupCandidate = request.url?.match(/^\/v1\.47\/volumes\/(freshell-claude-candidate-[a-f0-9-]{36})$/)?.[1]
      const ownedCleanup = (cleanupVolume && [...this.preparedInputs.values()].some(input => input.indexedFiles?.volumeName === cleanupVolume)
        && (request.method === 'GET' || (request.method === 'DELETE' && this.inputVolumes.has(cleanupVolume))))
        || (cleanupCandidate && this.claudeCandidates.has(cleanupCandidate) && this.candidateVolumes.has(cleanupCandidate)
          && (request.method === 'GET' || request.method === 'DELETE'))
      if (this.draining && !ownedCleanup) {
        response.writeHead(503, { connection: 'close' })
        response.end('owner cleanup in progress')
        request.resume()
        return
      }
      this.incomingRequests.add(request)
      const settlement = this.handle(request, response).catch(() => {
        try {
          this.record({
            method: request.method ?? 'GET', url: request.url ?? '/',
            decision: 'block', reason: 'owner_request_failed', destructive: false, unsafeAttempt: false,
          })
        } catch {
          process.stderr.write(`${JSON.stringify({
            severity: 'error', event: 'runtime.broker.request_failure_logging_failed', runId: this.policy.testRunId,
          })}\n`)
        } finally {
          response.destroy()
        }
      })
      this.pendingRequests.add(settlement)
      const forget = () => {
        this.pendingRequests.delete(settlement)
        this.incomingRequests.delete(request)
      }
      settlement.then(forget, forget)
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.policy.proxySocketPath, () => resolve())
    })
    fs.chmodSync(this.policy.proxySocketPath, 0o600)
  }

  /** Wait until every request this proxy accepted has its Docker answer
    * recorded, at most `timeoutMs`. A helper create Docker answers after the
    * supervisor stopped waiting, or after the supervisor container was
    * removed, still makes the helper; once settled, receiptIds() names it.
    * False when requests are still unanswered at the deadline. */
  async settleForwarded(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.pendingRequests.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled([...this.pendingRequests]),
        new Promise(resolve => { timer = setTimeout(resolve, remaining) }),
      ])
      clearTimeout(timer)
    }
    return true
  }

  async close(): Promise<void> {
    if (!this.server) return
    const closed = new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server.closeAllConnections()
    await closed
    this.server = undefined
    fs.rmSync(this.policy.proxySocketPath, { force: true })
  }

  /** The owner first stops its exact producers/enclosures, keeping this broker
   * available until their already-forwarded operations publish their receipts. */
  async awaitPendingRequests(): Promise<BrokerSettlementFailure[]> {
    this.draining = true
    // Only shutdown has a deadline. A healthy helper wait may legitimately run
    // for the full scenario. Expiry destroys and joins our actual transports;
    // it cannot establish whether an unacknowledged daemon create allocated.
    const deadline = setTimeout(() => {
      this.drainExpired = true
      // Injected delays have no upstream socket yet. Settle their handlers
      // without forwarding a new CREATE after the owner has finished cleanup.
      for (const cancel of this.heldHelperCreates) cancel()
      for (const request of this.upstreamRequests) request.destroy(new Error('cleanup_deadline'))
      for (const request of this.incomingRequests) request.destroy()
    }, CLEANUP_DRAIN_MS)
    try {
      while (this.pendingRequests.size) await Promise.all([...this.pendingRequests])
      return [...this.settlementFailures]
    } finally {
      clearTimeout(deadline)
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const url = request.url ?? '/'
    let body: Buffer
    try {
      body = await readBoundedBody(request)
    } catch (error) {
      this.block(response, method, url, 413, String(error), false, undefined)
      return
    }

    const target = parseContainerTarget(url)
    const destructive = isDestructiveDockerRequest(method, target?.action)

    if (method === 'POST' && (url === `${DOCKER_API_PREFIX}/volumes/create`
      || url.startsWith(`${DOCKER_API_PREFIX}/containers/create?`))) {
      await this.registerPublishedFixtureInputs(body, url)
    }

    if (method === 'GET' && url === '/_ping') {
      await this.forwardAndReply(request, response, body, { destructive: false })
      return
    }
    if (method === 'GET' && url === `${DOCKER_API_PREFIX}/info`) {
      await this.forwardAndReply(request, response, body, { destructive: false })
      return
    }
    if (method==='GET' && [...this.policy.allowedImageRefs].some((image)=>url===`${DOCKER_API_PREFIX}/images/${image}/json`)) {
      await this.forwardAndReply(request,response,body,{destructive:false})
      return
    }

    // Cold publisher inspection is confined to one accepted generation or
    // one installation/soul's indexed labels. Never expose an unfiltered list.
    if (method === 'GET' && body.length === 0) {
      const parsed = new URL(url, 'http://docker')
      let filters: Record<string, unknown> = {}
      try { const value = JSON.parse(parsed.searchParams.get('filters') ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) filters = value } catch {}
      const keys = [...parsed.searchParams.keys()]
      const users = parsed.pathname === `${DOCKER_API_PREFIX}/containers/json`
        && keys.length === 2 && parsed.searchParams.getAll('filters').length === 1 && parsed.searchParams.getAll('all').length === 1 && parsed.searchParams.get('all') === '1'
        && Object.keys(filters).length === 1 && Array.isArray(filters.volume) && filters.volume.length === 1
        && [...this.preparedInputs.values()].some(input => input.indexedFiles?.volumeName === (filters.volume as unknown[])[0])
      const inventory = parsed.pathname === `${DOCKER_API_PREFIX}/volumes`
        && keys.length === 1 && parsed.searchParams.getAll('filters').length === 1 && Object.keys(filters).length === 1
        && Array.isArray(filters.label) && filters.label.length === 3 && filters.label.every(value => typeof value === 'string')
        && [...this.preparedInputs.values()].some(input => JSON.stringify([...filters.label as string[]].sort()) === JSON.stringify([
          'com.freshell.managed-inputs=true', `com.freshell.installation-id=${input.installationId}`, `com.freshell.soul-id=${input.soulId}`,
        ].sort()))
      if (users || inventory) { await this.forwardAndReply(request,response,body,{destructive:false}); return }
    }
    const retiring = url.match(/^\/v1\.47\/containers\/([a-f0-9]{64})\?force=0$/)?.[1]
    const prior = retiring && this.receiptsById.get(retiring)
    if (method === 'DELETE' && prior && body.length === 0) {
      const inspected = await this.forward({ method:'GET',url:`${DOCKER_API_PREFIX}/containers/${retiring}/json`,headers:{} } as IncomingMessage,Buffer.alloc(0))
      let actual: Record<string,any> = {};try {actual=JSON.parse(inspected.body.toString())} catch {}
      const labels = {project:'freshell','com.freshell.managed':'true','com.freshell.installation-id':prior.installationId,
        'com.freshell.soul-id':prior.soulId,'com.freshell.incarnation-id':prior.incarnationId,'com.freshell.runtime-test-run-id':this.policy.testRunId}
      if (inspected.statusCode !== 404 && (inspected.statusCode !== 200 || actual.Id !== retiring || actual.Config?.Image !== prior.imageRef
        || !ownedHelperLabels(actual.Config?.Labels,labels) || actual.State?.Running !== false || actual.State?.Paused === true
        || actual.State?.Restarting === true || !['created','exited','dead'].includes(actual.State?.Status))) {
        this.block(response,method,url,403,'prior indexed generation workload is live or ownership changed',true);return
      }
      await this.forwardAndReply(request,response,body,{destructive:true,containerId:retiring});return
    }

    const volume = url.match(/^\/v1\.47\/volumes\/(freshell-provider-[a-f0-9]{24})$/)?.[1]
    if (method === 'GET' && volume && !this.initialProviderVolumes.has(volume)
      && this.policy.initialProviderVolumeLookup) {
      try {
        const owner = this.policy.initialProviderVolumeLookup(volume)
        if (owner) {
          if (owner.providerVolumeName !== volume) throw new Error('published initial provider volume differs')
          this.authorizeInitialProviderVolume(owner)
        }
      } catch {
        this.block(response, method, url, 403, 'owned initial provider preparation lookup failed', false)
        return
      }
    }
    if (method === 'GET' && volume && (this.initialProviderVolumes.has(volume)
      || this.receipts().some((receipt) => receipt.providerVolumeName === volume))) {
      await this.forwardAndReply(request, response, body, { destructive: false })
      return
    }
    const candidateVolume = url.match(/^\/v1\.47\/volumes\/(freshell-claude-candidate-[a-f0-9-]{36})$/)?.[1]
    const candidate = candidateVolume && this.claudeCandidates.get(candidateVolume)
    if (method === 'GET' && candidate) {
      await this.forwardAndReply(request, response, body, { destructive: false })
      return
    }
    if (method === 'GET' && candidateVolume && !candidate
      && /^freshell-claude-candidate-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(candidateVolume)) {
      const rejection = this.claudePublicationRejection(candidateVolume.slice('freshell-claude-candidate-'.length))
      if (rejection) {
        this.block(response, method, url, 403, `candidate absence qualification unavailable at ${rejection}`, false)
        return
      }
      const inspected = await this.forward(request, body)
      if (inspected.statusCode !== 404) {
        this.block(response, method, url, 403, 'unregistered candidate probe may expose only actual absence', false)
        return
      }
      // Absence is read-only evidence. Register no candidate or mutation owner;
      // the later exact POST still requires the complete publication handoff.
      this.record({ method, url, decision: 'forward', destructive: false, unsafeAttempt: false })
      replyDocker(response, inspected)
      return
    }
    if (method === 'DELETE' && candidate && this.candidateVolumes.has(candidateVolume!)) {
      const inspected = await this.forward({ method: 'GET', url, headers: {} } as IncomingMessage, Buffer.alloc(0))
      let actual: Record<string, any> = {}
      try { actual = JSON.parse(inspected.body.toString()) } catch {}
      if (inspected.statusCode !== 404 && (inspected.statusCode !== 200 || actual.Name !== candidateVolume || actual.Driver !== 'local'
        || (actual.Options != null && !equalRecord(actual.Options, {})) || !equalRecord(actual.Labels, candidateLabels(candidate, this.policy.testRunId)))) {
        this.block(response, method, url, 403, 'Claude candidate ordinary disk ownership changed', true)
        return
      }
      await this.forwardAndReply(request, response, body, { destructive: true })
      return
    }
    const indexedVolume=url.match(/^\/v1\.47\/volumes\/(freshell-inputs-[a-f0-9]{24})$/)?.[1]
    const input=indexedVolume && [...this.preparedInputs.values()].find((candidate)=>candidate.indexedFiles?.volumeName===indexedVolume)
    if (method==='GET' && input) {
      await this.forwardAndReply(request,response,body,{destructive:false})
      return
    }
    if (method==='DELETE' && input && this.inputVolumes.has(indexedVolume!)) {
      const inspected=await this.forward({method:'GET',url:`${DOCKER_API_PREFIX}/volumes/${indexedVolume}`,headers:{}} as IncomingMessage,Buffer.alloc(0))
      let metadata:Record<string,unknown>={}
      try {metadata=JSON.parse(inspected.body.toString())} catch {}
      if (inspected.statusCode!==404 && (metadata.Name!==indexedVolume || metadata.Driver!=='local'
        || !equalRecord(metadata.Labels,indexedLabels(input)) || !equalRecord(metadata.Options,{type:'tmpfs',device:'tmpfs',o:INDEXED_TMPFS_OPTIONS}))) {
        this.block(response,method,url,403,'indexed volume ownership changed',true)
        return
      }
      await this.forwardAndReply(request,response,body,{destructive:true})
      return
    }
    if (method==='POST' && url===`${DOCKER_API_PREFIX}/volumes/create`) {
      let parsed:Record<string,any>={}
      try {parsed=JSON.parse(body.toString())} catch {}
      const candidate = this.claudeCandidates.get(parsed.Name)
      if (candidate) {
        if (Object.keys(parsed).length !== 4 || parsed.Driver !== 'local' || !equalRecord(parsed.DriverOpts, {})
          || !equalRecord(parsed.Labels, candidateLabels(candidate, this.policy.testRunId))) {
          this.block(response, method, url, 403, 'Claude candidate requires its exact ordinary disk backing', true)
          return
        }
        this.candidateVolumes.add(parsed.Name) // Retain exact ownership on a lost acknowledgement.
        await this.forwardAndReply(request, response, body, { destructive: false })
        return
      }
      const initial=this.initialProviderVolumes.get(parsed.Name)
      if (initial) {
        const labels=parsed.Labels ?? {}
        const expected={
          'com.freshell.installation-id':initial.installationId,'com.freshell.soul-id':initial.soulId,
          'freshell.input.reservation':labels['freshell.input.reservation'],
          'freshell.input.incarnation':labels['freshell.input.incarnation'],'freshell.input.intent':'1',
          'freshell.input.daemon':initial.daemonId,'freshell.input.image':initial.imageRef,
          'freshell.input.binary-sha256':initial.binarySha256,
        }
        if (Object.keys(parsed).length!==3 || parsed.Driver!=='local' || !equalRecord(labels,expected)
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(labels['freshell.input.reservation'])
          || !/^[a-zA-Z0-9_-]{1,128}$/.test(labels['freshell.input.incarnation'])) {
          this.block(response,method,url,403,'initial volume must match the exact reserved soul source',true)
          return
        }
        this.initialReservations.set(initial.providerVolumeName, {
          reservationId: labels['freshell.input.reservation'], incarnationId: labels['freshell.input.incarnation'],
        })
        await this.forwardAndReply(request,response,body,{destructive:false})
        return
      }
      const input=[...this.preparedInputs.values()].find((candidate)=>candidate.indexedFiles?.volumeName===parsed.Name)
      if (!input || Object.keys(parsed).length!==4 || parsed.Driver!=='local'
        || !equalRecord(parsed.DriverOpts,{type:'tmpfs',device:'tmpfs',o:INDEXED_TMPFS_OPTIONS}) || !equalRecord(parsed.Labels,indexedLabels(input))) {
        this.block(response,method,url,403,'indexed volume must match an owned bounded preparation',true)
        return
      }
      this.inputVolumes.add(parsed.Name)
      await this.forwardAndReply(request,response,body,{destructive:false})
      return
    }

    const helperTarget = url.match(/^\/v1\.47\/containers\/([^/?]+)(?:\/(start|wait|logs|json))?(?:\?.*)?$/)
    const sourceEntry = helperTarget && [...this.claudeSourceHelpers].find(([name, helper]) => (
      helperTarget[1] === name || helperTarget[1] === helper.containerId
    ))
    if (sourceEntry) {
      const [name, helper] = sourceEntry
      const targetName = helperTarget![1]
      const exactId = targetName === helper.containerId
      const deleting = method === 'DELETE' && url === `${DOCKER_API_PREFIX}/containers/${targetName}?force=1`
      if (method === 'GET' && url === `${DOCKER_API_PREFIX}/containers/${targetName}/json`) {
        const inspected = await this.forward(request, body)
        let actual: Record<string, any> = {}
        try { actual = JSON.parse(inspected.body.toString()) } catch {}
        // A successful create may lose its acknowledgement. Adopt only the full
        // identity returned by the exact reserved name and fixed owned profile.
        if (!helper.containerId && targetName === name && inspected.statusCode === 200
          && typeof actual.Id === 'string' && /^[a-f0-9]{64}$/.test(actual.Id)
          && !this.receiptIds().has(actual.Id) && this.ownedClaudeSourceHelper(actual, helper.expected)) {
          helper.containerId = actual.Id
        }
        this.record({ method, url, decision: 'forward', destructive: false, unsafeAttempt: false,
          containerId: helper.containerId, helperName: name })
        replyDocker(response, inspected)
        return
      }
      if (deleting) {
        const inspected = await this.forward({ method: 'GET', url: `${DOCKER_API_PREFIX}/containers/${targetName}/json`, headers: {} } as IncomingMessage, Buffer.alloc(0))
        let actual: Record<string, any> = {}
        try { actual = JSON.parse(inspected.body.toString()) } catch {}
        if (inspected.statusCode !== 404 && (inspected.statusCode !== 200 || !this.ownedClaudeSourceHelper(actual, helper.expected))) {
          this.block(response, method, url, 403, 'Claude source helper cleanup ownership changed', true)
          return
        }
      }
      if (deleting
        || (method === 'POST' && exactId && [
          `${DOCKER_API_PREFIX}/containers/${targetName}/start`,
          `${DOCKER_API_PREFIX}/containers/${targetName}/wait?condition=not-running`,
        ].includes(url))) {
        await this.forwardAndReply(request, response, body, { destructive: true, containerId: helper.containerId, helperName: name })
        return
      }
    }
    const publisher=helperTarget && [...this.inputPublishers].find(([name,publisher])=>helperTarget[1]===name || helperTarget[1]===publisher.containerId)
    if (publisher) {
      const [name,owned]=publisher
      const exactId=helperTarget![1]===owned.containerId
      if (method==='DELETE' && !exactId) {
        const inspected=await this.forward({method:'GET',url:`${DOCKER_API_PREFIX}/containers/${name}/json`,headers:{}} as IncomingMessage,Buffer.alloc(0))
        let actual:Record<string,any>={}
        try {actual=JSON.parse(inspected.body.toString())} catch {}
        const environment=(entries:unknown)=>Array.isArray(entries)?JSON.stringify([...entries].sort()):undefined
        const ownedConfig=inspected.statusCode===404 || (inspected.statusCode===200 && ['Image','User','Tty'].every((key)=>actual.Config?.[key]===owned.expected[key])
          && ['Entrypoint','Cmd'].every((key)=>JSON.stringify(actual.Config?.[key])===JSON.stringify(owned.expected[key]))
          && ownedHelperLabels(actual.Config?.Labels,owned.expected.Labels)
          && environment(actual.Config?.Env)===environment(owned.expected.Env)
          && Array.isArray(actual.HostConfig?.Mounts) && actual.HostConfig.Mounts.length===3
          && owned.expected.HostConfig.Mounts.every((expected:Record<string,any>)=>actual.HostConfig.Mounts.some((mount:Record<string,any>)=>
            ['Type','Source','Target'].every((key)=>mount[key]===expected[key])
            && (mount.ReadOnly ?? false)===(expected.ReadOnly ?? false)
            && (expected.Type!=='volume' || (mount.VolumeOptions?.NoCopy===true && (mount.VolumeOptions.Subpath ?? '')==='' && !mount.VolumeOptions.DriverConfig))))
          && actual.HostConfig?.LogConfig?.Type==='none')
        if (!ownedConfig) {
          this.block(response,method,url,403,'indexed publisher named cleanup ownership changed',true)
          return
        }
      }
      if ((method==='GET' && url===`${DOCKER_API_PREFIX}/containers/${helperTarget![1]}/json`)
        || (method==='POST' && exactId && url===`${DOCKER_API_PREFIX}/containers/${owned.containerId}/start`)
        || (method==='POST' && exactId && owned.expected.Cmd?.[0]==='prepare-provider-mountpoints'
          && url===`${DOCKER_API_PREFIX}/containers/${owned.containerId}/wait?condition=not-running`)
        || (method==='DELETE' && url===`${DOCKER_API_PREFIX}/containers/${helperTarget![1]}?force=1`)) {
        const forwarded=await this.forward(request,body)
        this.record({method,url,decision:'forward',destructive:method!=='GET',unsafeAttempt:false,containerId:owned.containerId,helperName:name})
        replyDocker(response,forwarded)
        return
      }
    }
    const helperEntry = helperTarget && [...this.historyHelpers].find(([name, helper]) => (
      helperTarget[1] === name || helperTarget[1] === helper.containerId
    ))
    if (helperEntry) {
      const [name, helper] = helperEntry
      const exactId = helperTarget![1] === helper.containerId
      const helperPath = `${DOCKER_API_PREFIX}/containers/${helper.containerId}`
      // API1.47 omitted wait condition is not-running. Docker logs first
      // inspects Tty, then serializes the same stdout/stderr flags stderr-first.
      const allowed = (method === 'POST' && exactId && [
        `${helperPath}/start`, `${helperPath}/wait`, `${helperPath}/wait?condition=not-running`,
      ].includes(url))
        || (method === 'GET' && exactId && url === `${helperPath}/json`)
        || (method === 'GET' && exactId && helper.kind !== 'auth' && [
          `${helperPath}/logs?stdout=1&stderr=0`,
          `${helperPath}/logs?stdout=1&stderr=1`, `${helperPath}/logs?stderr=1&stdout=1`,
        ].includes(url))
        || (method === 'GET' && helper.kind === 'auth' && url === `${DOCKER_API_PREFIX}/containers/${helperTarget![1]}/json`)
        || (method === 'DELETE' && url === `${DOCKER_API_PREFIX}/containers/${helperTarget![1]}?force=1`)
      if (allowed) {
        const forwarded = await this.forward(request, body)
        this.record({ method, url, decision: 'forward', destructive: method === 'DELETE' || method === 'POST', unsafeAttempt: false,
          containerId: helper.containerId, helperName: name, ownerContainerId: helper.owner.containerId, providerVolumeName: helper.owner.providerVolumeName })
        replyDocker(response, forwarded)
        return
      }
    }

    if (method === 'POST' && url.startsWith(`${DOCKER_API_PREFIX}/containers/create?`)) {
      const name = new URL(url, 'http://docker').searchParams.get('name') ?? ''
      const candidateReader = /^freshell-claude-candidate-reader-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)
      const mountpointHelper = /^freshell-mountpoints-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)
      let candidateMountpoints = false
      if (mountpointHelper) {
        try { candidateMountpoints = JSON.parse(body.toString()).Labels?.['com.freshell.claude-candidate'] === 'ordinary' } catch {}
      }
      if (name.startsWith('freshell-claude-source-') || candidateReader || candidateMountpoints) {
        const valid = candidateReader || candidateMountpoints
          ? this.validateClaudeCandidateHelper(body, candidateReader ? 'reader' : 'mountpoints')
          : /^freshell-claude-source-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name) && this.validateClaudeSourceHelper(body)
        if (!valid || this.claudeSourceHelpers.has(name)) {
          this.block(response, method, url, 403, 'Claude source helper must match its exact owned fixed reader', false)
          return
        }
        const helper: { expected: Record<string, any>; containerId?: string } = { expected: JSON.parse(body.toString()) }
        this.claudeSourceHelpers.set(name, helper)
        await this.holdHelperCreate(method, url, name)
        try {
          const forwarded = await this.forward(request, body)
          if (forwarded.statusCode === 201) {
            const parsed = JSON.parse(forwarded.body.toString())
            if (typeof parsed.Id !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.Id) || this.receiptIds().has(parsed.Id)) throw new Error('invalid Claude source helper identity')
            helper.containerId = parsed.Id
          }
          this.record({ method, url, decision: 'forward', destructive: false, unsafeAttempt: false, helperName: name, containerId: helper.containerId, requestDigest: sha256(body), reason: this.helperRejectionReason(forwarded, helper.expected) })
          replyDocker(response, forwarded)
        } catch {
          this.record({ method, url, decision: 'forward', reason: 'Claude source helper acknowledgement unavailable', destructive: false, unsafeAttempt: false, helperName: name, requestDigest: sha256(body) })
          response.statusCode = 503
          response.end(JSON.stringify({ message: 'Claude source helper acknowledgement unavailable; exact named ownership inspection required' }))
        }
        return
      }
      if (/^freshell-inputs-[a-f0-9]{24}-publisher$/.test(name) || mountpointHelper) {
        const mountpoint = mountpointHelper ? this.validateMountpointHelper(body) : undefined
        const input=mountpointHelper ? mountpoint?.input : this.validateInputPublisher(name,body)
        let previousAbsent=true
        if (input && this.inputPublishers.has(name)) {
          const previous=await this.forward({method:'GET',url:`${DOCKER_API_PREFIX}/containers/${name}/json`,headers:{}} as IncomingMessage,Buffer.alloc(0))
          previousAbsent=previous.statusCode===404
          this.record({method:'GET',url:`${DOCKER_API_PREFIX}/containers/${name}/json`,decision:'forward',destructive:false,unsafeAttempt:false,helperName:name})
        }
        if (!input || !previousAbsent) {
          this.block(response,method,url,403,mountpoint?.reason ?? 'indexed publisher must match an owned fixed preparation',false)
          return
        }
        const publisher:{input:PreparedInputAuthorization;expected:Record<string,any>;containerId?:string}={input,expected:JSON.parse(body.toString())}
        this.inputPublishers.set(name,publisher)
        await this.holdHelperCreate(method, url, name)
        try {
          const forwarded=await this.forward(request,body)
          if (forwarded.statusCode===201) {
            const parsed=JSON.parse(forwarded.body.toString())
            if (typeof parsed.Id!=='string' || !/^[a-f0-9]{64}$/.test(parsed.Id) || this.receiptIds().has(parsed.Id)) throw new Error('invalid indexed publisher identity')
            publisher.containerId=parsed.Id
          }
          this.record({method,url,decision:'forward',destructive:false,unsafeAttempt:false,helperName:name,containerId:publisher.containerId,providerVolumeName:mountpointHelper ? input.providerVolumeName : input.indexedFiles!.volumeName,reason:this.helperRejectionReason(forwarded,publisher.expected)})
          replyDocker(response,forwarded)
        } catch {
          response.statusCode=503
          response.end(JSON.stringify({message:'indexed publisher acknowledgement unavailable; exact ownership inspection required'}))
        }
        return
      }
      if (name.startsWith('freshell-history-') || name.startsWith('freshell-auth-') || name.startsWith('freshell-opencode-repair-')) {
        const kind = name.startsWith('freshell-auth-') ? 'auth' : name.startsWith('freshell-opencode-repair-') ? 'repair' : 'history'
        const owner = kind === 'auth' ? this.validateAuthHelper(name, body)
          : kind === 'repair' ? this.validateStoppedRepairHelper(name, body) : this.validateHistoryHelper(name, body)
        if (!owner || this.historyHelpers.has(name)) {
          this.block(response, method, url, 403, 'helper does not match its owned source and topology', false)
          return
        }
        // Reserve the exact validated name before forwarding: Docker may create it but lose its acknowledgement.
        const helper: { owner: BrokerReceipt; containerId?: string; kind: 'history' | 'auth' | 'repair' } = { owner, kind }
        this.historyHelpers.set(name, helper)
        try {
          const forwarded = await this.forward(request, body)
          if (forwarded.statusCode === 201) {
            const parsed = JSON.parse(forwarded.body.toString('utf8')) as { Id?: unknown }
            if (typeof parsed.Id !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.Id) || this.receiptIds().has(parsed.Id)) {
              throw new Error('Docker returned an invalid or already owned history helper id')
            }
            helper.containerId = parsed.Id
          }
          this.record({ method, url, decision: 'forward', destructive: false, unsafeAttempt: false,
            containerId: helper.containerId, helperName: name, requestDigest: sha256(body), ownerContainerId: owner.containerId, providerVolumeName: owner.providerVolumeName })
          replyDocker(response, forwarded)
        } catch (error) {
          this.record({ method, url, decision: 'forward', reason: `history helper create acknowledgement unavailable: ${String(error)}`,
            destructive: false, unsafeAttempt: false, helperName: name, requestDigest: sha256(body), ownerContainerId: owner.containerId, providerVolumeName: owner.providerVolumeName })
          response.statusCode = 503
          response.end(JSON.stringify({ message: 'history helper create acknowledgement unavailable' }))
        }
        return
      }

      const validation = this.validateCreate(body)
      if (!validation.ok) {
        this.block(response, method, url, 403, validation.reason, true, undefined)
        return
      }
      if (this.inputPublicationBeforeCreateFailure && [...this.inputPublishers.values()].some(publisher => publisher.input.incarnationId === validation.incarnationId && publisher.expected.Cmd?.[0] === 'publish-provider-inputs')) {
        this.inputPublicationBeforeCreateFailure = false
        this.record({method,url,decision:'inject_failure',reason:'indexed population before main create',destructive:false,unsafeAttempt:false})
        response.statusCode=503;response.end(JSON.stringify({message:'closed indexed publication before main create'}));return
      }
      const forwarded = await this.forward(request, body)
      if (forwarded.statusCode === 201) {
        const parsed = JSON.parse(forwarded.body.toString('utf8')) as { Id?: unknown }
        const containerId = typeof parsed.Id === 'string' ? parsed.Id : ''
        if (!/^[0-9a-f]{64}$/.test(containerId)) {
          this.block(response, method, url, 502, 'Docker returned a non-full container id', true, undefined)
          return
        }
        this.knownContainerIds.add(containerId)
        this.receiptsById.set(containerId, {
          containerId,
          installationId: validation.installationId,
          createdAt: new Date().toISOString(),
          requestDigest: sha256(body),
          incarnationId: validation.incarnationId,
          soulId: validation.soulId,
          imageRef: validation.imageRef,
          runtimeDir: validation.runtimeDir,
          hostBinaryPath: validation.hostBinaryPath,
          ...(validation.providerVolumeName ? { providerVolumeName: validation.providerVolumeName } : {}),
          ...(validation.workspacePath ? { workspacePath: validation.workspacePath } : {}),
        })
        this.record({ method, url, decision: 'forward', destructive: false, unsafeAttempt: false, containerId })
      } else {
        this.record({ method, url, decision: 'forward', destructive: false, unsafeAttempt: false })
      }
      replyDocker(response, forwarded)
      return
    }

    if (target) {
      const negativeOwner = this.task2LegacyNegativeInspectionOwners.get(target.containerId)
      if (negativeOwner && method === 'GET' && target.action === 'json') {
        await this.forwardAndReply(request, response, body, { destructive: false,
          containerId: target.containerId, ownerContainerId: negativeOwner })
        return
      }
      const known = this.knownContainerIds.has(target.containerId)
      if (!known) {
        this.block(response, method, url, 403, 'container id is not in this broker run receipt set', destructive, target.containerId)
        return
      }

      if (method === 'GET' && target.action === 'json') {
        await this.forwardAndReply(request, response, body, { destructive: false, containerId: target.containerId })
        return
      }

      if (method === 'POST' && ['start', 'stop', 'kill', 'unpause', 'update'].includes(target.action)) {
        if (target.action === 'stop' && this.stopFailuresRemaining > 0) {
          this.stopFailuresRemaining -= 1
          this.record({ method, url, decision: 'inject_failure', reason: 'configured stop failure', destructive: true, unsafeAttempt: false, containerId: target.containerId })
          response.statusCode = 500
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ message: 'runtime test broker injected Docker stop failure' }))
          return
        }
        await this.forwardAndReply(request, response, body, { destructive: true, containerId: target.containerId })
        return
      }
    }

    this.block(response, method, url, 403, 'Docker operation is outside the runtime-test broker policy', destructive, target?.containerId)
  }

  private validateCreate(body: Buffer):
    | { ok: true; installationId: string; incarnationId: string; soulId: string; imageRef: string; runtimeDir: string; hostBinaryPath: string; providerVolumeName?: string; workspacePath?: string }
    | { ok: false; reason: string } {
    let parsed: Record<string, any>
    try {
      parsed = JSON.parse(body.toString('utf8')) as Record<string, any>
    } catch {
      return { ok: false, reason: 'container create body is not JSON' }
    }

    const imageRef = typeof parsed.Image === 'string' ? parsed.Image : ''
    if (!this.policy.allowedImageRefs.has(imageRef)) return { ok: false, reason: `unapproved image ${imageRef}` }
    const labels = parsed.Labels ?? {}
    const incarnationId = stringField(labels, 'com.freshell.incarnation-id')
    const soulId = stringField(labels, 'com.freshell.soul-id')
    const installationId = stringField(labels, 'com.freshell.installation-id')
    if (labels.project !== 'freshell') return { ok: false, reason: 'wrong project bookkeeping label' }
    if (labels['com.freshell.managed'] !== 'true') return { ok: false, reason: 'missing managed label' }
    if (labels['com.freshell.runtime-test-run-id'] !== this.policy.testRunId) return { ok: false, reason: 'wrong runtime-test run id' }
    if (!incarnationId || !soulId || !installationId) return { ok: false, reason: 'missing installation/incarnation/soul labels' }

    const host = parsed.HostConfig ?? {}
    if (host.Mounts !== undefined && !Array.isArray(host.Mounts)) {
      return { ok: false, reason: 'typed mounts require an exact owned provider preparation authorization' }
    }
    const terminalWorkload = host.NetworkMode === 'bridge'
    const freshAgentWorkload = Array.isArray(parsed.Env) && parsed.Env.some((value: unknown) => (
      typeof value === 'string' && value.startsWith('FRESHELL_HOSTED_FRESH_AGENT=')
    ))
    if (host.NetworkMode !== 'none' && !terminalWorkload) return { ok: false, reason: 'runtime network must be none or isolated bridge' }
    const extraHosts = Array.isArray(host.ExtraHosts) ? host.ExtraHosts : []
    const localAddresses = new Set(Object.values(os.networkInterfaces()).flatMap((interfaces) => (
      interfaces?.filter((network) => network.family === 'IPv4' && !network.internal).map((network) => network.address) ?? []
    )))
    for (const address of this.policy.allowedHostGatewayAddresses ?? []) localAddresses.add(address)
    if (extraHosts.some((entry: unknown) => {
      if (entry === 'host.docker.internal:host-gateway') return false
      if (typeof entry !== 'string' || !entry.startsWith('host.docker.internal:')) return true
      return !localAddresses.has(entry.slice('host.docker.internal:'.length))
    })) {
      return { ok: false, reason: 'unapproved runtime host gateway' }
    }
    if (terminalWorkload && !this.policy.allowTerminalWorkloads) return { ok: false, reason: 'terminal workload networking not enabled for this gate' }
    if ((host.PidMode ?? '') !== '') return { ok: false, reason: 'host pid namespace is forbidden' }
    if (host.ReadonlyRootfs !== true) return { ok: false, reason: 'runtime rootfs must be readonly' }
    if (host.Privileged === true) return { ok: false, reason: 'privileged runtime forbidden' }
    if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL')) return { ok: false, reason: 'all capabilities must be dropped before explicit host additions' }
    const capAdd = Array.isArray(host.CapAdd) ? [...host.CapAdd].sort() : []
    const allowedCapAdd = terminalWorkload
      ? [['CHOWN', 'KILL', 'SETGID', 'SETUID'], ['CHOWN', 'SETGID', 'SETUID']]
      : [[]]
    if (!allowedCapAdd.some((capabilities) => JSON.stringify(capAdd) === JSON.stringify(capabilities))) {
      return { ok: false, reason: `unexpected host capability additions: ${capAdd.join(',')}` }
    }
    if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges:true')) return { ok: false, reason: 'no-new-privileges is required' }
    if (host.RestartPolicy?.Name !== 'no') return { ok: false, reason: 'staging container must start with restart=no' }
    if (!(Number(host.NanoCpus) > 0) || !(Number(host.Memory) > 0) || !(Number(host.PidsLimit) > 0)) {
      return { ok: false, reason: 'CPU/memory/pid limits must be explicit and nonzero' }
    }
    if (host.PortBindings && Object.keys(host.PortBindings).length > 0) return { ok: false, reason: 'runtime ports are forbidden' }

    const tmpfs = host.Tmpfs ?? {}
    if (tmpfs['/tmp'] !== 'rw,noexec,nosuid,nodev,size=128m') return { ok: false, reason: 'runtime /tmp must remain bounded and noexec' }
    if (tmpfs['/run/freshell-private'] !== undefined && tmpfs['/run/freshell-private'] !== 'rw,noexec,nosuid,nodev,size=16m,mode=0710') {
      return { ok: false, reason: 'provider private tmpfs must be bounded and noexec' }
    }
    const tmpfsKeys = Object.keys(tmpfs).sort()
    const allowedTmpfsKeys = ['/tmp']
    if (tmpfsKeys.includes('/run/freshell-private')) allowedTmpfsKeys.push('/run/freshell-private')
    if (tmpfsKeys.includes('/run/opencode-tmp')) allowedTmpfsKeys.push('/run/opencode-tmp')
    for (const destination of tmpfsKeys) {
      if (isOperatorHomeMaskDestination(destination, this.policy.allowedOperatorHomeRoots) && tmpfs[destination] === '') {
        allowedTmpfsKeys.push(destination)
      }
    }
    allowedTmpfsKeys.sort()
    if (JSON.stringify(tmpfsKeys) !== JSON.stringify(allowedTmpfsKeys)) return { ok: false, reason: `unexpected runtime tmpfs topology: ${tmpfsKeys.join(',')}` }
    if (tmpfs['/run/opencode-tmp'] !== undefined && tmpfs['/run/opencode-tmp'] !== 'rw,exec,nosuid,nodev,size=64m,mode=1777') {
      return { ok: false, reason: 'OpenCode exec tmpfs must be bounded and nosuid/nodev' }
    }

    const binds = Array.isArray(host.Binds) ? host.Binds as string[] : []
    if (!terminalWorkload && binds.length !== 3) return { ok: false, reason: `expected binary, runtime, and soul provider-volume fixture binds, found ${binds.length}` }
    let hostBinaryPath = ''
    let runtimeDir = ''
    let providerVolumeName = ''
    let workspacePath = ''
    let actorStateDir = ''
    let opencodeTransferStagePath: string | undefined
    for (const bind of binds) {
      const parts = bind.split(':')
      const mode = parts.pop() ?? ''
      const destination = parts.pop() ?? ''
      const source = parts.join(':')
      if (destination === '/runtime/freshell-session-host' && mode === 'ro' && this.policy.allowedHostBinaryPaths.has(source)) {
        hostBinaryPath = source
        continue
      }
      if (destination === '/run/freshell' && mode === 'rw' && isStrictDescendant(source, this.policy.runtimeRootPrefix)) {
        runtimeDir = source
        continue
      }
      if (destination === '/home/freshell/provider' && mode === 'rw' && /^freshell-provider-[a-f0-9]{24}$/.test(source)) {
        providerVolumeName = source
        continue
      }
      if (terminalWorkload && destination === '/run/freshell-opencode-transfer') {
        const relative = path.relative(this.policy.runtimeRootPrefix, source)
        const parts = relative.split(path.sep)
        if (mode !== 'ro'
          || !isStrictDescendant(source, this.policy.runtimeRootPrefix)
          || parts.length !== 4
          || !/^[a-zA-Z0-9-]+$/.test(parts[0])
          || parts[1] !== 'x'
          || parts[2] !== 'opencode-transfers'
          || !/^opencode-transfer-[a-zA-Z0-9-]+\.ready$/.test(parts[3])
          || opencodeTransferStagePath) {
          return { ok: false, reason: `unapproved OpenCode transfer stage bind ${bind}` }
        }
        opencodeTransferStagePath = source
        continue
      }
      if (destination === '/run/freshell-host-actor' && mode === 'rw') {
        if (actorStateDir) return { ok: false, reason: 'duplicate host actor state bind' }
        actorStateDir = source
        continue
      }
      if (terminalWorkload && destination === source && mode === 'rw' && this.isAllowedWorkspacePath(source)) {
        if (!workspacePath) workspacePath = source
        continue
      }
      if (terminalWorkload && destination === source && mode === 'ro' && this.policy.allowedOperatorHomeRoots?.has(source)) {
        continue
      }
      if (terminalWorkload && /^\/run\/freshell-bootstrap\/provider-\d+$/.test(destination) && mode === 'ro' && this.policy.allowedBootstrapFiles?.has(source)) {
        continue
      }
      if (terminalWorkload && /^\/run\/freshell-secrets\/provider-\d+$/.test(destination) && mode === 'ro' && this.policy.allowedBootstrapFiles?.has(source)) {
        continue
      }
      if (terminalWorkload && destination === '/run/freshell/mcp-capability.json' && mode === 'ro') {
        const relative = path.relative(path.dirname(this.policy.runtimeRootPrefix), source)
        if (/^scenarios\/[^/]+\/control\/mcp-capabilities\/grant-[a-zA-Z0-9-]+\.json$/.test(relative)) continue
      }
      if (terminalWorkload && destination === '/run/freshell-private/user-provider' && mode === 'ro') {
        const relative = path.relative(path.dirname(this.policy.runtimeRootPrefix), source)
        if (/^scenarios\/[^/]+\/control\/provider-roots\/grant-[a-zA-Z0-9-]+$/.test(relative)) continue
        if (/(?:^|\/)(?:\.claude|\.codex|\.amplifier|\.config\/opencode)$/.test(source)
          && (this.isAllowedWorkspacePath(source) || this.policy.allowedProviderUserRoots?.has(source))) continue
      }
      return { ok: false, reason: `unapproved bind ${bind}` }
    }
    if (!hostBinaryPath || !runtimeDir || !providerVolumeName) return { ok: false, reason: 'required binary/runtime/provider-volume bind topology missing' }
    if (opencodeTransferStagePath
      && path.dirname(opencodeTransferStagePath) !== path.join(path.dirname(runtimeDir), 'opencode-transfers')) {
      return { ok: false, reason: 'OpenCode transfer stage is not owned by the active runtime root' }
    }
    if (terminalWorkload && !workspacePath) return { ok: false, reason: 'terminal workload missing approved workspace bind' }
    const actorKey = createHash('sha256').update(`${installationId}\0${soulId}`).digest('hex')
    const expectedActorStateDir = path.join(path.dirname(runtimeDir), 'souls', actorKey, 'actor')
    if (freshAgentWorkload && actorStateDir !== expectedActorStateDir) {
      return { ok: false, reason: 'fresh-agent host actor state bind does not match the labeled soul' }
    }
    if (!freshAgentWorkload && actorStateDir) {
      return { ok: false, reason: 'non-agent workload gained a host actor state bind' }
    }
    if (binds.some((bind) => bind.includes('docker.sock') || bind.includes('/var/lib/freshell-supervisor') || bind.includes('/run/freshell-supervisor'))) {
      return { ok: false, reason: 'management-state mount is forbidden' }
    }
    const prepared=[...this.preparedInputs.values()].filter((input) => input.installationId === installationId
      && input.soulId === soulId && input.incarnationId === incarnationId && input.imageRef === imageRef
      && input.hostBinaryPath === hostBinaryPath && input.providerVolumeName === providerVolumeName);
    if ((host.Mounts?.length || prepared.length) && !prepared.some((input)=>preparedMountsMatch(host.Mounts ?? [],input))) return { ok: false, reason: 'typed mounts differ from this attempt owned prepared input set' }
    return { ok: true, installationId, incarnationId, soulId, imageRef, runtimeDir, hostBinaryPath, ...(providerVolumeName ? { providerVolumeName } : {}), ...(workspacePath ? { workspacePath } : {}) }
  }

  private validateClaudeCandidateHelper(body: Buffer, role: 'reader' | 'mountpoints'): boolean {
    let parsed: Record<string, any>
    try { parsed = JSON.parse(body.toString()) } catch { return false }
    const input = [...this.claudeCandidates.values()].find((input) => equalRecord(parsed.Labels, candidateLabels(input, this.policy.testRunId)))
    const reader = role === 'reader', host = parsed.HostConfig ?? {}
    if (!input || !this.candidateVolumes.has(candidateVolumeName(input)) || parsed.Image !== input.imageRef || parsed.User !== '0:0' || parsed.Tty !== false
      || JSON.stringify(parsed.Entrypoint) !== JSON.stringify(['/runtime/freshell-session-host'])
      || JSON.stringify(parsed.Cmd) !== JSON.stringify([reader ? 'project-claude-candidate-private' : 'prepare-provider-mountpoints'])
      || !privateHelperEnvironment(parsed.Env, reader)
      || (reader ? parsed.WorkingDir !== input.cwd : parsed.WorkingDir !== undefined)
      || Object.keys(parsed).some((key) => !['Image','User','Tty','Labels','Entrypoint','Cmd','Env','HostConfig',...(reader ? ['WorkingDir'] : [])].includes(key))
      || Object.keys(host).some((key) => !['NetworkMode','ReadonlyRootfs','CapDrop','CapAdd','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','LogConfig','Mounts',...(reader ? ['Tmpfs'] : [])].includes(key))
      || host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true
      || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL']) || JSON.stringify(host.CapAdd) !== JSON.stringify(['CHOWN','SETGID','SETUID'])
      || JSON.stringify(host.SecurityOpt) !== JSON.stringify(['no-new-privileges'])
      || host.Memory !== (reader ? 256 : 128) * 1024 * 1024 || host.MemorySwap !== host.Memory || host.NanoCpus !== 500_000_000 || host.PidsLimit !== 32
      || !equalRecord(host.LogConfig, { Type: 'none', Config: host.LogConfig?.Config }) || Object.keys(host.LogConfig?.Config ?? {}).length
      || (reader ? !equalRecord(host.Tmpfs, {}) : host.Tmpfs !== undefined)) return false
    const mounts = host.Mounts
    if (!Array.isArray(mounts)) return false
    const exchangeTarget = reader ? '/run/freshell-source-exchange' : '/run/freshell-input-exchange'
    const exchange = mounts.find((mount) => mount?.Type === 'bind' && mount.Target === exchangeTarget && mount.ReadOnly === true
      && this.isAllowedExchangeSource(mount.Source, 'freshell-inputs'))
    if (!exchange) return false
    const expected: Record<string, any>[] = [
      { Type: 'bind', Source: input.hostBinaryPath, Target: '/runtime/freshell-session-host', ReadOnly: true },
      { Type: 'volume', Source: candidateVolumeName(input), Target: '/home/freshell/provider', ReadOnly: false, VolumeOptions: { NoCopy: true } },
      { Type: 'bind', Source: exchange.Source, Target: exchangeTarget, ReadOnly: true },
    ]
    if (reader) {
      expected.push({ Type: 'bind', Source: input.workspacePath, Target: input.workspacePath, ReadOnly: true },
        { Type: 'bind', Source: path.join(exchange.Source, 'ordinary-stage'), Target: '/run/freshell-candidate-inputs', ReadOnly: true })
      const selected = new Set(['.freshell/claude-candidate-binding.json','.freshell/prepared-context.json','.freshell/prepared-result.json',input.manifestRelativePath,
        ...input.configurationBinds.map((bind) => bind.sourceRelativePath),...input.resourceMounts.map((mount) => mount.stageRelativePath)])
      for (const relative of selected) expected.push({ Type: 'bind', Source: path.join(input.stageRoot, relative), Target: path.join('/run/freshell-candidate-inputs', relative), ReadOnly: true })
      if (input.retained) {
        expected.push({ Type:'volume',Source:input.providerVolumeName,Target:'/run/freshell-retained-home',ReadOnly:true,VolumeOptions:{NoCopy:true} },
          { Type:'bind',Source:path.join(exchange.Source,'retained-stage'),Target:'/run/freshell-retained-inputs',ReadOnly:true })
        const selected = new Set(['.freshell/prepared-context.json',input.manifestRelativePath,
          ...input.retained.configurationBinds.map((bind) => bind.sourceRelativePath),...input.retained.resourceMounts.map((unit) => unit.stageRelativePath)])
        for (const relative of selected) expected.push({Type:'bind',Source:path.join(input.retained.stageRoot,relative),Target:path.join('/run/freshell-retained-inputs',relative),ReadOnly:true})
      }
      expected.push(...claudeGitCommonMounts(input))
      for (const bind of input.configurationBinds) expected.push({ Type: 'bind', Source: path.join(input.stageRoot, bind.sourceRelativePath), Target: bind.effectiveDestination, ReadOnly: true })
      for (const mount of input.resourceMounts) expected.push({ Type: 'volume', Source: candidateVolumeName(input), Target: mount.effectiveDestination,
        ReadOnly: mount.kind === 'file', VolumeOptions: { NoCopy: true, Subpath: mount.providerRelativePath } })
    }
    if (mounts.length !== expected.length) return false
    const remaining = new Map(expected.map((mount) => [mount.Target, mount]))
    for (const mount of mounts) {
      if (!mount || typeof mount !== 'object' || Array.isArray(mount)) return false
      const wanted = remaining.get(mount.Target)
      if (!wanted || Object.keys(mount).some((key) => !['Type','Source','Target','ReadOnly','VolumeOptions'].includes(key))
        || ['Type','Source','Target','ReadOnly'].some((key) => mount[key] !== wanted[key])) return false
      if (wanted.Type === 'volume' ? !equalRecord(mount.VolumeOptions, wanted.VolumeOptions) : mount.VolumeOptions !== undefined) return false
      remaining.delete(mount.Target)
    }
    return remaining.size === 0
  }

  private validateClaudeSourceHelper(body: Buffer): boolean {
    let parsed: Record<string, any>
    try { parsed = JSON.parse(body.toString()) } catch { return false }
    const labels = parsed.Labels ?? {}
    const owner = [...this.initialProviderVolumes.values()].find((input) => input.installationId === labels['com.freshell.installation-id']
      && input.soulId === labels['com.freshell.soul-id'] && input.imageRef === parsed.Image
      && input.binarySha256 === labels['com.freshell.source-binary-sha256'])
    if (!owner || parsed.User !== '65534:0' || parsed.Tty !== false
      || JSON.stringify(parsed.Entrypoint) !== JSON.stringify(['/runtime/freshell-session-host'])
      || JSON.stringify(parsed.Cmd) !== JSON.stringify(['observe-claude-sources-private'])
      || !privateHelperEnvironment(parsed.Env, true)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(labels['com.freshell.source-request-id'])
      || !equalRecord(labels, {
        'com.freshell.installation-id': owner.installationId, 'com.freshell.soul-id': owner.soulId,
        'com.freshell.runtime-test-run-id': this.policy.testRunId,
        'com.freshell.source-request-id': labels['com.freshell.source-request-id'],
        'com.freshell.source-binary-sha256': owner.binarySha256,
      })) return false
    const host = parsed.HostConfig ?? {}
    if (Object.keys(parsed).some((key) => !['Image','User','Tty','WorkingDir','Labels','Entrypoint','Cmd','Env','HostConfig'].includes(key))
      || Object.keys(host).some((key) => !['NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','LogConfig','Tmpfs','Mounts'].includes(key))
      || host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true
      || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL']) || JSON.stringify(host.SecurityOpt) !== JSON.stringify(['no-new-privileges'])
      || host.Memory !== 256 * 1024 * 1024 || host.MemorySwap !== 256 * 1024 * 1024 || host.NanoCpus !== 500_000_000 || host.PidsLimit !== 32
      || !equalRecord(host.LogConfig, { Type: 'none', Config: host.LogConfig?.Config }) || Object.keys(host.LogConfig?.Config ?? {}).length) return false
    const mounts = host.Mounts
    if (!Array.isArray(mounts)
      || mounts.some((mount) => !mount || Object.keys(mount).some((key) => !['Type','Source','Target','ReadOnly','VolumeOptions'].includes(key)))) return false
    const binary = mounts.find((mount) => mount.Type === 'bind' && mount.Source === owner.hostBinaryPath && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    const workspace = mounts.find((mount) => mount.Type === 'bind' && mount.Source === mount.Target && this.isAllowedWorkspacePath(mount.Source) && mount.ReadOnly === true)
    const exchange = mounts.find((mount) => mount.Type === 'bind' && mount.Target === '/run/freshell-source-exchange' && mount.ReadOnly === true
      && this.isAllowedExchangeSource(mount.Source, 'freshell-inputs'))
    if (!binary || !workspace || !exchange || [binary,workspace,exchange].some(mount => mount.VolumeOptions !== undefined)) return false
    const home = mounts.find(mount => mount.Target === '/home/freshell/provider')
    if (home) {
      if (!equalRecord(host.Tmpfs, {}) || home.Type !== 'volume' || home.Source !== owner.providerVolumeName
        || home.ReadOnly !== true || !equalRecord(home.VolumeOptions,{NoCopy:true})) return false
      // Match a previously authorized complete ordinary generation. No native
      // store path, arbitrary alias, or original controller source is admitted.
      const profiles = [...this.claudeCandidates.values()].filter(input => input.installationId === owner.installationId
        && input.soulId === owner.soulId && input.providerVolumeName === owner.providerVolumeName)
      const matches = profiles.some(input => {
        const expected = [binary,workspace,exchange,home,
          ...input.configurationBinds.map(bind => ({Type:'bind',Source:path.join(input.stageRoot,bind.sourceRelativePath),Target:bind.effectiveDestination,ReadOnly:true})),
          ...input.resourceMounts.map(unit => ({Type:'volume',Source:owner.providerVolumeName,Target:unit.effectiveDestination,ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:unit.providerRelativePath}})),
          ...claudeGitCommonMounts(input),
        ]
        return mounts.length === expected.length && new Set(mounts.map(mount => mount.Target)).size === mounts.length
          && expected.every(wanted => mounts.some(actual => ['Type','Source','Target','ReadOnly'].every(key => actual[key] === wanted[key])
            && (wanted.Type === 'volume' ? equalRecord(actual.VolumeOptions,wanted.VolumeOptions) : actual.VolumeOptions === undefined)))
      })
      if (!matches) return false
    } else {
      // Linked checkouts also expose their separately selected Git common
      // directory. The producer mounts it at the same path, read-only.
      const common = mounts.filter(mount => ![binary, workspace, exchange].includes(mount))
      if (common.length > 1 || common.some(mount => mount.Type !== 'bind' || mount.Source !== mount.Target
        || !this.policy.allowedWorkspaceRoots?.has(mount.Source) || mount.Source === workspace.Source
        || isStrictDescendant(mount.Source, workspace.Source) || mount.ReadOnly !== true || mount.VolumeOptions !== undefined)
        || !equalRecord(host.Tmpfs, { '/home/freshell/provider': 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=0,mode=0700' })) return false
    }
    return typeof parsed.WorkingDir === 'string'
      && path.normalize(parsed.WorkingDir) === parsed.WorkingDir
      && (parsed.WorkingDir === workspace.Source || isStrictDescendant(parsed.WorkingDir, workspace.Source))
  }

  private ownedClaudeSourceHelper(actual: Record<string, any>, expected: Record<string, any>): boolean {
    const config = actual.Config ?? {}, host = actual.HostConfig ?? {}
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected)
    if (expected.Labels?.['com.freshell.claude-candidate'] === 'ordinary') {
      return ['Image','User','Tty'].every((key) => config[key] === expected[key])
        && (expected.WorkingDir === undefined || config.WorkingDir === expected.WorkingDir)
        && ['Entrypoint','Cmd'].every((key) => same(config[key], expected[key]))
        && ownedHelperLabels(config.Labels, expected.Labels)
        && Array.isArray(config.Env) && same([...config.Env].sort(), [...expected.Env].sort())
        && ['NetworkMode','ReadonlyRootfs','CapDrop','CapAdd','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit'].every((key) => same(host[key], expected.HostConfig[key]))
        && same(host.Tmpfs ?? {}, expected.HostConfig.Tmpfs ?? {}) && host.LogConfig?.Type === 'none'
        && Array.isArray(host.Mounts) && host.Mounts.length === expected.HostConfig.Mounts.length
        && expected.HostConfig.Mounts.every((wanted: Record<string, any>) => host.Mounts.some((mount: Record<string, any>) =>
          ['Type','Source','Target'].every((key) => mount[key] === wanted[key]) && (mount.ReadOnly ?? false) === wanted.ReadOnly
          && (wanted.Type === 'volume' ? mount.VolumeOptions?.NoCopy === true && !mount.VolumeOptions.DriverConfig
            && (mount.VolumeOptions.Subpath ?? '') === (wanted.VolumeOptions.Subpath ?? '') : mount.VolumeOptions === undefined)))
    }
    return ['Image','User','Tty','WorkingDir'].every((key) => config[key] === expected[key])
      && ['Entrypoint','Cmd'].every((key) => same(config[key], expected[key]))
      && ownedHelperLabels(config.Labels, expected.Labels)
      && Array.isArray(config.Env) && same([...config.Env].sort(), [...expected.Env].sort())
      && ['NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit'].every((key) => same(host[key], expected.HostConfig[key]))
      && same(host.Tmpfs ?? {}, expected.HostConfig.Tmpfs ?? {})
      && (host.CapAdd?.length ?? 0) === 0 && host.LogConfig?.Type === 'none'
      && Array.isArray(host.Mounts) && host.Mounts.length === expected.HostConfig.Mounts.length
      && expected.HostConfig.Mounts.every((wanted: Record<string, any>) => host.Mounts.some((mount: Record<string, any>) =>
        ['Type','Source','Target','ReadOnly'].every((key) => mount[key] === wanted[key])
        && (wanted.Type === 'volume' ? mount.VolumeOptions?.NoCopy === true && !mount.VolumeOptions.DriverConfig
          && (mount.VolumeOptions.Subpath ?? '') === (wanted.VolumeOptions.Subpath ?? '') : mount.VolumeOptions === undefined)))
  }

  private validateInputPublisher(name:string,body:Buffer):PreparedInputAuthorization | undefined {
    let parsed:Record<string,any>
    try {parsed=JSON.parse(body.toString())} catch {return}
    const input=[...this.preparedInputs.values()].find((input)=>`${input.indexedFiles?.volumeName}-publisher`===name)
    if (!input || !this.inputVolumes.has(input.indexedFiles!.volumeName) || parsed.Image!==input.imageRef
      || parsed.User!=='65534:0' || parsed.Tty!==false || !equalRecord(parsed.Labels,indexedLabels(input))
      || JSON.stringify(parsed.Entrypoint)!==JSON.stringify(['/runtime/freshell-session-host'])
      || JSON.stringify(parsed.Cmd)!==JSON.stringify(['publish-provider-inputs']) || !privateHelperEnvironment(parsed.Env,false)) return
    const host=parsed.HostConfig ?? {}
    if (Object.keys(parsed).some((key)=>!['Image','User','Tty','Labels','Entrypoint','Cmd','Env','HostConfig'].includes(key))
      || Object.keys(host).some((key)=>!['NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','LogConfig','Mounts'].includes(key))) return
    if (host.NetworkMode!=='none' || host.ReadonlyRootfs!==true || host.Privileged===true || (host.PidMode ?? '')!==''
      || (host.Binds?.length ?? 0)!==0 || (host.CapAdd?.length ?? 0)!==0 || Object.keys(host.Tmpfs ?? {}).length
      || JSON.stringify(host.CapDrop)!==JSON.stringify(['ALL']) || JSON.stringify(host.SecurityOpt)!==JSON.stringify(['no-new-privileges'])
      || host.Memory!==128*1024*1024 || host.MemorySwap!==128*1024*1024 || host.NanoCpus!==500_000_000 || host.PidsLimit!==32
      || !equalRecord(host.LogConfig,{Type:'none',Config:host.LogConfig?.Config}) || Object.keys(host.LogConfig?.Config ?? {}).length) return
    const mounts=host.Mounts
    if (!Array.isArray(mounts) || mounts.length!==3) return
    const binary=mounts.find((mount)=>mount.Type==='bind' && mount.Source===input.hostBinaryPath && mount.Target==='/runtime/freshell-session-host' && mount.ReadOnly===true)
    const volume=mounts.find((mount)=>mount.Type==='volume' && mount.Source===input.indexedFiles!.volumeName && mount.Target==='/run/freshell-input-files' && mount.ReadOnly===false && equalRecord(mount.VolumeOptions,{NoCopy:true}))
    const exchange=mounts.find((mount)=>mount.Type==='bind' && mount.Target==='/run/freshell-input-exchange' && mount.ReadOnly===true
      && this.isAllowedExchangeSource(mount.Source, 'freshell-inputs'))
    if (!binary || !volume || !exchange || [binary,volume,exchange].some((mount)=>Object.keys(mount).some((key)=>!['Type','Source','Target','ReadOnly','VolumeOptions'].includes(key)))
      || binary.VolumeOptions!==undefined || exchange.VolumeOptions!==undefined) return
    return input
  }

  private validateMountpointHelper(body:Buffer): { input?: PreparedInputAuthorization; reason?: string } {
    const reject = (phase: 'json' | 'owner' | 'image' | 'labels' | 'identity_argv' | 'environment' | 'shape'
      | 'limits_authority' | 'mount_count' | 'exchange' | 'mounts') => ({ reason: `mountpoint helper unavailable at ${phase}` })
    let parsed:Record<string,any>
    try {parsed=JSON.parse(body.toString())} catch {return reject('json')}
    const owners=[...this.preparedInputs.values()].filter((input)=>
      parsed.Labels?.['com.freshell.installation-id']===input.installationId
      && parsed.Labels?.['com.freshell.soul-id']===input.soulId
      && parsed.Labels?.['com.freshell.incarnation-id']===input.incarnationId)
    if (!owners.length) return reject('owner')
    const input=owners.find((input)=>parsed.Image===input.imageRef)
    if (!input) return reject('image')
    if (!equalRecord(parsed.Labels,{'com.freshell.installation-id':input.installationId,
      'com.freshell.soul-id':input.soulId,'com.freshell.incarnation-id':input.incarnationId})) return reject('labels')
    if (parsed.User!=='0:0' || parsed.Tty!==false
      || JSON.stringify(parsed.Entrypoint)!==JSON.stringify(['/runtime/freshell-session-host'])
      || JSON.stringify(parsed.Cmd)!==JSON.stringify(['prepare-provider-mountpoints'])) return reject('identity_argv')
    if (!privateHelperEnvironment(parsed.Env,false)) return reject('environment')
    const host=parsed.HostConfig ?? {}
    if (Object.keys(parsed).some((key)=>!['Image','User','Tty','Labels','Entrypoint','Cmd','Env','HostConfig'].includes(key))
      || Object.keys(host).some((key)=>!['NetworkMode','ReadonlyRootfs','CapDrop','CapAdd','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','LogConfig','Mounts'].includes(key))) return reject('shape')
    if (host.NetworkMode!=='none' || host.ReadonlyRootfs!==true
      || JSON.stringify(host.CapDrop)!==JSON.stringify(['ALL'])
      || JSON.stringify(host.CapAdd)!==JSON.stringify(['CHOWN','SETGID','SETUID'])
      || JSON.stringify(host.SecurityOpt)!==JSON.stringify(['no-new-privileges'])
      || host.Memory!==128*1024*1024 || host.MemorySwap!==128*1024*1024
      || host.NanoCpus!==500_000_000 || host.PidsLimit!==32
      || !equalRecord(host.LogConfig,{Type:'none',Config:host.LogConfig?.Config})
      || Object.keys(host.LogConfig?.Config ?? {}).length) return reject('limits_authority')
    const mounts=host.Mounts
    if (!Array.isArray(mounts) || mounts.length!==3) return reject('mount_count')
    const binary=mounts.find((mount)=>mount.Type==='bind' && mount.Source===input.hostBinaryPath
      && mount.Target==='/runtime/freshell-session-host' && mount.ReadOnly===true)
    const volume=mounts.find((mount)=>mount.Type==='volume' && mount.Source===input.providerVolumeName
      && mount.Target==='/home/freshell/provider' && mount.ReadOnly===false && equalRecord(mount.VolumeOptions,{NoCopy:true}))
    const exchange=mounts.find((mount)=>mount.Type==='bind' && mount.Target==='/run/freshell-input-exchange' && mount.ReadOnly===true)
    if (!exchange || !this.isAllowedExchangeSource(exchange.Source, 'freshell-inputs')) return reject('exchange')
    if (!binary || !volume || !exchange || [binary,volume,exchange].some((mount)=>Object.keys(mount).some((key)=>!['Type','Source','Target','ReadOnly','VolumeOptions'].includes(key)))
      || binary.VolumeOptions!==undefined || exchange.VolumeOptions!==undefined) return reject('mounts')
    return { input }
  }

  // Browser fixtures publish through the actual controller, whose generated
  // stages exist before Docker receives their first request. Register that
  // immutable handoff here; the ordinary Docker validators still decide every
  // request. Explicit native fixture handoffs continue to use the same APIs.
  private claudePublicationRejection(requestId: string): string | undefined {
    let phase = 'physical_stage'
    try {
      const root = path.dirname(this.policy.runtimeRootPrefix)
      for (const scenario of this.fixtureDirectories(path.join(root, 'scenarios'), 32)) {
        const control = path.join(root, 'scenarios', scenario, 'control')
        for (const grant of this.fixtureDirectories(path.join(control, 'provider-roots'), 128)) {
          if (!FIXTURE_GRANT.test(grant)) continue
          if (!fs.existsSync(path.join(control, 'provider-roots', grant, '.freshell/claude-candidate-binding.json'))) continue
          const qualified = this.qualifyPublishedClaudeCandidate(control, grant, requestId)
          if ('authorization' in qualified) return undefined
          phase = qualified.phase
        }
      }
    } catch { /* Unqualified publication exposes no daemon metadata. */ }
    return phase
  }

  /**
   * Qualify one controller-published Claude candidate stage against its owned
   * soul and return its exact candidate authorization. A creation candidate is
   * bound to its initial reservation. A recovery candidate is bound to its
   * registry attempt and to the frozen prior generation it retains, with the
   * same profile the closed launch fixture hands off explicitly.
   */
  private qualifyPublishedClaudeCandidate(control: string, grant: string, requestId: string):
    { authorization: ClaudeCandidateAuthorization } | { phase: string } {
    let phase = 'owner_capability'
    try {
      const stageRoot = path.join(control, 'provider-roots', grant)
      const binding = this.fixtureMetadata(path.join(stageRoot, '.freshell/claude-candidate-binding.json')).value
      const capability = this.fixtureMetadata(path.join(control, 'mcp-capabilities', `${grant}.json`), 128 * 1024).value
      const owner = [...this.initialProviderVolumes.values()].find(owner => owner.soulId === binding.soulId && owner.soulId === capability.soulId)
      const recovery = binding.registryAttemptId != null
      const prior = binding.priorGenerationId
      if (!owner || capability.incarnationId != null || binding.version !== 1 || !CLAUDE_SOURCE_FLAVORS.has(binding.provider)
        || binding.generationId !== grant || !Number.isSafeInteger(binding.intentRevision) || binding.intentRevision < 1
        || (recovery
          ? binding.initialReservationId != null || typeof binding.registryAttemptId !== 'string'
            || !/^recovery-/.test(binding.registryAttemptId) || !FIXTURE_UUID.test(binding.registryAttemptId.slice('recovery-'.length))
            || typeof prior !== 'string' || !FIXTURE_GRANT.test(prior) || prior === grant
            // The controller issues a replacement as a pending preparation
            // that names exactly the generation it replaces.
            || capability.preparation?.phase !== 'pending' || !Array.isArray(capability.preparation?.priorGrantIds)
            || !capability.preparation.priorGrantIds.includes(prior)
          : binding.intentRevision !== 1 || prior != null || !FIXTURE_UUID.test(binding.initialReservationId ?? ''))) return { phase }
      phase = 'prepared_metadata'
      const context = this.fixtureMetadata(path.join(stageRoot, '.freshell/prepared-context.json'))
      const result = this.fixtureMetadata(path.join(stageRoot, '.freshell/prepared-result.json'))
      const inputs = context.value.preparedInputs
      if (!context.value.preparation?.claude || !inputs || inputs.generationId !== grant
        || context.value.mcpCapability?.grantId !== grant
        || (inputs.initialAuthReservation ?? null) !== (binding.initialReservationId ?? null)
        || JSON.stringify(result.value.providerLaunchContext) !== JSON.stringify(context.value)
        || !Array.isArray(result.value.providerSecretReferences) || inputs.manifest?.relativePath !== '.freshell/input-manifest.json'
        || sha256Hex(context.bytes) !== binding.preparedContextSha256 || sha256Hex(result.bytes) !== binding.preparedResultSha256) return { phase }
      phase = 'authority_binding'
      // A creation authority is its public reservation. A recovery authority is
      // the supervisor's private callback scope, which the supervisor itself
      // requalifies against this publication; here only its digest shape is
      // observable.
      if (recovery
        ? !/^[a-f0-9]{64}$/.test(binding.authoritySha256 ?? '')
        : sha256Hex(Buffer.from(JSON.stringify({ kind: 'initial_reservation', reservationId: binding.initialReservationId }))) !== binding.authoritySha256) return { phase }
      let reservationId: string = binding.initialReservationId
      let retained: ClaudeCandidateAuthorization['retained']
      if (recovery) {
        phase = 'retained_generation'
        const priorRoot = path.join(control, 'provider-roots', prior)
        const priorContext = this.fixtureMetadata(path.join(priorRoot, '.freshell/prepared-context.json')).value
        const priorInputs = priorContext.preparedInputs
        // Original creation metadata is carried only by the frozen prior
        // generation; the recovery authority remains its registry attempt.
        if (!priorContext.preparation?.claude || !priorInputs || priorInputs.generationId !== prior
          || priorContext.mcpCapability?.grantId !== prior || !FIXTURE_UUID.test(priorInputs.initialAuthReservation ?? '')) return { phase }
        reservationId = priorInputs.initialAuthReservation
        retained = { attemptId: binding.registryAttemptId, generationId: prior, stageRoot: priorRoot,
          configurationBinds: priorInputs.configBinds ?? [], resourceMounts: priorInputs.resourceMounts ?? [] }
      }
      phase = 'manifest_artifact'
      const manifest = this.fixtureMetadata(path.join(stageRoot, inputs.manifest.relativePath), 64 * 1024 * 1024)
      const binary = fs.lstatSync(owner.hostBinaryPath)
      if (sha256Hex(manifest.bytes) !== binding.manifestSha256 || inputs.manifest.sha256 !== binding.manifestSha256
        || !binary.isFile() || binary.isSymbolicLink() || binary.size > 128 * 1024 * 1024
        || sha256Hex(fs.readFileSync(owner.hostBinaryPath)) !== owner.binarySha256) return { phase }
      phase = 'selected_target'
      const authorization: ClaudeCandidateAuthorization = { ...owner, generationId: grant, stageRoot,
        requestId, reservationId, workspacePath: binding.workspacePath, cwd: binding.cwd,
        gitCommonDir: binding.gitCommonDir === null ? undefined : binding.gitCommonDir, manifestRelativePath: inputs.manifest.relativePath,
        configurationBinds: inputs.configBinds ?? [], resourceMounts: inputs.resourceMounts ?? [],
        ...(retained ? { retained } : {}) }
      this.validateClaudeCandidateAuthorization(authorization, true)
      return { authorization }
    } catch {
      return { phase }
    }
  }

  private async quiescentFixtureOwner(owner: InitialProviderVolumeAuthorization): Promise<BrokerReceipt | undefined> {
    const latest = () => this.receipts().filter(receipt => receipt.installationId === owner.installationId
      && receipt.soulId === owner.soulId).at(-1)
    const prior = latest()
    if (!prior || prior.providerVolumeName !== owner.providerVolumeName || prior.imageRef !== owner.imageRef
      || prior.hostBinaryPath !== owner.hostBinaryPath) return
    const inspected = await this.forward({ method: 'GET',
      url: `${DOCKER_API_PREFIX}/containers/${prior.containerId}/json`, headers: {} } as IncomingMessage, Buffer.alloc(0))
    if (latest() !== prior) return
    let actual: Record<string, any> = {}
    try { actual = JSON.parse(inspected.body.toString()) } catch {}
    const labels = { project: 'freshell', 'com.freshell.managed': 'true',
      'com.freshell.installation-id': prior.installationId, 'com.freshell.soul-id': prior.soulId,
      'com.freshell.incarnation-id': prior.incarnationId, 'com.freshell.runtime-test-run-id': this.policy.testRunId }
    const binary = actual.HostConfig?.Binds?.includes(`${owner.hostBinaryPath}:/runtime/freshell-session-host:ro`)
      || actual.HostConfig?.Mounts?.some((mount: Record<string, any>) => mount.Type === 'bind'
        && mount.Source === owner.hostBinaryPath && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    if (inspected.statusCode !== 404 && (inspected.statusCode !== 200 || actual.Id !== prior.containerId
      || actual.Config?.Image !== prior.imageRef || !ownedHelperLabels(actual.Config?.Labels, labels)
      || !binary || actual.State?.Running !== false || actual.State?.Paused === true
      || actual.State?.Restarting === true || !['created', 'exited', 'dead'].includes(actual.State?.Status))) return
    return prior
  }

  private async registerPublishedFixtureInputs(body: Buffer, url: string): Promise<void> {
    let phase = 'owner'
    try {
      const request = JSON.parse(body.toString())
      const labels = request.Labels ?? {}
      const owner = [...this.initialProviderVolumes.values()].find(source =>
        source.installationId === labels['com.freshell.installation-id']
        && source.soulId === labels['com.freshell.soul-id'])
      if (!owner || (request.Image !== undefined && request.Image !== owner.imageRef)) return
      const candidate = labels['com.freshell.claude-candidate'] === 'ordinary'
      const generation = labels['com.freshell.input-generation']
      const incarnationId = labels['com.freshell.incarnation-id']
      if (candidate && this.claudeCandidates.has(`freshell-claude-candidate-${labels['com.freshell.source-request-id']}`)) return
      if (!candidate && [...this.preparedInputs.values()].some(input => input.installationId === owner.installationId
        && input.soulId === owner.soulId && input.incarnationId === incarnationId
        && (generation === undefined || generation === input.generationId))) return
      const reservation = this.initialReservations.get(owner.providerVolumeName)
      const initial = reservation?.incarnationId === incarnationId
      if (!candidate && !initial) {
        // A replacement has no initial reservation. Qualify the latest owned
        // runtime for this soul, never an earlier quiescent incarnation while
        // its successor is live or has changed ownership.
        const prior = this.receipts().filter(receipt => receipt.installationId === owner.installationId
          && receipt.soulId === owner.soulId).at(-1)
        if (!prior || !incarnationId || prior.incarnationId === incarnationId
          || prior.providerVolumeName !== owner.providerVolumeName || prior.imageRef !== owner.imageRef
          || prior.hostBinaryPath !== owner.hostBinaryPath) return
        phase = 'retained_owner'
        if (await this.quiescentFixtureOwner(owner) !== prior) return
      }
      const root = path.dirname(this.policy.runtimeRootPrefix)
      phase = 'physical_directories'
      const scenarios = this.fixtureDirectories(path.join(root, 'scenarios'), 32)
      for (const scenario of scenarios) {
        const control = path.join(root, 'scenarios', scenario, 'control')
        for (const grant of this.fixtureDirectories(path.join(control, 'provider-roots'), 128)) {
          if (!/^grant-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(grant)
            || (generation !== undefined && generation !== grant)) continue
          const stageRoot = path.join(control, 'provider-roots', grant)
          phase = 'capability_metadata'
          const capability = this.fixtureMetadata(path.join(control, 'mcp-capabilities', `${grant}.json`), 128 * 1024).value
          if (capability.soulId !== owner.soulId || (capability.incarnationId != null
            && capability.incarnationId !== incarnationId)) continue
          const contextDocument = this.fixtureMetadata(path.join(stageRoot, '.freshell/prepared-context.json'))
          phase = 'prepared_metadata'
          const resultDocument = this.fixtureMetadata(path.join(stageRoot, '.freshell/prepared-result.json'))
          const context = contextDocument.value
          const result = resultDocument.value
          const inputs = context.preparedInputs
          if (!inputs || inputs.generationId !== grant || context.mcpCapability?.grantId !== grant
            || JSON.stringify(result.providerLaunchContext) !== JSON.stringify(context)
            || !Array.isArray(result.providerSecretReferences)
            || inputs.manifest?.relativePath !== '.freshell/input-manifest.json') continue
          const manifest = this.fixtureMetadata(path.join(stageRoot, inputs.manifest.relativePath), 64 * 1024 * 1024)
          phase = 'manifest_hash'
          if (sha256Hex(manifest.bytes) !== inputs.manifest.sha256) continue
          phase = 'host_artifact'
          const binary = fs.lstatSync(owner.hostBinaryPath)
          if (!binary.isFile() || binary.isSymbolicLink() || binary.size > 128 * 1024 * 1024
            || sha256Hex(fs.readFileSync(owner.hostBinaryPath)) !== owner.binarySha256) continue
          if (candidate) {
            phase = 'candidate_binding'
            const qualified = this.qualifyPublishedClaudeCandidate(control, grant, labels['com.freshell.source-request-id'])
            if (!('authorization' in qualified) || qualified.authorization.soulId !== owner.soulId
              || !equalRecord(labels, candidateLabels(qualified.authorization, this.policy.testRunId))) continue
            phase = 'candidate_authorization'
            this.registerClaudeCandidate(qualified.authorization, true)
          } else {
            if (initial ? inputs.initialAuthReservation !== reservation!.reservationId
              : inputs.initialAuthReservation != null) continue
            const indexedSecretSources: { grantIndex: number; sourceId: number }[] = []
            result.providerSecretReferences.forEach((reference: Record<string, any>, grantIndex: number) => {
              if (!['claude_configuration_file', 'codex_configuration_file', 'opencode_configuration_file', 'amplifier_configuration_file'].includes(reference.profile)) return
              const source = reference.providerRelativePath?.match(/^\.freshell\/references\/(\d+)$/)?.[1]
              if (source === undefined) throw new Error('fixture configuration source index invalid')
              indexedSecretSources.push({ grantIndex, sourceId: Number(source) })
            })
            if (indexedSecretSources.length !== inputs.manifest.sourceCount) continue
            phase = 'prepared_authorization'
            this.authorizePreparedInputs({ ...owner, incarnationId, generationId: grant, stageRoot,
              configurationBinds: (inputs.configBinds ?? []).map((bind: Record<string, any>) => ({
                sourceRelativePath: bind.sourceRelativePath, effectiveDestination: bind.effectiveDestination,
              })), resourceMounts: (inputs.resourceMounts ?? []).map((mount: Record<string, any>) => ({
                providerRelativePath: mount.providerRelativePath, effectiveDestination: mount.effectiveDestination,
                kind: mount.kind, writable: mount.writable,
              })), indexedFiles: inputs.indexedFiles, indexedSecretSources,
            })
          }
          return
        }
      }
      this.record({ method: 'POST', url, decision: 'block', reason: `fixture publication unavailable at ${phase}`, destructive: false, unsafeAttempt: false })
    } catch (error) {
      // Keep fixed categories and the rejected pathname, never input contents
      // or arbitrary exception messages.
      const categories: Record<string, string> = {
        'prepared input owner/stage is outside this fixture run': 'owner_or_stage',
        'prepared input metadata exceeds control profile': 'metadata_limit',
        'prepared input target is outside selected fixture roots': 'target_root',
        'prepared input target is duplicated': 'duplicate_target',
        'prepared template source is invalid': 'invalid_template_source',
        'prepared resource source is invalid': 'invalid_resource_source',
        'prepared indexed volume identity/profile is invalid': 'indexed_identity_or_profile',
        'prepared indexed source id is invalid': 'indexed_source_id',
        'prepared private source has no indexed volume': 'missing_indexed_volume',
        'prepared private input index is invalid': 'private_input_index',
        'prepared input generation changed; reconcile before replacement': 'changed_generation',
      }
      const category = error instanceof Error ? categories[error.message] ?? 'unclassified' : 'unclassified'
      const target = error instanceof PreparedInputTargetError ? {
        targetPath: diagnosticPath(error.targetPath),
        preparationStageRoot: diagnosticPath(error.preparationStageRoot),
        selectedWorkspaceRoots: [...this.policy.allowedWorkspaceRoots ?? []]
          .filter(root => diagnosticPath(root) !== undefined),
        selectedProviderInputRoots: [...this.policy.allowedProviderInputRoots ?? []]
          .filter(root => diagnosticPath(root) !== undefined),
      } : {}
      this.record({ method: 'POST', url, decision: 'block', reason: `fixture publication unavailable at ${phase}: ${category}`,
        ...target, destructive: false, unsafeAttempt: false })
    }
  }

  private fixtureDirectories(directory: string, limit: number): string[] {
    if (!fs.existsSync(directory)) return []
    this.physicalFixturePath(directory)
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    if (entries.length > limit || entries.some(entry => entry.isSymbolicLink())) throw new Error('fixture directory profile invalid')
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  }

  private physicalFixturePath(file: string): void {
    const root = path.dirname(this.policy.runtimeRootPrefix)
    const relative = path.relative(root, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('fixture metadata outside owned root')
    let parent = root
    const owner = fs.lstatSync(root).uid
    for (const part of relative.split(path.sep)) {
      parent = path.join(parent, part)
      const stat = fs.lstatSync(parent)
      if (stat.isSymbolicLink() || stat.uid !== owner) throw new Error('fixture metadata physical owner changed')
    }
  }

  private fixtureMetadata(file: string, limit = 1024 * 1024): { value: Record<string, any>; bytes: Buffer } {
    this.physicalFixturePath(file)
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile() || stat.size > limit) throw new Error('fixture metadata profile exceeded')
      const bytes = Buffer.alloc(stat.size)
      if (fs.readSync(descriptor, bytes) !== stat.size || fs.readSync(descriptor, Buffer.alloc(1)) !== 0) throw new Error('fixture metadata changed')
      const value = JSON.parse(bytes.toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fixture metadata invalid')
      return { value, bytes }
    } finally { fs.closeSync(descriptor) }
  }

  private validateStoppedRepairHelper(name: string, body: Buffer): BrokerReceipt | undefined {
    if (!/^freshell-opencode-repair-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) return
    let parsed: Record<string, any>
    try { parsed = JSON.parse(body.toString('utf8')) } catch { return }
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected)
    const host = parsed.HostConfig ?? {}
    const workspace = parsed.Cmd?.[4]
    const cwd = parsed.WorkingDir
    if (parsed.User !== '0:0' || parsed.Tty !== false || Object.keys(parsed.Labels ?? {}).length !== 0
      || !same(parsed.Entrypoint, ['/runtime/freshell-session-host'])
      || typeof workspace !== 'string' || path.normalize(workspace) !== workspace || !this.isAllowedWorkspacePath(workspace)
      || typeof cwd !== 'string' || path.normalize(cwd) !== cwd
      || !(cwd === workspace || isStrictDescendant(cwd, workspace))
      || !same(parsed.Cmd, ['opencode-stopped-repair-worker', '--stage-dir', '/run/freshell-opencode-transfer',
        '--workspace-root', workspace, '--expected-cwd', cwd, '--provider-uid', '65534', '--provider-gid', '0'])
      || !this.validHistoryHelperHost(host, false, ['SETUID', 'SETGID'])
      || (host.PortBindings && Object.keys(host.PortBindings).length > 0)
      || (host.ExtraHosts?.length ?? 0) !== 0) return
    const mounts: Record<string, any>[] = host.Mounts
    if (!Array.isArray(mounts) || ![4, 5].includes(mounts.length)
      || new Set(mounts.map(mount => mount.Target)).size !== mounts.length) return
    const binary = mounts.find(mount => mount.Type === 'bind' && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    const volume = mounts.find(mount => mount.Type === 'volume' && mount.Target === '/home/freshell/provider' && mount.ReadOnly === false)
    const stage = mounts.find(mount => mount.Type === 'bind' && mount.Target === '/run/freshell-opencode-transfer' && mount.ReadOnly === true)
    const workspaceMount = mounts.find(mount => mount.Type === 'bind' && mount.Source === workspace && mount.Target === workspace && mount.ReadOnly === true)
    if (!binary || !volume || !stage || !workspaceMount || typeof stage.Source !== 'string'
      || path.normalize(stage.Source) !== stage.Source || !/^(?:opencode-transfer-[a-zA-Z0-9-]+|stopped-repair-[a-f0-9]{48})\.ready$/.test(path.basename(stage.Source))) return
    if (mounts.length === 5) {
      const git = mounts.find(mount => mount !== binary && mount !== volume && mount !== stage && mount !== workspaceMount)
      if (!git || git.Type !== 'bind' || git.ReadOnly !== true || git.Source !== git.Target
        || typeof git.Source !== 'string' || path.normalize(git.Source) !== git.Source
        || !this.isAllowedWorkspacePath(git.Source) || git.Source === workspace || isStrictDescendant(git.Source, workspace)) return
    }
    const requiredEnv = new Map([
      ['HOME', '/home/freshell/provider'], ['XDG_DATA_HOME', '/home/freshell/provider/.local/share'],
      ['XDG_CONFIG_HOME', '/home/freshell/provider/.config'], ['OPENCODE_DB', '/home/freshell/provider/.local/share/opencode/opencode.db'],
    ])
    // Production clones terminal.env, then forces these four locations. The ordinary host's Env is a different projection.
    if (!Array.isArray(parsed.Env) || parsed.Env.some((value: unknown) => typeof value !== 'string' || value.indexOf('=') < 1 || value.includes('\0'))) return
    const env: string[] = parsed.Env
    const keys = env.map(value => value.slice(0, value.indexOf('=')))
    if (new Set(keys).size !== keys.length || [...requiredEnv].some(([key, value]) => !env.includes(`${key}=${value}`))) return
    return this.receipts().find(receipt => receipt.imageRef === parsed.Image && receipt.hostBinaryPath === binary.Source
      && receipt.providerVolumeName === volume.Source && receipt.workspacePath === workspace
      && path.dirname(stage.Source) === path.join(path.dirname(receipt.runtimeDir), 'opencode-transfers'))
  }

  private validateHistoryHelper(name: string, body: Buffer): BrokerReceipt | undefined {
    if (!/^freshell-history-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) return
    let parsed: Record<string, any>
    try { parsed = JSON.parse(body.toString('utf8')) } catch { return }
    const host = parsed.HostConfig ?? {}
    if (Object.keys(parsed.Labels ?? {}).length !== 0) return
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected)
    if (same(parsed.Entrypoint, ['node'])) return this.validateNodeHistoryHelper(parsed)
    if (parsed.User !== '65534:0'
      || !same(parsed.Entrypoint, ['/runtime/freshell-session-host'])) return
    const cmd = parsed.Cmd
    const retained = Array.isArray(cmd) && cmd.length === 2 && cmd[0] === 'retained-opencode-store-worker'
    if (parsed.Tty !== !retained) return
    let selected: Record<string, any> | undefined
    if (retained) {
      if (typeof cmd[1] !== 'string' || Buffer.byteLength(cmd[1]) > 8192) return
      try { selected = JSON.parse(cmd[1]) } catch { return }
      if (!selected || Object.keys(selected).sort().join(',') !== 'cwd,imageRef,nativeSessionId,providerGid,providerHome,providerStoreId,providerUid,workspacePath'
        || selected.imageRef !== parsed.Image || !/^sha256:[a-f0-9]{64}$/.test(selected.imageRef)
        || selected.providerHome !== '/home/freshell/provider' || selected.providerUid !== 65534 || selected.providerGid !== 0
        || typeof selected.providerStoreId !== 'string' || !selected.providerStoreId || selected.providerStoreId.length > 256
        || typeof selected.nativeSessionId !== 'string' || !/^ses_[A-Za-z0-9_-]{1,252}$/.test(selected.nativeSessionId)
        || typeof selected.workspacePath !== 'string' || path.normalize(selected.workspacePath) !== selected.workspacePath || !this.isAllowedWorkspacePath(selected.workspacePath)
        || typeof selected.cwd !== 'string' || path.normalize(selected.cwd) !== selected.cwd
        || !(selected.cwd === selected.workspacePath || isStrictDescendant(selected.cwd, selected.workspacePath))
        || parsed.WorkingDir !== selected.cwd
        // Docker CLI serializes its environment map in arbitrary order.
        // Sorting keeps the exact four entries, including duplicate rejection.
        || !Array.isArray(parsed.Env)
        || !same([...parsed.Env].sort(), ['HOME=/home/freshell/provider', 'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db', 'XDG_CONFIG_HOME=/home/freshell/provider/.config', 'XDG_DATA_HOME=/home/freshell/provider/.local/share'])) return
    } else if (!Array.isArray(cmd) || cmd.length !== 7 || cmd[0] !== 'native-history-only'
      || cmd[1] !== '--provider' || !['claude', 'kilroy', 'codex', 'opencode'].includes(cmd[2])
      || cmd[3] !== '--session-id' || typeof cmd[4] !== 'string' || !cmd[4]
      || cmd[5] !== '--provider-home' || cmd[6] !== '/home/freshell/provider'
      || !same(parsed.Env, ['HOME=/home/freshell/provider'])) return
    if (!this.validHistoryHelperHost(host, retained)) return
    const mounts = host.Mounts
    if (!Array.isArray(mounts) || (retained ? ![3, 4].includes(mounts.length) : mounts.length !== 2)) return
    const binary = mounts.find((mount) => mount.Type === 'bind' && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    const volume = mounts.find((mount) => mount.Type === 'volume' && mount.Target === '/home/freshell/provider' && mount.ReadOnly === true)
    if (!binary || !volume || !this.policy.allowedHostBinaryPaths.has(binary.Source) || !this.policy.allowedImageRefs.has(parsed.Image)) return
    if (retained) {
      const workspace = mounts.find((mount) => mount.Type === 'bind' && mount.Source === selected!.workspacePath && mount.Target === selected!.workspacePath && mount.ReadOnly === true)
      if (!workspace || new Set(mounts.map((mount) => mount.Target)).size !== mounts.length) return
      if (mounts.length === 4) {
        const git = mounts.find((mount) => mount !== binary && mount !== volume && mount !== workspace)
        if (!git || git.Type !== 'bind' || git.ReadOnly !== true || git.Source !== git.Target
          || !this.isAllowedWorkspacePath(git.Source) || isStrictDescendant(git.Source, workspace.Source)) return
      }
      return this.receipts().find((receipt) => receipt.providerVolumeName === volume.Source && receipt.workspacePath === workspace.Source)
    }
    return this.receipts().find((receipt) => receipt.providerVolumeName === volume.Source
      && receipt.imageRef === parsed.Image && receipt.hostBinaryPath === binary.Source)
  }

  private validateAuthHelper(name: string, body: Buffer): BrokerReceipt | undefined {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
    if (!new RegExp(`^freshell-auth-${uuid}$`).test(name)) return
    let parsed: Record<string, any>
    try { parsed = JSON.parse(body.toString('utf8')) } catch { return }
    const host = parsed.HostConfig ?? {}
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected)
    if (Object.keys(parsed.Labels ?? {}).length !== 0 || parsed.User !== '65534:0' || parsed.Tty !== false
      || !same(parsed.Entrypoint, ['/runtime/freshell-session-host']) || !same(parsed.Cmd, ['native-auth-only'])
      || !privateHelperEnvironment(parsed.Env,true)) return
    if (host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true || host.Privileged === true
      || (host.PidMode ?? '') !== '' || (host.Binds?.length ?? 0) !== 0 || (host.CapAdd?.length ?? 0) !== 0
      || !same(host.CapDrop, ['ALL']) || !same(host.SecurityOpt, ['no-new-privileges'])
      || host.Memory !== 256 * 1024 * 1024 || host.MemorySwap !== 256 * 1024 * 1024
      || host.NanoCpus !== 500_000_000 || host.PidsLimit !== 32 || Object.keys(host.Tmpfs ?? {}).length !== 0
      || !same(host.LogConfig, { Type: 'none', Config: {} })) return
    const mounts = host.Mounts
    if (!Array.isArray(mounts) || mounts.length !== 3) return
    const binary = mounts.find((mount) => mount.Type === 'bind' && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    const volume = mounts.find((mount) => mount.Type === 'volume' && mount.Target === '/home/freshell/provider' && mount.ReadOnly === true && same(mount.VolumeOptions, { NoCopy: true }))
    const exchange = mounts.find((mount) => mount.Type === 'bind' && mount.Target === '/run/freshell-auth-exchange' && mount.ReadOnly === true)
    if (!binary || !volume || !exchange || typeof exchange.Source !== 'string'
      || !this.isAllowedExchangeSource(exchange.Source, 'freshell-auth')
      || !this.policy.allowedHostBinaryPaths.has(binary.Source) || !this.policy.allowedImageRefs.has(parsed.Image)) return
    return this.receipts().find((receipt) => receipt.providerVolumeName === volume.Source
      && receipt.imageRef === parsed.Image && receipt.hostBinaryPath === binary.Source)
  }

  private validHistoryHelperHost(host: Record<string, any>, retained: boolean, capAdd: string[] = []): boolean {
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected)
    return host.NetworkMode === 'none' && host.ReadonlyRootfs === true && host.Privileged !== true
      && (host.PidMode ?? '') === '' && (host.Binds?.length ?? 0) === 0 && same(host.CapAdd ?? [], capAdd)
      && same(host.CapDrop, ['ALL']) && same(host.SecurityOpt, ['no-new-privileges'])
      && host.Memory === 256 * 1024 * 1024 && host.MemorySwap === 256 * 1024 * 1024
      && host.NanoCpus === 500_000_000 && host.PidsLimit === 32
      && same(host.Tmpfs, { '/tmp': retained ? 'rw,noexec,nosuid,nodev,size=64m' : 'rw,noexec,nosuid,nodev,size=16m' })
  }

  private validateNodeHistoryHelper(parsed: Record<string, any>): BrokerReceipt | undefined {
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected)
    const host = parsed.HostConfig ?? {}
    const cmd = parsed.Cmd
    const semantic = Array.isArray(cmd) && cmd.length === 7 && cmd[2] === TASK007_BATCH_STORE_PROBE
    const workspace = semantic ? cmd[6] : parsed.WorkingDir
    if (typeof workspace !== 'string' || path.normalize(workspace) !== workspace || !this.isAllowedWorkspacePath(workspace)) return
    const sources: Record<string, string> = {
      claude: '/home/freshell/provider/.claude/projects', codex: '/home/freshell/provider/.codex/sessions',
      opencode: '/home/freshell/provider/.local/share/opencode/opencode.db', amplifier: '/home/freshell/provider/.amplifier/projects',
    }
    // Read the owner binding only when handling a request, after both ESM
    // modules initialize; the helper admits no caller-selected script.
    const batch = Array.isArray(cmd) && (cmd.length === 5 || semantic) && cmd[0] === '--no-warnings' && cmd[1] === '-e'
      && cmd[2] === TASK007_BATCH_STORE_PROBE && cmd[3] === sources.opencode
      && typeof cmd[4] === 'string' && /^ses_[A-Za-z0-9_-]{1,252}$/.test(cmd[4])
      && (!semantic || cmd[5] === '/run/freshell-opencode-reader.frame')
      && typeof parsed.Image === 'string' && /^sha256:[a-f0-9]{64}$/.test(parsed.Image)
    const native = typeof workspace === 'string' && Array.isArray(cmd) && cmd.length === 5
      && cmd[0] === '--no-warnings'
      && cmd[1] === path.join(workspace, 'dist', `native-history-${this.policy.testRunId}`, 'probe-cli.mjs')
      && typeof cmd[2] === 'string' && Object.hasOwn(sources, cmd[2]) && cmd[3] === sources[cmd[2]]
      && typeof cmd[4] === 'string' && cmd[4].length > 0
    if ((!batch && !native) || parsed.User !== '65534:0' || parsed.Tty !== !batch || !this.validHistoryHelperHost(host, false)
      || !Array.isArray(parsed.Env) || !same([...parsed.Env].sort(), semantic ? ['HOME=/home/freshell/provider', 'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db', 'XDG_CONFIG_HOME=/home/freshell/provider/.config', 'XDG_DATA_HOME=/home/freshell/provider/.local/share'] : ['HOME=/home/freshell/provider'])
      || (semantic && (typeof parsed.WorkingDir !== 'string' || path.normalize(parsed.WorkingDir) !== parsed.WorkingDir
        || !(parsed.WorkingDir === workspace || isStrictDescendant(parsed.WorkingDir, workspace))))
      || !this.policy.allowedImageRefs.has(parsed.Image)) return
    const mounts = host.Mounts
    if (!Array.isArray(mounts) || mounts.length !== (semantic ? 4 : 2) || new Set(mounts.map(mount => mount.Target)).size !== mounts.length) return
    const volume = mounts.find(mount => mount.Type === 'volume' && mount.Target === '/home/freshell/provider' && mount.ReadOnly === true)
    const source = mounts.find(mount => mount.Type === 'bind' && mount.Source === workspace && mount.Target === workspace && mount.ReadOnly === true)
    if (!volume || !source) return
    const binary = semantic && mounts.find(mount => mount.Type === 'bind' && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    const descriptor = semantic && mounts.find(mount => mount.Type === 'bind' && mount.Target === '/run/freshell-opencode-reader.frame' && mount.ReadOnly === true)
    if (semantic && (!binary || !descriptor || !this.policy.allowedHostBinaryPaths.has(binary.Source))) return
    return this.receipts().find(receipt => receipt.providerVolumeName === volume.Source
      && receipt.workspacePath === workspace && receipt.imageRef === parsed.Image
      && (!semantic || (binary.Source === receipt.hostBinaryPath
        && descriptor.Source === path.join(receipt.runtimeDir, 'task007-reader-descriptor.frame'))))
  }

  private isAllowedWorkspacePath(candidate: string): boolean {
    const roots = this.policy.allowedWorkspaceRoots ?? new Set<string>()
    for (const root of roots) {
      if (candidate === root || isStrictDescendant(candidate, root)) return true
    }
    return false
  }

  private isAllowedProviderInputPath(candidate: string): boolean {
    const roots = this.policy.allowedProviderInputRoots ?? new Set<string>()
    for (const root of roots) {
      if (candidate === root || isStrictDescendant(candidate, root)) return true
    }
    return false
  }

  private isAllowedExchangeSource(source: unknown, prefix: 'freshell-inputs' | 'freshell-auth'): source is string {
    if (typeof source !== 'string' || path.normalize(source) !== source
      || !new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).test(path.basename(source))) return false
    if (path.dirname(source) === os.tmpdir()) return true
    if (path.dirname(source) !== path.dirname(this.policy.runtimeRootPrefix)) return false
    try {
      this.physicalFixturePath(source)
      return fs.lstatSync(source).isDirectory()
    } catch { return false }
  }

  /** Called only for the already validated fixed helpers; never persist daemon payloads. */
  private helperRejectionReason(response: DockerResponse, expected: Record<string, any>): string | undefined {
    if (response.statusCode === 201) return
    let missingBindSource = false
    if (response.body.length <= 64 * 1024) {
      try {
        const message = JSON.parse(response.body.toString()).message
        missingBindSource = typeof message === 'string'
          && message.startsWith('invalid mount config for type "bind": bind source path does not exist:')
      } catch {}
    }
    const exchange = expected.HostConfig.Mounts.find((mount: Record<string, any>) =>
      mount.Type === 'bind' && ['/run/freshell-source-exchange', '/run/freshell-input-exchange'].includes(mount.Target))
    const hostExists = exchange ? fs.existsSync(exchange.Source) : false
    return `upstream helper rejected: status=${response.statusCode}; cause=${missingBindSource ? 'missing_bind_source' : 'unclassified'}; ownedExchangeHostExists=${hostExists}`
  }

  private async forwardAndReply(request: IncomingMessage, response: ServerResponse, body: Buffer, event: { destructive: boolean; containerId?: string; helperName?:string; ownerContainerId?: string }): Promise<void> {
    const forwarded = await this.forward(request, body)
    this.record({ method: request.method ?? 'GET', url: request.url ?? '/', decision: 'forward', destructive: event.destructive, unsafeAttempt: false, containerId: event.containerId,helperName:event.helperName, ownerContainerId:event.ownerContainerId })
    replyDocker(response, forwarded)
  }

  private forward(request: IncomingMessage, body: Buffer): Promise<DockerResponse> {
    if (this.drainExpired) return Promise.reject(new Error('broker cleanup deadline expired'))
    const requestId = `${this.policy.testRunId}:${++this.transportSequence}`
    const started = performance.now()
    const elapsed = () => Math.max(0, performance.now() - started)
    const transportPhases: TransportPhases = {
      socketAssignedMs: null, socketConnectMs: null,
      requestFinishedMs: null, responseHeadersMs: null,
      responseEndMs: null, reusedSocket: false,
      socketConnectingAtAssignment: null,
    }
    const address = { requestId, method: request.method ?? 'GET', ...transportAddress(request.url ?? '/') }
    this.recordTransport('request_started', 'info', address)
    return new Promise((resolve, reject) => {
      let result: DockerResponse | undefined
      let failure: string | undefined
      const upstream = http.request({
        socketPath: this.policy.realSocketPath,
        path: request.url,
        method: request.method,
        headers: sanitizeHeaders(request.headers, body.length),
      }, (upstreamResponse) => {
        transportPhases.responseHeadersMs = elapsed()
        const chunks: Buffer[] = []
        upstreamResponse.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        upstreamResponse.once('end', () => {
          transportPhases.responseEndMs = elapsed()
          result = { statusCode: upstreamResponse.statusCode ?? 500, headers: upstreamResponse.headers, body: Buffer.concat(chunks) }
        })
        const failResponse = () => { failure ??= 'upstream_response_incomplete'; upstream.destroy() }
        upstreamResponse.once('aborted', failResponse)
        upstreamResponse.once('error', failResponse)
        upstreamResponse.once('close', () => { if (!upstreamResponse.complete) failResponse() })
      })
      this.upstreamRequests.add(upstream)
      upstream.once('socket', socket => {
        transportPhases.socketAssignedMs = elapsed()
        transportPhases.reusedSocket = upstream.reusedSocket
        transportPhases.socketConnectingAtAssignment = socket.connecting
        if (socket.connecting) socket.once('connect', () => { transportPhases.socketConnectMs = elapsed() })
      })
      upstream.once('finish', () => { transportPhases.requestFinishedMs = elapsed() })
      upstream.once('error', () => { failure ??= this.drainExpired ? 'cleanup_deadline' : 'upstream_request_failed' })
      upstream.once('close', () => {
        this.upstreamRequests.delete(upstream)
        this.recordTransport('request_completed', result && !failure ? 'info' : 'warn', {
          ...address, durationMs: elapsed(), transportPhases,
          ...(result && !failure ? { statusCode: result.statusCode } : { errorCategory: failure ?? 'upstream_response_incomplete' }),
        })
        if (result && !failure) { resolve(result); return }
        const details: BrokerSettlementFailure = { method: request.method ?? 'GET', url: request.url ?? '/',
          reason: failure ?? 'upstream_response_incomplete',
          allocationUnknown: request.method === 'POST' && !!request.url?.startsWith(`${DOCKER_API_PREFIX}/containers/create?`) }
        this.settlementFailures.push(details)
        try {
          this.record({ ...details, decision: 'block', destructive: false, unsafeAttempt: false })
          reject(new Error(details.reason))
        } catch (error) {
          reject(error)
        }
      })
      if (body.length > 0) upstream.write(body)
      upstream.end()
    })
  }

  /** Transport diagnostics do not enter the ownership/cleanup receipt stream. */
  private recordTransport(phase: 'request_started' | 'request_completed', severity: 'info' | 'warn', fields: {
    requestId: string; method: string; route: string; containerId?: string; stopGraceSeconds?: number; durationMs?: number; statusCode?: number; errorCategory?: string
    transportPhases?: TransportPhases
  }): void {
    const entry = { at: new Date().toISOString(), severity, event: `runtime.broker.${phase}`, ...fields }
    try {
      fs.appendFileSync(this.policy.logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      fs.chmodSync(this.policy.logPath, 0o600)
    } catch {
      process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'runtime.broker.transport_logging_failed',
        runId: this.policy.testRunId, requestId: fields.requestId, phase })}\n`)
    }
  }

  private block(response: ServerResponse, method: string, url: string, status: number, reason: string, destructive: boolean, containerId?: string): void {
    this.record({ method, url, decision: 'block', reason, destructive, unsafeAttempt: destructive, containerId })
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ message: reason }))
  }

  private record(event: Omit<BrokerEvent, 'at' | 'severity'>): void {
    const full: BrokerEvent = { at: new Date().toISOString(), severity: event.decision === 'forward' ? 'info' : 'warn', ...event }
    this.events.push(full)
    fs.appendFileSync(this.policy.logPath, `${JSON.stringify(full)}\n`, { mode: 0o600 })
    fs.chmodSync(this.policy.logPath, 0o600)
  }
}

/** Only fixed actions, exact container IDs and numeric Stop grace belong in diagnostics. */
function transportAddress(url: string): { route: string; containerId?: string; stopGraceSeconds?: number } {
  const parsed = new URL(url, 'http://docker')
  if (parsed.pathname === '/_ping') return { route: 'daemon_ping' }
  if (parsed.pathname === `${DOCKER_API_PREFIX}/info`) return { route: 'daemon_info' }
  if (parsed.pathname === `${DOCKER_API_PREFIX}/containers/create`) return { route: 'container_create' }
  if (parsed.pathname.startsWith(`${DOCKER_API_PREFIX}/volumes/`)) return { route: 'volume_inspect' }
  const target = parsed.pathname.match(/^\/v1\.47\/containers\/([^/]+)(?:\/(json|start|stop|kill|unpause|update|wait|logs))?$/)
  const action = target?.[2] ?? 'remove'
  const containerId = target && /^[a-f0-9]{64}$/.test(target[1]) ? target[1] : undefined
  const grace = parsed.searchParams.get('t')
  const stopGraceSeconds = action === 'stop' && grace !== null && /^\d+$/.test(grace) && Number.isSafeInteger(Number(grace)) ? Number(grace) : undefined
  return { route: target ? `container_${action}` : 'unknown',
    ...(containerId ? { containerId } : {}), ...(stopGraceSeconds !== undefined ? { stopGraceSeconds } : {}) }
}

function parseContainerTarget(url: string): { containerId: string; action: string } | undefined {
  const match = url.match(/^\/v1\.47\/containers\/([0-9a-f]{64})\/(json|start|stop|kill|unpause|update)(?:\?.*)?$/)
  return match ? { containerId: match[1], action: match[2] } : undefined
}

function isDestructiveDockerRequest(method: string, action?: string): boolean {
  return method === 'POST' && ['start', 'stop', 'kill', 'unpause', 'update'].includes(action ?? '')
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders, bodyLength: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  if (headers['content-type']) out['content-type'] = headers['content-type']
  out['content-length'] = bodyLength
  out.host = 'docker'
  out.connection = 'close'
  return out
}

function replyDocker(response: ServerResponse, forwarded: DockerResponse): void {
  response.statusCode = forwarded.statusCode
  for (const [key, value] of Object.entries(forwarded.headers)) {
    if (value !== undefined && !['transfer-encoding', 'connection', 'content-length'].includes(key.toLowerCase())) response.setHeader(key, value)
  }
  response.setHeader('content-length', forwarded.body.length)
  response.end(forwarded.body)
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) throw new Error(`request body exceeds ${MAX_REQUEST_BYTES} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function stringField(object: Record<string, unknown>, key: string): string {
  const value = object[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Secret-mask destinations the supervisor mounts over the read-only operator
 * home. Mirrors OPERATOR_HOME_MASK_REL_PATHS in
 * crates/freshell-supervisor/src/backend/docker.rs; the supervisor filters
 * these to destinations that exist, and always mounts them with empty
 * (default) tmpfs options.
 */
const OPERATOR_HOME_MASK_REL_PATHS = ['.freshell', '.amplifier/onecli', '.config/gcloud']

function isOperatorHomeMaskDestination(destination: string, roots?: Set<string>): boolean {
  if (!roots) return false
  for (const root of roots) {
    for (const relative of OPERATOR_HOME_MASK_REL_PATHS) {
      if (destination === `${root}/${relative}`) return true
    }
  }
  return false
}

function isStrictDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function sha256(bytes: Buffer): string {
  return `sha256:${sha256Hex(bytes)}`
}

const FIXTURE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const FIXTURE_GRANT = /^grant-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
