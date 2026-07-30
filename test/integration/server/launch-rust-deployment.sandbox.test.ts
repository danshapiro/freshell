import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

if (process.env.FRESHELL_DESTRUCTIVE_SANDBOX !== '1') {
  throw new Error(
    'launch-rust deployment tests are destructive and require FRESHELL_DESTRUCTIVE_SANDBOX=1',
  )
}
if (!path.resolve(os.tmpdir()).startsWith('/tmp')) {
  throw new Error(`sandbox test outputs must be rooted beneath container /tmp, got ${os.tmpdir()}`)
}

const testFile = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(testFile), '../../..')
const fixtures = path.join(repository, 'test/fixtures/launch-rust')

type FixtureState = {
  selectedGenerationId: string
  runningServerGenerationId: string | null
  legacy: boolean
  stopCount: number
  startCount: number
}

let fixtureRoot = ''
let checkout = ''
let environment: NodeJS.ProcessEnv

function run(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
  return spawnSync(path.join(checkout, 'scripts/launch-rust.sh'), args, {
    cwd: checkout,
    encoding: 'utf8',
    env: { ...environment, ...extraEnvironment },
  })
}

function controller(args: string[]) {
  return spawnSync(path.join(fixtures, 'fake-controller.mjs'), args, {
    cwd: checkout,
    encoding: 'utf8',
    env: environment,
  })
}

function state(port = '43127'): FixtureState {
  return JSON.parse(
    readFileSync(
      path.join(checkout, '.freshell-deploy', 'ports', port, 'fixture-state.json'),
      'utf8',
    ),
  )
}

function events() {
  if (!existsSync(environment.FRESHELL_FIXTURE_LOG!)) return []
  return readFileSync(environment.FRESHELL_FIXTURE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { command: string; args: string[]; target?: string; clientOut?: string })
}

function checked(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
  } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result
}

function checkedAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
  } = {},
) {
  const timeout = options.timeout ?? 180_000
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflow = false
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next) > 32 * 1024 * 1024) {
        overflow = true
        child.kill('SIGTERM')
      }
      return next
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeout)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && !overflow && !timedOut) {
        resolve({ stdout, stderr })
        return
      }
      const outcome = timedOut
        ? `timed out after ${timeout}ms`
        : overflow
          ? 'exceeded the 32 MiB output bound'
          : `failed (${code ?? signal})`
      reject(
        new Error(
          `${command} ${args.join(' ')} ${outcome}:\n${stdout}\n${stderr}`,
        ),
      )
    })
  })
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture port was not assigned')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return address.port
}

async function waitForHttp(port: number, expected: 'up' | 'down', timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (expected === 'up' && response.status === 200) return
    } catch {
      if (expected === 'down') return
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`port ${port} did not become ${expected}`)
}

