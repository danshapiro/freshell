import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceRoot = process.cwd()
const wrapperSource = process.env.FRESHELL_TEST_SANDBOX_WRAPPER_SOURCE ?? path.join(sourceRoot, 'scripts/sandbox-test.sh')
const containerHelper = '/run/freshell-sandbox-diagnostics.mjs'
const cid = 'a'.repeat(64)

type Mount = { Type: string; Source: string; Target: string; ReadOnly: boolean }
type CreateRequest = { Cmd: string[]; HostConfig: { Mounts: Mount[] } }

// Exercise Docker's real --mount CSV parser. This small API fixture models
// creation/attachment and executes only the launcher's bounded test prelude;
// it never connects to a real daemon or creates a container or volume.
async function dockerFixture(root: string, caller: string) {
  const socketPath = path.join(root, 'docker.sock')
  const requests: string[] = []
  const creates: CreateRequest[] = []
  const sockets = new Set<Socket>()
  let attach: Duplex | undefined
  let completed: { stdout: string; stderr: string; status: number } | undefined
  let finish!: (value: { stdout: string; stderr: string; status: number }) => void
  const completion = new Promise<{ stdout: string; stderr: string; status: number }>(resolve => { finish = resolve })

  function sendOutput() {
    if (!attach || !completed) return
    for (const [kind, output] of [[1, completed.stdout], [2, completed.stderr]] as const) {
      const bytes = Buffer.from(output)
      if (bytes.length === 0) continue
      const header = Buffer.alloc(8)
      header[0] = kind
      header.writeUInt32BE(bytes.length, 4)
      attach.write(Buffer.concat([header, bytes]))
    }
    attach.end()
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Api-Version': '1.44' })
    res.end(JSON.stringify(body))
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '').replace(/^\/v\d+\.\d+/, '')
    requests.push(`${req.method} ${url}`)
    if (url === '/_ping') {
      res.writeHead(200, { 'Api-Version': '1.44' })
      res.end('OK')
    } else if (url.startsWith('/volumes?')) {
      json(res, 200, { Volumes: [], Warnings: [] })
    } else if (url.startsWith('/images/') && url.endsWith('/json')) {
      json(res, 200, { Id: `sha256:${cid}`, Config: {} })
    } else if (url.startsWith('/networks/')) {
      json(res, 200, { Name: 'freshell-sandbox', Id: cid })
    } else if (req.method === 'POST' && url.startsWith('/containers/create?')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      creates.push(JSON.parse(Buffer.concat(chunks).toString()) as CreateRequest)
      json(res, 201, { Id: cid, Warnings: [] })
    } else if (req.method === 'POST' && url === `/containers/${cid}/start`) {
      json(res, 204, {})
      const spec = creates.at(-1)!
      const [shell, option, prelude, label, helper, ...args] = spec.Cmd
      const mount = spec.HostConfig.Mounts.find(item => item.Target === containerHelper)
      // Never execute arbitrary input sent to this test-only server.
      if (shell !== 'bash' || option !== '-c' || label !== 'sandbox-observe'
        || helper !== containerHelper || args.at(-1) !== caller) {
        completed = { stdout: '', stderr: 'unexpected fixture command', status: 1 }
        finish(completed)
        sendOutput()
        return
      }
      const mappedHelper = mount?.Source ?? path.join(root, 'absent-helper')
      try {
        const result = await execFileAsync('bash', ['-c', prelude, label, mappedHelper, ...args], {
          cwd: root, timeout: 5000, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root },
        })
        completed = { stdout: result.stdout, stderr: result.stderr, status: 0 }
      } catch (error) {
        const result = error as { stdout?: string; stderr?: string; code?: number }
        completed = { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.code ?? 1 }
      }
      finish(completed)
      sendOutput()
    } else if (req.method === 'POST' && url.startsWith(`/containers/${cid}/wait`)) {
      // Docker waits for the response headers before sending start.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      res.end(JSON.stringify({ StatusCode: (await completion).status }))
    } else if (url.startsWith('/containers/json?')) {
      json(res, 200, [])
    } else if (url === `/containers/${cid}/json`) {
      json(res, 404, { message: 'no such container' })
    } else {
      json(res, 500, { message: `unexpected fixture request: ${req.method} ${url}` })
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket) => {
    requests.push(`${req.method} ${(req.url ?? '').replace(/^\/v\d+\.\d+/, '')}`)
    if (req.method !== 'POST' || !req.url?.includes(`/containers/${cid}/attach?`)) {
      socket.destroy()
      return
    }
    attach = socket
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    sendOutput()
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve))
  return {
    socketPath, requests, creates,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-C', root, '-c', 'user.name=Sandbox Test', '-c', 'user.email=sandbox@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    stdio: 'pipe', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
}

