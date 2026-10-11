import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fakeDocker = vi.hoisted(() => ({ settled: false, commands: [] as string[][], supervisorCommands: [] as string[][] }))
vi.mock('node:child_process', () => {
  const api = {
    spawn: () => { throw new Error('unexpected spawned process in isolated harness fixture') },
    execFileSync: (program: string, args: string[]) => {
      if (program === 'git' && args.join(' ') === 'rev-parse HEAD') return 'cleanup-fixture-commit\n'
      if (program === 'docker' && args[0] === 'volume' && args[1] === 'create') return `${args[2]}\n`
      if (program === 'docker' && args[0] === 'run' && args.includes('/var/lib/freshell-supervisor')) {
        fakeDocker.supervisorCommands.push(args)
        return `${'f'.repeat(64)}\n`
      }
      throw new Error('unexpected executable in isolated cleanup fixture')
    },
    spawnSync: (program: string, args: string[]) => {
      if (program !== 'docker' || !['inspect', 'rm'].includes(args[0]) || !args.at(-1)?.match(/^[a-f0-9]{64}$/)) {
        throw new Error('unexpected child process in isolated cleanup fixture')
      }
      fakeDocker.commands.push(args)
      if (args[0] === 'rm') fakeDocker.settled = true
      return { status: 0, stdout: '', stderr: '' }
    },
  }
  return { ...api, default: api }
})

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { RestrictedDockerBroker, type PreparedInputAuthorization } from '../../../../scripts/testing/runtime-test-broker.js'
import { ManagedRuntimeBrowserRig } from '../../../e2e-browser/helpers/managed-runtime.js'
import { prepareProviderParityUserRoots } from '../../../helpers/provider-parity-environment.js'
import { assertManagedTerminalCreated } from '../../../../scripts/testing/managed-environment-create.js'
import type { ErrorMessage } from '../../../../shared/ws-protocol.js'

