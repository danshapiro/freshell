#!/usr/bin/env node

// Temporary adapter for the pinned cold/warm Rust cache experiment. Kept
// outside the repository; it uses the coordinator's socket, store, and spawn
// watchdog primitives instead of introducing a command identity in source.

import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants as osConstants } from 'node:os'
import { performance } from 'node:perf_hooks'

const CACHE_DIR = '/home/dan/.cache/freshell-cache-experiment/20261029T2342Z-77444e9'
const COMMIT = '77444e9f22e1dbcf34c01202e4fb5acfad144281'
const WORKTREE_SUFFIX = path.join('.worktrees', 'rust-cache-experiment-77444e9')
const EXPERIMENT = 'rust-cache-experiment-77444e9'
const LABELS = ['cold', 'warm'] as const
const TARGET_VOLUME = 'freshell-sandbox-cargo-target'
const TARGET_HASH = '38624dc0873f'
const TARGET_CONTAINER_PATH = `/freshell-test-artifacts/targets/${TARGET_HASH}`
const TARGET_VOLUME_MOUNTPOINT = '/home/dan/.local/share/docker/volumes/freshell-sandbox-cargo-target/_data'
const TARGET_HOST_PATH = path.join(TARGET_VOLUME_MOUNTPOINT, 'targets', TARGET_HASH)
const SANDBOX_IMAGE_REF = 'freshell-sandbox:latest'
const SANDBOX_IMAGE_ID = 'sha256:6104b72781bc9da15b0ed21ab0400657d513b0f94cf8a53447b073e361f1c2c0'
const DEFAULT_POLL_MS = 60_000
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1000
type Signal = NodeJS.Signals

const usage = `Usage:
  pnpm exec tsx ${CACHE_DIR}/rust-cache-gate-harness.ts --repo <pinned-worktree> --cold-log <path> --warm-log <path> --receipt <path>
  pnpm exec tsx ${CACHE_DIR}/rust-cache-gate-harness.ts --self-check [--repo <checkout>]`

function event(name: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ severity: 'info', event: name, timestamp: new Date().toISOString(), ...fields })}\n`)
}

function errorEvent(name: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ severity: 'error', event: name, timestamp: new Date().toISOString(), ...fields })}\n`)
}

function parseArgs(argv: string[]): { repo: string; selfCheck: boolean; coldLog?: string; warmLog?: string; receipt?: string } {
  const values = new Map<string, string>()
  let selfCheck = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') throw new Error(usage)
    if (arg === '--self-check') { selfCheck = true; continue }
    if (!['--repo', '--cold-log', '--warm-log', '--receipt'].includes(arg)) throw new Error(`Unknown argument: ${arg}\n${usage}`)
    const value = argv[++i]
    if (!value || value.startsWith('--') || values.has(arg)) throw new Error(`Missing or repeated value for ${arg}`)
    values.set(arg, value)
  }
  if (!selfCheck && (!values.has('--repo') || !values.has('--cold-log') || !values.has('--warm-log') || !values.has('--receipt'))) {
    throw new Error(usage)
  }
  return {
    repo: path.resolve(values.get('--repo') ?? process.cwd()),
    selfCheck,
    coldLog: values.get('--cold-log'),
    warmLog: values.get('--warm-log'),
    receipt: values.get('--receipt'),
  }
}

async function loadModules(repo: string): Promise<any> {
  const load = (name: string) => import(pathToFileURL(path.join(repo, `scripts/testing/${name}.ts`)).href)
  const [endpoint, store, upstream, processTree, repoContext] = await Promise.all([
    load('coordinator-endpoint'), load('coordinator-store'), load('coordinator-upstream'),
    load('process-tree'), load('repo-context'),
  ])
  return { endpoint, store, upstream, processTree, repoContext }
}

async function repoInfo(repo: string, m: any): Promise<any> {
  const checkout = await m.repoContext.resolveGitCheckoutRoot(repo)
  const [repoRoot, commonDir, branchDirty] = await Promise.all([
    m.repoContext.resolveGitRepoRoot(repo),
    m.repoContext.resolveGitCommonDir(repo),
    m.repoContext.resolveGitBranchAndDirty(repo),
  ])
  const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim()
  if (!commonDir || path.resolve(checkout) !== path.resolve(repo)) throw new Error(`--repo must be a Git worktree root: ${repo}`)
  if (!path.resolve(repo).endsWith(path.sep + WORKTREE_SUFFIX)) throw new Error(`--repo must end in ${WORKTREE_SUFFIX}`)
  if (commit !== COMMIT) throw new Error(`Expected pinned commit ${COMMIT}; found ${commit || '(none)'}`)
  if (dirty || branchDirty.isDirty !== false) throw new Error(`Pinned worktree must be clean before the experiment:\n${dirty}`)
  return { invocationCwd: repo, checkoutRoot: checkout, repoRoot, commonDir, branch: branchDirty.branch, commit, isDirty: false }
}

function assertSameSource(initial: any, current: any): void {
  if (current.commit !== initial.commit) throw new Error(`Source commit changed: expected ${initial.commit}, found ${current.commit}`)
  if (current.isDirty !== false) throw new Error('Source worktree became dirty during the experiment.')
}

function readOnlyCommand(command: string, args: string[]): string {
  const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }
  try { return execFileSync(command, args, options).trim() }
  catch (directError) {
    try { return execFileSync('sudo', ['-n', command, ...args], options).trim() }
    catch (sudoError) {
      throw new Error(`Read-only measurement command failed (${command} ${args.join(' ')}): direct=${String(directError)}; sudo -n=${String(sudoError)}`)
    }
  }
}

function assertSandboxImageId(stage: string, imageId: string): any {
  if (imageId !== SANDBOX_IMAGE_ID) throw new Error(`Sandbox image changed at ${stage}: expected ${SANDBOX_IMAGE_ID}, found ${imageId || '(empty)'}`)
  const check = { stage, checkedAt: new Date().toISOString(), imageRef: SANDBOX_IMAGE_REF, imageId }
  event('rust_cache_sandbox_image_validated', check)
  return check
}

