#!/usr/bin/env -S node_modules/.bin/tsx
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_MANAGED_PROVIDERS = ['shell', 'claude', 'codex', 'opencode', 'amplifier'] as const
const RELEASE_SCHEMA_VERSION = 2
const UNIX_SOCKET_PATH_BUDGET = 104

type PreparedReleaseInput = {
  repoRoot: string
  freshellHome: string
  commit: string
  imageRef: string
  serverBinary: string
  supervisorBinary: string
  hostBinary: string
}

export type PreparedRelease = {
  schemaVersion: 2
  releaseId: string
  commit: string
  imageRef: string
  repoRoot: string
  releaseRoot: string
  serverBinary: string
  supervisorBinary: string
  hostBinary: string
  binaryDigests: {
    server: string
    supervisor: string
    host: string
  }
  preparedAt: string
}

export type ManagedReleasePaths = {
  repoRoot: string
  freshellHome: string
  root: string
  releasesRoot: string
  currentFile: string
  controlRoot: string
  controlSocket: string
  controlSecret: string
  registryRoot: string
  runtimeRoot: string
  supervisorPidFile: string
  supervisorLogFile: string
  webEnvironmentFile: string
  backupsRoot: string
}

export type StaticPreflightFacts = {
  platform: string
  cgroupV2: boolean
  dockerRootless: boolean
  dockerImageId: string | undefined
}

export function releasePaths(repoRoot: string, freshellHome = process.env.FRESHELL_HOME || path.join(os.homedir(), '.freshell')): ManagedReleasePaths {
  const resolvedRepo = fs.realpathSync(repoRoot)
  const home = path.resolve(freshellHome)
  const root = path.join(home, 'mr')
  const controlRoot = path.join(root, 'c')
  return {
    repoRoot: resolvedRepo,
    freshellHome: home,
    root,
    releasesRoot: path.join(root, 'releases'),
    currentFile: path.join(root, 'current.json'),
    controlRoot,
    controlSocket: path.join(controlRoot, 'supervisor.sock'),
    controlSecret: path.join(controlRoot, 'secret'),
    registryRoot: path.join(root, 'registry'),
    runtimeRoot: path.join(root, 'r'),
    supervisorPidFile: path.join(root, 'supervisor.pid'),
    supervisorLogFile: path.join(home, 'logs', 'managed-runtime-supervisor.log'),
    webEnvironmentFile: path.join(root, 'web.env'),
    backupsRoot: path.join(root, 'backups'),
  }
}

function assertIdentifier(value: string, label: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`${label} is invalid`)
}

function assertRegularExecutable(source: string, label: string): string {
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  if ((stat.mode & 0o111) === 0) throw new Error(`${label} must be executable`)
  return fs.realpathSync(source)
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function atomicWrite(file: string, contents: string, mode = 0o600): void {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode)
  try {
    fs.writeFileSync(fd, contents)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temporary, file)
  fs.chmodSync(file, mode)
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
}

function safeCopyExecutable(source: string, destination: string): void {
  const sourceDigest = sha256File(source)
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination)
    if (stat.isSymbolicLink() || !stat.isFile() || sha256File(destination) !== sourceDigest) {
      throw new Error(`immutable release path already contains different bytes: ${destination}`)
    }
    fs.chmodSync(destination, 0o755)
    return
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(destination, 0o755)
}

function releaseIdFor(
  commit: string,
  imageRef: string,
  digests: PreparedRelease['binaryDigests'],
): string {
  return createHash('sha256')
    .update(`stage5a-release-v2\0${commit}\0${imageRef}\0`)
    .update(digests.server)
    .update(digests.supervisor)
    .update(digests.host)
    .digest('hex')
    .slice(0, 24)
}