describe('trusted diagnostics helper Docker mount', () => {
  it.each([
    { name: 'ordinary plain', directory: 'trusted', linked: false },
    { name: 'ordinary comma', directory: 'trusted,one', linked: false },
    { name: 'ordinary quote', directory: 'trusted"one', linked: false },
    { name: 'ordinary comma and quote', directory: 'trusted,one"two', linked: false },
    { name: 'ordinary newline', directory: 'trusted\none', linked: false },
    { name: 'linked comma with missing target helper', directory: 'trusted,one', linked: true },
    { name: 'linked comma and quote with different target helper', directory: 'trusted,one"two', linked: true, different: true },
    { name: 'missing trusted helper', directory: 'trusted,one', linked: false, helper: 'missing' },
    { name: 'failing trusted helper', directory: 'trusted,one', linked: false, helper: 'failing' },
    { name: 'missing trusted helper preserves caller failure', directory: 'trusted,one', linked: false, helper: 'missing', status: 37 },
    { name: 'failing trusted helper preserves caller failure', directory: 'trusted,one', linked: false, helper: 'failing', status: 37 },
    { name: 'untrusted target', directory: 'trusted,one', linked: true, untrusted: true },
  ])('$name', async scenario => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'fm-'))
      let daemon: Awaited<ReturnType<typeof dockerFixture>> | undefined
      try {
        const common = path.join(root, 'common')
        const wrapper = path.join(root, scenario.directory)
        const target = scenario.linked ? path.join(root, 'target') : wrapper
        const control = path.join(root, 'control')
        const bin = path.join(root, 'bin')
        const dockerConfig = path.join(root, 'docker-config')
        for (const dir of [common, control, bin, dockerConfig]) mkdirSync(dir)
        if (!scenario.linked) mkdirSync(wrapper)
        const repo = scenario.linked ? common : wrapper
        git(repo, 'init', '-q')
        git(repo, 'commit', '--allow-empty', '-qm', 'fixture')
        if (scenario.linked) {
          git(common, 'worktree', 'add', '--detach', '-q', wrapper, 'HEAD')
          if (scenario.untrusted) {
            mkdirSync(target)
            git(target, 'init', '-q')
          } else git(common, 'worktree', 'add', '--detach', '-q', target, 'HEAD')
        }
        for (const file of ['scripts/sandbox-test.sh', 'scripts/testing/sandbox-diagnostics.mjs']) {
          if (file.endsWith('sandbox-diagnostics.mjs') && scenario.helper === 'missing') continue
          mkdirSync(path.dirname(path.join(wrapper, file)), { recursive: true })
          copyFileSync(file === 'scripts/sandbox-test.sh' ? wrapperSource : path.join(sourceRoot, file), path.join(wrapper, file))
        }
        if (scenario.helper === 'failing') {
          writeFileSync(path.join(wrapper, 'scripts/testing/sandbox-diagnostics.mjs'), 'process.exit(79)\n')
        }
        if (scenario.different) {
          const wrong = path.join(target, 'scripts/testing/sandbox-diagnostics.mjs')
          mkdirSync(path.dirname(wrong), { recursive: true })
          writeFileSync(wrong, "console.error('WRONG_TARGET_HELPER'); process.exit(79)\n")
        }
        const docker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim()
        symlinkSync(docker, path.join(bin, 'docker'))
        const caller = `printf 'caller-ran\\n'${scenario.status ? `; exit ${scenario.status}` : ''}`
        daemon = await dockerFixture(root, caller)
        const env = {
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: control,
          DOCKER_CONFIG: dockerConfig, DOCKER_HOST: `unix://${daemon.socketPath}`,
          FRESHELL_SANDBOX_DEPENDENCIES_READY: '1', FRESHELL_SANDBOX_OWNER_GUARD: '0',
          FRESHELL_SANDBOX_CACHE_PREFIX: 'sandbox-mount-test', GIT_CONFIG_NOSYSTEM: '1',
        }
        const args = [path.join(wrapper, 'scripts/sandbox-test.sh'),
          ...(scenario.linked ? ['--workspace-root', target, '--runtime-suite'] : []), caller]
        let result: { stdout: string; stderr: string; status: number }
        try {
          const run = await execFileAsync('bash', args, { env, encoding: 'utf8', timeout: 15_000 })
          result = { ...run, status: 0 }
        } catch (error) {
          const run = error as { stdout?: string; stderr?: string; code?: number }
          result = { stdout: run.stdout ?? '', stderr: run.stderr ?? '', status: run.code ?? 1 }
        }
        if (scenario.untrusted) {
          expect(result.status, result.stderr).toBe(2)
          expect(result.stderr).toContain('--workspace-root must be a worktree in the trusted wrapper repository')
          expect(daemon.requests).toEqual([])
          return
        }
        expect(result.status, `${result.stderr}\nrequests: ${JSON.stringify(daemon.requests)}`).toBe(scenario.status ?? 0)
        expect(result.stdout).toBe('caller-ran\n')
        expect(daemon.creates).toHaveLength(1)
        const mount = daemon.creates[0].HostConfig.Mounts.find(item => item.Target === containerHelper)
        if (scenario.helper === 'missing') expect(mount).toBeUndefined()
        else expect(mount).toMatchObject({ Type: 'bind', Source: path.join(wrapper, 'scripts/testing/sandbox-diagnostics.mjs'),
          Target: containerHelper, ReadOnly: true })
        if (scenario.linked) {
          expect(common).not.toContain(',')
          expect(daemon.creates[0].HostConfig.Mounts).toContainEqual(expect.objectContaining({
            Type: 'bind', Source: path.join(common, '.git'), Target: path.join(common, '.git'), ReadOnly: true,
          }))
        }
        const receipts = result.stderr.split('\n').flatMap(line => {
          try { return [JSON.parse(line)] } catch { return [] }
        })
        if (scenario.helper) {
          expect(receipts).toContainEqual(expect.objectContaining({ event: 'sandbox_diagnostics_unavailable', mode: 'effective' }))
        } else {
          expect(receipts).toContainEqual(expect.objectContaining({ event: 'sandbox_effective_limits',
            phase: scenario.linked ? 'runtime-suite' : 'ordinary',
            command_sha256: createHash('sha256').update(caller).digest('hex') }))
          expect(result.stderr).not.toContain('sandbox_diagnostics_unavailable')
        }
        expect(result.stderr).not.toContain('WRONG_TARGET_HELPER')
        expect(readdirSync(control)).toEqual([])
      } finally {
        await daemon?.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