describe('managed environment create failure retention', () => {
  it.each(['known', 'unknown'] as const)('retains safe %s failure evidence before normal owned cleanup', async kind => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-create-failure-'))
    const home = path.join(directory, 'home')
    await fs.mkdir(home)
    const rig = new ManagedRuntimeBrowserRig(directory, 2, {}, {}, 'release', { enabledProviders: [] }, home)
    const secretMarkers = ['AUTH_SECRET_MARKER', 'CONFIG_SECRET_MARKER', 'CONVERSATION_SECRET_MARKER']
    const reason = 'selected workspace input mountpoint is unavailable'
    const response: ErrorMessage = { type: 'error', code: 'PTY_SPAWN_FAILED', timestamp: new Date().toISOString(),
      message: kind === 'known' ? `runtime backend configuration rejected: ${reason}; ${secretMarkers.join(' ')}`
        : secretMarkers.join(' ') }
    const failureEvent = { event: 'supervisor.activation_failed', data: { stage: 'create_stopped_runtime',
      errorCode: 'BACKEND_UNAVAILABLE', errorClass: 'runtime_activation_failed', payload: secretMarkers } }
    const logs = vi.spyOn(rig.runtime, 'containerLogs').mockReturnValue(JSON.stringify(failureEvent))
    const web = { capturedOutput: vi.fn(() => ({ stdout: JSON.stringify(failureEvent), stderr: secretMarkers.join(' ') })),
      stop: async () => fs.rm(home, { recursive: true }) }
    rig.web = web as unknown as typeof rig.web
    rig.supervisor = { containerId: 'd'.repeat(64) } as typeof rig.supervisor
    try {
      expect(() => assertManagedTerminalCreated(rig, response)).toThrow()
      expect(await rig.stop()).toEqual({ ok: true, errors: [] })
      await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
      const stored = await fs.readFile(path.join(rig.runtime.evidenceDir, 'incidents/managed-environment-create-failure.json'), 'utf8')
      const incident = JSON.parse(stored)
      expect(incident).toMatchObject({ severity: 'error', event: 'managed_environment.create_failed',
        code: 'PTY_SPAWN_FAILED', reason: kind === 'known' ? reason : 'UNKNOWN',
        supervisor: { event: 'supervisor.activation_failed', stage: 'create_stopped_runtime', errorCode: 'BACKEND_UNAVAILABLE' } })
      for (const marker of secretMarkers) expect(stored).not.toContain(marker)
      expect(logs).toHaveBeenCalledWith(rig.supervisor.containerId)
      expect(web.capturedOutput).toHaveBeenCalledOnce()
    } finally {
      await fs.rm(rig.runtime.testRoot, { recursive: true, force: true })
      await fs.rm(directory, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })

  it('accepts a real created response without reading failure logs or writing an incident', () => {
    const owner = { web: { capturedOutput: vi.fn() }, runtime: { containerLogs: vi.fn(), writeIncident: vi.fn() },
      supervisor: { containerId: 'd'.repeat(64) } }
    expect(() => assertManagedTerminalCreated(owner, { type: 'terminal.created' })).not.toThrow()
    expect(owner.web.capturedOutput).not.toHaveBeenCalled()
    expect(owner.runtime.containerLogs).not.toHaveBeenCalled()
    expect(owner.runtime.writeIncident).not.toHaveBeenCalled()
  })
})

function useOwnedHarnessArtifacts(harness: RuntimeHarness, host: string): void {
  const artifact = harness as unknown as { ensureRuntimeImage(): void; buildBinaries(): void; collectCapabilities(): unknown; collectBuildInfo(): unknown }
  vi.spyOn(artifact, 'ensureRuntimeImage').mockImplementation(() => { harness.imageRef = `sha256:${'a'.repeat(64)}` })
  vi.spyOn(artifact, 'buildBinaries').mockImplementation(() => { harness.testHostBinary = host; harness.releaseHostBinary = host })
  vi.spyOn(artifact, 'collectCapabilities').mockReturnValue({ fixture: true })
  vi.spyOn(artifact, 'collectBuildInfo').mockReturnValue({ fixture: true })
}

it.each(['claude', 'opencode'] as const)('qualifies original isolated HOME aliases through the actual browser harness policy: %s', async provider => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-home-'))
  const repository = path.join(directory, 'repository')
  const home = path.join(directory, 'home')
  const workspace = path.join(repository, 'workspace')
  const xdgConfigHome = path.join(home, 'custom-xdg')
  const socket = path.join(directory, 'daemon.sock')
  const forwarded: string[] = []
  const daemon = http.createServer((request, response) => {
    forwarded.push(request.url!)
    response.statusCode = request.method === 'POST' ? 201 : 404
    response.end('{}')
  })
  const inheritedDockerHost = process.env.DOCKER_HOST
  let harness: RuntimeHarness | undefined
  try {
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    await fs.mkdir(workspace, { recursive: true })
    await fs.mkdir(path.join(repository, 'test/runtime'), { recursive: true })
    await fs.writeFile(path.join(repository, 'test/runtime/gate-manifest.json'), '{}')
    await new Promise<void>(resolve => daemon.listen(socket, resolve))
    process.env.DOCKER_HOST = `unix://${socket}`
    const rig = new ManagedRuntimeBrowserRig(repository, 2, { XDG_CONFIG_HOME: xdgConfigHome }, {}, 'test', { enabledProviders: [provider] }, home)
    harness = rig.runtime
    const host = path.join(directory, 'host')
    await fs.writeFile(host, 'owned fixture host artifact')
    useOwnedHarnessArtifacts(harness, host)
    const outsideRoot = path.join(directory, 'outside-provider')
    await fs.mkdir(outsideRoot)
    await fs.symlink(outsideRoot, path.join(home, '.amplifier'))
    await expect(harness.prepare()).rejects.toThrow('selected owned physical directory')
    expect(forwarded).toEqual([])
    await fs.unlink(path.join(home, '.amplifier'))
    prepareProviderParityUserRoots(home, xdgConfigHome)
    if (provider === 'opencode') {
      const symlink = path.join(home, 'linked-xdg')
      await fs.symlink(xdgConfigHome, symlink)
      for (const selected of [home, outsideRoot, path.join(home, '../sibling'), symlink,
        `${xdgConfigHome}/../custom-xdg`, path.join(home, '.codex/sessions')]) {
        const invalid = new ManagedRuntimeBrowserRig(repository, 2, { XDG_CONFIG_HOME: selected }, {}, 'test', { enabledProviders: [provider] }, home).runtime
        useOwnedHarnessArtifacts(invalid, host)
        try {
          await expect(invalid.prepare(), selected).rejects.toThrow(/provider fixture (root|XDG root)/)
          expect(forwarded).toEqual([])
        } finally {
          await invalid.broker?.close()
          await fs.rm(invalid.testRoot, { recursive: true, force: true })
        }
      }
    }
    await harness.prepare()
    const generationId = 'grant-11111111-1111-4111-8111-111111111111'
    const reservationId = '22222222-2222-4222-8222-222222222222'
    const requestId = '33333333-3333-4333-8333-333333333333'
    const installationId = 'installation-home', soulId = 'soul-home'
    const owner = { installationId, soulId, imageRef: harness.imageRef, hostBinaryPath: host,
      binarySha256: createHash('sha256').update(await fs.readFile(host)).digest('hex'), daemonId: 'daemon-home',
      providerVolumeName: `freshell-provider-${createHash('sha256').update(`${installationId}\0${soulId}`).digest('hex').slice(0, 24)}` }
    harness.broker.authorizeInitialProviderVolume(owner)
    const control = path.join(harness.testRoot, 'scenarios/scenario/control')
    const metadata = path.join(control, 'provider-roots', generationId, '.freshell')
    await fs.mkdir(metadata, { recursive: true })
    await fs.mkdir(path.join(metadata, 'templates'))
    await fs.writeFile(path.join(metadata, 'templates/source-0'), '{"fixtureSetting":true}')
    await fs.mkdir(path.join(control, 'mcp-capabilities'), { recursive: true })
    const manifest = Buffer.from(JSON.stringify({ version: 1, sources: [], aliases: [], recipes: [] }))
    const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
    await fs.writeFile(path.join(metadata, 'input-manifest.json'), manifest)
    const indexedVolume = `freshell-inputs-${createHash('sha256').update(`${soulId}\0${generationId}`).digest('hex').slice(0, 24)}`
    const context = { preparation: provider === 'claude' ? { claude: { mcp_args: [] } }
        : { opencode: { project_config: [], tui_config: null, inline_config: false } }, config: [],
      mcpCapability: { grantId: generationId, endpoint: 'http://127.0.0.1:1/api/managed-mcp', providerRelativePath: '.freshell/mcp-capability.json' },
      preparedInputs: { generationId, initialAuthReservation: reservationId,
        manifest: { relativePath: '.freshell/input-manifest.json', sha256: digest(manifest), sourceCount: 0, aliasCount: 0, recipeCount: 0 },
        // ordinary_stage supplies both mapped and original selected-HOME aliases.
        configBinds: (provider === 'claude'
          ? ['/home/freshell/provider/.claude/settings.json', path.join(home, '.claude/settings.json')]
          : ['/home/freshell/provider/.config/opencode/tui.jsonc', path.join(xdgConfigHome, 'opencode/tui.jsonc')])
          .map(effectiveDestination => ({ sourceRelativePath: '.freshell/templates/source-0', logicalDestination: effectiveDestination, effectiveDestination })),
        resourceMounts: [], ...(provider === 'opencode' ? { indexedFiles: { volumeName: indexedVolume, aliases: [] } } : {}) } }
    const contextBytes = Buffer.from(JSON.stringify(context))
    const resultBytes = Buffer.from(JSON.stringify({ providerLaunchContext: context, providerSecretReferences: [] }))
    await fs.writeFile(path.join(metadata, 'prepared-context.json'), contextBytes)
    await fs.writeFile(path.join(metadata, 'prepared-result.json'), resultBytes)
    await fs.writeFile(path.join(control, 'mcp-capabilities', `${generationId}.json`), JSON.stringify({ soulId, incarnationId: null }))
    const binding = { version: 1, provider: 'claude', soulId, generationId, initialReservationId: reservationId,
      intentRevision: 1, registryAttemptId: null, workspacePath: workspace, cwd: workspace, gitCommonDir: null,
      authoritySha256: digest(JSON.stringify({ kind: 'initial_reservation', reservationId })), manifestSha256: digest(manifest),
      preparedContextSha256: digest(contextBytes), preparedResultSha256: digest(resultBytes) }
    const publication = path.join(metadata, 'claude-candidate-binding.json')
    const url = provider === 'claude' ? `/v1.47/volumes/freshell-claude-candidate-${requestId}` : '/v1.47/volumes/create'
    const volume = { Name: indexedVolume, Driver: 'local',
      DriverOpts: { type: 'tmpfs', device: 'tmpfs', o: 'size=64m,mode=0700,uid=65534,gid=0,nr_inodes=1024,nosuid,nodev,noexec' },
      Labels: { 'com.freshell.managed-inputs': 'true', 'com.freshell.installation-id': installationId,
        'com.freshell.soul-id': soulId, 'com.freshell.incarnation-id': 'incarnation-home', 'com.freshell.input-generation': generationId } }
    const request = (method: string, target = url, body?: unknown) => new Promise<number>((resolve, reject) => {
      const outgoing = http.request({ socketPath: harness!.broker.proxySocketPath, path: target, method }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode!))
      })
      outgoing.once('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body))
    })
    const selectedRequest = () => provider === 'claude' ? request('GET') : request('POST', url, volume)
    if (provider === 'opencode') {
      expect(await request('POST', '/v1.47/volumes/create', { Name: owner.providerVolumeName, Driver: 'local', Labels: {
        'com.freshell.installation-id': installationId, 'com.freshell.soul-id': soulId,
        'freshell.input.reservation': reservationId, 'freshell.input.incarnation': 'incarnation-home', 'freshell.input.intent': '1',
        'freshell.input.daemon': owner.daemonId, 'freshell.input.image': owner.imageRef, 'freshell.input.binary-sha256': owner.binarySha256,
      } })).toBe(201)
      forwarded.length = 0
      await fs.writeFile(path.join(control, 'mcp-capabilities', `${generationId}.json`), JSON.stringify({ soulId: 'foreign', incarnationId: null }))
    }
    await fs.writeFile(publication, JSON.stringify({ ...binding, soulId: 'foreign' }))
    expect(await selectedRequest()).toBe(403)
    expect(forwarded).toEqual([])
    await fs.writeFile(path.join(control, 'mcp-capabilities', `${generationId}.json`), JSON.stringify({ soulId, incarnationId: null }))
    for (const outside of [path.join(home, 'outside/settings.json'), path.join(directory, 'sibling/.claude/settings.json'),
      '/home/freshell/provider/.local/share/opencode/session.json']) {
      const changed = structuredClone(context)
      changed.preparedInputs.configBinds[1].effectiveDestination = outside
      changed.preparedInputs.configBinds[1].logicalDestination = outside
      const changedContext = Buffer.from(JSON.stringify(changed))
      const changedResult = Buffer.from(JSON.stringify({ providerLaunchContext: changed, providerSecretReferences: [] }))
      await fs.writeFile(path.join(metadata, 'prepared-context.json'), changedContext)
      await fs.writeFile(path.join(metadata, 'prepared-result.json'), changedResult)
      await fs.writeFile(publication, JSON.stringify({ ...binding,
        preparedContextSha256: digest(changedContext), preparedResultSha256: digest(changedResult) }))
      expect(await selectedRequest()).toBe(403)
      expect(forwarded).toEqual([])
    }
    await fs.writeFile(path.join(metadata, 'prepared-context.json'), contextBytes)
    await fs.writeFile(path.join(metadata, 'prepared-result.json'), resultBytes)
    await fs.writeFile(publication, JSON.stringify(binding))
    expect(await selectedRequest(), JSON.stringify(harness.broker.eventsSnapshot().slice(-4))).toBe(provider === 'claude' ? 404 : 201)
    expect(forwarded).toEqual([url])
    if (provider === 'claude') {
      expect(await request('DELETE')).toBe(403)
      expect(await request('POST')).toBe(403)
    } else {
      expect(await request('POST', url, { ...volume, Labels: { ...volume.Labels, 'com.freshell.soul-id': 'foreign' } })).toBe(403)
      expect(await request('DELETE', `/v1.47/volumes/${indexedVolume}?force=1`)).toBe(403)
    }
    expect(forwarded).toEqual([url])
  } finally {
    await harness?.broker?.close()
    await new Promise<void>(resolve => daemon.close(() => resolve()))
    if (inheritedDockerHost === undefined) delete process.env.DOCKER_HOST
    else process.env.DOCKER_HOST = inheritedDockerHost
    if (harness) await fs.rm(harness.testRoot, { recursive: true, force: true })
    await fs.rm(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
})