function inspectSandboxImage(stage: string): any {
  const imageId = readOnlyCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE_REF])
  return assertSandboxImageId(stage, imageId)
}

function resolveTargetIdentity(repo: any): any {
  const derivedHash = createHash('sha256').update(path.resolve(repo.checkoutRoot)).digest('hex').slice(0, 12)
  if (derivedHash !== TARGET_HASH) throw new Error(`Pinned worktree target hash mismatch: expected ${TARGET_HASH}, derived ${derivedHash}`)
  const mountpoint = readOnlyCommand('docker', ['volume', 'inspect', '--format', '{{.Mountpoint}}', TARGET_VOLUME])
  if (path.resolve(mountpoint) !== path.resolve(TARGET_VOLUME_MOUNTPOINT)) {
    throw new Error(`Cargo target volume mountpoint mismatch: expected ${TARGET_VOLUME_MOUNTPOINT}, found ${mountpoint || '(empty)'}`)
  }
  const hostPath = path.resolve(mountpoint, 'targets', derivedHash)
  if (hostPath !== path.resolve(TARGET_HOST_PATH) || TARGET_CONTAINER_PATH !== `/freshell-test-artifacts/targets/${derivedHash}`) {
    throw new Error(`Cargo target path does not match the pinned experiment namespace: host=${hostPath}, container=${TARGET_CONTAINER_PATH}`)
  }
  return { volumeName: TARGET_VOLUME, volumeMountpoint: mountpoint, targetHash: derivedHash, containerPath: TARGET_CONTAINER_PATH, hostPath }
}

const INVENTORY_SCRIPT = String.raw`
import json, os, re, stat, sys
root = sys.argv[1]
try:
    root_mode = os.lstat(root).st_mode
except FileNotFoundError:
    print(json.dumps({"exists": False, "hasPayload": False, "directories": {}, "executables": {"server": [], "sessionHost": [], "integrationTests": []}}))
    raise SystemExit(0)
if not stat.S_ISDIR(root_mode):
    raise SystemExit("target root is not a directory")
def safe_dir(rel):
    current = root
    for part in rel.split("/"):
        current = os.path.join(current, part)
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError:
            return False
        if not stat.S_ISDIR(mode):
            return False
    return True
directories = {}
for rel in ("debug/deps", "debug/incremental", "debug/build", "debug/.fingerprint"):
    directories[rel] = safe_dir(rel)

# The before-cold check needs to reject any retained file or symlink, while
# allowing an otherwise-empty directory skeleton. Stop at the first payload.
has_payload = False
stack = [root]
while stack and not has_payload:
    current = stack.pop()
    try:
        entries = list(os.scandir(current))
    except OSError as exc:
        raise SystemExit("cannot read target directory %s: %s" % (current, exc))
    for entry in entries:
        st = entry.stat(follow_symlinks=False)
        if stat.S_ISDIR(st.st_mode):
            stack.append(entry.path)
        else:
            has_payload = True
            break

integration_targets = set()
fingerprint_root = os.path.join(root, "debug/.fingerprint")
if directories["debug/.fingerprint"]:
    try:
        packages = os.scandir(fingerprint_root)
        for package in packages:
            if not package.is_dir(follow_symlinks=False):
                continue
            for item in os.scandir(package.path):
                match = re.fullmatch(r"test-integration-test-(.+)\.json", item.name)
                if match and item.is_file(follow_symlinks=False):
                    integration_targets.add(match.group(1))
    except OSError as exc:
        raise SystemExit("cannot read Cargo fingerprints: %s" % exc)

executables = {"server": [], "sessionHost": [], "integrationTests": []}
candidate_paths = []
debug_root = os.path.join(root, "debug")
if safe_dir("debug"):
    candidate_paths.append(debug_root)
deps_root = os.path.join(debug_root, "deps")
if directories["debug/deps"]:
    candidate_paths.append(deps_root)
for directory in candidate_paths:
    try:
        for entry in os.scandir(directory):
            st = entry.stat(follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode) or not (st.st_mode & 0o111):
                continue
            name = entry.name
            record = {"path": entry.path, "name": name, "sizeBytes": st.st_size}
            if re.fullmatch(r"freshell[-_]server(?:-[0-9a-fA-F]{8,})?", name):
                executables["server"].append(record)
            if re.fullmatch(r"freshell[-_]session[-_]host(?:-[0-9a-fA-F]{8,})?", name):
                executables["sessionHost"].append(record)
            for target in sorted(integration_targets, key=len, reverse=True):
                spellings = {target, target.replace("-", "_")}
                matched = next((value for value in spellings if name == value or name.startswith(value + "-")), None)
                if matched is not None:
                    executables["integrationTests"].append({**record, "targetName": target})
                    break
    except OSError as exc:
        raise SystemExit("cannot read executable directory %s: %s" % (directory, exc))
print(json.dumps({"exists": True, "hasPayload": has_payload, "directories": directories, "integrationTargets": sorted(integration_targets), "executables": executables}))
`