export function prepareImmutableRelease(input: PreparedReleaseInput): PreparedRelease {
  const paths = releasePaths(input.repoRoot, input.freshellHome)
  assertIdentifier(input.commit, 'commit', /^[0-9a-f]{40}$/)
  assertIdentifier(input.imageRef, 'runtime image reference', /^sha256:[0-9a-f]{64}$/)
  const sources = {
    server: assertRegularExecutable(input.serverBinary, 'server binary'),
    supervisor: assertRegularExecutable(input.supervisorBinary, 'supervisor binary'),
    host: assertRegularExecutable(input.hostBinary, 'session-host binary'),
  }
  const binaryDigests = {
    server: sha256File(sources.server),
    supervisor: sha256File(sources.supervisor),
    host: sha256File(sources.host),
  }
  const releaseId = releaseIdFor(input.commit, input.imageRef, binaryDigests)
  const releaseRoot = path.join(paths.releasesRoot, releaseId)
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
  fs.chmodSync(releaseRoot, 0o700)
  const release: PreparedRelease = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    releaseId,
    commit: input.commit,
    imageRef: input.imageRef,
    repoRoot: paths.repoRoot,
    releaseRoot,
    serverBinary: path.join(releaseRoot, 'freshell-server'),
    supervisorBinary: path.join(releaseRoot, 'freshell-supervisor'),
    hostBinary: path.join(releaseRoot, 'freshell-session-host'),
    binaryDigests,
    preparedAt: new Date().toISOString(),
  }
  safeCopyExecutable(sources.server, release.serverBinary)
  safeCopyExecutable(sources.supervisor, release.supervisorBinary)
  safeCopyExecutable(sources.host, release.hostBinary)
  const metadata = path.join(releaseRoot, 'release.json')
  if (fs.existsSync(metadata)) return readPreparedRelease(paths, releaseId)
  atomicWrite(metadata, `${JSON.stringify(release, null, 2)}
`)
  return readPreparedRelease(paths, releaseId)
}

function parseRelease(value: unknown, paths: ManagedReleasePaths): PreparedRelease {
  const release = value as Partial<PreparedRelease> | null
  const digests = release?.binaryDigests
  if (!release || release.schemaVersion !== RELEASE_SCHEMA_VERSION
      || typeof release.releaseId !== 'string' || !/^[0-9a-f]{24}$/.test(release.releaseId)
      || typeof release.commit !== 'string' || !/^[0-9a-f]{40}$/.test(release.commit)
      || typeof release.imageRef !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(release.imageRef)
      || typeof release.releaseRoot !== 'string' || typeof release.repoRoot !== 'string'
      || typeof release.serverBinary !== 'string' || typeof release.supervisorBinary !== 'string'
      || typeof release.hostBinary !== 'string' || typeof release.preparedAt !== 'string'
      || !digests || typeof digests.server !== 'string' || !/^[0-9a-f]{64}$/.test(digests.server)
      || typeof digests.supervisor !== 'string' || !/^[0-9a-f]{64}$/.test(digests.supervisor)
      || typeof digests.host !== 'string' || !/^[0-9a-f]{64}$/.test(digests.host)) {
    throw new Error('managed runtime release metadata is invalid')
  }
  const expectedRoot = path.join(paths.releasesRoot, release.releaseId)
  if (path.resolve(release.releaseRoot) !== expectedRoot
      || path.resolve(release.serverBinary) !== path.join(expectedRoot, 'freshell-server')
      || path.resolve(release.supervisorBinary) !== path.join(expectedRoot, 'freshell-supervisor')
      || path.resolve(release.hostBinary) !== path.join(expectedRoot, 'freshell-session-host')
      || path.resolve(release.repoRoot) !== paths.repoRoot
      || releaseIdFor(release.commit, release.imageRef, digests) !== release.releaseId) {
    throw new Error('managed runtime release metadata escaped or disagrees with its immutable identity')
  }
  return release as PreparedRelease
}

function verifyReleaseArtifacts(release: PreparedRelease): void {
  for (const [label, file, expected] of [
    ['server', release.serverBinary, release.binaryDigests.server],
    ['supervisor', release.supervisorBinary, release.binaryDigests.supervisor],
    ['session host', release.hostBinary, release.binaryDigests.host],
  ] as const) {
    assertRegularExecutable(file, `${label} release binary`)
    if (sha256File(file) !== expected) {
      throw new Error(`${label} immutable release binary digest does not match release metadata`)
    }
  }
}