describe('closed managed environment fixture inputs', () => {
  it('dispatches the selected private HOME with workspace and bootstrap into its supervisor', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-supervisor-input-'))
    const repository = path.join(directory, 'repository'), home = path.join(directory, 'home')
    const xdg = path.join(home, 'fixture-xdg'), workspace = path.join(directory, 'workspace')
    const grant = path.join(directory, 'grant.env'), socket = path.join(directory, 'daemon.sock')
    const previousDockerHost = process.env.DOCKER_HOST
    const daemon = http.createServer((_request, response) => response.writeHead(500).end())
    let harness: RuntimeHarness | undefined
    try {
      await fs.mkdir(path.join(repository, 'test/runtime'), { recursive: true })
      await fs.writeFile(path.join(repository, 'test/runtime/gate-manifest.json'), '{}')
      await fs.mkdir(path.join(xdg, 'opencode'), { recursive: true })
      await fs.chmod(home, 0o700)
      await fs.mkdir(workspace)
      await fs.writeFile(grant, 'synthetic-closed-grant', { mode: 0o600 })
      const host = path.join(directory, 'host')
      await fs.writeFile(host, 'owned fixture host artifact')
      await new Promise<void>(resolve => daemon.listen(socket, resolve))
      process.env.DOCKER_HOST = `unix://${socket}`
      const rig = new ManagedRuntimeBrowserRig(repository, 2, { HOME: home, XDG_CONFIG_HOME: xdg },
        { HOME: home, XDG_CONFIG_HOME: xdg }, 'test', { enabledProviders: ['opencode'] }, home,
        { workspaceRoots: [workspace], bootstrapFiles: [grant], defaultCwd: workspace })
      harness = rig.runtime
      useOwnedHarnessArtifacts(harness, host)
      await harness.prepare()
      fakeDocker.supervisorCommands = []
      await harness.startSupervisor({ scenarioId: 'closed-home', waitForHealth: false,
        env: { HOME: home, XDG_CONFIG_HOME: xdg } })
      expect(fakeDocker.supervisorCommands).toHaveLength(1)
      const dispatched = fakeDocker.supervisorCommands[0]
      expect(dispatched).toContain(`${workspace}:${workspace}:ro`)
      expect(dispatched).toContain(`${grant}:${grant}:ro`)
      expect(dispatched).toContain(`HOME=${home}`)
      expect(dispatched).toContain(`XDG_CONFIG_HOME=${xdg}`)
      expect(dispatched).toContain(`${home}:${home}:ro`)
      expect(dispatched).not.toContain(`${repository}:${repository}:ro`)
      expect((await fs.stat(home)).mode & 0o777).toBe(0o700)
    } finally {
      await harness?.broker?.close()
      await new Promise<void>(resolve => daemon.close(() => resolve()))
      if (previousDockerHost === undefined) delete process.env.DOCKER_HOST
      else process.env.DOCKER_HOST = previousDockerHost
      if (harness) await fs.rm(harness.testRoot, { recursive: true, force: true })
      await fs.rm(directory, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })

  it.each(['selected-workspace', 'selected-bootstrap', 'ambient-bootstrap'] as const)(
    'routes only the explicitly selected fixture inputs: %s', async selection => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-input-'))
      const repository = path.join(directory, 'repository')
      const home = path.join(directory, 'home')
      const workspace = selection === 'selected-workspace'
        ? path.join(directory, 'selected-workspace') : path.join(repository, 'selected-workspace')
      const grant = path.join(directory, 'selected.env')
      const socket = path.join(directory, 'daemon.sock')
      const forwarded: string[] = []
      const daemon = http.createServer((request, response) => {
        request.resume()
        forwarded.push(request.url!)
        response.writeHead(201).end(JSON.stringify({ Id: 'd'.repeat(64) }))
      })
      const previousDockerHost = process.env.DOCKER_HOST
      const bootstrapKey = 'FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE'
      const previousBootstrap = process.env[bootstrapKey]
      let harness: RuntimeHarness | undefined
      try {
        await fs.mkdir(path.join(repository, 'test/runtime'), { recursive: true })
        await fs.mkdir(home)
        await fs.mkdir(workspace)
        await fs.writeFile(path.join(repository, 'test/runtime/gate-manifest.json'), '{}')
        await fs.writeFile(grant, 'synthetic-selected-grant', { mode: 0o600 })
        const host = path.join(directory, 'host')
        await fs.writeFile(host, 'owned fixture host artifact')
        await new Promise<void>(resolve => daemon.listen(socket, resolve))
        process.env.DOCKER_HOST = `unix://${socket}`
        if (selection === 'ambient-bootstrap') process.env[bootstrapKey] = grant
        else delete process.env[bootstrapKey]
        harness = new RuntimeHarness(repository, undefined, 2, home, undefined, {
          workspaceRoots: [workspace], bootstrapFiles: selection === 'selected-bootstrap' ? [grant] : [],
        })
        useOwnedHarnessArtifacts(harness, host)
        await harness.prepare()
        const create = (selectedWorkspace: string, bootstrap?: string) => new Promise<number>((resolve, reject) => {
          const request = http.request({ socketPath: harness!.broker.proxySocketPath,
            path: '/v1.47/containers/create?name=closed-fixture', method: 'POST' }, response => {
            response.resume(); response.once('end', () => resolve(response.statusCode!))
          })
          request.once('error', reject)
          request.end(JSON.stringify({ Image: harness!.imageRef, Env: [], Labels: {
            project: 'freshell', 'com.freshell.managed': 'true',
            'com.freshell.installation-id': 'installation-fixture',
            'com.freshell.soul-id': 'soul-fixture', 'com.freshell.incarnation-id': 'incarnation-fixture',
            'com.freshell.runtime-test-run-id': harness!.runId,
          }, HostConfig: { NetworkMode: 'bridge', ExtraHosts: [], PidMode: '', ReadonlyRootfs: true,
            Privileged: false, CapDrop: ['ALL'], CapAdd: ['CHOWN', 'SETGID', 'SETUID'],
            SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' },
            NanoCpus: 500_000_000, Memory: 128 * 1024 * 1024, PidsLimit: 64,
            Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' }, Binds: [
              `${host}:/runtime/freshell-session-host:ro`,
              `${path.join(harness!.testRoot, 'r/scenario/x/incarnation-fixture')}:/run/freshell:rw`,
              `freshell-provider-${'a'.repeat(24)}:/home/freshell/provider:rw`,
              `${selectedWorkspace}:${selectedWorkspace}:rw`,
              ...(bootstrap ? [`${bootstrap}:/run/freshell-bootstrap/provider-0:ro`] : []),
            ] } }))
        })
        const expected = selection === 'ambient-bootstrap' ? 403 : 201
        expect(await create(workspace, selection === 'selected-workspace' ? undefined : grant),
          JSON.stringify(harness.broker.eventsSnapshot())).toBe(expected)
        expect(forwarded).toEqual(expected === 201 ? ['/v1.47/containers/create?name=closed-fixture'] : [])
        // Closing the selected roots must also remove the repository's ambient grant.
        forwarded.length = 0
        expect(await create(repository)).toBe(403)
        expect(forwarded).toEqual([])
      } finally {
        await harness?.broker?.close()
        await new Promise<void>(resolve => daemon.close(() => resolve()))
        if (previousDockerHost === undefined) delete process.env.DOCKER_HOST
        else process.env.DOCKER_HOST = previousDockerHost
        if (previousBootstrap === undefined) delete process.env[bootstrapKey]
        else process.env[bootstrapKey] = previousBootstrap
        if (harness) await fs.rm(harness.testRoot, { recursive: true, force: true })
        await fs.rm(directory, { recursive: true, force: true })
        vi.restoreAllMocks()
      }
    },
  )
})