function parseDuOutput(output: string, label: string): Map<string, number> {
  const result = new Map<string, number>()
  for (const line of output.split('\n')) {
    if (!line) continue
    const match = line.match(/^([0-9]+)\s+(.+)$/)
    if (!match) throw new Error(`Could not parse ${label} du output line: ${line}`)
    const bytes = Number(match[1])
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Invalid ${label} du byte count: ${match[1]}`)
    result.set(path.resolve(match[2]), bytes)
  }
  return result
}

function measureTargetDirectory(targetPath: string): any {
  const inventoryText = readOnlyCommand('python3', ['-c', INVENTORY_SCRIPT, targetPath])
  let metadata: any
  try { metadata = JSON.parse(inventoryText) }
  catch (e) { throw new Error(`Target inventory returned invalid JSON: ${String(e)}`) }
  if (!metadata || typeof metadata.exists !== 'boolean' || !metadata.directories || !metadata.executables) {
    throw new Error('Target inventory returned an incomplete measurement.')
  }
  const executableGroups: Record<string, unknown> = {}
  for (const [name, files] of Object.entries(metadata.executables)) {
    if (!Array.isArray(files)) throw new Error(`Target executable inventory group ${name} is malformed.`)
    executableGroups[name] = { count: files.length, files }
  }
  if (!metadata.exists) {
    const composition = Object.fromEntries(['debug/deps', 'debug/incremental', 'debug/build', 'debug/.fingerprint'].map((name) => [name, { exists: false, allocatedBytes: 0, apparentBytes: 0 }]))
    return { exists: false, hasPayload: false, allocatedBytes: 0, apparentBytes: 0, composition, executables: executableGroups, integrationTargets: [] }
  }
  const allocated = parseDuOutput(readOnlyCommand('du', ['--max-depth=2', '-B1', '--', targetPath]), 'allocated')
  const apparent = parseDuOutput(readOnlyCommand('du', ['--apparent-size', '--max-depth=2', '-B1', '--', targetPath]), 'apparent')
  const absoluteTarget = path.resolve(targetPath)
  if (!allocated.has(absoluteTarget) || !apparent.has(absoluteTarget)) throw new Error(`du did not report the target root ${absoluteTarget}`)
  const composition: Record<string, unknown> = {}
  for (const name of ['debug/deps', 'debug/incremental', 'debug/build', 'debug/.fingerprint']) {
    const exists = metadata.directories[name] === true
    const dir = path.resolve(targetPath, name)
    if (exists && (!allocated.has(dir) || !apparent.has(dir))) throw new Error(`du did not report expected composition directory ${dir}`)
    composition[name] = { exists, allocatedBytes: exists ? allocated.get(dir) : 0, apparentBytes: exists ? apparent.get(dir) : 0 }
  }
  return {
    exists: true,
    hasPayload: metadata.hasPayload === true,
    allocatedBytes: allocated.get(absoluteTarget),
    apparentBytes: apparent.get(absoluteTarget),
    composition,
    executables: executableGroups,
    integrationTargets: metadata.integrationTargets,
  }
}

function captureTargetSnapshot(stage: string, repo: any): any {
  const measurementStartedAt = new Date().toISOString()
  const targetIdentity = resolveTargetIdentity(repo)
  const measurement = measureTargetDirectory(targetIdentity.hostPath)
  const snapshot = {
    stage,
    measurementStartedAt,
    measuredAt: new Date().toISOString(),
    targetIdentity,
    sandboxImage: { imageRef: SANDBOX_IMAGE_REF, expectedImageId: SANDBOX_IMAGE_ID },
    ...measurement,
  }
  event('rust_cache_target_snapshot', snapshot)
  return snapshot
}

function assertEmptyTarget(snapshot: any): void {
  if (snapshot.exists && snapshot.hasPayload) throw new Error(`The before-cold target is not empty: ${snapshot.targetIdentity.hostPath}`)
  if (snapshot.apparentBytes !== 0) throw new Error(`The before-cold target has ${snapshot.apparentBytes} apparent bytes; expected an empty target.`)
}

async function revalidateAndRecordSource(initial: any, stage: string, readCurrent: () => Promise<any>, checks: any[]): Promise<any> {
  const current = await readCurrent()
  assertSameSource(initial, current)
  const check = { stage, checkedAt: new Date().toISOString(), commit: current.commit, clean: true }
  checks.push(check)
  event('source_revalidation_passed', check)
  return current
}

type FinalOutcome = { status: string; exitCode: number; error?: string }

function markFailure(outcome: FinalOutcome, reason: string): void {
  outcome.status = 'failure'
  outcome.exitCode = 1
  outcome.error ??= reason
}

async function cleanupGate(m: any, storeDir: string, runId: string, listener: any, onFailure: (message: string) => void): Promise<void> {
  try { await m.store.clearHolderIfRunIdMatches(storeDir, runId) }
  catch (e) { onFailure(`clearHolderIfRunIdMatches: ${String(e)}`) }
  try { await listener.close(); event('coordinator_gate_released', { runId }) }
  catch (e) { onFailure(`listener.close: ${String(e)}`) }
}

function recordCommon(repo: any, runId: string): Record<string, unknown> {
  const commandKey = `${EXPERIMENT}-${runId.slice(0, 8)}`
  return {
    runId,
    summary: `Rust cold/warm cache experiment at ${COMMIT.slice(0, 12)}`,
    summarySource: 'fallback',
    entrypoint: { commandKey },
    command: {
      display: 'two sequential FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust runs (cold, warm)',
      argv: [commandKey, 'cold: FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust', 'warm: FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust'],
    },
    repo: {
      invocationCwd: repo.invocationCwd,
      checkoutRoot: repo.checkoutRoot,
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
      worktreePath: repo.checkoutRoot,
      branch: repo.branch,
      commit: repo.commit,
      isDirty: repo.isDirty,
    },
    runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
    agent: {
      kind: process.env.FRESHELL_AGENT_KIND ?? 'rust-cache-experiment-harness',
      sessionId: process.env.FRESHELL_AGENT_SESSION_ID,
      threadId: process.env.FRESHELL_AGENT_THREAD_ID,
    },
  }
}

function holder(repo: any, runId: string, startedAt: string): Record<string, unknown> {
  return { ...recordCommon(repo, runId), schemaVersion: 1, startedAt, pid: process.pid, hostname: os.hostname(), username: process.env.USER ?? process.env.LOGNAME }
}

function latest(repo: any, runId: string, startedAt: string, finishedAt: string, exitCode: number): Record<string, unknown> {
  return {
    ...recordCommon(repo, runId), startedAt, finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    outcome: exitCode === 0 ? 'success' : 'failure', exitCode,
  }
}

function artifactPath(raw: string, repo: string): string {
  const full = path.resolve(raw)
  const insideRepo = path.relative(repo, full)
  if (insideRepo === '' || (!insideRepo.startsWith(`..${path.sep}`) && insideRepo !== '..' && !path.isAbsolute(insideRepo))) {
    throw new Error(`Artifacts must remain outside the worktree: ${full}`)
  }
  const insideCache = path.relative(CACHE_DIR, full)
  if (insideCache === '' || insideCache === '..' || insideCache.startsWith(`..${path.sep}`) || path.isAbsolute(insideCache)) {
    throw new Error(`Artifacts must remain under ${CACHE_DIR}: ${full}`)
  }
  return full
}

async function createFreshFile(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const handle = await fsp.open(file, 'wx', 0o600)
  try { await handle.writeFile(text) } finally { await handle.close() }
}

async function saveReceipt(file: string, receipt: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fsp.writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await fsp.rename(temp, file)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function signalCode(signal: Signal): number { return 128 + (osConstants.signals[signal] ?? 1) }
function positiveEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

function installSignalHandling(m: any): { signal: () => Signal | undefined; active: (value: boolean, baseline?: number[]) => void; wait: (ms: number) => Promise<void>; remove: () => void } {
  let pending: Signal | undefined
  let runningPhase = false
  let phaseBaseline = new Set<number>()
  let wake: (() => void) | undefined
  const forward = (signal: Signal) => {
    try {
      const pids = m.processTree.descendantPids(process.pid, m.processTree.readProcessSnapshot()).filter((pid: number) => !phaseBaseline.has(pid))
      for (const pid of [...pids].reverse()) {
        try { process.kill(pid, signal) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') errorEvent('signal_forward_failed', { pid, signal, error: String(e) }) }
      }
      event('signal_forwarded', { signal, ownedDescendantCount: pids.length })
    } catch (e) { errorEvent('signal_forward_snapshot_failed', { signal, error: String(e) }) }
  }
  const handlers = new Map<Signal, () => void>()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = () => {
      pending ??= signal
      event('rust_cache_experiment_interrupted', { signal: pending, activePhase: runningPhase })
      wake?.()
      if (runningPhase) forward(signal)
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  const wait = (ms: number) => new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (done) return; done = true; clearTimeout(timer); wake = undefined; resolve() }
    const timer = setTimeout(finish, ms)
    wake = finish
    if (pending) finish()
  })
  return {
    signal: () => pending,
    active: (value, baseline: number[] = []) => { runningPhase = value; phaseBaseline = value ? new Set(baseline) : new Set() },
    wait,
    remove: () => { for (const [signal, handler] of handlers) process.off(signal, handler) },
  }
}

async function acquireGate(endpoint: any, m: any, queuedAt: number, signals: ReturnType<typeof installSignalHandling>): Promise<any | undefined> {
  const pollMs = positiveEnv('FRESHELL_TEST_COORDINATOR_POLL_MS', DEFAULT_POLL_MS)
  const maxWaitMs = positiveEnv('FRESHELL_TEST_COORDINATOR_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS)
  while (!signals.signal()) {
    const attempt = await m.endpoint.tryListen(endpoint)
    if (attempt.kind === 'listening') return attempt
    const active = await m.endpoint.readActiveHolder(endpoint)
    event('coordinator_gate_waiting', {
      waitedMs: Date.now() - queuedAt,
      activeHolder: active === 'running-undescribed' ? active : active ? { summary: active.summary, command: active.command.display } : undefined,
    })
    if (Date.now() - queuedAt >= maxWaitMs) return undefined
    await signals.wait(pollMs)
  }
  return undefined
}

function aliveOwnedDescendants(m: any): number[] {
  const descendants: number[] = m.processTree.descendantPids(process.pid, m.processTree.readProcessSnapshot())
  return descendants.filter((pid) => {
    try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
  })
}

async function waitForOwnedChildren(m: any, baseline: readonly number[], timeoutMs?: number): Promise<void> {
  let lastNotice = 0
  const startedAt = Date.now()
  const baselinePids = new Set(baseline)
  while (true) {
    try {
      const alive = aliveOwnedDescendants(m).filter((pid) => !baselinePids.has(pid))
      if (!alive.length) return
      if (timeoutMs && Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${alive.length} phase-owned descendant(s) to exit.`)
      if (Date.now() - lastNotice >= 10_000) {
        event('waiting_for_owned_children_to_settle', { descendantCount: alive.length })
        lastNotice = Date.now()
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Timed out waiting for')) throw e
      if (Date.now() - lastNotice >= 10_000) {
        errorEvent('owned_child_snapshot_failed', { error: String(e) })
        lastNotice = Date.now()
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
  }
}

async function runPhase(label: 'cold' | 'warm', log: string, m: any, signals: ReturnType<typeof installSignalHandling>): Promise<any> {
  const phaseStartedAt = new Date().toISOString()
  let commandStartedAt: string | undefined
  let commandStart: number | undefined
  let commandFinishedAt: string | undefined
  let commandElapsedMs = 0
  let settleWaitMs = 0
  await fsp.appendFile(log, `${JSON.stringify({ severity: 'info', event: 'rust_cache_experiment_phase_started', label, startedAt: phaseStartedAt, command: 'FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust' })}\n`)
  let exitCode = signals.signal() ? signalCode(signals.signal()!) : 1
  let error: string | undefined
  if (!signals.signal()) {
    let baseline: number[] = []
    try {
      baseline = aliveOwnedDescendants(m)
      signals.active(true, baseline)
      commandStartedAt = new Date().toISOString()
      commandStart = performance.now()
      // Bash only sends stdout/stderr to the phase log; the child command and
      // sandbox environment are the same for both measurements.
      exitCode = await m.upstream.spawnAndWait(
        'bash', ['-c', 'set -e; exec >> "$1" 2>&1; exec pnpm run test:rust', 'rust-cache-experiment-run', log],
        { ...process.env, FRESHELL_RUST_TEST_SANDBOX: '1' }, false,
      )
      commandFinishedAt = new Date().toISOString()
      if (commandStart !== undefined) commandElapsedMs = performance.now() - commandStart
      const settleStartedAt = performance.now()
      await waitForOwnedChildren(m, baseline)
      settleWaitMs = performance.now() - settleStartedAt
    } catch (e) {
      if (!commandFinishedAt) {
        commandFinishedAt = new Date().toISOString()
        if (commandStart !== undefined) commandElapsedMs = performance.now() - commandStart
      }
      error = e instanceof Error ? e.message : String(e)
      exitCode = 1
    } finally { signals.active(false) }
  }
  const interruptedBy = signals.signal()
  if (interruptedBy) exitCode = signalCode(interruptedBy)
  const finishedAt = new Date().toISOString()
  const effectiveCommandStartedAt = commandStartedAt ?? phaseStartedAt
  commandFinishedAt ??= finishedAt
  const settleFinishedAt = finishedAt
  const outcome = interruptedBy ? 'interrupted' : exitCode === 0 ? 'success' : 'failure'
  const measurementNote = 'elapsedMs is the pnpm run test:rust child lifetime; settleWaitMs is orchestration cleanup after that command exits.'
  await fsp.appendFile(log, `${JSON.stringify({ severity: exitCode ? 'error' : 'info', event: 'rust_cache_experiment_phase_finished', label, commandStartedAt: effectiveCommandStartedAt, commandFinishedAt, elapsedMs: commandElapsedMs, commandElapsedMs, settleFinishedAt, settleWaitMs, measurementNote, exitCode, outcome, interruptedBy, error })}\n`)
  event('rust_cache_experiment_phase_finished', { label, commandStartedAt: effectiveCommandStartedAt, commandFinishedAt, elapsedMs: commandElapsedMs, commandElapsedMs, settleFinishedAt, settleWaitMs, measurementNote, exitCode, outcome, log })
  return {
    label, command: ['pnpm', 'run', 'test:rust'], sandboxEnv: { FRESHELL_RUST_TEST_SANDBOX: '1' }, logPath: log,
    startedAt: effectiveCommandStartedAt, finishedAt: commandFinishedAt, elapsedMs: commandElapsedMs, settleFinishedAt, settleWaitMs,
    exitCode, outcome, interruptedBy, error,
  }
}

async function runMeasuredSequence(options: {
  signals: ReturnType<typeof installSignalHandling>
  coldLog: string
  warmLog: string
  phases: any[]
  snapshots: any[]
  validateLaunch: (stage: string) => Promise<void>
  capture: (stage: string) => any
  phaseRunner: (label: 'cold' | 'warm', log: string) => Promise<any>
}): Promise<void> {
  const initial = options.capture('before-cold')
  options.snapshots.push(initial)
  assertEmptyTarget(initial)
  if (options.signals.signal()) return

  await options.validateLaunch('before-cold-launch')
  if (options.signals.signal()) return
  const cold = await options.phaseRunner('cold', options.coldLog)
  options.phases.push(cold)

  // Measure immediately after the cold command settles and before any warm
  // validation or child process can change the target.
  options.snapshots.push(options.capture('cold-finished-before-warm'))
  if (cold.exitCode !== 0 || options.signals.signal()) return

  await options.validateLaunch('before-warm-launch')
  if (options.signals.signal()) return
  const warm = await options.phaseRunner('warm', options.warmLog)
  options.phases.push(warm)
  options.snapshots.push(options.capture('after-warm'))
}

async function experiment(options: ReturnType<typeof parseArgs>, m: any): Promise<number> {
  if (process.platform !== 'linux') throw new Error('This harness only runs the WSL/Linux Rust sandbox.')
  const repo = await repoInfo(options.repo, m)
  const coldLog = artifactPath(options.coldLog!, repo.checkoutRoot)
  const warmLog = artifactPath(options.warmLog!, repo.checkoutRoot)
  const receiptPath = artifactPath(options.receipt!, repo.checkoutRoot)
  if (new Set([coldLog, warmLog, receiptPath]).size !== 3) throw new Error('Log and receipt paths must be distinct.')

  const runId = randomUUID()
  const queuedAt = new Date().toISOString()
  const queuedAtMs = Date.now()
  const start = performance.now()
  const endpoint = m.endpoint.buildCoordinatorEndpoint(repo.commonDir)
  const storeDir = m.store.getCoordinatorStoreDir(repo.commonDir)
  const targetHash = createHash('sha256').update(path.resolve(repo.checkoutRoot)).digest('hex').slice(0, 12)
  if (targetHash !== TARGET_HASH) throw new Error(`Pinned worktree target hash mismatch: expected ${TARGET_HASH}, derived ${targetHash}`)
  const cargoTargetDirectory = `/freshell-test-artifacts/targets/${targetHash}`
  const sourceChecks: any[] = [{ stage: 'before-queue', checkedAt: queuedAt, commit: repo.commit, clean: true }]
  await createFreshFile(coldLog, `${JSON.stringify({ event: 'log_created', experiment: EXPERIMENT, label: 'cold', commit: COMMIT, cargoTargetDirectory })}\n`)
  await createFreshFile(warmLog, `${JSON.stringify({ event: 'log_created', experiment: EXPERIMENT, label: 'warm', commit: COMMIT, cargoTargetDirectory })}\n`)
  await createFreshFile(receiptPath, `${JSON.stringify({ schemaVersion: 1, experiment: EXPERIMENT, status: 'starting', runId, commit: COMMIT, queuedAt })}\n`)

  const signals = installSignalHandling(m)
  const phases: any[] = []
  const cacheSnapshots: any[] = []
  const imageChecks: any[] = []
  const cleanupErrors: string[] = []
  let listener: any
  let acquiredAt: string | undefined
  const outcome: FinalOutcome = { status: 'incomplete', exitCode: 1 }
  let sourceError: string | undefined
  let finishedAt: string | undefined
  try {
    listener = await acquireGate(endpoint, m, queuedAtMs, signals)
    if (!listener) {
      if (signals.signal()) { outcome.status = 'interrupted'; outcome.exitCode = signalCode(signals.signal()!) }
      else { outcome.status = 'queue_timeout'; outcome.exitCode = 124 }
    } else if (signals.signal()) {
      outcome.status = 'interrupted'; outcome.exitCode = signalCode(signals.signal()!)
    } else {
      acquiredAt = new Date().toISOString()
      await m.store.writeHolder(storeDir, holder(repo, runId, acquiredAt))
      event('coordinator_gate_acquired', { runId, endpoint: endpoint.address, command: 'FRESHELL_RUST_TEST_SANDBOX=1 pnpm run test:rust (cold, warm)' })
      try {
        await revalidateAndRecordSource(repo, 'after-gate-before-cold', () => repoInfo(repo.checkoutRoot, m), sourceChecks)
      } catch (e) {
        sourceError = `Source revalidation after gate acquisition failed: ${e instanceof Error ? e.message : String(e)}`
        errorEvent('source_revalidation_failed', { runId, stage: 'after-gate-before-cold', error: sourceError })
      }
      if (!sourceError && !signals.signal()) {
        await runMeasuredSequence({
          signals, coldLog, warmLog, phases, snapshots: cacheSnapshots,
          validateLaunch: async (stage) => {
            try { await revalidateAndRecordSource(repo, stage, () => repoInfo(repo.checkoutRoot, m), sourceChecks) }
            catch (e) {
              sourceError = `Source revalidation at ${stage} failed: ${e instanceof Error ? e.message : String(e)}`
              errorEvent('source_revalidation_failed', { runId, stage, error: sourceError })
              throw new Error(sourceError)
            }
            imageChecks.push(inspectSandboxImage(stage))
          },
          capture: (stage) => captureTargetSnapshot(stage, repo),
          phaseRunner: (label, log) => runPhase(label, log, m, signals),
        })
      }
      if (signals.signal()) { outcome.status = 'interrupted'; outcome.exitCode = signalCode(signals.signal()!) }
      else if (sourceError) { markFailure(outcome, sourceError) }
      else if (phases.some((phase) => phase.exitCode !== 0)) {
        outcome.status = 'failure'
        outcome.exitCode = phases.find((phase) => phase.exitCode !== 0)?.exitCode ?? 1
      }
      else if (phases.length !== LABELS.length) { outcome.status = 'incomplete'; outcome.exitCode = 1 }
      else { outcome.status = 'success'; outcome.exitCode = 0 }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    errorEvent('rust_cache_experiment_failed', { runId, error: message })
    if (signals.signal()) { outcome.status = 'interrupted'; outcome.exitCode = signalCode(signals.signal()!) }
    else { markFailure(outcome, message) }
  } finally {
    finishedAt = new Date().toISOString()
    if (listener) {
      await cleanupGate(m, storeDir, runId, listener, (message) => {
        cleanupErrors.push(message)
        markFailure(outcome, message)
        errorEvent('coordinator_cleanup_failed', { runId, error: message })
      })
    }
    if (signals.signal() && outcome.exitCode === 0) {
      outcome.status = 'interrupted'
      outcome.exitCode = signalCode(signals.signal()!)
    }
    try {
      await m.store.recordCommandResult(storeDir, latest(repo, runId, acquiredAt ?? queuedAt, finishedAt, outcome.exitCode))
    } catch (e) {
      const message = `recordCommandResult: ${String(e)}`
      cleanupErrors.push(message)
      markFailure(outcome, message)
      errorEvent('coordinator_result_record_failed', { runId, error: message })
    }
    signals.remove()
  }

  const receipt = {
    schemaVersion: 1, experiment: EXPERIMENT, status: outcome.status, runId, commit: COMMIT, worktreePath: repo.checkoutRoot,
    coordinatorEndpoint: { kind: endpoint.kind, address: endpoint.address, commonDir: repo.commonDir },
    cargoTargetDirectory,
    command: { argv: ['pnpm', 'run', 'test:rust'], environment: { FRESHELL_RUST_TEST_SANDBOX: '1' } },
    queuedAt, acquiredAt, finishedAt, queueWaitMs: acquiredAt ? Date.parse(acquiredAt) - queuedAtMs : undefined,
    totalElapsedMs: performance.now() - start,
    measurementNote: 'Target allocated and apparent bytes are measured with du in the named Docker volume; the four composition paths and executable inventories are captured at before-cold, cold-finished-before-warm, and after-warm. Each phase elapsedMs is the pnpm run test:rust child lifetime and excludes post-exit process settlement; settleWaitMs is reported separately.',
    interruptedBy: signals.signal(), sourceChecks, imageChecks, cacheSnapshots, phases,
    exitCode: outcome.exitCode, error: outcome.error,
    cleanupErrors: cleanupErrors.length ? cleanupErrors : undefined,
  }
  try { await saveReceipt(receiptPath, receipt) }
  catch (e) {
    const message = `experiment receipt write failed: ${String(e)}`
    cleanupErrors.push(message)
    markFailure(outcome, message)
    receipt.status = outcome.status
    receipt.exitCode = outcome.exitCode
    receipt.error = outcome.error
    receipt.cleanupErrors = cleanupErrors
    errorEvent('experiment_receipt_write_failed', { receiptPath, error: message })
    try { await m.store.recordCommandResult(storeDir, latest(repo, runId, acquiredAt ?? queuedAt, finishedAt!, outcome.exitCode)) }
    catch (recordError) { errorEvent('coordinator_result_update_failed', { runId, error: String(recordError) }) }
  }
  event('rust_cache_experiment_finished', { status: outcome.status, exitCode: outcome.exitCode, phases: phases.map((p) => ({ label: p.label, elapsedMs: p.elapsedMs, exitCode: p.exitCode })), snapshotStages: cacheSnapshots.map((snapshot) => snapshot.stage), imageChecks: imageChecks.map((check) => ({ stage: check.stage, imageId: check.imageId })), receiptPath })
  return outcome.exitCode
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Self-check failed: ${message}`)
}

async function selfCheck(m: any): Promise<void> {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-rust-cache-gate-check-'))
  const commonDir = path.join(temp, 'temporary-common-dir')
  const endpoint = m.endpoint.buildCoordinatorEndpoint(commonDir, process.platform, [temp])
  const storeDir = m.store.getCoordinatorStoreDir(commonDir)
  const runId = randomUUID()
  let listener: any
  let orchestrationChild: any
  try {
    const imageCheck = assertSandboxImageId('self-check-expected-id', SANDBOX_IMAGE_ID)
    assert(imageCheck.imageId === SANDBOX_IMAGE_ID, 'sandbox image validation must accept the pinned ID')
    let wrongImageRejected = false
    try { assertSandboxImageId('self-check-wrong-id', 'sha256:wrong') } catch { wrongImageRejected = true }
    assert(wrongImageRejected, 'sandbox image validation must reject a different image ID')
    const first = await m.endpoint.tryListen(endpoint)
    assert(first.kind === 'listening', 'first listener should acquire the endpoint')
    listener = first
    const second = await m.endpoint.tryListen(endpoint)
    if (second.kind === 'listening') await second.close()
    assert(second.kind === 'busy', 'second listener should see the occupied endpoint')
    await m.store.writeHolder(storeDir, {
      schemaVersion: 1, runId, summary: 'isolated harness self-check', summarySource: 'fallback', startedAt: new Date().toISOString(),
      pid: process.pid, hostname: os.hostname(), username: process.env.USER,
      entrypoint: { commandKey: 'rust-cache-gate-self-check' }, command: { display: 'node -e process.exit(7)', argv: ['self-check'] },
      repo: { checkoutRoot: temp, repoRoot: temp, commonDir, worktreePath: temp },
      runtime: { nodeVersion: process.version, platform: process.platform, arch: process.arch }, agent: { kind: 'harness-self-check' },
    })
    const active = await m.endpoint.readActiveHolder(endpoint)
    assert(active && active !== 'running-undescribed' && active.runId === runId, 'schema-valid holder should be visible')

    const baseline = { commit: COMMIT, isDirty: false }
    const sourceChecks: any[] = []
    await revalidateAndRecordSource(baseline, 'after-gate-before-cold', async () => baseline, sourceChecks)
    assert(sourceChecks[0]?.stage === 'after-gate-before-cold' && sourceChecks[0]?.clean === true, 'post-acquisition source check should be recorded')
    let coldWouldStart = false
    try {
      await revalidateAndRecordSource(
        baseline,
        'after-gate-before-cold',
        async () => ({ commit: `${COMMIT.slice(0, -1)}0`, isDirty: false }),
        sourceChecks,
      )
      coldWouldStart = true
    } catch { /* changed source must abort the cold phase */ }
    assert(!coldWouldStart && sourceChecks.length === 1, 'source drift while queued must be rejected before the cold phase starts')
    for (const changed of [{ commit: COMMIT, isDirty: true }]) {
      let rejected = false
      try { await revalidateAndRecordSource(baseline, 'between-cold-and-warm', async () => changed, sourceChecks) } catch { rejected = true }
      assert(rejected && sourceChecks.length === 1, 'source revalidation must reject a dirty worktree without recording it as clean')
    }

    const dummyTarget = path.join(temp, 'dummy-cargo-target')
    await fsp.mkdir(dummyTarget)
    const dummySnapshots: any[] = []
    const dummyPhases: any[] = []
    const launchValidations: string[] = []
    const dummyWarmMarker = path.join(dummyTarget, 'debug', 'incremental', 'dummy', 'warm.marker')
    await runMeasuredSequence({
      signals: { signal: () => undefined } as any,
      coldLog: path.join(temp, 'dummy-cold.log'),
      warmLog: path.join(temp, 'dummy-warm.log'),
      phases: dummyPhases,
      snapshots: dummySnapshots,
      validateLaunch: async (stage) => {
        launchValidations.push(stage)
        if (stage === 'before-warm-launch') {
          const coldSnapshot = dummySnapshots[1]
          assert(coldSnapshot?.stage === 'cold-finished-before-warm', 'cold cache measurement must be recorded before warm validation')
          assert(coldSnapshot.apparentBytes > 0, 'cold snapshot must include files written by the cold phase')
          assert(!await fsp.stat(dummyWarmMarker).then(() => true, () => false), 'warm phase must not have changed the target before warm validation')
          assert(coldSnapshot.executables.server.count === 1, 'server executable inventory must include path and size after cold')
          assert(coldSnapshot.executables.sessionHost.count === 1, 'session-host executable inventory must include path and size after cold')
          assert(coldSnapshot.executables.integrationTests.count === 1, 'integration-test executable inventory must include path and size after cold')
          assert(coldSnapshot.composition['debug/deps'].apparentBytes > 0, 'cold snapshot must include debug/deps composition')
        }
      },
      capture: (stage) => ({ stage, measuredAt: new Date().toISOString(), ...measureTargetDirectory(dummyTarget) }),
      phaseRunner: async (label) => {
        if (label === 'cold') {
          const deps = path.join(dummyTarget, 'debug', 'deps')
          const fingerprint = path.join(dummyTarget, 'debug', '.fingerprint', 'dummy-0123456789abcdef')
          await fsp.mkdir(deps, { recursive: true })
          await fsp.mkdir(fingerprint, { recursive: true })
          const fakeBinaries = [
            [path.join(deps, 'freshell_server-0123456789abcdef'), 'server'],
            [path.join(deps, 'freshell-session-host-0123456789abcdef'), 'session-host'],
            [path.join(deps, 'demo-integration-0123456789abcdef'), 'integration-test'],
          ]
          for (const [file, contents] of fakeBinaries) {
            await fsp.writeFile(file, contents, { mode: 0o755 })
            await fsp.chmod(file, 0o755)
          }
          await fsp.writeFile(path.join(fingerprint, 'test-integration-test-demo-integration.json'), '{}')
        } else {
          await fsp.mkdir(path.dirname(dummyWarmMarker), { recursive: true })
          await fsp.writeFile(dummyWarmMarker, 'warm cache mutation')
        }
        return { label, exitCode: 0 }
      },
    })
    assert(dummySnapshots.map((snapshot) => snapshot.stage).join(',') === 'before-cold,cold-finished-before-warm,after-warm', 'target snapshots must bracket cold and warm in order')
    assert(launchValidations.join(',') === 'before-cold-launch,before-warm-launch', 'source/image validation must run immediately before each phase')
    assert(dummySnapshots[0].hasPayload === false && dummySnapshots[0].apparentBytes === 0, 'initial target snapshot must report the empty target')
    assert(dummySnapshots[2].apparentBytes > dummySnapshots[1].apparentBytes, 'final warm snapshot must include the warm phase mutation')
    assert(dummySnapshots[2].composition['debug/incremental'].apparentBytes > 0, 'final snapshot must capture incremental composition')

    orchestrationChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await once(orchestrationChild, 'spawn')
    const phaseBaseline = aliveOwnedDescendants(m)
    assert(phaseBaseline.includes(orchestrationChild.pid), 'persistent orchestration child should be present in the baseline')
    const childCode = await m.upstream.spawnAndWait(process.execPath, ['-e', 'process.exit(7)'], process.env, false)
    assert(childCode === 7, `failing dummy child should return 7; got ${childCode}`)
    await waitForOwnedChildren(m, phaseBaseline, 5_000)
    assert(orchestrationChild.exitCode === null && orchestrationChild.signalCode === null, 'phase settlement must leave the pre-existing orchestration child alive')
    orchestrationChild.kill('SIGTERM')
    await once(orchestrationChild, 'exit')
    orchestrationChild = undefined

    const tempRepo = { invocationCwd: temp, checkoutRoot: temp, repoRoot: temp, commonDir, branch: 'self-check', commit: COMMIT, isDirty: false }
    const cleanupOutcome: FinalOutcome = { status: 'success', exitCode: 0 }
    const cleanupFailures: string[] = []
    await cleanupGate(
      { store: { clearHolderIfRunIdMatches: async () => { throw new Error('injected clear failure') } } },
      storeDir,
      randomUUID(),
      { close: async () => undefined },
      (message) => { cleanupFailures.push(message); markFailure(cleanupOutcome, message) },
    )
    assert(cleanupFailures.length === 1 && cleanupOutcome.status === 'failure' && cleanupOutcome.exitCode === 1, 'cleanup failure must turn a success into failure')
    const resultRunId = randomUUID()
    const now = new Date().toISOString()
    await m.store.recordCommandResult(storeDir, latest(tempRepo, resultRunId, now, now, cleanupOutcome.exitCode))
    const recorded = (await m.store.readCommandRuns(storeDir)).byKey[`${EXPERIMENT}-${resultRunId.slice(0, 8)}`]
    assert(recorded?.outcome === 'failure' && recorded.exitCode === 1, 'coordinator latest result must record the post-cleanup failure')

    const receiptOutcome: FinalOutcome = { status: 'success', exitCode: 0 }
    const blockedReceipt = path.join(temp, 'receipt-is-a-directory')
    await fsp.mkdir(blockedReceipt)
    let receiptRejected = false
    try { await saveReceipt(blockedReceipt, { status: 'success' }) }
    catch (e) { receiptRejected = true; markFailure(receiptOutcome, String(e)) }
    assert(receiptRejected && receiptOutcome.status === 'failure' && receiptOutcome.exitCode === 1, 'receipt write failure must turn a success into failure')

    await m.store.clearHolderIfRunIdMatches(storeDir, runId)
    await listener.close()
    listener = undefined
    const available = await m.endpoint.tryListen(endpoint)
    assert(available.kind === 'listening', 'endpoint should be reacquirable after release')
    await available.close()
    assert(await m.endpoint.readActiveHolder(endpoint) === undefined, 'matching holder should be cleared')
    event('rust_cache_gate_harness_self_check_passed', { result: 'exclusive acquisition, holder cleanup, failing child exit, persistent orchestration descendant exclusion, source/image pin validation, source revalidation, ordered target snapshots with executable/composition inventory, cleanup/receipt failure outcomes' })
  } finally {
    if (orchestrationChild && orchestrationChild.exitCode === null && orchestrationChild.signalCode === null) {
      const exited = once(orchestrationChild, 'exit')
      orchestrationChild.kill('SIGTERM')
      await exited
    }
    if (listener) {
      await m.store.clearHolderIfRunIdMatches(storeDir, runId).catch(() => undefined)
      await listener.close().catch(() => undefined)
    }
    await fsp.rm(temp, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseArgs>
  try { options = parseArgs(process.argv.slice(2)) }
  catch (e) { errorEvent('usage_or_argument_error', { error: e instanceof Error ? e.message : String(e) }); process.exitCode = 2; return }
  const m = await loadModules(options.repo)
  if (options.selfCheck) return selfCheck(m)
  process.chdir(options.repo)
  process.exitCode = await experiment(options, m)
}

main().catch((e: unknown) => {
  errorEvent('rust_cache_gate_harness_failed', { error: e instanceof Error ? e.message : String(e) })
  process.exitCode = 1
})