export function readPreparedRelease(paths: ManagedReleasePaths, releaseId: string): PreparedRelease {
  assertIdentifier(releaseId, 'release id', /^[0-9a-f]{24}$/)
  const metadata = path.join(paths.releasesRoot, releaseId, 'release.json')
  const stat = fs.lstatSync(metadata)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('managed runtime release metadata must be a regular file')
  const release = parseRelease(JSON.parse(fs.readFileSync(metadata, 'utf8')), paths)
  verifyReleaseArtifacts(release)
  return release
}

export function activatePreparedRelease(
  release: PreparedRelease,
  paths: ManagedReleasePaths,
): PreparedRelease {
  const verified = readPreparedRelease(paths, release.releaseId)
  if (JSON.stringify(verified) !== JSON.stringify(release)) {
    throw new Error('prepared release differs from its immutable metadata')
  }
  // The generic web routing environment is written first. If that fails,
  // the durable active-release pointer remains unchanged.
  writeManagedWebEnvironment(paths)
  atomicWrite(paths.currentFile, `${JSON.stringify(verified, null, 2)}
`)
  return verified
}

export function readCurrentRelease(paths: ManagedReleasePaths): PreparedRelease {
  const stat = fs.lstatSync(paths.currentFile)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('managed runtime current release must be a regular file')
  const pointer = parseRelease(JSON.parse(fs.readFileSync(paths.currentFile, 'utf8')), paths)
  return readPreparedRelease(paths, pointer.releaseId)
}

export function managedWebEnvironment(paths: ManagedReleasePaths): Record<string, string> {
  return {
    FRESHELL_MANAGED_RUNTIME_V1: '1',
    FRESHELL_MANAGED_FRESH_AGENT_V1: '1',
    FRESHELL_MANAGED_PROVIDERS: DEFAULT_MANAGED_PROVIDERS.join(','),
    FRESHELL_RUNTIME_CONTROL_SOCKET: paths.controlSocket,
    FRESHELL_RUNTIME_CONTROL_SECRET_FILE: paths.controlSecret,
  }
}

export function writeManagedWebEnvironment(paths: ManagedReleasePaths): string {
  const environment = managedWebEnvironment(paths)
  atomicWrite(paths.webEnvironmentFile, `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
  return paths.webEnvironmentFile
}

export function supervisorArguments(release: PreparedRelease, paths: ManagedReleasePaths, dockerSocket: string): string[] {
  return [
    'serve',
    '--registry-root', paths.registryRoot,
    '--control-socket', paths.controlSocket,
    '--control-secret-file', paths.controlSecret,
    '--docker-socket', dockerSocket,
    '--runtime-root', paths.runtimeRoot,
    '--host-binary', release.hostBinary,
    '--image-ref', release.imageRef,
    '--test-run-id', `release-${release.releaseId}`,
  ]
}

export function validateStaticPreflight(release: PreparedRelease, paths: ManagedReleasePaths, facts: StaticPreflightFacts): string[] {
  const errors: string[] = []
  if (facts.platform !== 'linux') errors.push('managed runtime release requires Linux')
  if (!facts.cgroupV2) errors.push('managed runtime release requires cgroup v2')
  if (!facts.dockerRootless) errors.push('managed runtime release requires rootless Docker')
  if (facts.dockerImageId !== release.imageRef) errors.push('runtime image does not match the immutable release image')
  for (const [label, file] of [['server', release.serverBinary], ['supervisor', release.supervisorBinary], ['session host', release.hostBinary]] as const) {
    try { assertRegularExecutable(file, label) } catch (error) { errors.push((error as Error).message) }
  }
  if (Buffer.byteLength(paths.controlSocket) >= UNIX_SOCKET_PATH_BUDGET) errors.push('supervisor control socket exceeds the Linux Unix-socket path budget')
  const worstHost = path.join(paths.runtimeRoot, `incarnation-${'0'.repeat(36)}`, 'host.sock')
  if (Buffer.byteLength(worstHost) >= UNIX_SOCKET_PATH_BUDGET) errors.push('session-host control socket exceeds the Linux Unix-socket path budget')
  return errors
}

function resolveDockerSocket(): string {
  const configured = process.env.DOCKER_HOST
  const candidate = configured?.startsWith('unix://')
    ? configured.slice('unix://'.length)
    : configured
      ? ''
      : `/run/user/${process.getuid?.() ?? 0}/docker.sock`
  if (!candidate) throw new Error('DOCKER_HOST must name a unix:// socket for managed runtime')
  const stat = fs.statSync(candidate)
  if (!stat.isSocket()) throw new Error(`Docker endpoint is not a Unix socket: ${candidate}`)
  return fs.realpathSync(candidate)
}

function dockerFacts(release: PreparedRelease, dockerSocket: string): StaticPreflightFacts {
  const env = { ...process.env, DOCKER_HOST: `unix://${dockerSocket}` }
  const security = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8', env })) as string[]
  const imageId = execFileSync('docker', ['image', 'inspect', release.imageRef, '--format', '{{.Id}}'], { encoding: 'utf8', env }).trim()
  return {
    platform: process.platform,
    cgroupV2: fs.existsSync('/sys/fs/cgroup/cgroup.controllers'),
    dockerRootless: security.some(value => /rootless/i.test(value)),
    dockerImageId: imageId,
  }
}

function credentialPreflightErrors(): string[] {
  const errors: string[] = []
  const credentialChecks = [
    ['Claude', path.join(os.homedir(), '.claude', '.credentials.json'), false],
    ['Codex', path.join(os.homedir(), '.codex', 'auth.json'), false],
    ['Amplifier', path.join(os.homedir(), '.amplifier', 'keys.env'), true],
  ] as const
  for (const [provider, file, privateMode] of credentialChecks) {
    try {
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isFile() || (privateMode && (stat.mode & 0o077) !== 0)) {
        errors.push(`${provider} credential reference is not a safe private regular file: ${file}`)
      }
    } catch {
      errors.push(`${provider} credential reference is missing: ${file}`)
    }
  }
  return errors
}