function initialize(label = 'prior', options: string[] = []) {
  const result = controller([
    'fixture-init',
    '--checkout',
    checkout,
    '--port',
    '43127',
    '--label',
    label,
    ...options,
  ])
  expect(result.status, result.stderr).toBe(0)
  writeFileSync(environment.FRESHELL_FIXTURE_LOG!, '')
  return result.stdout.trim()
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'freshell-launch-task6-'))
  checkout = path.join(fixtureRoot, 'checkout')
  const bin = path.join(fixtureRoot, 'bin')
  mkdirSync(path.join(checkout, 'scripts'), { recursive: true })
  mkdirSync(path.join(checkout, 'extensions'), { recursive: true })
  mkdirSync(path.join(checkout, 'crates/freshell-claude-sidecar'), { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(checkout, '.git'), 'gitdir: /tmp/fixture.git\n')
  writeFileSync(path.join(checkout, 'package.json'), '{"name":"fixture","dependencies":{}}\n')
  writeFileSync(
    path.join(checkout, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture"}}}\n',
  )
  writeFileSync(path.join(checkout, 'extensions', 'fixture.json'), '{}\n')
  writeFileSync(path.join(checkout, 'crates/freshell-claude-sidecar', 'index.mjs'), 'process.exit(0)\n')
  writeFileSync(path.join(checkout, 'crates/freshell-claude-sidecar', 'package.json'), '{"name":"sidecar"}\n')
  writeFileSync(
    path.join(checkout, 'crates/freshell-claude-sidecar', 'package-lock.json'),
    '{"name":"sidecar","lockfileVersion":3,"packages":{"":{"name":"sidecar"}}}\n',
  )
  copyFileSync(path.join(repository, 'scripts/launch-rust.sh'), path.join(checkout, 'scripts/launch-rust.sh'))
  chmodSync(path.join(checkout, 'scripts/launch-rust.sh'), 0o755)
  for (const [source, destination] of [
    ['fake-npm.mjs', 'npm'],
    ['fake-cargo.mjs', 'cargo'],
  ]) {
    copyFileSync(path.join(fixtures, source), path.join(bin, destination))
    chmodSync(path.join(bin, destination), 0o755)
  }
  const node = process.execPath
  environment = {
    ...process.env,
    PATH: `${bin}:${path.dirname(node)}:/usr/bin:/bin`,
    PORT: undefined,
    FRESHELL_DEPLOY_BUILD_PARENT: path.join(fixtureRoot, 'private-builds'),
    FRESHELL_FIXTURE_CHECKOUT: checkout,
    FRESHELL_FIXTURE_CONTROLLER: path.join(fixtures, 'fake-controller.mjs'),
    FRESHELL_FIXTURE_LOG: path.join(fixtureRoot, 'commands.jsonl'),
    FRESHELL_FIXTURE_PACKAGE_JSON: path.join(checkout, 'package.json'),
    FRESHELL_FIXTURE_PACKAGE_LOCK: path.join(checkout, 'package-lock.json'),
    AUTH_TOKEN: 'sandbox-token',
  }
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('canonical launch-rust deployment wrapper', () => {
  it.each([
    { args: ['--port'], message: /missing value|port/i },
    { args: ['--port', '0'], message: /port/i },
    { args: ['--port=043127'], message: /port/i },
    { args: ['--port=65536'], message: /port/i },
    { args: ['--port=18446744073709551617', '--stop'], message: /port/i },
    { args: [`--port=${'9'.repeat(10_000)}`, '--stop'], message: /port/i },
    { args: ['--port=abc'], message: /port/i },
    { args: ['--port=43127', '--port=43128'], message: /duplicate/i },
    { args: [], message: /requires.*restart/i },
    { args: ['--restart', '--restart'], message: /duplicate/i },
    { args: ['--client-only', '--client-only'], message: /duplicate/i },
    { args: ['--server-only', '--server-only', '--restart'], message: /duplicate/i },
    { args: ['--skip-build', '--skip-build'], message: /duplicate/i },
    { args: ['--stop', '--stop'], message: /duplicate/i },
    { args: ['--client-only', '--server-only', '--restart'], message: /conflict/i },
    { args: ['--client-only', '--restart'], message: /conflict/i },
    { args: ['--server-only'], message: /requires.*restart/i },
    { args: ['--skip-build', '--client-only'], message: /conflict/i },
    { args: ['--skip-build', '--server-only', '--restart'], message: /conflict/i },
    { args: ['--skip-build', '--stop'], message: /conflict/i },
    { args: ['--client-only', '--stop'], message: /conflict/i },
    { args: ['--server-only', '--restart', '--stop'], message: /conflict/i },
    { args: ['--stop', '--restart'], message: /conflict/i },
    { args: ['--wat'], message: /unknown/i },
  ])('rejects $args before invoking a build or controller', ({ args, message }) => {
    const result = run(args)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(message)
    expect(events()).toEqual([])
    expect(existsSync(path.join(checkout, 'dist'))).toBe(false)
    expect(existsSync(path.join(checkout, 'target'))).toBe(false)
  })

  it('builds only the client for client-only and uses private exclusive output', () => {
    initialize()
    const result = run(['--port', '43127', '--client-only'])
    expect(result.status, result.stderr).toBe(0)
    const recorded = events()
    expect(recorded.filter((event) => event.command === 'cargo')).toEqual([])
    expect(recorded.filter((event) => event.command === 'npm').map((event) => event.args.slice(0, 2)))
      .toEqual([
        ['run', 'typecheck:client'],
        ['run', 'build:client'],
      ])
    expect(recorded.find((event) => event.command === 'npm' && event.args[1] === 'build:client')?.clientOut)
      .toMatch(/^\/tmp\//)
    expect(recorded.find((event) => event.command === 'controller')?.args).toContain('client-only')
    expect(existsSync(path.join(checkout, 'dist'))).toBe(false)
    expect(existsSync(path.join(checkout, 'target'))).toBe(false)
  })

  it('keeps default staging outside the immutable store and preserves caller parent permissions', () => {
    initialize()
    const defaultResult = run(
      ['--port', '43127', '--client-only'],
      { FRESHELL_DEPLOY_BUILD_PARENT: undefined },
    )
    expect(defaultResult.status, defaultResult.stderr).toBe(0)
    expect(
      events().find((event) => event.command === 'npm' && event.args[1] === 'build:client')?.clientOut,
    ).toMatch(/^\/tmp\//)
    expect(existsSync(path.join(checkout, '.freshell-deploy', 'builds'))).toBe(false)

    writeFileSync(environment.FRESHELL_FIXTURE_LOG!, '')
    const callerParent = path.join(fixtureRoot, 'caller-build-parent')
    mkdirSync(callerParent, { mode: 0o755 })
    chmodSync(callerParent, 0o755)
    const callerResult = run(
      ['--port', '43127', '--client-only'],
      { FRESHELL_DEPLOY_BUILD_PARENT: callerParent },
    )
    expect(callerResult.status, callerResult.stderr).toBe(0)
    expect(statSync(callerParent).mode & 0o777).toBe(0o755)
  })

  it('rejects checkout-contained and non-sticky writable staging parents before building', () => {
    initialize()
    const insideCheckout = path.join(checkout, 'private-builds')
    mkdirSync(insideCheckout)
    const inside = run(
      ['--port', '43127', '--client-only'],
      { FRESHELL_DEPLOY_BUILD_PARENT: insideCheckout },
    )
    expect(inside.status).not.toBe(0)
    expect(inside.stderr).toMatch(/outside the checkout/i)
    expect(events()).toEqual([])

    const writable = path.join(fixtureRoot, 'writable-builds')
    mkdirSync(writable)
    chmodSync(writable, 0o777)
    const unsafe = run(
      ['--port', '43127', '--client-only'],
      { FRESHELL_DEPLOY_BUILD_PARENT: writable },
    )
    expect(unsafe.status).not.toBe(0)
    expect(unsafe.stderr).toMatch(/writable/i)
    expect(events()).toEqual([])
  })

  it('builds the complete server runtime but not the client for server-only', () => {
    initialize()
    const result = run(['--port=43127', '--server-only', '--restart'])
    expect(result.status, result.stderr).toBe(0)
    const recorded = events()
    expect(recorded.filter((event) => event.command === 'npm').map((event) => event.args.slice(0, 2)))
      .toEqual([
        ['run', 'typecheck:server'],
        ['run', 'build:server'],
        ['ci', '--omit=dev'],
      ])
    const cargo = recorded.find((event) => event.command === 'cargo')
    expect(cargo?.args).toEqual(expect.arrayContaining(['freshell-server', 'freshell-deploy']))
    expect(cargo?.target).toMatch(/^\/tmp\//)
    expect(recorded.find((event) => event.command === 'controller')?.args).toContain('server')
    expect(existsSync(path.join(checkout, 'dist'))).toBe(false)
    expect(existsSync(path.join(checkout, 'target'))).toBe(false)
  })

  it('builds both components and the complete runtime for a combined restart', () => {
    initialize()
    const result = run(['--port', '43127', '--restart'])
    expect(result.status, result.stderr).toBe(0)
    const npm = events().filter((event) => event.command === 'npm').map((event) => event.args.slice(0, 2))
    expect(npm).toEqual([
      ['run', 'typecheck:client'],
      ['run', 'build:client'],
      ['run', 'typecheck:server'],
      ['run', 'build:server'],
      ['ci', '--omit=dev'],
    ])
    expect(events().find((event) => event.command === 'controller' && event.args[0] === 'deploy')?.args)
      .toContain('full')
  })

  it.each(['client_rejects_server', 'server_rejects_client'])(
    'rejects %s incompatibility before selected/running identities change',
    (direction) => {
      initialize()
      const before = state()
      const result = run(
        ['--port', '43127', '--restart'],
        { FRESHELL_FIXTURE_INCOMPATIBILITY: direction },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(direction)
      expect(state()).toEqual(before)
    },
  )

  it('preserves skip-build no-restart semantics and only restart interrupts a running server', () => {
    initialize()
    const before = state()
    const start = run(['--port', '43127', '--skip-build'])
    expect(start.status, start.stderr).toBe(0)
    expect(state()).toEqual(before)

    const restart = run(['--port', '43127', '--skip-build', '--restart'])
    expect(restart.status, restart.stderr).toBe(0)
    expect(state()).toMatchObject({
      selectedGenerationId: before.selectedGenerationId,
      runningServerGenerationId: before.selectedGenerationId,
      stopCount: before.stopCount + 1,
      startCount: before.startCount + 1,
    })
    expect(events().every((event) => !['npm', 'cargo'].includes(event.command))).toBe(true)
  })

  it('keeps selected-client and running-server identities correct through independent updates', () => {
    const prior = initialize()
    expect(run(['--port', '43127', '--client-only']).status).toBe(0)
    const client = state()
    expect(client.selectedGenerationId).not.toBe(prior)
    expect(client.runningServerGenerationId).toBe(prior)

    expect(run(['--port', '43127', '--stop']).status).toBe(0)
    expect(state()).toMatchObject({
      selectedGenerationId: client.selectedGenerationId,
      runningServerGenerationId: null,
    })

    expect(run(['--port', '43127', '--skip-build']).status).toBe(0)
    expect(state()).toMatchObject({
      selectedGenerationId: client.selectedGenerationId,
      runningServerGenerationId: client.selectedGenerationId,
    })

    expect(run(['--port', '43127', '--server-only', '--restart']).status).toBe(0)
    const server = state()
    expect(server.selectedGenerationId).not.toBe(client.selectedGenerationId)
    expect(server.runningServerGenerationId).toBe(server.selectedGenerationId)

    const failed = run(
      ['--port', '43127', '--server-only', '--restart'],
      { FRESHELL_FIXTURE_FAILPOINT: 'after_stop' },
    )
    expect(failed.status).not.toBe(0)
    expect(state()).toEqual(server)
  })

  it.each([
    'after_prepared',
    'after_stop_intent',
    'after_stop',
    'after_start_intent',
    'after_launch_claim',
    'after_target_ready',
    'after_switch_intent',
    'after_pointer_switch',
    'after_authorization',
  ])('rolls back interruption at the pre-commit boundary %s', (failpoint) => {
    initialize()
    const before = state()
    const result = run(
      ['--port', '43127', '--restart'],
      { FRESHELL_FIXTURE_FAILPOINT: failpoint },
    )
    expect(result.status).not.toBe(0)
    expect(state()).toEqual(before)
  })

  it.each(['after_activation_receipt', 'after_activation_confirmed'])(
    'replays committed activation at %s',
    (failpoint) => {
      initialize()
      const before = state()
      const result = run(
        ['--port', '43127', '--restart'],
        { FRESHELL_FIXTURE_FAILPOINT: failpoint },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(state().selectedGenerationId).not.toBe(before.selectedGenerationId)
      expect(state().runningServerGenerationId).toBe(state().selectedGenerationId)
    },
  )

  it('captures legacy before combined build and rejects one-sided legacy updates', () => {
    const legacy = initialize('legacy', ['--legacy'])
    const oneSided = run(['--port', '43127', '--client-only'])
    expect(oneSided.status).not.toBe(0)
    expect(state()).toMatchObject({
      selectedGenerationId: legacy,
      runningServerGenerationId: legacy,
      legacy: true,
    })

    writeFileSync(environment.FRESHELL_FIXTURE_LOG!, '')
    const combined = run(['--port', '43127', '--restart'])
    expect(combined.status, combined.stderr).toBe(0)
    const commands = events()
    expect(commands.findIndex((event) => event.command === 'controller' && event.args[0] === 'capture'))
      .toBeLessThan(commands.findIndex((event) => event.command === 'controller' && event.args[0] === 'deploy'))
    expect(state().legacy).toBe(false)
  })

  it('rejects server-only updates while the selected generation is legacy', () => {
    const legacy = initialize('legacy-server', ['--legacy'])
    const result = run(['--port', '43127', '--server-only', '--restart'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/one-sided|bootstrap/i)
    expect(state()).toMatchObject({
      selectedGenerationId: legacy,
      runningServerGenerationId: legacy,
      legacy: true,
    })
  })

  it('contains no shell process control, process scans, live artifact replacement, or JSON construction', () => {
    const source = readFileSync(path.join(repository, 'scripts/launch-rust.sh'), 'utf8')
    expect(source).not.toMatch(/\bkill\b/)
    expect(source).not.toMatch(/\/proc\/|\bps\b|\bpgrep\b|\bpkill\b|\bss\b|\blsof\b/)
    expect(source).not.toMatch(/\bmv\b[^\n]*(?:dist|target|current|live\\.json)/)
    expect(source).not.toMatch(/(?:printf|echo)[^\n]*[{[]/)
  })
})

describe('real deployment controller boundary', () => {
  it('captures, activates, updates, stops, starts, and restarts exact real processes', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'freshell-real-deploy-task6-'))
    const realCheckout = path.join(root, 'checkout')
    const home = path.join(root, 'home')
    const runtime = path.join(root, 'runtime')
    const candidateClient = path.join(root, 'candidate-client')
    const nextClient = path.join(root, 'next-client')
    const distServer = path.join(runtime, 'dist-server')
    const sidecar = path.join(runtime, 'sidecar')
    const nodeModules = path.join(runtime, 'node_modules')
    const pidFile = path.join(root, 'legacy.pid')
    const logFile = path.join(root, 'legacy.log')
    const token = `task6-real-sandbox-${Date.now()}-token`
    const node = realpathSync(process.execPath)
    let port = await unusedPort()
    while (port === 3002) port = await unusedPort()
    const knownPids = new Set<number>()

    mkdirSync(realCheckout, { recursive: true })
    mkdirSync(home)
    mkdirSync(path.join(distServer, 'mcp'), { recursive: true })
    mkdirSync(sidecar)
    mkdirSync(nodeModules)
    writeFileSync(path.join(realCheckout, '.git'), 'gitdir: /tmp/task6-real-fixture.git\n')
    writeFileSync(
      path.join(realCheckout, '.env'),
      `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\n`,
      { mode: 0o600 },
    )
    const packageManifest = JSON.stringify({
      name: 'freshell-real-deploy-fixture',
      version: '1.0.0',
      type: 'module',
    })
    const packageLock = JSON.stringify({
      name: 'freshell-real-deploy-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'freshell-real-deploy-fixture',
          version: '1.0.0',
        },
      },
    })
    const hiddenPackageLock = JSON.stringify({
      name: 'freshell-real-deploy-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {},
    })
    writeFileSync(path.join(realCheckout, 'package.json'), packageManifest)
    writeFileSync(path.join(realCheckout, 'package-lock.json'), packageLock)
    writeFileSync(path.join(runtime, 'package.json'), packageManifest)
    writeFileSync(path.join(runtime, 'package-lock.json'), packageLock)
    writeFileSync(path.join(nodeModules, '.package-lock.json'), hiddenPackageLock)
    writeFileSync(path.join(distServer, 'mcp/server.js'), 'export const task6RealFixture = true\n')
    writeFileSync(path.join(sidecar, 'package.json'), packageManifest)
    writeFileSync(path.join(sidecar, 'package-lock.json'), packageLock)
    writeFileSync(
      path.join(sidecar, 'index.mjs'),
      "import readline from 'node:readline'\n" +
        "const lines = readline.createInterface({ input: process.stdin })\n" +
        "lines.on('line', (line) => {\n" +
        "  if (JSON.parse(line).type === 'shutdown') process.exit(0)\n" +
        "})\n",
    )

    const realEnvironment = {
      ...process.env,
      AUTH_TOKEN: token,
      FRESHELL_HOME: home,
      HOME: home,
    }

    try {
      await checkedAsync('cargo', ['build', '--quiet', '-p', 'freshell-server'], {
        env: realEnvironment,
        timeout: 240_000,
      })
      await checkedAsync('cargo', ['build', '--quiet', '--release', '-p', 'freshell-deploy'], {
        env: realEnvironment,
        timeout: 600_000,
      })
      await checkedAsync('npm', ['run', 'build:client'], {
        env: { ...realEnvironment, FRESHELL_CLIENT_OUT_DIR: candidateClient },
      })
      mkdirSync(path.join(realCheckout, 'dist'), { recursive: true })
      cpSync(distServer, path.join(realCheckout, 'dist/server'), {
        recursive: true,
      })
      symlinkSync(nodeModules, path.join(realCheckout, 'node_modules'))

      const server = path.join(repository, 'target/debug/freshell-server')
      const controller = path.join(repository, 'target/release/freshell-deploy')
      const extensions = realpathSync(path.join(repository, 'extensions'))
      const captureFixture = path.join(fixtures, 'real-capture-parent.sh')
      await checkedAsync(captureFixture, [], {
        cwd: realCheckout,
        env: {
          ...realEnvironment,
          NODE_ENV: 'production',
          PORT: String(port),
          FRESHELL_BIND_HOST: '127.0.0.1',
          FRESHELL_CLIENT_DIR: candidateClient,
          FRESHELL_EXTENSIONS_DIR: extensions,
          FRESHELL_CLAUDE_SIDECAR: path.join(sidecar, 'index.mjs'),
          FRESHELL_CLAUDE_NODE: node,
          FRESHELL_MCP_SERVER_ENTRY: path.join(realCheckout, 'dist/server/mcp/server.js'),
          FRESHELL_REAL_SERVER: server,
          FRESHELL_REAL_CONTROLLER: controller,
          FRESHELL_REAL_CHECKOUT: realCheckout,
          FRESHELL_REAL_PID_FILE: pidFile,
          FRESHELL_REAL_LOG_FILE: logFile,
          FRESHELL_REAL_PORT: String(port),
          FRESHELL_REAL_CLIENT_DIR: candidateClient,
          FRESHELL_REAL_EXTENSIONS_DIR: extensions,
          FRESHELL_REAL_DIST_SERVER_DIR: path.join(realCheckout, 'dist/server'),
          FRESHELL_REAL_SIDECAR_DIR: sidecar,
          FRESHELL_REAL_PACKAGE_JSON: path.join(realCheckout, 'package.json'),
          FRESHELL_REAL_PACKAGE_LOCK: path.join(realCheckout, 'package-lock.json'),
          FRESHELL_REAL_NODE_MODULES: nodeModules,
          FRESHELL_REAL_NODE: node,
          FRESHELL_REAL_NODE_VERSION: process.version,
        },
        timeout: 300_000,
      })
      const legacyPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isSafeInteger(legacyPid)).toBe(true)
      knownPids.add(legacyPid)
      await waitForHttp(port, 'up')

      const common = ['--checkout', realCheckout, '--port', String(port)]
      const fullDeployArgs = (client: string) => [
        'deploy',
        ...common,
        '--mode',
        'full',
        '--client-dir',
        client,
        '--server-executable',
        server,
        '--controller-executable',
        controller,
        '--extensions-dir',
        extensions,
        '--dist-server-dir',
        distServer,
        '--mcp-entry-relative',
        'mcp/server.js',
        '--claude-sidecar-dir',
        sidecar,
        '--claude-sidecar-entry-relative',
        'index.mjs',
        '--package-json',
        path.join(runtime, 'package.json'),
        '--package-lock',
        path.join(runtime, 'package-lock.json'),
        '--node-modules',
        path.join(runtime, 'node_modules'),
        '--node-executable',
        node,
        '--node-version',
        process.version,
      ]
      expect(
        (await checkedAsync(controller, ['bootstrap-status', ...common], {
          cwd: realCheckout,
          env: realEnvironment,
        })).stdout.trim(),
      ).toBe('captured-legacy')

      await checkedAsync(
        controller,
        fullDeployArgs(candidateClient),
        { cwd: realCheckout, env: realEnvironment, timeout: 300_000 },
      )
      await waitForHttp(port, 'up')

      const portRoot = path.join(realCheckout, '.freshell-deploy/ports', String(port))
      const liveFile = path.join(portRoot, 'live.json')
      const transaction = JSON.parse(readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'))
      expect(transaction.finalized).toBe(true)
      expect(existsSync(transaction.controls.activatedFile)).toBe(true)
      const fullLive = JSON.parse(readFileSync(liveFile, 'utf8'))
      knownPids.add(fullLive.processIdentity.pid)
      expect(fullLive.legacy).toBe(false)
      expect(fullLive.runningServerGenerationId).toBe(fullLive.selectedGenerationId)

      const boundaries = [
        {
          name: 'pre-commit',
          phase: 'switch_current_intent',
          selected: 'prior',
          activated: false,
          live: false,
          finalized: false,
        },
        {
          name: 'pointer-switch',
          phase: 'switch_current_intent',
          selected: 'target',
          activated: false,
          live: false,
          finalized: false,
        },
        {
          name: 'target-owned-receipt',
          phase: 'activation_authorized',
          selected: 'target',
          activated: true,
          live: false,
          finalized: false,
        },
        {
          name: 'live-receipt',
          phase: 'activation_confirmed',
          selected: 'target',
          activated: true,
          live: true,
          finalized: false,
        },
        {
          name: 'finalization',
          phase: 'activation_confirmed',
          selected: 'target',
          activated: true,
          live: true,
          finalized: true,
        },
      ] as const
      for (const boundary of boundaries) {
        const priorLive = JSON.parse(readFileSync(liveFile, 'utf8'))
        knownPids.add(priorLive.processIdentity.pid)
        const interruptedClient = path.join(root, `interrupt-${boundary.name}`)
        cpSync(candidateClient, interruptedClient, { recursive: true })
        writeFileSync(
          path.join(interruptedClient, 'task6-interruption-marker.txt'),
          `${boundary.name}\n`,
        )

        await expect(
          checkedAsync(controller, fullDeployArgs(interruptedClient), {
            cwd: realCheckout,
            env: {
              ...realEnvironment,
              FRESHELL_DESTRUCTIVE_SANDBOX: '1',
              FRESHELL_DEPLOY_TEST_INTERRUPT_AFTER: boundary.name,
            },
            timeout: 300_000,
          }),
        ).rejects.toThrow()

        const interrupted = JSON.parse(
          readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'),
        )
        if (interrupted.candidate?.process?.pid) {
          knownPids.add(interrupted.candidate.process.pid)
        }
        const selected = path.basename(readlinkSync(path.join(portRoot, 'current')))
        expect(interrupted.phase, boundary.name).toBe(boundary.phase)
        expect(interrupted.finalized, boundary.name).toBe(boundary.finalized)
        expect(selected, boundary.name).toBe(
          boundary.selected === 'prior'
            ? interrupted.priorGenerationId
            : interrupted.targetGenerationId,
        )
        expect(existsSync(interrupted.controls.activatedFile), boundary.name).toBe(
          boundary.activated,
        )
        const interruptedLive = JSON.parse(readFileSync(liveFile, 'utf8'))
        expect(
          interruptedLive.selectedGenerationId === interrupted.targetGenerationId,
          boundary.name,
        ).toBe(boundary.live)

        if (boundary.name === 'pre-commit') {
          writeFileSync(
            path.join(realCheckout, '.env'),
            `FRESHELL_HOME=${home}\n`,
            { mode: 0o600 },
          )
          await expect(
            checkedAsync(controller, ['bootstrap-status', ...common], {
              cwd: realCheckout,
              env: { ...realEnvironment, AUTH_TOKEN: undefined },
            }),
          ).rejects.toThrow(/AUTH_TOKEN/)
          writeFileSync(
            path.join(realCheckout, '.env'),
            `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\n`,
            { mode: 0o600 },
          )
        }

        expect(
          (await checkedAsync(controller, ['bootstrap-status', ...common], {
            cwd: realCheckout,
            env: realEnvironment,
            timeout: 300_000,
          })).stdout.trim(),
          boundary.name,
        ).toBe('managed')
        await checkedAsync(controller, fullDeployArgs(interruptedClient), {
          cwd: realCheckout,
          env: realEnvironment,
          timeout: 300_000,
        })
        await waitForHttp(port, 'up')
        const recovered = JSON.parse(
          readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'),
        )
        const recoveredLive = JSON.parse(readFileSync(liveFile, 'utf8'))
        knownPids.add(recoveredLive.processIdentity.pid)
        expect(recovered.finalized, boundary.name).toBe(true)
        expect(recoveredLive.selectedGenerationId, boundary.name).toBe(
          path.basename(readlinkSync(path.join(portRoot, 'current'))),
        )
        expect(recoveredLive.runningServerGenerationId, boundary.name).toBe(
          recoveredLive.selectedGenerationId,
        )
      }

      cpSync(candidateClient, nextClient, { recursive: true })
      writeFileSync(path.join(nextClient, 'task6-client-marker.txt'), 'client-only\n')
      const beforeClientLive = JSON.parse(readFileSync(liveFile, 'utf8'))
      let storedController = path.join(portRoot, 'current/controller/freshell-deploy')
      await checkedAsync(
        storedController,
        [
          'deploy',
          ...common,
          '--mode',
          'client-only',
          '--client-dir',
          nextClient,
          '--node-executable',
          node,
          '--node-version',
          process.version,
        ],
        { cwd: realCheckout, env: realEnvironment },
      )
      const clientLive = JSON.parse(readFileSync(liveFile, 'utf8'))
      expect(clientLive.selectedGenerationId).not.toBe(beforeClientLive.selectedGenerationId)
      expect(clientLive.runningServerGenerationId).toBe(beforeClientLive.runningServerGenerationId)
      expect(clientLive.processIdentity.pid).toBe(beforeClientLive.processIdentity.pid)

      storedController = path.join(portRoot, 'current/controller/freshell-deploy')
      writeFileSync(
        path.join(realCheckout, '.env'),
        `FRESHELL_HOME=${home}\n`,
        { mode: 0o600 },
      )
      await checkedAsync(storedController, ['stop-current', ...common], {
        cwd: realCheckout,
        env: { ...realEnvironment, AUTH_TOKEN: undefined },
      })
      await waitForHttp(port, 'down')
      const stopped = JSON.parse(readFileSync(liveFile, 'utf8'))
      expect(stopped.runningServerGenerationId).toBeNull()
      expect(stopped.processIdentity).toBeUndefined()

      writeFileSync(
        path.join(realCheckout, '.env'),
        `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\n`,
        { mode: 0o600 },
      )
      await checkedAsync(storedController, ['start-current', ...common], {
        cwd: realCheckout,
        env: realEnvironment,
      })
      await waitForHttp(port, 'up')
      const started = JSON.parse(readFileSync(liveFile, 'utf8'))
      knownPids.add(started.processIdentity.pid)
      expect(started.runningServerGenerationId).toBe(started.selectedGenerationId)

      await checkedAsync(storedController, ['restart-current', ...common], {
        cwd: realCheckout,
        env: realEnvironment,
      })
      await waitForHttp(port, 'up')
      const restarted = JSON.parse(readFileSync(liveFile, 'utf8'))
      knownPids.add(restarted.processIdentity.pid)
      expect(restarted.processIdentity.pid).not.toBe(started.processIdentity.pid)
      expect(restarted.runningServerGenerationId).toBe(restarted.selectedGenerationId)

      await checkedAsync(storedController, ['stop-current', ...common], {
        cwd: realCheckout,
        env: realEnvironment,
      })
      await waitForHttp(port, 'down')
    } finally {
      const portRoot = path.join(realCheckout, '.freshell-deploy/ports', String(port))
      const liveFile = path.join(portRoot, 'live.json')
      if (existsSync(liveFile)) {
        try {
          const live = JSON.parse(readFileSync(liveFile, 'utf8'))
          if (live.processIdentity?.pid) knownPids.add(live.processIdentity.pid)
        } catch {
          // Exact PIDs already observed remain available for sandbox cleanup.
        }
      }
      for (const pid of knownPids) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Already stopped by the controller.
        }
      }
      spawnSync('chmod', ['-R', 'u+w', root], { encoding: 'utf8' })
      rmSync(root, { recursive: true, force: true })
    }
  }, 900_000)
})