describe('runtime harness indexed input cleanup', () => {
  it.each(['removed', 'foreign-label', 'attached', 'retained-after-delete'] as const)(
    'settles the actual publisher before exact nonforce cleanup: %s', async outcome => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-cleanup-'))
      const calls: { method: string; url: string }[] = []
      let volume: any, exists = false
      fakeDocker.settled = false
      fakeDocker.commands = []
      const daemon = http.createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
        calls.push({ method: request.method!, url: request.url! })
        if (request.url === '/v1.47/volumes/create') {
          volume = { Name: body.Name, Driver: body.Driver, Options: body.DriverOpts, Labels: body.Labels }
          exists = true
          response.statusCode = 201
          response.end(JSON.stringify(volume))
        } else if (request.url?.startsWith('/v1.47/containers/create?')) {
          response.statusCode = 201
          response.end(JSON.stringify({ Id: 'a'.repeat(64) }))
        } else if (request.method === 'GET') {
          response.statusCode = exists ? 200 : 404
          response.end(JSON.stringify(exists ? volume : {}))
        } else if (request.method === 'DELETE') {
          if (!fakeDocker.settled || outcome === 'attached') response.statusCode = 409
          else {
            response.statusCode = 204
            if (outcome !== 'retained-after-delete') exists = false
          }
          response.end()
        } else { response.statusCode = 500; response.end() }
      })
      const harness = new RuntimeHarness(directory)
      const broker = new RestrictedDockerBroker({ realSocketPath: path.join(directory, 'daemon.sock'),
        proxySocketPath: path.join(directory, 'broker.sock'), runtimeRootPrefix: path.join(directory, 'r'),
        allowedHostBinaryPaths: new Set([path.join(directory, 'host')]), allowedImageRefs: new Set(['sha256:fixture']),
        allowedWorkspaceRoots: new Set(['/workspace']), testRunId: harness.runId, logPath: path.join(directory, 'broker.jsonl') })
      harness.broker = broker
      const request = (method: string, url: string, body?: unknown) => new Promise<number>((resolve, reject) => {
        const outgoing = http.request({ socketPath: broker.proxySocketPath, path: url, method }, response => {
          response.resume()
          response.once('end', () => resolve(response.statusCode!))
        })
        outgoing.once('error', reject)
        outgoing.end(body === undefined ? undefined : JSON.stringify(body))
      })
      try {
        await new Promise<void>(resolve => daemon.listen(path.join(directory, 'daemon.sock'), resolve))
        await broker.start()
        // Exercise cleanup's actual live-broker lifecycle without image/build preparation.
        ;(harness as unknown as { brokerStarted: boolean }).brokerStarted = true
        const generationId = 'grant-cleanup', soulId = 'soul-cleanup'
        const input: PreparedInputAuthorization = { installationId: 'installation-cleanup', soulId,
          incarnationId: 'incarnation-cleanup', generationId, imageRef: 'sha256:fixture', hostBinaryPath: path.join(directory, 'host'),
          providerVolumeName: `freshell-provider-${'b'.repeat(24)}`,
          stageRoot: path.join(directory, 'scenarios/scenario/control/provider-roots', generationId),
          configurationBinds: [], resourceMounts: [], indexedSecretSources: [],
          indexedFiles: { volumeName: `freshell-inputs-${createHash('sha256').update(`${soulId}\0${generationId}`).digest('hex').slice(0, 24)}`, aliases: [] } }
        broker.authorizePreparedInputs(input)
        const labels = { 'com.freshell.managed-inputs': 'true', 'com.freshell.installation-id': input.installationId,
          'com.freshell.soul-id': soulId, 'com.freshell.incarnation-id': input.incarnationId, 'com.freshell.input-generation': generationId }
        expect(await request('POST', '/v1.47/volumes/create', { Name: input.indexedFiles!.volumeName, Driver: 'local',
          DriverOpts: { type: 'tmpfs', device: 'tmpfs', o: 'size=64m,mode=0700,uid=65534,gid=0,nr_inodes=1024,nosuid,nodev,noexec' }, Labels: labels })).toBe(201)
        const exchange = path.join(directory, 'freshell-inputs-11111111-1111-4111-8111-111111111111')
        await fs.mkdir(exchange)
        const publisher = { Image: input.imageRef, User: '65534:0', Tty: false, Labels: labels,
          Entrypoint: ['/runtime/freshell-session-host'], Cmd: ['publish-provider-inputs'], Env: ['PATH='],
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
            Memory: 128 * 1024 * 1024, MemorySwap: 128 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 32, LogConfig: { Type: 'none', Config: {} },
            Mounts: [{ Type: 'bind', Source: input.hostBinaryPath, Target: '/runtime/freshell-session-host', ReadOnly: true },
              { Type: 'volume', Source: input.indexedFiles!.volumeName, Target: '/run/freshell-input-files', ReadOnly: false, VolumeOptions: { NoCopy: true } },
              { Type: 'bind', Source: exchange, Target: '/run/freshell-input-exchange', ReadOnly: true }] } }
        // A rejected publisher must not become cleanup authority.
        expect(await request('POST', `/v1.47/containers/create?name=freshell-inputs-${'c'.repeat(24)}-publisher`, publisher)).toBe(403)
        expect(await request('POST', `/v1.47/containers/create?name=${input.indexedFiles!.volumeName}-publisher`, publisher)).toBe(201)
        if (outcome === 'foreign-label') volume.Labels['com.freshell.soul-id'] = 'foreign'
        const result = await harness.cleanup()
        expect(fakeDocker.settled).toBe(true)
        expect(fakeDocker.commands).toEqual([['inspect', 'a'.repeat(64)], ['rm', '-f', 'a'.repeat(64)]])
        expect(result.ok).toBe(outcome === 'removed')
        expect(exists).toBe(outcome !== 'removed')
        const deletes = calls.filter(call => call.method === 'DELETE')
        expect(deletes).toEqual(outcome === 'foreign-label' ? [] : [{ method: 'DELETE', url: `/v1.47/volumes/${input.indexedFiles!.volumeName}` }])
        const cleanup = JSON.parse(await fs.readFile(path.join(harness.evidenceDir, 'cleanup.json'), 'utf8'))
        expect(cleanup.volumes).toContain(input.indexedFiles!.volumeName)
        expect(cleanup.volumes).not.toContain(`freshell-inputs-${'c'.repeat(24)}`)
        if (outcome === 'removed') expect(calls.at(-1)).toEqual({ method: 'GET', url: `/v1.47/volumes/${input.indexedFiles!.volumeName}` })
      } finally {
        await broker.close()
        await new Promise<void>(resolve => daemon.close(() => resolve()))
        await fs.rm(directory, { recursive: true, force: true })
      }
    },
  )
})