function preflightRelease(release: PreparedRelease, paths: ManagedReleasePaths): {
  dockerSocket: string
  errors: string[]
} {
  ensurePrivateState(paths)
  const dockerSocket = resolveDockerSocket()
  const errors = [
    ...validateStaticPreflight(release, paths, dockerFacts(release, dockerSocket)),
    ...credentialPreflightErrors(),
  ]
  return { dockerSocket, errors }
}

export async function backupRegistry(
  paths: ManagedReleasePaths,
  releaseId: string,
): Promise<string | null> {
  const source = path.join(paths.registryRoot, 'runtime.sqlite3')
  if (!fs.existsSync(source)) return null
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('managed runtime registry must be a regular file before backup')
  }
  const { DatabaseSync, backup } = await import('node:sqlite')
  fs.mkdirSync(paths.backupsRoot, { recursive: true, mode: 0o700 })
  const target = path.join(
    paths.backupsRoot,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${releaseId}.sqlite3`,
  )
  const database = new DatabaseSync(source, { readOnly: true })
  try {
    await backup(database, target)
  } finally {
    database.close()
  }
  fs.chmodSync(target, 0o600)
  const check = new DatabaseSync(target, { readOnly: true })
  try {
    const row = check.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (!row || !Object.values(row).includes('ok')) {
      throw new Error('managed runtime registry backup failed SQLite quick_check')
    }
  } finally {
    check.close()
  }
  return target
}

function ensurePrivateState(paths: ManagedReleasePaths): void {
  for (const directory of [paths.root, paths.controlRoot, paths.registryRoot, paths.runtimeRoot, path.dirname(paths.supervisorLogFile)]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (directory !== path.dirname(paths.supervisorLogFile)) fs.chmodSync(directory, 0o700)
  }
  if (!fs.existsSync(paths.controlSecret)) {
    atomicWrite(paths.controlSecret, `${randomBytes(48).toString('hex')}\n`)
  } else {
    const stat = fs.lstatSync(paths.controlSecret)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('managed runtime control secret must be a private regular file')
    fs.chmodSync(paths.controlSecret, 0o600)
  }
  writeManagedWebEnvironment(paths)
}

function pidFromFile(file: string): number | undefined {
  if (!fs.existsSync(file)) return undefined
  const raw = fs.readFileSync(file, 'utf8').trim()
  return /^\d+$/.test(raw) ? Number(raw) : undefined
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    return close >= 0 && stat.slice(close + 2, close + 3) !== 'Z'
  } catch {
    return false
  }
}

function commandLine(pid: number): string[] {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean) } catch { return [] }
}

function isOwnedSupervisor(pid: number, paths: ManagedReleasePaths): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !processAlive(pid)) return false
  const args = commandLine(pid)
  const cwd = (() => { try { return fs.realpathSync(`/proc/${pid}/cwd`) } catch { return '' } })()
  const binary = args[0] ? path.resolve(args[0]) : ''
  return cwd === paths.repoRoot
    && binary.startsWith(`${paths.releasesRoot}${path.sep}`)
    && path.basename(binary) === 'freshell-supervisor'
    && args.includes('serve')
    && args.includes(paths.controlSocket)
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath)
    const done = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(300)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function stopOwnedSupervisor(paths: ManagedReleasePaths): Promise<boolean> {
  const pid = pidFromFile(paths.supervisorPidFile)
  if (!pid) return false
  if (!isOwnedSupervisor(pid, paths)) {
    if (processAlive(pid)) throw new Error(`refusing to stop pid ${pid}: it is not this installation's managed runtime supervisor`)
    fs.rmSync(paths.supervisorPidFile, { force: true })
    return false
  }
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 5000
  while (processAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  if (processAlive(pid)) throw new Error(`managed runtime supervisor ${pid} did not exit after SIGTERM; refusing to escalate`)
  fs.rmSync(paths.supervisorPidFile, { force: true })
  if (fs.existsSync(paths.controlSocket) && !(await socketAcceptsConnections(paths.controlSocket))) fs.rmSync(paths.controlSocket)
  return true
}

