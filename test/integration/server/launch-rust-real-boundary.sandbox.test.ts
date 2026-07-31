import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { createHash } from 'node:crypto'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { stopOwnedChildBeforeIdentity } from '../../helpers/owned-child-process.js'

function isStrictlyBeneath(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function isAtOrBeneath(root: string, candidate: string) {
  return (
    path.resolve(root) === path.resolve(candidate)
    || isStrictlyBeneath(root, candidate)
  )
}

if (process.env.FRESHELL_DESTRUCTIVE_SANDBOX !== '1') {
  throw new Error(
    'launch-rust deployment tests are destructive and require FRESHELL_DESTRUCTIVE_SANDBOX=1',
  )
}
if (!isAtOrBeneath('/tmp', os.tmpdir())) {
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

type RecordedProcessIdentity = {
  pid: number
  kernelBootId: string
  startTimeTicks: string
}

function processIdentityKey(identity: RecordedProcessIdentity) {
  return `${identity.pid}:${identity.kernelBootId}:${identity.startTimeTicks}`
}

function rememberProcess(
  processes: Map<string, RecordedProcessIdentity>,
  identity: RecordedProcessIdentity,
) {
  processes.set(processIdentityKey(identity), {
    pid: identity.pid,
    kernelBootId: identity.kernelBootId,
    startTimeTicks: identity.startTimeTicks,
  })
}

function readProcessIdentity(pid: number): RecordedProcessIdentity {
  const kernelBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) throw new Error(`could not parse /proc/${pid}/stat`)
  const fieldsAfterCommand = stat.slice(commandEnd + 2).split(' ')
  return {
    pid,
    kernelBootId,
    startTimeTicks: fieldsAfterCommand[19],
  }
}

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

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function isRecordedProcessRunning(identity: RecordedProcessIdentity) {
  try {
    const actual = readProcessIdentity(identity.pid)
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    const fieldsAfterCommand = stat.slice(commandEnd + 2).split(' ')
    return (
      actual.kernelBootId === identity.kernelBootId
      && actual.startTimeTicks === identity.startTimeTicks
      && fieldsAfterCommand[0] !== 'Z'
    )
  } catch {
    return false
  }
}

async function stopRecordedProcess(
  identity: RecordedProcessIdentity,
  label: string,
  timeout = 20_000,
) {
  if (!isRecordedProcessRunning(identity)) return
  process.kill(identity.pid, 'SIGTERM')
  const gracefulDeadline = Date.now() + timeout / 2
  while (Date.now() < gracefulDeadline && isRecordedProcessRunning(identity)) {
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  if (isRecordedProcessRunning(identity)) {
    process.kill(identity.pid, 'SIGKILL')
  }
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && isRecordedProcessRunning(identity)) {
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  if (isRecordedProcessRunning(identity)) {
    throw new Error(`${label} did not exit: ${processIdentityKey(identity)}`)
  }
}

async function waitForPortFree(port: number, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const probe = net.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', resolve)
      })
      await new Promise<void>((resolve, reject) => {
        probe.close((error) => error ? reject(error) : resolve())
      })
      return
    } catch {
      probe.close()
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`port ${port} did not become free`)
}

function assertExactManagedGeneration(
  portRoot: string,
  live: any,
  port: number,
  expectedNode: string,
  expectController = true,
) {
  const generationRoot = path.join(portRoot, 'generations', live.selectedGenerationId)
  const manifest = JSON.parse(readFileSync(path.join(generationRoot, 'manifest.json'), 'utf8'))
  const fileEntries = manifest.entries.filter((entry: any) => entry.type === 'file')
  expect(manifest.generationId).toBe(live.selectedGenerationId)
  expect(fileEntries.length).toBeGreaterThan(10)
  for (const entry of fileEntries) {
    expect(sha256(path.join(generationRoot, entry.path)), entry.path).toBe(entry.sha256)
  }
  const requiredFiles = [
    'client/index.html',
    'server/freshell-server',
    'dist/server/mcp/server.js',
    'claude-sidecar/index.mjs',
    'package.json',
    'package-lock.json',
    'node_modules/.package-lock.json',
  ]
  if (expectController) requiredFiles.push('controller/freshell-deploy')
  for (const required of requiredFiles) {
    expect(fileEntries.some((entry: any) => entry.path === required), required).toBe(true)
  }
  expect(fileEntries.some((entry: any) => entry.path.startsWith('extensions/'))).toBe(true)

  const identity = live.processIdentity
  const executable = path.join(generationRoot, 'server/freshell-server')
  const executableStat = statSync(executable)
  expect(realpathSync(`/proc/${identity.pid}/exe`)).toBe(realpathSync(executable))
  expect(identity.executable).toMatchObject({
    device: String(executableStat.dev),
    inode: String(executableStat.ino),
    sha256: sha256(executable),
  })
  expect(identity.listener).toMatchObject({
    port,
    ownerPid: identity.pid,
    networkNamespace: readlinkSync(`/proc/${identity.pid}/ns/net`),
  })
  expect(
    readdirSync(`/proc/${identity.pid}/fd`).some((fd) => {
      try {
        return readlinkSync(`/proc/${identity.pid}/fd/${fd}`)
          === `socket:[${identity.listener.socketInode}]`
      } catch {
        return false
      }
    }),
  ).toBe(true)

  const expectedRuntime = {
    // The browser artifact follows the atomic current pointer so client-only
    // deployments take effect without replacing this exact server process.
    clientDir: path.join(portRoot, 'current/client'),
    extensionsDir: path.join(generationRoot, 'extensions'),
    distServerDir: path.join(generationRoot, 'dist/server'),
    mcpEntry: path.join(generationRoot, 'dist/server/mcp/server.js'),
    claudeSidecarEntry: path.join(generationRoot, 'claude-sidecar/index.mjs'),
    packageJson: path.join(generationRoot, 'package.json'),
    packageLock: path.join(generationRoot, 'package-lock.json'),
    productionNodeModules: path.join(generationRoot, 'node_modules'),
    nodeExecutable: expectedNode,
  }
  expect(identity.runtime).toMatchObject(expectedRuntime)
  const processEnvironment = Object.fromEntries(
    readFileSync(`/proc/${identity.pid}/environ`)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const equals = entry.indexOf('=')
        return [entry.slice(0, equals), entry.slice(equals + 1)]
      }),
  )
  expect(processEnvironment).toMatchObject({
    FRESHELL_CLIENT_DIR: expectedRuntime.clientDir,
    FRESHELL_EXTENSIONS_DIR: expectedRuntime.extensionsDir,
    FRESHELL_CLAUDE_SIDECAR: expectedRuntime.claudeSidecarEntry,
    FRESHELL_CLAUDE_NODE: expectedRuntime.nodeExecutable,
    FRESHELL_MCP_SERVER_ENTRY: expectedRuntime.mcpEntry,
    FRESHELL_DEPLOY_GENERATION_ID: live.runningServerGenerationId,
  })
}

