import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const DOCKER_API_PREFIX = '/v1.47'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const INDEXED_TMPFS_OPTIONS = 'size=64m,mode=0700,uid=65534,gid=0,nr_inodes=1024,nosuid,nodev,noexec'

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

function preparedMountsMatch(actual: unknown[], input: PreparedInputAuthorization): boolean {
  const expected: Record<string, unknown>[] = input.configurationBinds.map((bind) => ({
    Type: 'bind', Source: path.join(input.stageRoot, bind.sourceRelativePath), Target: bind.effectiveDestination, ReadOnly: true,
  }))
  expected.push(...input.resourceMounts.map((mount) => ({
    Type: 'volume', Source: input.providerVolumeName, Target: mount.effectiveDestination, ReadOnly: mount.kind === 'file',
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

export type BrokerReceipt = {
  containerId: string
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
  method: string
  url: string
  decision: 'forward' | 'block' | 'inject_failure'
  reason?: string
  containerId?: string
  ownerContainerId?: string
  helperName?: string
  requestDigest?: string
  providerVolumeName?: string
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
  allowedWorkspaceRoots?: Set<string>
  allowedProviderUserRoots?: Set<string>
  allowedBootstrapFiles?: Set<string>
  allowedHostGatewayAddresses?: Set<string>
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
  resourceMounts: { providerRelativePath: string; effectiveDestination: string; kind: 'file' | 'directory' }[]
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

/** Metadata for the fixed initial Claude candidate, before a workload exists. */
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
}

function candidateVolumeName(input: ClaudeCandidateAuthorization): string {
  return `freshell-claude-candidate-${input.requestId}`
}
function candidateLabels(input: ClaudeCandidateAuthorization, runId: string): Record<string, string> {
  return { 'com.freshell.installation-id': input.installationId, 'com.freshell.soul-id': input.soulId,
    'com.freshell.runtime-test-run-id': runId, 'com.freshell.source-request-id': input.requestId,
    'com.freshell.source-binary-sha256': input.binarySha256, 'com.freshell.input-generation': input.generationId,
    'com.freshell.source-reservation-id': input.reservationId, 'com.freshell.claude-candidate': 'ordinary' }
}

type DockerResponse = {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export class RestrictedDockerBroker {
  private readonly claudeCandidates = new Map<string, ClaudeCandidateAuthorization>()
  private readonly candidateVolumes = new Set<string>()
  private readonly initialProviderVolumes = new Map<string,InitialProviderVolumeAuthorization>()
  private readonly preparedInputs = new Map<string, PreparedInputAuthorization>()
  private readonly inputVolumes = new Set<string>()
  private readonly inputPublishers = new Map<string, {
    input: PreparedInputAuthorization
    expected: Record<string, any>
    containerId?: string
  }>()
  private readonly knownContainerIds = new Set<string>()
  private readonly receiptsById = new Map<string, BrokerReceipt>()
  private readonly historyHelpers = new Map<string, { owner: BrokerReceipt; containerId?: string; kind: 'history' | 'auth' }>()
  private readonly claudeSourceHelpers = new Map<string, { expected: Record<string, any>; containerId?: string }>()
  private readonly events: BrokerEvent[] = []
  private server?: http.Server
  private stopFailuresRemaining = 0

  constructor(private readonly policy: RestrictedDockerBrokerPolicy) {}

  authorizeClaudeCandidate(input: ClaudeCandidateAuthorization): void {
    const initial = this.initialProviderVolumes.get(input.providerVolumeName)
    const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
    const fixture = path.dirname(this.policy.runtimeRootPrefix)
    const relative = path.relative(fixture, input.stageRoot)
    const destination = (value: string) => typeof value === 'string' && path.isAbsolute(value)
      && path.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value)
      && (value === input.workspacePath || isStrictDescendant(value, input.workspacePath)
        || [...this.policy.allowedProviderUserRoots ?? []].some((root) => value === root || isStrictDescendant(value, root)))
    const unit = (value: string, prefix: string, file = false) => typeof value === 'string'
      && new RegExp(`^${prefix}/[a-zA-Z0-9_-]{1,128}${file ? '/source' : ''}$`).test(value)
    if (!initial || !['installationId','soulId','imageRef','hostBinaryPath','binarySha256','daemonId'].every((key) => input[key as keyof InitialProviderVolumeAuthorization] === initial[key as keyof InitialProviderVolumeAuthorization])
      || !uuid(input.requestId) || !uuid(input.reservationId) || !input.generationId.startsWith('grant-') || !uuid(input.generationId.slice(6))
      || relative !== `scenarios/${relative.split('/')[1]}/control/provider-roots/${input.generationId}`
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(relative.split('/')[1] ?? '')
      || !this.policy.allowedWorkspaceRoots?.has(input.workspacePath) || !destination(input.cwd)
      || !(input.cwd === input.workspacePath || isStrictDescendant(input.cwd, input.workspacePath))
      || (input.gitCommonDir !== undefined && (!path.isAbsolute(input.gitCommonDir) || path.normalize(input.gitCommonDir) !== input.gitCommonDir
        || /[\x00-\x1f\x7f]/.test(input.gitCommonDir) || !(input.gitCommonDir === input.workspacePath || isStrictDescendant(input.gitCommonDir, input.workspacePath) || isStrictDescendant(input.gitCommonDir, fixture))))
      || input.manifestRelativePath !== '.freshell/input-manifest.json'
      || !Array.isArray(input.configurationBinds) || !Array.isArray(input.resourceMounts)
      || Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new Error('initial Claude candidate is outside this fixture request')
    const targets = new Set<string>()
    const claim = (value: string) => { if (!destination(value) || targets.has(value)) throw new Error('Claude candidate selected target is invalid'); targets.add(value) }
    for (const bind of input.configurationBinds) {
      if (!unit(bind.sourceRelativePath, '\\.freshell/templates')) throw new Error('Claude candidate template source is invalid')
      claim(bind.effectiveDestination)
    }
    for (const mount of input.resourceMounts) {
      if (!['file','directory'].includes(mount.kind)
        || !unit(mount.stageRelativePath, '\\.freshell/resource-units', mount.kind === 'file')
        || !unit(mount.providerRelativePath, '\\.freshell/provider-roots', mount.kind === 'file')) throw new Error('Claude candidate resource source is invalid')
      claim(mount.effectiveDestination)
    }
    const key = candidateVolumeName(input), previous = this.claudeCandidates.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(input)) throw new Error('Claude candidate request changed')
    if (!previous && this.claudeCandidates.size >= 6) throw new Error('closed Claude fixture exceeds its two routes and two replans')
    this.claudeCandidates.set(key, structuredClone(input))
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
    const destination = (value: string) => path.isAbsolute(value) && path.normalize(value) === value
      && !/[\x00-\x1f\x7f]/.test(value)
      && (this.isAllowedWorkspacePath(value)
        || [...this.policy.allowedProviderUserRoots ?? []].some((root) => value === root || isStrictDescendant(value, root)))
    const targets = new Set<string>()
    const claim = (value: string) => {
      if (!destination(value) || targets.has(value)) throw new Error('prepared input target is outside selected fixture roots or duplicated')
      targets.add(value)
    }
    for (const bind of input.configurationBinds) {
      if (!unit(bind.sourceRelativePath, '.freshell/templates/')) throw new Error('prepared template source is invalid')
      claim(bind.effectiveDestination)
    }
    for (const mount of input.resourceMounts) {
      const relative=mount.kind==='file' && mount.providerRelativePath.endsWith('/source') ? mount.providerRelativePath.slice(0,-'/source'.length) : mount.providerRelativePath;
      if (!unit(relative, '.freshell/provider-roots/') || (mount.kind==='file' && !mount.providerRelativePath.endsWith('/source')) || !['file', 'directory'].includes(mount.kind)) throw new Error('prepared resource source is invalid')
      claim(mount.effectiveDestination)
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

  eventsSnapshot(): BrokerEvent[] {
    return [...this.events]
  }

  unsafeAttempts(): BrokerEvent[] {
    return this.events.filter((event) => event.unsafeAttempt)
  }

  destructiveRequestsFor(containerId: string): BrokerEvent[] {
    return this.events.filter((event) => event.destructive && event.containerId === containerId)
  }

  failNextStop(count = 1): void {
    this.stopFailuresRemaining = Math.max(0, count)
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.policy.proxySocketPath), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(this.policy.logPath), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(this.policy.logPath), 0o700)
    fs.rmSync(this.policy.proxySocketPath, { force: true })
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.policy.proxySocketPath, () => resolve())
    })
    fs.chmodSync(this.policy.proxySocketPath, 0o600)
  }

  async close(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = undefined
    fs.rmSync(this.policy.proxySocketPath, { force: true })
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

    const volume = url.match(/^\/v1\.47\/volumes\/(freshell-provider-[a-f0-9]{24})$/)?.[1]
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
        await this.forwardAndReply(request, response, body, { destructive: method !== 'GET', containerId: helper.containerId, helperName: name })
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
        await this.forwardAndReply(request,response,body,{destructive:method!=='GET',containerId:owned.containerId,helperName:name})
        return
      }
    }
    const helperEntry = helperTarget && [...this.historyHelpers].find(([name, helper]) => (
      helperTarget[1] === name || helperTarget[1] === helper.containerId
    ))
    if (helperEntry) {
      const [name, helper] = helperEntry
      const exactId = helperTarget![1] === helper.containerId
      const allowed = (method === 'POST' && exactId && url === `${DOCKER_API_PREFIX}/containers/${helper.containerId}/start`)
        || (method === 'POST' && exactId && url === `${DOCKER_API_PREFIX}/containers/${helper.containerId}/wait?condition=not-running`)
        || (method === 'GET' && helper.kind === 'history' && exactId && [0, 1].some((stderr) => url === `${DOCKER_API_PREFIX}/containers/${helper.containerId}/logs?stdout=1&stderr=${stderr}`))
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
        try {
          const forwarded = await this.forward(request, body)
          if (forwarded.statusCode === 201) {
            const parsed = JSON.parse(forwarded.body.toString())
            if (typeof parsed.Id !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.Id) || this.receiptIds().has(parsed.Id)) throw new Error('invalid Claude source helper identity')
            helper.containerId = parsed.Id
          }
          this.record({ method, url, decision: 'forward', destructive: false, unsafeAttempt: false, helperName: name, containerId: helper.containerId, requestDigest: sha256(body) })
          replyDocker(response, forwarded)
        } catch {
          this.record({ method, url, decision: 'forward', reason: 'Claude source helper acknowledgement unavailable', destructive: false, unsafeAttempt: false, helperName: name, requestDigest: sha256(body) })
          response.statusCode = 503
          response.end(JSON.stringify({ message: 'Claude source helper acknowledgement unavailable; exact named ownership inspection required' }))
        }
        return
      }
      if (/^freshell-inputs-[a-f0-9]{24}-publisher$/.test(name) || mountpointHelper) {
        const input=mountpointHelper ? this.validateMountpointHelper(body) : this.validateInputPublisher(name,body)
        if (!input || this.inputPublishers.has(name)) {
          this.block(response,method,url,403,'indexed publisher must match an owned fixed preparation',false)
          return
        }
        const publisher:{input:PreparedInputAuthorization;expected:Record<string,any>;containerId?:string}={input,expected:JSON.parse(body.toString())}
        this.inputPublishers.set(name,publisher)
        try {
          const forwarded=await this.forward(request,body)
          if (forwarded.statusCode===201) {
            const parsed=JSON.parse(forwarded.body.toString())
            if (typeof parsed.Id!=='string' || !/^[a-f0-9]{64}$/.test(parsed.Id) || this.receiptIds().has(parsed.Id)) throw new Error('invalid indexed publisher identity')
            publisher.containerId=parsed.Id
          }
          this.record({method,url,decision:'forward',destructive:false,unsafeAttempt:false,helperName:name,containerId:publisher.containerId,providerVolumeName:mountpointHelper ? input.providerVolumeName : input.indexedFiles!.volumeName})
          replyDocker(response,forwarded)
        } catch {
          response.statusCode=503
          response.end(JSON.stringify({message:'indexed publisher acknowledgement unavailable; exact ownership inspection required'}))
        }
        return
      }
      if (name.startsWith('freshell-history-') || name.startsWith('freshell-auth-')) {
        const kind = name.startsWith('freshell-auth-') ? 'auth' : 'history'
        const owner = kind === 'auth' ? this.validateAuthHelper(name, body) : this.validateHistoryHelper(name, body)
        if (!owner || this.historyHelpers.has(name)) {
          this.block(response, method, url, 403, 'history helper does not match an owned read-only source', false)
          return
        }
        // Reserve the exact validated name before forwarding: Docker may create it but lose its acknowledgement.
        const helper: { owner: BrokerReceipt; containerId?: string; kind: 'history' | 'auth' } = { owner, kind }
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
    | { ok: true; incarnationId: string; soulId: string; imageRef: string; runtimeDir: string; hostBinaryPath: string; providerVolumeName?: string; workspacePath?: string }
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
    const expectedCapAdd = terminalWorkload ? ['CHOWN', 'SETGID', 'SETUID'] : []
    if (JSON.stringify(capAdd) !== JSON.stringify(expectedCapAdd)) return { ok: false, reason: `unexpected host capability additions: ${capAdd.join(',')}` }
    if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges:true')) return { ok: false, reason: 'no-new-privileges is required' }
    if (host.RestartPolicy?.Name !== 'no') return { ok: false, reason: 'staging container must start with restart=no' }
    if (!(Number(host.NanoCpus) > 0) || !(Number(host.Memory) > 0) || !(Number(host.PidsLimit) > 0)) {
      return { ok: false, reason: 'CPU/memory/pid limits must be explicit and nonzero' }
    }
    if (host.PortBindings && Object.keys(host.PortBindings).length > 0) return { ok: false, reason: 'runtime ports are forbidden' }

    const tmpfs = host.Tmpfs ?? {}
    if (tmpfs['/tmp'] !== 'rw,noexec,nosuid,nodev,size=128m') return { ok: false, reason: 'runtime /tmp must remain bounded and noexec' }
    if (tmpfs['/run/freshell-private'] !== undefined && tmpfs['/run/freshell-private'] !== 'rw,noexec,nosuid,nodev,size=16m,mode=0700') {
      return { ok: false, reason: 'provider private tmpfs must be bounded and noexec' }
    }
    const tmpfsKeys = Object.keys(tmpfs).sort()
    const allowedTmpfsKeys = ['/tmp']
    if (tmpfsKeys.includes('/run/freshell-private')) allowedTmpfsKeys.push('/run/freshell-private')
    if (tmpfsKeys.includes('/run/opencode-tmp')) allowedTmpfsKeys.push('/run/opencode-tmp')
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
      if (destination === '/run/freshell-host-actor' && mode === 'rw') {
        if (actorStateDir) return { ok: false, reason: 'duplicate host actor state bind' }
        actorStateDir = source
        continue
      }
      if (terminalWorkload && destination === source && mode === 'rw' && this.isAllowedWorkspacePath(source)) {
        if (!workspacePath) workspacePath = source
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
    return { ok: true, incarnationId, soulId, imageRef, runtimeDir, hostBinaryPath, ...(providerVolumeName ? { providerVolumeName } : {}), ...(workspacePath ? { workspacePath } : {}) }
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
      && typeof mount.Source === 'string' && path.dirname(mount.Source) === os.tmpdir()
      && /^freshell-inputs-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path.basename(mount.Source)))
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
      if (input.gitCommonDir && input.gitCommonDir !== input.workspacePath && !isStrictDescendant(input.gitCommonDir, input.workspacePath)) {
        expected.push({ Type: 'bind', Source: input.gitCommonDir, Target: input.gitCommonDir, ReadOnly: true })
      }
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
      || !equalRecord(host.LogConfig, { Type: 'none', Config: host.LogConfig?.Config }) || Object.keys(host.LogConfig?.Config ?? {}).length
      || !equalRecord(host.Tmpfs, { '/home/freshell/provider': 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=0,mode=0700' })) return false
    const mounts = host.Mounts
    if (!Array.isArray(mounts) || mounts.length !== 3
      || mounts.some((mount) => !mount || Object.keys(mount).some((key) => !['Type','Source','Target','ReadOnly'].includes(key)))) return false
    const binary = mounts.find((mount) => mount.Type === 'bind' && mount.Source === owner.hostBinaryPath && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    const workspace = mounts.find((mount) => mount.Type === 'bind' && mount.Source === mount.Target && this.policy.allowedWorkspaceRoots?.has(mount.Source) && mount.ReadOnly === true)
    const exchange = mounts.find((mount) => mount.Type === 'bind' && mount.Target === '/run/freshell-source-exchange' && mount.ReadOnly === true
      && typeof mount.Source === 'string' && path.dirname(mount.Source) === os.tmpdir()
      && /^freshell-inputs-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path.basename(mount.Source)))
    return !!binary && !!workspace && !!exchange && typeof parsed.WorkingDir === 'string'
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
      && ['NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','Tmpfs'].every((key) => same(host[key], expected.HostConfig[key]))
      && (host.CapAdd?.length ?? 0) === 0 && host.LogConfig?.Type === 'none'
      && Array.isArray(host.Mounts) && host.Mounts.length === expected.HostConfig.Mounts.length
      && expected.HostConfig.Mounts.every((wanted: Record<string, any>) => host.Mounts.some((mount: Record<string, any>) =>
        ['Type','Source','Target','ReadOnly'].every((key) => mount[key] === wanted[key]) && !mount.VolumeOptions))
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
      && typeof mount.Source==='string' && path.dirname(mount.Source)===os.tmpdir()
      && /^freshell-inputs-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path.basename(mount.Source)))
    if (!binary || !volume || !exchange || [binary,volume,exchange].some((mount)=>Object.keys(mount).some((key)=>!['Type','Source','Target','ReadOnly','VolumeOptions'].includes(key)))
      || binary.VolumeOptions!==undefined || exchange.VolumeOptions!==undefined) return
    return input
  }

  private validateMountpointHelper(body:Buffer):PreparedInputAuthorization | undefined {
    let parsed:Record<string,any>
    try {parsed=JSON.parse(body.toString())} catch {return}
    const input=[...this.preparedInputs.values()].find((input)=>parsed.Image===input.imageRef
      && equalRecord(parsed.Labels,{'com.freshell.installation-id':input.installationId,
        'com.freshell.soul-id':input.soulId,'com.freshell.incarnation-id':input.incarnationId}))
    if (!input || parsed.User!=='0:0' || parsed.Tty!==false
      || JSON.stringify(parsed.Entrypoint)!==JSON.stringify(['/runtime/freshell-session-host'])
      || JSON.stringify(parsed.Cmd)!==JSON.stringify(['prepare-provider-mountpoints'])
      || !privateHelperEnvironment(parsed.Env,false)) return
    const host=parsed.HostConfig ?? {}
    if (Object.keys(parsed).some((key)=>!['Image','User','Tty','Labels','Entrypoint','Cmd','Env','HostConfig'].includes(key))
      || Object.keys(host).some((key)=>!['NetworkMode','ReadonlyRootfs','CapDrop','CapAdd','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','LogConfig','Mounts'].includes(key))) return
    if (host.NetworkMode!=='none' || host.ReadonlyRootfs!==true
      || JSON.stringify(host.CapDrop)!==JSON.stringify(['ALL'])
      || JSON.stringify(host.CapAdd)!==JSON.stringify(['CHOWN','SETGID','SETUID'])
      || JSON.stringify(host.SecurityOpt)!==JSON.stringify(['no-new-privileges'])
      || host.Memory!==128*1024*1024 || host.MemorySwap!==128*1024*1024
      || host.NanoCpus!==500_000_000 || host.PidsLimit!==32
      || !equalRecord(host.LogConfig,{Type:'none',Config:host.LogConfig?.Config})
      || Object.keys(host.LogConfig?.Config ?? {}).length) return
    const mounts=host.Mounts
    if (!Array.isArray(mounts) || mounts.length!==3) return
    const binary=mounts.find((mount)=>mount.Type==='bind' && mount.Source===input.hostBinaryPath
      && mount.Target==='/runtime/freshell-session-host' && mount.ReadOnly===true)
    const volume=mounts.find((mount)=>mount.Type==='volume' && mount.Source===input.providerVolumeName
      && mount.Target==='/home/freshell/provider' && mount.ReadOnly===false && equalRecord(mount.VolumeOptions,{NoCopy:true}))
    const exchange=mounts.find((mount)=>mount.Type==='bind' && mount.Target==='/run/freshell-input-exchange' && mount.ReadOnly===true
      && typeof mount.Source==='string' && path.dirname(mount.Source)===os.tmpdir()
      && /^freshell-inputs-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path.basename(mount.Source)))
    if (!binary || !volume || !exchange || [binary,volume,exchange].some((mount)=>Object.keys(mount).some((key)=>!['Type','Source','Target','ReadOnly','VolumeOptions'].includes(key)))
      || binary.VolumeOptions!==undefined || exchange.VolumeOptions!==undefined) return
    return input
  }

  private validateHistoryHelper(name: string, body: Buffer): BrokerReceipt | undefined {
    if (!/^freshell-history-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) return
    let parsed: Record<string, any>
    try { parsed = JSON.parse(body.toString('utf8')) } catch { return }
    const host = parsed.HostConfig ?? {}
    if (Object.keys(parsed.Labels ?? {}).length !== 0) return
    const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected)
    if (parsed.User !== '65534:0' || parsed.Tty !== true
      || !same(parsed.Entrypoint, ['/runtime/freshell-session-host'])
      || !same(parsed.Env, ['HOME=/home/freshell/provider'])) return
    const cmd = parsed.Cmd
    if (!Array.isArray(cmd) || cmd.length !== 7 || cmd[0] !== 'native-history-only'
      || cmd[1] !== '--provider' || !['claude', 'kilroy', 'codex', 'opencode'].includes(cmd[2])
      || cmd[3] !== '--session-id' || typeof cmd[4] !== 'string' || !cmd[4]
      || cmd[5] !== '--provider-home' || cmd[6] !== '/home/freshell/provider') return
    if (host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true || host.Privileged === true
      || (host.PidMode ?? '') !== '' || (host.Binds?.length ?? 0) !== 0 || (host.CapAdd?.length ?? 0) !== 0
      || !same(host.CapDrop, ['ALL']) || !same(host.SecurityOpt, ['no-new-privileges'])
      || host.Memory !== 256 * 1024 * 1024 || host.MemorySwap !== 256 * 1024 * 1024
      || host.NanoCpus !== 500_000_000 || host.PidsLimit !== 32
      || !same(host.Tmpfs, { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' })) return
    const mounts = host.Mounts
    if (!Array.isArray(mounts) || mounts.length !== 2) return
    const binary = mounts.find((mount) => mount.Type === 'bind' && mount.Target === '/runtime/freshell-session-host' && mount.ReadOnly === true)
    const volume = mounts.find((mount) => mount.Type === 'volume' && mount.Target === '/home/freshell/provider' && mount.ReadOnly === true)
    if (!binary || !volume || !this.policy.allowedHostBinaryPaths.has(binary.Source) || !this.policy.allowedImageRefs.has(parsed.Image)) return
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
      || !new RegExp(`^freshell-auth-${uuid}$`).test(path.basename(exchange.Source)) || path.dirname(exchange.Source) !== os.tmpdir()
      || !this.policy.allowedHostBinaryPaths.has(binary.Source) || !this.policy.allowedImageRefs.has(parsed.Image)) return
    return this.receipts().find((receipt) => receipt.providerVolumeName === volume.Source
      && receipt.imageRef === parsed.Image && receipt.hostBinaryPath === binary.Source)
  }

  private isAllowedWorkspacePath(candidate: string): boolean {
    const roots = this.policy.allowedWorkspaceRoots ?? new Set<string>()
    for (const root of roots) {
      if (candidate === root || isStrictDescendant(candidate, root)) return true
    }
    return false
  }

  private async forwardAndReply(request: IncomingMessage, response: ServerResponse, body: Buffer, event: { destructive: boolean; containerId?: string; helperName?:string }): Promise<void> {
    const forwarded = await this.forward(request, body)
    this.record({ method: request.method ?? 'GET', url: request.url ?? '/', decision: 'forward', destructive: event.destructive, unsafeAttempt: false, containerId: event.containerId,helperName:event.helperName })
    replyDocker(response, forwarded)
  }

  private forward(request: IncomingMessage, body: Buffer): Promise<DockerResponse> {
    return new Promise((resolve, reject) => {
      const upstream = http.request({
        socketPath: this.policy.realSocketPath,
        path: request.url,
        method: request.method,
        headers: sanitizeHeaders(request.headers, body.length),
      }, (upstreamResponse) => {
        const chunks: Buffer[] = []
        upstreamResponse.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        upstreamResponse.once('end', () => resolve({ statusCode: upstreamResponse.statusCode ?? 500, headers: upstreamResponse.headers, body: Buffer.concat(chunks) }))
      })
      upstream.once('error', reject)
      if (body.length > 0) upstream.write(body)
      upstream.end()
    })
  }

  private block(response: ServerResponse, method: string, url: string, status: number, reason: string, destructive: boolean, containerId?: string): void {
    this.record({ method, url, decision: 'block', reason, destructive, unsafeAttempt: destructive, containerId })
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ message: reason }))
  }

  private record(event: Omit<BrokerEvent, 'at'>): void {
    const full: BrokerEvent = { at: new Date().toISOString(), ...event }
    this.events.push(full)
    fs.appendFileSync(this.policy.logPath, `${JSON.stringify(full)}\n`, { mode: 0o600 })
    fs.chmodSync(this.policy.logPath, 0o600)
  }
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

function isStrictDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