async function ensureSupervisor(release: PreparedRelease, paths: ManagedReleasePaths, replace: boolean): Promise<number> {
  ensurePrivateState(paths)
  const dockerSocket = resolveDockerSocket()
  const errors = validateStaticPreflight(release, paths, dockerFacts(release, dockerSocket))
  if (errors.length) throw new Error(`managed runtime preflight failed:\n- ${errors.join('\n- ')}`)
  const currentPid = pidFromFile(paths.supervisorPidFile)
  if (currentPid && isOwnedSupervisor(currentPid, paths)) {
    const runningBinary = commandLine(currentPid)[0]
    if (path.resolve(runningBinary) === release.supervisorBinary) return currentPid
    if (!replace) throw new Error('a different managed runtime supervisor release is running; use --replace during an approved web restart')
    await stopOwnedSupervisor(paths)
  } else if (currentPid && processAlive(currentPid)) {
    throw new Error(`supervisor pid file points at foreign live pid ${currentPid}`)
  } else if (currentPid) {
    fs.rmSync(paths.supervisorPidFile, { force: true })
  }
  if (await socketAcceptsConnections(paths.controlSocket)) throw new Error(`refusing to replace an unowned live supervisor socket: ${paths.controlSocket}`)
  if (fs.existsSync(paths.controlSocket)) fs.rmSync(paths.controlSocket)
  const logFd = fs.openSync(paths.supervisorLogFile, 'a', 0o600)
  const child = spawn(release.supervisorBinary, supervisorArguments(release, paths, dockerSocket), {
    cwd: paths.repoRoot,
    env: { ...process.env, FRESHELL_MANAGED_PROVIDERS: DEFAULT_MANAGED_PROVIDERS.join(',') },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  fs.closeSync(logFd)
  child.unref()
  if (!child.pid) throw new Error('managed runtime supervisor did not return a pid')
  atomicWrite(paths.supervisorPidFile, `${child.pid}\n`)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!processAlive(child.pid)) {
      fs.rmSync(paths.supervisorPidFile, { force: true })
      const tail = fs.existsSync(paths.supervisorLogFile) ? fs.readFileSync(paths.supervisorLogFile, 'utf8').slice(-4000) : ''
      throw new Error(`managed runtime supervisor exited during startup\n${tail}`)
    }
    if (await socketAcceptsConnections(paths.controlSocket)) return child.pid
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  let cleanupError: string | undefined
  try {
    await stopOwnedSupervisor(paths)
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error)
  }
  throw new Error(
    `managed runtime supervisor ${child.pid} did not become ready at ${paths.controlSocket}`
    + (cleanupError ? `; exact startup cleanup failed: ${cleanupError}` : ''),
  )
}

