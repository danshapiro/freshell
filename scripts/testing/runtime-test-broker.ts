import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const DOCKER_API_PREFIX = '/v1.47'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const CLEANUP_DRAIN_MS = 5_000

export type BrokerSettlementFailure = {
  method: string
  url: string
  reason: string
  allocationUnknown: boolean
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
  allowedProviderUserRoots?: Set<string>
  allowedBootstrapFiles?: Set<string>
  testRunId: string
  logPath: string
}

type DockerResponse = {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export class RestrictedDockerBroker {
  private readonly task2LegacyNegativeInspectionOwners = new Map<string, string>()
  private readonly knownContainerIds = new Set<string>()
  private readonly receiptsById = new Map<string, BrokerReceipt>()
  private readonly historyHelpers = new Map<string, { owner: BrokerReceipt; containerId?: string }>()
  private readonly events: BrokerEvent[] = []
  private server?: http.Server
  private readonly pendingRequests = new Set<Promise<void>>()
  private readonly incomingRequests = new Set<IncomingMessage>()
  private readonly upstreamRequests = new Set<http.ClientRequest>()
  private readonly settlementFailures: BrokerSettlementFailure[] = []
  private draining = false
  private drainExpired = false
  private stopFailuresRemaining = 0

  constructor(private readonly policy: RestrictedDockerBrokerPolicy) {}

  get proxySocketPath(): string {
    return this.policy.proxySocketPath
  }

  receipts(): BrokerReceipt[] {
    return [...this.receiptsById.values()]
  }

  receiptIds(): Set<string> {
    return new Set([...this.knownContainerIds, ...[...this.historyHelpers.values()].flatMap((helper) => helper.containerId ? [helper.containerId] : [])])
  }

  historyHelperNames(): string[] { return [...this.historyHelpers.keys()] }

  eventsSnapshot(): BrokerEvent[] {
    return [...this.events]
  }

  unsafeAttempts(): BrokerEvent[] {
    return this.events.filter((event) => event.unsafeAttempt)
  }

  destructiveRequestsFor(containerId: string): BrokerEvent[] {
    return this.events.filter((event) => event.destructive && event.containerId === containerId)
  }

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

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.policy.proxySocketPath), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(this.policy.logPath), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(this.policy.logPath), 0o700)
    fs.rmSync(this.policy.proxySocketPath, { force: true })
    this.server = http.createServer((request, response) => {
      if (this.draining) {
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

    if (method === 'GET' && url === '/_ping') {
      await this.forwardAndReply(request, response, body, { destructive: false })
      return
    }
    if (method === 'GET' && url === `${DOCKER_API_PREFIX}/info`) {
      await this.forwardAndReply(request, response, body, { destructive: false })
      return
    }

    const volume = url.match(/^\/v1\.47\/volumes\/(freshell-provider-[a-f0-9]{24})$/)?.[1]
    if (method === 'GET' && volume && this.receipts().some((receipt) => receipt.providerVolumeName === volume)) {
      await this.forwardAndReply(request, response, body, { destructive: false })
      return
    }

    const helperTarget = url.match(/^\/v1\.47\/containers\/([^/?]+)(?:\/(start|wait|logs))?(?:\?.*)?$/)
    const helperEntry = helperTarget && [...this.historyHelpers].find(([name, helper]) => (
      helperTarget[1] === name || helperTarget[1] === helper.containerId
    ))
    if (helperEntry) {
      const [name, helper] = helperEntry
      const exactId = helperTarget![1] === helper.containerId
      const allowed = (method === 'POST' && exactId && url === `${DOCKER_API_PREFIX}/containers/${helper.containerId}/start`)
        || (method === 'POST' && exactId && url === `${DOCKER_API_PREFIX}/containers/${helper.containerId}/wait?condition=not-running`)
        || (method === 'GET' && exactId && [0, 1].some((stderr) => url === `${DOCKER_API_PREFIX}/containers/${helper.containerId}/logs?stdout=1&stderr=${stderr}`))
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
      if (name.startsWith('freshell-history-') || name.startsWith('freshell-opencode-repair-')) {
        const owner = name.startsWith('freshell-opencode-repair-')
          ? this.validateStoppedRepairHelper(name, body) : this.validateHistoryHelper(name, body)
        if (!owner || this.historyHelpers.has(name)) {
          this.block(response, method, url, 403, 'helper does not match its owned source and topology', false)
          return
        }
        // Reserve the exact validated name before forwarding: Docker may create it but lose its acknowledgement.
        const helper: { owner: BrokerReceipt; containerId?: string } = { owner }
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
    const terminalWorkload = host.NetworkMode === 'bridge'
    const freshAgentWorkload = Array.isArray(parsed.Env) && parsed.Env.some((value: unknown) => (
      typeof value === 'string' && value.startsWith('FRESHELL_HOSTED_FRESH_AGENT=')
    ))
    if (host.NetworkMode !== 'none' && !terminalWorkload) return { ok: false, reason: 'runtime network must be none or isolated bridge' }
    const extraHosts = Array.isArray(host.ExtraHosts) ? host.ExtraHosts : []
    const localAddresses = new Set(Object.values(os.networkInterfaces()).flatMap((interfaces) => (
      interfaces?.filter((network) => network.family === 'IPv4' && !network.internal).map((network) => network.address) ?? []
    )))
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
    return { ok: true, incarnationId, soulId, imageRef, runtimeDir, hostBinaryPath, ...(providerVolumeName ? { providerVolumeName } : {}), ...(workspacePath ? { workspacePath } : {}) }
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
      || path.normalize(stage.Source) !== stage.Source || !/^opencode-transfer-[a-zA-Z0-9-]+\.ready$/.test(path.basename(stage.Source))) return
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
        || !same(parsed.Env, ['HOME=/home/freshell/provider', 'XDG_DATA_HOME=/home/freshell/provider/.local/share', 'XDG_CONFIG_HOME=/home/freshell/provider/.config', 'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db'])) return
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
    const host = parsed.HostConfig ?? {}
    const cmd = parsed.Cmd
    const workspace = parsed.WorkingDir
    const sources: Record<string, string> = {
      claude: '/home/freshell/provider/.claude/projects', codex: '/home/freshell/provider/.codex/sessions',
      opencode: '/home/freshell/provider/.local/share/opencode/opencode.db', amplifier: '/home/freshell/provider/.amplifier/projects',
    }
    if (parsed.User !== '65534:0' || parsed.Tty !== true || !this.validHistoryHelperHost(host, false)
      || JSON.stringify(parsed.Env) !== JSON.stringify(['HOME=/home/freshell/provider'])
      || typeof workspace !== 'string' || path.normalize(workspace) !== workspace || !this.isAllowedWorkspacePath(workspace)
      || !Array.isArray(cmd) || cmd.length !== 7 || cmd[0] !== '--no-warnings' || cmd[1] !== '--import'
      || cmd[2] !== path.join(workspace, 'node_modules/tsx/dist/loader.mjs')
      || cmd[3] !== path.join(workspace, 'test/e2e-browser/helpers/provider-native-history/probe-cli.ts')
      || typeof cmd[4] !== 'string' || !Object.hasOwn(sources, cmd[4]) || cmd[5] !== sources[cmd[4]]
      || typeof cmd[6] !== 'string' || !cmd[6] || !this.policy.allowedImageRefs.has(parsed.Image)) return
    const mounts = host.Mounts
    if (!Array.isArray(mounts) || mounts.length !== 2) return
    const volume = mounts.find(mount => mount.Type === 'volume' && mount.Target === '/home/freshell/provider' && mount.ReadOnly === true)
    const source = mounts.find(mount => mount.Type === 'bind' && mount.Source === workspace && mount.Target === workspace && mount.ReadOnly === true)
    if (!volume || !source) return
    return this.receipts().find(receipt => receipt.providerVolumeName === volume.Source
      && receipt.workspacePath === workspace && receipt.imageRef === parsed.Image)
  }

  private isAllowedWorkspacePath(candidate: string): boolean {
    const roots = this.policy.allowedWorkspaceRoots ?? new Set<string>()
    for (const root of roots) {
      if (candidate === root || isStrictDescendant(candidate, root)) return true
    }
    return false
  }

  private async forwardAndReply(request: IncomingMessage, response: ServerResponse, body: Buffer, event: { destructive: boolean; containerId?: string; ownerContainerId?: string }): Promise<void> {
    const forwarded = await this.forward(request, body)
    this.record({ method: request.method ?? 'GET', url: request.url ?? '/', decision: 'forward', destructive: event.destructive, unsafeAttempt: false, containerId: event.containerId, ownerContainerId: event.ownerContainerId })
    replyDocker(response, forwarded)
  }

  private forward(request: IncomingMessage, body: Buffer): Promise<DockerResponse> {
    if (this.drainExpired) return Promise.reject(new Error('broker cleanup deadline expired'))
    return new Promise((resolve, reject) => {
      let result: DockerResponse | undefined
      let failure: string | undefined
      const upstream = http.request({
        socketPath: this.policy.realSocketPath,
        path: request.url,
        method: request.method,
        headers: sanitizeHeaders(request.headers, body.length),
      }, (upstreamResponse) => {
        const chunks: Buffer[] = []
        upstreamResponse.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        upstreamResponse.once('end', () => { result = { statusCode: upstreamResponse.statusCode ?? 500, headers: upstreamResponse.headers, body: Buffer.concat(chunks) } })
        const failResponse = () => { failure ??= 'upstream_response_incomplete'; upstream.destroy() }
        upstreamResponse.once('aborted', failResponse)
        upstreamResponse.once('error', failResponse)
        upstreamResponse.once('close', () => { if (!upstreamResponse.complete) failResponse() })
      })
      this.upstreamRequests.add(upstream)
      upstream.once('error', () => { failure ??= this.drainExpired ? 'cleanup_deadline' : 'upstream_request_failed' })
      upstream.once('close', () => {
        this.upstreamRequests.delete(upstream)
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
