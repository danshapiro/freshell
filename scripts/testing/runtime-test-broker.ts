import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const DOCKER_API_PREFIX = '/v1.47'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024

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
  testRunId: string
  logPath: string
}

type DockerResponse = {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export class RestrictedDockerBroker {
  private readonly knownContainerIds = new Set<string>()
  private readonly receiptsById = new Map<string, BrokerReceipt>()
  private readonly historyHelpers = new Map<string, { owner: BrokerReceipt; containerId?: string }>()
  private readonly events: BrokerEvent[] = []
  private server?: http.Server
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
      if (name.startsWith('freshell-history-')) {
        const owner = this.validateHistoryHelper(name, body)
        if (!owner || this.historyHelpers.has(name)) {
          this.block(response, method, url, 403, 'history helper does not match an owned read-only source', false)
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
    return { ok: true, incarnationId, soulId, imageRef, runtimeDir, hostBinaryPath, ...(providerVolumeName ? { providerVolumeName } : {}), ...(workspacePath ? { workspacePath } : {}) }
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

  private isAllowedWorkspacePath(candidate: string): boolean {
    const roots = this.policy.allowedWorkspaceRoots ?? new Set<string>()
    for (const root of roots) {
      if (candidate === root || isStrictDescendant(candidate, root)) return true
    }
    return false
  }

  private async forwardAndReply(request: IncomingMessage, response: ServerResponse, body: Buffer, event: { destructive: boolean; containerId?: string }): Promise<void> {
    const forwarded = await this.forward(request, body)
    this.record({ method: request.method ?? 'GET', url: request.url ?? '/', decision: 'forward', destructive: event.destructive, unsafeAttempt: false, containerId: event.containerId })
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