function argument(args: string[], key: string): string | undefined {
  const index = args.indexOf(key)
  return index >= 0 ? args[index + 1] : undefined
}

function requiredArgument(args: string[], key: string): string {
  const value = argument(args, key)
  if (!value) throw new Error(`missing ${key}`)
  return value
}

async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0]
  const repoRoot = fs.realpathSync(requiredArgument(args, '--repo-root'))
  const freshellHome = argument(args, '--freshell-home') || process.env.FRESHELL_HOME || path.join(os.homedir(), '.freshell')
  const paths = releasePaths(repoRoot, freshellHome)
  if (command === 'prepare') {
    const release = prepareImmutableRelease({
      repoRoot, freshellHome,
      commit: requiredArgument(args, '--commit'), imageRef: requiredArgument(args, '--image-ref'),
      serverBinary: requiredArgument(args, '--server-binary'), supervisorBinary: requiredArgument(args, '--supervisor-binary'),
      hostBinary: requiredArgument(args, '--host-binary'),
    })
    console.log(JSON.stringify(release))
    return 0
  }
  if (command === 'stop-supervisor') {
    console.log(JSON.stringify({ stopped: await stopOwnedSupervisor(paths) }))
    return 0
  }
  if (command === 'status') {
    let release: PreparedRelease | undefined
    try { release = readCurrentRelease(paths) } catch {}
    const pid = pidFromFile(paths.supervisorPidFile)
    console.log(JSON.stringify({
      releaseId: release?.releaseId ?? null,
      supervisorPid: pid ?? null,
      supervisorOwnedAndRunning: pid ? isOwnedSupervisor(pid, paths) : false,
      socketReady: await socketAcceptsConnections(paths.controlSocket),
      paths,
    }, null, 2))
    return 0
  }
  const selectedReleaseId = argument(args, '--release-id')
  const release = selectedReleaseId
    ? readPreparedRelease(paths, selectedReleaseId)
    : readCurrentRelease(paths)
  if (command === 'current') {
    const field = argument(args, '--field')
    console.log(field ? String((release as unknown as Record<string, unknown>)[field] ?? '') : JSON.stringify(release))
    return 0
  }
  if (command === 'preflight') {
    const { dockerSocket, errors } = preflightRelease(release, paths)
    console.log(JSON.stringify({ ok: errors.length === 0, releaseId: release.releaseId, dockerSocket, errors }, null, 2))
    return errors.length ? 1 : 0
  }
  if (command === 'activate') {
    const { errors } = preflightRelease(release, paths)
    if (errors.length) throw new Error(`managed runtime preflight failed:\n- ${errors.join('\n- ')}`)
    activatePreparedRelease(release, paths)
    console.log(JSON.stringify({ activated: release.releaseId }))
    return 0
  }
  if (command === 'backup-registry') {
    console.log(JSON.stringify({ backup: await backupRegistry(paths, release.releaseId) }))
    return 0
  }
  if (command === 'ensure-supervisor') {
    if (selectedReleaseId) throw new Error('activate a prepared release before starting its supervisor')
    const pid = await ensureSupervisor(release, paths, args.includes('--replace'))
    console.log(String(pid))
    return 0
  }
  if (command === 'web-env-file') {
    if (selectedReleaseId) throw new Error('activate a prepared release before requesting web environment')
    console.log(writeManagedWebEnvironment(paths))
    return 0
  }
  throw new Error('usage: managed-runtime-release.ts <prepare|activate|current|preflight|backup-registry|ensure-supervisor|stop-supervisor|status|web-env-file> --repo-root PATH [options]')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
