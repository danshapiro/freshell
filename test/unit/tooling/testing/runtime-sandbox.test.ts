import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fakeDocker = vi.hoisted(() => ({ settled: false, commands: [] as string[][] }))
vi.mock('node:child_process', () => {
  const api = {
    spawn: () => { throw new Error('unexpected spawned process in isolated harness fixture') },
    execFileSync: (program: string, args: string[]) => {
      if (program === 'git' && args.join(' ') === 'rev-parse HEAD') return 'cleanup-fixture-commit\n'
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