function assertExactPrecommitRollback(
  transaction: any,
  priorLive: any,
  restoredLive: any,
) {
  expect(transaction.phase).toBe('rollback_complete')
  expect(transaction.finalized).toBe(true)
  expect(transaction.launchAttempts.map((attempt: any) => attempt.lane))
    .toEqual(['target_gated', 'prior_rollback'])
  expect(transaction.launchAttempts.map((attempt: any) => attempt.state.status))
    .toEqual(['started', 'started'])
  expect(transaction.launchAttempts[0].state.processIdentity)
    .toEqual(transaction.candidate.process)
  expect(transaction.launchAttempts[1].state.processIdentity)
    .toEqual(restoredLive.processIdentity)

  const targetAttempt = transaction.launchAttempts[0]
  const targetReadyFile = path.join(
    path.dirname(targetAttempt.readyFile),
    `${targetAttempt.attemptId}.server-ready.json`,
  )
  const ready = JSON.parse(readFileSync(targetReadyFile, 'utf8'))
  const authorization = JSON.parse(
    readFileSync(transaction.controls.authorizationFile, 'utf8'),
  )
  expect(ready).toEqual(transaction.candidate.ready)
  expect(authorization).toEqual({
    schemaVersion: '1',
    nonce: transaction.nonce,
    serverProcessGenerationId: transaction.targetGenerationId,
  })
  expect(existsSync(transaction.controls.activatedFile)).toBe(false)
  expect(transaction.candidate.ready).toMatchObject({
    schemaVersion: '1',
    nonce: transaction.nonce,
    pid: transaction.candidate.process.pid,
    serverProcessGenerationId: transaction.targetGenerationId,
  })
  expect(transaction.candidate.process.listener.ownerPid)
    .toBe(transaction.candidate.process.pid)
  expect(isRecordedProcessRunning(priorLive.processIdentity)).toBe(false)
  expect(isRecordedProcessRunning(transaction.candidate.process)).toBe(false)
  expect(isRecordedProcessRunning(restoredLive.processIdentity)).toBe(true)
  expect(restoredLive.selectedGenerationId).toBe(priorLive.selectedGenerationId)
  expect(restoredLive.runningServerGenerationId).toBe(
    priorLive.runningServerGenerationId,
  )
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
  mkdirSync(path.join(checkout, 'node_modules'))
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
        ['run', 'typecheck:client:app'],
        ['run', 'typecheck:deployment-compatibility'],
        ['run', 'build:client'],
      ])
    const appTypecheck = recorded.find(
      (event) => event.command === 'npm' && event.args[1] === 'typecheck:client:app',
    )
    const buildInfoIndex = appTypecheck?.args.indexOf('--tsBuildInfoFile') ?? -1
    expect(buildInfoIndex).toBeGreaterThan(0)
    expect(isStrictlyBeneath('/tmp', appTypecheck?.args[buildInfoIndex + 1] ?? '')).toBe(true)
    expect(isStrictlyBeneath(
      '/tmp',
      recorded.find(
        (event) => event.command === 'npm' && event.args[1] === 'build:client',
      )?.clientOut ?? '',
    )).toBe(true)
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
    expect(isStrictlyBeneath(
      '/tmp',
      events().find(
        (event) => event.command === 'npm' && event.args[1] === 'build:client',
      )?.clientOut ?? '',
    )).toBe(true)
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

  it('rejects the foreign-owned sticky staging trust boundary behind the predictable default-parent attack', () => {
    initialize()
    const foreignStickyParent = os.tmpdir()
    expect(statSync(foreignStickyParent).uid).not.toBe(process.getuid?.())
    expect(statSync(foreignStickyParent).mode & 0o1777).toBe(0o1777)

    const result = run(
      ['--port', '43127', '--client-only'],
      { FRESHELL_DEPLOY_BUILD_PARENT: foreignStickyParent },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/owned by the current user/i)
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
    expect(isStrictlyBeneath('/tmp', cargo?.target ?? '')).toBe(true)
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
      ['run', 'typecheck:client:app'],
      ['run', 'typecheck:deployment-compatibility'],
      ['run', 'build:client'],
      ['run', 'typecheck:server'],
      ['run', 'build:server'],
      ['ci', '--omit=dev'],
    ])
    expect(events().find((event) => event.command === 'controller' && event.args[0] === 'deploy')?.args)
      .toContain('full')
  })

  it('starts a combined deployment on a genuinely unused port without legacy capture', () => {
    const result = run(['--port', '43128', '--restart'])
    expect(result.status, result.stderr).toBe(0)
    const recorded = events()
    expect(
      recorded.some(
        (event) => event.command === 'controller' && event.args[0] === 'capture',
      ),
    ).toBe(false)
    expect(state('43128')).toMatchObject({
      runningServerGenerationId: expect.any(String),
      legacy: false,
      stopCount: 0,
      startCount: 1,
    })
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
    const capture = commands.find(
      (event) => event.command === 'controller' && event.args[0] === 'capture',
    )
    expect(capture).toBeDefined()
    expect(commands.indexOf(capture!))
      .toBeLessThan(commands.findIndex((event) => event.command === 'controller' && event.args[0] === 'deploy'))
    const nodeModulesIndex = capture?.args.indexOf('--node-modules') ?? -1
    expect(nodeModulesIndex).toBeGreaterThan(0)
    expect(capture?.args[nodeModulesIndex + 1]).toBe(path.join(checkout, 'node_modules'))
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
    const knownProcesses = new Map<string, RecordedProcessIdentity>()
    const cleanupContext: {
      root?: string
      realCheckout?: string
      port?: number
      pidFile?: string
      environment?: NodeJS.ProcessEnv
      unrelatedSentinel?: ReturnType<typeof spawn>
      unrelatedSentinelIdentity?: RecordedProcessIdentity
    } = {}
    try {
      const root = mkdtempSync(path.join(os.tmpdir(), 'freshell-real-deploy-task6-'))
      cleanupContext.root = root
      const realCheckout = path.join(root, 'checkout')
      cleanupContext.realCheckout = realCheckout
      const home = path.join(root, 'home')
      const runtime = path.join(root, 'runtime')
      const candidateClient = path.join(root, 'candidate-client')
      const nextClient = path.join(root, 'next-client')
      const cargoTarget = path.join(root, 'cargo-target')
      const distServer = path.join(runtime, 'dist-server')
      const sidecar = path.join(runtime, 'sidecar')
      const nodeModules = path.join(runtime, 'node_modules')
      const pidFile = path.join(root, 'legacy.pid')
      cleanupContext.pidFile = pidFile
      const logFile = path.join(root, 'legacy.log')
      const token = `task6-real-sandbox-${Date.now()}-token`
      const clientMarker = `task7-real-client-${Date.now()}`
      const node = realpathSync(process.execPath)
      let port = await unusedPort()
      while (port === 3002) port = await unusedPort()
      cleanupContext.port = port
      const unrelatedSentinel = spawn(
        node,
        ['--eval', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore' },
      )
      cleanupContext.unrelatedSentinel = unrelatedSentinel
      if (!unrelatedSentinel.pid) throw new Error('unrelated sentinel did not start')
      const unrelatedSentinelIdentity = readProcessIdentity(unrelatedSentinel.pid)
      cleanupContext.unrelatedSentinelIdentity = unrelatedSentinelIdentity
      rememberProcess(knownProcesses, unrelatedSentinelIdentity)
      const realEnvironment = {
        ...process.env,
        AUTH_TOKEN: token,
        FRESHELL_HOME: home,
        HOME: home,
      }
      cleanupContext.environment = realEnvironment

      mkdirSync(realCheckout, { recursive: true })
    mkdirSync(path.join(realCheckout, 'scripts'))
    copyFileSync(
      path.join(repository, 'scripts/launch-rust.sh'),
      path.join(realCheckout, 'scripts/launch-rust.sh'),
    )
    chmodSync(path.join(realCheckout, 'scripts/launch-rust.sh'), 0o755)
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

      await checkedAsync('cargo', ['build', '--quiet', '-p', 'freshell-server'], {
        env: { ...realEnvironment, CARGO_TARGET_DIR: cargoTarget },
        timeout: 240_000,
      })
      await checkedAsync('cargo', ['build', '--quiet', '--release', '-p', 'freshell-deploy'], {
        env: { ...realEnvironment, CARGO_TARGET_DIR: cargoTarget },
        timeout: 600_000,
      })
      await checkedAsync('npm', ['run', 'build:client'], {
        env: { ...realEnvironment, FRESHELL_CLIENT_OUT_DIR: candidateClient },
      })
      const clientIndex = path.join(candidateClient, 'index.html')
      writeFileSync(
        clientIndex,
        readFileSync(clientIndex, 'utf8').replace(
          '</head>',
          `<meta name="task7-real-client" content="${clientMarker}"></head>`,
        ),
      )
      mkdirSync(path.join(realCheckout, 'dist'), { recursive: true })
      cpSync(distServer, path.join(realCheckout, 'dist/server'), {
        recursive: true,
      })
      symlinkSync(nodeModules, path.join(realCheckout, 'node_modules'))

      const server = path.join(cargoTarget, 'debug/freshell-server')
      const controller = path.join(cargoTarget, 'release/freshell-deploy')
      const extensions = realpathSync(path.join(repository, 'extensions'))
      const captureFixture = path.join(fixtures, 'real-capture-parent.sh')
      const brokenSidecar = path.join(root, 'broken-sidecar')
      cpSync(sidecar, brokenSidecar, { recursive: true })
      writeFileSync(
        path.join(brokenSidecar, 'index.mjs'),
        "await import('./missing-sidecar-dependency.mjs')\n",
      )
      const brokenDistServer = path.join(root, 'broken-dist-server')
      cpSync(distServer, brokenDistServer, { recursive: true })
      writeFileSync(
        path.join(brokenDistServer, 'mcp/server.js'),
        "await import('./missing-mcp-dependency.mjs')\n",
      )
      let freshPort = await unusedPort()
      while (freshPort === 3002 || freshPort === port) freshPort = await unusedPort()
      const freshCommon = ['--checkout', realCheckout, '--port', String(freshPort)]
      const freshDeployArgs = ({
        sidecarDir = sidecar,
        distServerDir = distServer,
      }: {
        sidecarDir?: string
        distServerDir?: string
      } = {}) => [
        'deploy',
        ...freshCommon,
        '--mode',
        'full',
        '--client-dir',
        candidateClient,
        '--server-executable',
        server,
        '--controller-executable',
        controller,
        '--extensions-dir',
        extensions,
        '--dist-server-dir',
        distServerDir,
        '--mcp-entry-relative',
        'mcp/server.js',
        '--claude-sidecar-dir',
        sidecarDir,
        '--claude-sidecar-entry-relative',
        'index.mjs',
        '--package-json',
        path.join(runtime, 'package.json'),
        '--package-lock',
        path.join(runtime, 'package-lock.json'),
        '--node-modules',
        nodeModules,
        '--node-executable',
        node,
        '--node-version',
        process.version,
      ]
      const freshPortRoot = path.join(
        realCheckout,
        '.freshell-deploy/ports',
        String(freshPort),
      )
      const expectFreshState = async () => {
        expect(existsSync(path.join(freshPortRoot, 'current'))).toBe(false)
        expect(existsSync(path.join(freshPortRoot, 'live.json'))).toBe(false)
        await waitForPortFree(freshPort)
        expect(
          (await checkedAsync(controller, ['bootstrap-status', ...freshCommon], {
            cwd: realCheckout,
            env: realEnvironment,
          })).stdout.trim(),
        ).toBe('fresh')
      }
      expect(
        (await checkedAsync(controller, ['bootstrap-status', ...freshCommon], {
          cwd: realCheckout,
          env: realEnvironment,
        })).stdout.trim(),
      ).toBe('fresh')
      await expect(
        checkedAsync(controller, freshDeployArgs({ sidecarDir: brokenSidecar }), {
          cwd: realCheckout,
          env: realEnvironment,
          timeout: 300_000,
        }),
      ).rejects.toThrow(/probe command failed/i)
      await expectFreshState()
      await expect(
        checkedAsync(controller, freshDeployArgs({ distServerDir: brokenDistServer }), {
          cwd: realCheckout,
          env: realEnvironment,
          timeout: 300_000,
        }),
      ).rejects.toThrow(/probe command failed/i)
      await expectFreshState()
      await checkedAsync(controller, freshDeployArgs(), {
        cwd: realCheckout,
        env: realEnvironment,
        timeout: 300_000,
      })
      await waitForHttp(freshPort, 'up')
      const freshLive = JSON.parse(readFileSync(
        path.join(
          realCheckout,
          '.freshell-deploy/ports',
          String(freshPort),
          'live.json',
        ),
        'utf8',
      ))
      rememberProcess(knownProcesses, freshLive.processIdentity)
      expect(freshLive).toMatchObject({
        selectedGenerationId: freshLive.runningServerGenerationId,
        legacy: false,
      })
      await checkedAsync(controller, ['stop-current', ...freshCommon], {
        cwd: realCheckout,
        env: realEnvironment,
      })
      await waitForHttp(freshPort, 'down')

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
      const legacyProcessIdentity = readProcessIdentity(legacyPid)
      rememberProcess(knownProcesses, legacyProcessIdentity)
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

      const portRoot = path.join(realCheckout, '.freshell-deploy/ports', String(port))
      const liveFile = path.join(portRoot, 'live.json')
      const capturedLegacy = JSON.parse(readFileSync(liveFile, 'utf8'))
      const legacyReceiptFile = path.join(portRoot, 'legacy.json')
      const legacyReceiptBytes = readFileSync(legacyReceiptFile, 'utf8')
      const legacyReceipt = JSON.parse(legacyReceiptBytes)
      const legacyController = path.join(portRoot, 'legacy-controller')
      expect(statSync(legacyController).mode & 0o777).toBe(0o500)
      expect(readFileSync(legacyController)).toEqual(readFileSync(controller))
      expect(legacyReceipt).toMatchObject({
        schemaVersion: '1',
        generationId: capturedLegacy.selectedGenerationId,
        legacy: true,
        process: capturedLegacy.processIdentity,
        node: {
          executable: node,
          version: process.version,
        },
        runtime: {
          serverExecutable: 'server/freshell-server',
          clientDir: 'client',
          extensionsDir: 'extensions',
          distServerDir: 'dist/server',
          mcpEntry: 'dist/server/mcp/server.js',
          claudeSidecarEntry: 'claude-sidecar/index.mjs',
          packageJson: 'package.json',
          packageLock: 'package-lock.json',
          productionNodeModules: 'node_modules',
        },
      })
      expect(legacyReceipt.process).toEqual(capturedLegacy.processIdentity)
      expect(legacyReceipt.launch).toEqual({
        cwd: capturedLegacy.processIdentity.cwd,
        argv0: capturedLegacy.processIdentity.argv0,
        argumentCount: capturedLegacy.processIdentity.argumentCount,
      })
      const capturedLegacyExecutableDigest = capturedLegacy.processIdentity.executable.sha256
      const failedLegacyClient = path.join(root, 'failed-legacy-client')
      cpSync(candidateClient, failedLegacyClient, { recursive: true })
      writeFileSync(
        path.join(failedLegacyClient, 'task7-failed-legacy-target.txt'),
        'retained failure evidence\n',
      )
      writeFileSync(
        path.join(realCheckout, '.env'),
        `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\n` +
          'FRESHELL_DESTRUCTIVE_SANDBOX=1\n' +
          'FRESHELL_TEST_EXIT_AFTER_DEPLOY_AUTHORIZATION=1\n',
        { mode: 0o600 },
      )
      await expect(
        checkedAsync(controller, fullDeployArgs(failedLegacyClient), {
          cwd: realCheckout,
          env: realEnvironment,
          timeout: 300_000,
        }),
      ).rejects.toThrow()
      writeFileSync(
        path.join(realCheckout, '.env'),
        `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\n`,
        { mode: 0o600 },
      )
      await waitForHttp(port, 'up')
      const failedLegacyTransaction = JSON.parse(
        readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'),
      )
      const restoredLegacy = JSON.parse(readFileSync(liveFile, 'utf8'))
      rememberProcess(knownProcesses, restoredLegacy.processIdentity)
      if (failedLegacyTransaction.candidate?.process?.pid) {
        rememberProcess(knownProcesses, failedLegacyTransaction.candidate.process)
      }
      assertExactPrecommitRollback(
        failedLegacyTransaction,
        capturedLegacy,
        restoredLegacy,
      )
      expect(readFileSync(legacyReceiptFile, 'utf8')).toBe(legacyReceiptBytes)
      expect(failedLegacyTransaction.priorNode).toEqual(legacyReceipt.node)
      expect(failedLegacyTransaction.priorRuntime).toEqual({
        ...restoredLegacy.processIdentity.runtime,
        clientDir: path.join(
          failedLegacyTransaction.priorGenerationRoot,
          'client',
        ),
      })
      expect(restoredLegacy).toMatchObject({
        selectedGenerationId: capturedLegacy.selectedGenerationId,
        runningServerGenerationId: capturedLegacy.runningServerGenerationId,
        // The exact captured generation is restored, but the controller now
        // owns its relaunched process and records managed provenance.
        legacy: false,
      })
      expect(restoredLegacy.processIdentity.pid).not.toBe(
        capturedLegacy.processIdentity.pid,
      )
      expect(restoredLegacy.processIdentity.executable.sha256).toBe(
        capturedLegacyExecutableDigest,
      )
      try {
        await checkedAsync(
          path.join(realCheckout, 'scripts/launch-rust.sh'),
          ['--port', String(port), '--skip-build', '--restart'],
          { cwd: realCheckout, env: realEnvironment, timeout: 300_000 },
        )
      } catch (error) {
        const lifecycleLog = path.join(portRoot, 'server.log')
        const lifecycleRecord = path.join(portRoot, 'lifecycle.json')
        throw new Error(
          `${String(error)}\nserver.log:\n${
            existsSync(lifecycleLog) ? readFileSync(lifecycleLog, 'utf8') : '<missing>'
          }\nlifecycle.json:\n${
            existsSync(lifecycleRecord) ? readFileSync(lifecycleRecord, 'utf8') : '<missing>'
          }`,
        )
      }
      await waitForHttp(port, 'up')
      const emergencyRestartedLegacy = JSON.parse(readFileSync(liveFile, 'utf8'))
      rememberProcess(knownProcesses, emergencyRestartedLegacy.processIdentity)
      expect(emergencyRestartedLegacy.selectedGenerationId).toBe(
        capturedLegacy.selectedGenerationId,
      )
      expect(emergencyRestartedLegacy.runningServerGenerationId).toBe(
        capturedLegacy.selectedGenerationId,
      )
      expect(emergencyRestartedLegacy.processIdentity.pid).not.toBe(
        restoredLegacy.processIdentity.pid,
      )
      expect(emergencyRestartedLegacy.processIdentity.executable.sha256).toBe(
        capturedLegacyExecutableDigest,
      )
      expect(path.basename(readlinkSync(path.join(portRoot, 'current')))).toBe(
        capturedLegacy.selectedGenerationId,
      )
      expect(
        existsSync(
          path.join(
            portRoot,
            'generations',
            failedLegacyTransaction.targetGenerationId,
            'client/task7-failed-legacy-target.txt',
          ),
        ),
      ).toBe(true)
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain(clientMarker)
      assertExactManagedGeneration(
        portRoot,
        emergencyRestartedLegacy,
        port,
        node,
        false,
      )
      expect(isRecordedProcessRunning(unrelatedSentinelIdentity)).toBe(true)

      await checkedAsync(
        path.join(realCheckout, 'scripts/launch-rust.sh'),
        ['--port', String(port), '--stop'],
        { cwd: realCheckout, env: realEnvironment, timeout: 300_000 },
      )
      await waitForHttp(port, 'down')
      const stoppedLegacy = JSON.parse(readFileSync(liveFile, 'utf8'))
      expect(stoppedLegacy).toEqual({
        schemaVersion: '1',
        selectedGenerationId: capturedLegacy.selectedGenerationId,
        runningServerGenerationId: null,
        legacy: false,
      })
      expect(
        (await checkedAsync(legacyController, ['bootstrap-status', ...common], {
          cwd: realCheckout,
          env: realEnvironment,
        })).stdout.trim(),
      ).toBe('captured-legacy')
      expect(isRecordedProcessRunning(unrelatedSentinelIdentity)).toBe(true)

      await checkedAsync(
        path.join(realCheckout, 'scripts/launch-rust.sh'),
        ['--port', String(port), '--skip-build'],
        { cwd: realCheckout, env: realEnvironment, timeout: 300_000 },
      )
      await waitForHttp(port, 'up')
      const startedAfterLegacyStop = JSON.parse(readFileSync(liveFile, 'utf8'))
      rememberProcess(knownProcesses, startedAfterLegacyStop.processIdentity)
      expect(startedAfterLegacyStop.selectedGenerationId).toBe(
        capturedLegacy.selectedGenerationId,
      )
      expect(startedAfterLegacyStop.runningServerGenerationId).toBe(
        capturedLegacy.selectedGenerationId,
      )
      expect(startedAfterLegacyStop.processIdentity.pid).not.toBe(
        emergencyRestartedLegacy.processIdentity.pid,
      )
      expect(startedAfterLegacyStop.processIdentity.executable.sha256).toBe(
        capturedLegacyExecutableDigest,
      )
      expect(isRecordedProcessRunning(unrelatedSentinelIdentity)).toBe(true)

      await checkedAsync(
        controller,
        fullDeployArgs(candidateClient),
        { cwd: realCheckout, env: realEnvironment, timeout: 300_000 },
      )
      await waitForHttp(port, 'up')

      const transaction = JSON.parse(readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'))
      expect(transaction.finalized).toBe(true)
      expect(existsSync(transaction.controls.activatedFile)).toBe(true)
      const fullLive = JSON.parse(readFileSync(liveFile, 'utf8'))
      rememberProcess(knownProcesses, fullLive.processIdentity)
      expect(fullLive.legacy).toBe(false)
      expect(fullLive.runningServerGenerationId).toBe(fullLive.selectedGenerationId)
      expect(port).not.toBe(3002)
      for (const disposablePath of [
        root,
        realCheckout,
        home,
        runtime,
        candidateClient,
        cargoTarget,
        portRoot,
        fullLive.processIdentity.cwd,
      ]) {
        expect(
          isStrictlyBeneath('/tmp', realpathSync(disposablePath)),
          disposablePath,
        ).toBe(true)
      }
      assertExactManagedGeneration(portRoot, fullLive, port, node)

      const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`)
      const health = await healthResponse.json()
      expect(Object.keys(health)).toEqual([
        'app',
        'ok',
        'requiresAuth',
        'version',
        'ready',
        'instanceId',
        'startedAt',
      ])
      expect(health).toMatchObject({
        app: 'freshell',
        ok: true,
        requiresAuth: true,
        ready: true,
      })
      const compatibilityResponse = await fetch(
        `http://127.0.0.1:${port}/api/deployment-compatibility`,
        { headers: { 'x-auth-token': token } },
      )
      const compatibility = await compatibilityResponse.json()
      expect(Object.keys(compatibility)).toEqual([
        'schemaVersion',
        'serverDeclaration',
        'serverDeclarationSha256',
        'serverProcessGenerationId',
        'bootId',
      ])
      expect(compatibility.serverDeclaration).toMatchObject({
        component: 'server',
        version: '0.7.0',
        supports: {
          client: {
            minInclusive: '0.7.5',
            maxExclusive: '0.7.6',
          },
        },
      })
      expect(compatibility.serverDeclarationSha256).toBe(
        createHash('sha256')
          .update(JSON.stringify(compatibility.serverDeclaration))
          .digest('hex'),
      )
      expect(compatibility.serverProcessGenerationId).toBe(fullLive.selectedGenerationId)
      const selectedRoot = path.join(
        portRoot,
        'generations',
        fullLive.selectedGenerationId,
      )
      const clientCompatibility = JSON.parse(
        readFileSync(
          path.join(selectedRoot, 'client/deployment-compatibility.json'),
          'utf8',
        ),
      )
      expect(clientCompatibility.declaration).toMatchObject({
        component: 'client',
        version: '0.7.5',
        supports: {
          server: {
            minInclusive: '0.7.0',
            maxExclusive: '0.7.1',
          },
        },
      })
      expect(clientCompatibility.declarationSha256).toBe(
        createHash('sha256')
          .update(JSON.stringify(clientCompatibility.declaration))
          .digest('hex'),
      )
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text())
        .toContain(clientMarker)

      const sidecarImport = spawnSync(
        node,
        [path.join(selectedRoot, 'claude-sidecar/index.mjs')],
        {
          cwd: selectedRoot,
          input: '{"type":"shutdown"}\n',
          encoding: 'utf8',
          env: { HOME: home },
        },
      )
      expect(sidecarImport.status, sidecarImport.stderr).toBe(0)
      const mcpImport = spawnSync(
        node,
        [
          '--input-type=module',
          '--eval',
          "const {pathToFileURL}=await import('node:url');await import(pathToFileURL(process.argv[1]).href)",
          path.join(selectedRoot, 'dist/server/mcp/server.js'),
        ],
        {
          cwd: selectedRoot,
          encoding: 'utf8',
          env: { HOME: home },
        },
      )
      expect(mcpImport.status, mcpImport.stderr).toBe(0)

      const failedClient = path.join(root, 'pre-commit-failure-client')
      cpSync(candidateClient, failedClient, { recursive: true })
      writeFileSync(
        path.join(failedClient, 'task7-pre-commit-failure-marker.txt'),
        'must-remain-retained-but-unselected\n',
      )
      const beforeFailedActivation = JSON.parse(readFileSync(liveFile, 'utf8'))
      writeFileSync(
        path.join(realCheckout, '.env'),
        `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\n` +
          'FRESHELL_DESTRUCTIVE_SANDBOX=1\n' +
          'FRESHELL_TEST_EXIT_AFTER_DEPLOY_AUTHORIZATION=1\n',
        { mode: 0o600 },
      )
      await expect(
        checkedAsync(controller, fullDeployArgs(failedClient), {
          cwd: realCheckout,
          env: realEnvironment,
          timeout: 300_000,
        }),
      ).rejects.toThrow()
      writeFileSync(
        path.join(realCheckout, '.env'),
        `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\n`,
        { mode: 0o600 },
      )
      await waitForHttp(port, 'up')

      const failedTransaction = JSON.parse(
        readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'),
      )
      if (failedTransaction.candidate?.process?.pid) {
        rememberProcess(knownProcesses, failedTransaction.candidate.process)
      }
      const restoredAfterFailure = JSON.parse(readFileSync(liveFile, 'utf8'))
      rememberProcess(knownProcesses, restoredAfterFailure.processIdentity)
      assertExactPrecommitRollback(
        failedTransaction,
        beforeFailedActivation,
        restoredAfterFailure,
      )
      expect(restoredAfterFailure.selectedGenerationId).toBe(
        beforeFailedActivation.selectedGenerationId,
      )
      expect(restoredAfterFailure.runningServerGenerationId).toBe(
        beforeFailedActivation.runningServerGenerationId,
      )
      expect(restoredAfterFailure.processIdentity.pid).not.toBe(
        beforeFailedActivation.processIdentity.pid,
      )
      expect(path.basename(readlinkSync(path.join(portRoot, 'current')))).toBe(
        beforeFailedActivation.selectedGenerationId,
      )
      expect(failedTransaction.targetGenerationId).not.toBe(
        beforeFailedActivation.selectedGenerationId,
      )
      expect(
        existsSync(
          path.join(
            portRoot,
            'generations',
            failedTransaction.targetGenerationId,
            'client/task7-pre-commit-failure-marker.txt',
          ),
        ),
      ).toBe(true)
      assertExactManagedGeneration(portRoot, restoredAfterFailure, port, node)
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text())
        .toContain(clientMarker)
      expect(isRecordedProcessRunning(unrelatedSentinelIdentity)).toBe(true)

      const boundaries = [
        {
          name: 'pre-commit',
          phase: 'switch_current_intent',
          selected: 'prior',
          activated: false,
          live: false,
          finalized: false,
          interruptPriorRelaunch: true,
          stopCandidateAfterReceipt: false,
        },
        {
          name: 'pointer-switch',
          phase: 'switch_current_intent',
          selected: 'target',
          activated: false,
          live: false,
          finalized: false,
          interruptPriorRelaunch: false,
          stopCandidateAfterReceipt: false,
        },
        {
          name: 'target-owned-receipt',
          phase: 'activation_authorized',
          selected: 'target',
          activated: true,
          live: false,
          finalized: false,
          interruptPriorRelaunch: false,
          stopCandidateAfterReceipt: true,
        },
        {
          name: 'live-receipt',
          phase: 'activation_confirmed',
          selected: 'target',
          activated: true,
          live: true,
          finalized: false,
          interruptPriorRelaunch: false,
          stopCandidateAfterReceipt: false,
        },
        {
          name: 'finalization',
          phase: 'activation_confirmed',
          selected: 'target',
          activated: true,
          live: true,
          finalized: true,
          interruptPriorRelaunch: false,
          stopCandidateAfterReceipt: false,
        },
      ] as const
      for (const boundary of boundaries) {
        const priorLive = JSON.parse(readFileSync(liveFile, 'utf8'))
        rememberProcess(knownProcesses, priorLive.processIdentity)
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
          rememberProcess(knownProcesses, interrupted.candidate.process)
        }
        const activationReceiptBytes = boundary.activated
          ? readFileSync(interrupted.controls.activatedFile, 'utf8')
          : null
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

        if (boundary.stopCandidateAfterReceipt) {
          await stopRecordedProcess(
            interrupted.candidate.process,
            'receipt-publishing target candidate',
          )
          await waitForHttp(port, 'down')
          await waitForPortFree(port)
          expect(
            readFileSync(interrupted.controls.activatedFile, 'utf8'),
            boundary.name,
          ).toBe(activationReceiptBytes)
        }

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

        if (boundary.interruptPriorRelaunch) {
          await expect(
            checkedAsync(controller, ['bootstrap-status', ...common], {
              cwd: realCheckout,
              env: {
                ...realEnvironment,
                FRESHELL_DESTRUCTIVE_SANDBOX: '1',
                FRESHELL_DEPLOY_TEST_INTERRUPT_AFTER: 'prior-relaunch-binding',
              },
              timeout: 300_000,
            }),
          ).rejects.toThrow()
          const rebound = JSON.parse(
            readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'),
          )
          const priorAttempt = rebound.launchAttempts.at(-1)
          expect(priorAttempt.lane, boundary.name).toBe('prior_rollback')
          expect(priorAttempt.state.status, boundary.name).toBe('started')
          rememberProcess(knownProcesses, priorAttempt.state.processIdentity)
          expect(
            isRecordedProcessRunning(priorAttempt.state.processIdentity),
            boundary.name,
          ).toBe(true)
          expect(
            path.basename(readlinkSync(path.join(portRoot, 'current'))),
            boundary.name,
          ).toBe(rebound.priorGenerationId)
        }

        expect(
          (await checkedAsync(controller, ['bootstrap-status', ...common], {
            cwd: realCheckout,
            env: realEnvironment,
            timeout: 300_000,
          })).stdout.trim(),
          boundary.name,
        ).toBe('managed')
        await waitForHttp(port, 'up')
        let recovered = JSON.parse(
          readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'),
        )
        let recoveredLive = JSON.parse(readFileSync(liveFile, 'utf8'))
        rememberProcess(knownProcesses, recoveredLive.processIdentity)

        if (boundary.activated) {
          if (boundary.stopCandidateAfterReceipt) {
            expect(recoveredLive.processIdentity, boundary.name)
              .not.toEqual(interrupted.candidate.process)
            expect(isRecordedProcessRunning(interrupted.candidate.process), boundary.name)
              .toBe(false)
            expect(
              recovered.launchAttempts.map((attempt: any) => attempt.lane),
              boundary.name,
            ).toEqual(['target_gated', 'target_roll_forward'])
            expect(
              recovered.launchAttempts.at(-1).state.processIdentity,
              boundary.name,
            ).toEqual(recoveredLive.processIdentity)
          } else {
            expect(recoveredLive.processIdentity, boundary.name)
              .toEqual(interrupted.candidate.process)
            expect(recovered.launchAttempts, boundary.name)
              .toEqual(interrupted.launchAttempts)
          }
          expect(readFileSync(interrupted.controls.activatedFile, 'utf8'), boundary.name)
            .toBe(activationReceiptBytes)
          expect(
            JSON.parse(readFileSync(interrupted.controls.activatedFile, 'utf8')),
            boundary.name,
          ).toEqual(interrupted.candidate.ready)
          expect(
            recovered.launchAttempts.map((attempt: any) => attempt.lane),
            boundary.name,
          ).not.toContain('prior_rollback')
          expect(
            isRecordedProcessRunning(recoveredLive.processIdentity),
            boundary.name,
          ).toBe(true)
        } else {
          expect(recovered.phase, boundary.name).toBe('rollback_complete')
          expect(recoveredLive.selectedGenerationId, boundary.name)
            .toBe(interrupted.priorGenerationId)
          expect(recoveredLive.runningServerGenerationId, boundary.name)
            .toBe(interrupted.priorGenerationId)
          await checkedAsync(controller, fullDeployArgs(interruptedClient), {
            cwd: realCheckout,
            env: realEnvironment,
            timeout: 300_000,
          })
          await waitForHttp(port, 'up')
          recovered = JSON.parse(
            readFileSync(path.join(portRoot, 'transaction.json'), 'utf8'),
          )
          recoveredLive = JSON.parse(readFileSync(liveFile, 'utf8'))
          rememberProcess(knownProcesses, recoveredLive.processIdentity)
        }

        expect(recovered.finalized, boundary.name).toBe(true)
        expect(recoveredLive.selectedGenerationId, boundary.name).toBe(
          path.basename(readlinkSync(path.join(portRoot, 'current'))),
        )
        expect(recoveredLive.runningServerGenerationId, boundary.name).toBe(
          recoveredLive.selectedGenerationId,
        )
        expect(recoveredLive.selectedGenerationId, boundary.name).toBe(
          recovered.targetGenerationId,
        )
        expect(
          await (
            await fetch(
              `http://127.0.0.1:${port}/task6-interruption-marker.txt`,
            )
          ).text(),
          boundary.name,
        ).toContain(boundary.name)
        if (boundary.activated) {
          expect(existsSync(recovered.controls.activatedFile)).toBe(true)
          expect(path.basename(readlinkSync(path.join(portRoot, 'current')))).toBe(
            recovered.targetGenerationId,
          )
        }
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
      rememberProcess(knownProcesses, started.processIdentity)
      expect(started.runningServerGenerationId).toBe(started.selectedGenerationId)

      const interruptedRestart = spawnSync(
        storedController,
        ['restart-current', ...common],
        {
          cwd: realCheckout,
          encoding: 'utf8',
          env: {
            ...realEnvironment,
            FRESHELL_DEPLOY_TEST_INTERRUPT_AFTER: 'lifecycle_restart_intent',
          },
        },
      )
      expect(interruptedRestart.status).toBeNull()
      expect(interruptedRestart.signal).toBe('SIGKILL')
      await waitForHttp(port, 'up')
      const pendingRestart = JSON.parse(
        readFileSync(path.join(portRoot, 'lifecycle.json'), 'utf8'),
      )
      expect(pendingRestart.complete).toBe(false)
      expect(pendingRestart.processToStop).toEqual(started.processIdentity)
      expect(JSON.parse(readFileSync(liveFile, 'utf8'))).toEqual(started)

      await checkedAsync(storedController, ['bootstrap-status', ...common], {
        cwd: realCheckout,
        env: realEnvironment,
      })
      await waitForHttp(port, 'up')
      const firstRestarted = JSON.parse(readFileSync(liveFile, 'utf8'))
      rememberProcess(knownProcesses, firstRestarted.processIdentity)
      expect(firstRestarted.processIdentity.pid).not.toBe(started.processIdentity.pid)

      const interruptedAfterStop = spawnSync(
        storedController,
        ['restart-current', ...common],
        {
          cwd: realCheckout,
          encoding: 'utf8',
          env: {
            ...realEnvironment,
            FRESHELL_DEPLOY_TEST_INTERRUPT_AFTER:
              'lifecycle_restart_process_stopped',
          },
        },
      )
      expect(interruptedAfterStop.status).toBeNull()
      expect(interruptedAfterStop.signal).toBe('SIGKILL')
      await waitForHttp(port, 'down')
      const stoppedRestart = JSON.parse(
        readFileSync(path.join(portRoot, 'lifecycle.json'), 'utf8'),
      )
      expect(stoppedRestart.complete).toBe(false)
      expect(stoppedRestart.processToStop).toEqual(firstRestarted.processIdentity)
      expect(JSON.parse(readFileSync(liveFile, 'utf8'))).toEqual(firstRestarted)

      await checkedAsync(storedController, ['bootstrap-status', ...common], {
        cwd: realCheckout,
        env: realEnvironment,
      })
      await waitForHttp(port, 'up')
      const restarted = JSON.parse(readFileSync(liveFile, 'utf8'))
      rememberProcess(knownProcesses, restarted.processIdentity)
      expect(restarted.processIdentity.pid).not.toBe(firstRestarted.processIdentity.pid)
      expect(restarted.runningServerGenerationId).toBe(restarted.selectedGenerationId)

      await checkedAsync(storedController, ['stop-current', ...common], {
        cwd: realCheckout,
        env: realEnvironment,
      })
      await waitForHttp(port, 'down')
    } finally {
      const cleanupErrors: string[] = []
      const {
        root,
        realCheckout,
        port,
        pidFile,
        environment: realEnvironment,
        unrelatedSentinel,
        unrelatedSentinelIdentity,
      } = cleanupContext
      if (
        unrelatedSentinel
        && !unrelatedSentinelIdentity
        && unrelatedSentinel.exitCode === null
      ) {
        try {
          await stopOwnedChildBeforeIdentity(
            unrelatedSentinel,
            'real-boundary unrelated sentinel',
          )
        } catch (error) {
          cleanupErrors.push(`could not stop unidentified owned sentinel: ${String(error)}`)
        }
      }
      if (realCheckout && port !== undefined) {
        const portRoot = path.join(realCheckout, '.freshell-deploy/ports', String(port))
        const liveFile = path.join(portRoot, 'live.json')
        if (existsSync(liveFile)) {
          try {
            const live = JSON.parse(readFileSync(liveFile, 'utf8'))
            if (live.processIdentity?.pid) {
              rememberProcess(knownProcesses, live.processIdentity)
            }
            const storedController = path.join(
              portRoot,
              'current/controller/freshell-deploy',
            )
            if (existsSync(storedController)) {
              try {
                await checkedAsync(
                  storedController,
                  [
                    'stop-current',
                    '--checkout',
                    realCheckout,
                    '--port',
                    String(port),
                  ],
                  {
                    cwd: realCheckout,
                    env: realEnvironment ?? process.env,
                    timeout: 60_000,
                  },
                )
              } catch (error) {
                cleanupErrors.push(`controller stop failed: ${String(error)}`)
              }
            }
          } catch (error) {
            cleanupErrors.push(`could not inspect live receipt: ${String(error)}`)
          }
        }
        if (pidFile && existsSync(pidFile)) {
          try {
            rememberProcess(
              knownProcesses,
              readProcessIdentity(Number(readFileSync(pidFile, 'utf8').trim())),
            )
          } catch {
            // The exact captured birth is already gone.
          }
        }
      }

      for (const identity of knownProcesses.values()) {
        if (!isRecordedProcessRunning(identity)) continue
        try {
          process.kill(identity.pid, 'SIGTERM')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            cleanupErrors.push(
              `could not stop ${processIdentityKey(identity)}: ${String(error)}`,
            )
          }
        }
      }
      const processDeadline = Date.now() + 20_000
      while (
        Date.now() < processDeadline
        && [...knownProcesses.values()].some(isRecordedProcessRunning)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      for (const identity of knownProcesses.values()) {
        if (isRecordedProcessRunning(identity)) {
          cleanupErrors.push(`recorded process remained alive: ${processIdentityKey(identity)}`)
        }
      }
      if (port !== undefined) {
        try {
          await waitForHttp(port, 'down')
          await waitForPortFree(port)
        } catch (error) {
          cleanupErrors.push(`port ${port} was not proved free: ${String(error)}`)
        }
      }
      if (root) {
        spawnSync('chmod', ['-R', 'u+rwX', root], { encoding: 'utf8' })
        rmSync(root, { recursive: true, force: true })
      }
      if (cleanupErrors.length > 0) {
        throw new Error(`real deployment cleanup was incomplete:\n${cleanupErrors.join('\n')}`)
      }
    }
  }, 900_000)
})
