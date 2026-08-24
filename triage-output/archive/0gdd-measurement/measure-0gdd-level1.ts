import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type Controls = { sweep: boolean; autoTitle: boolean; refresh: 'normal' | '10s' | 'warm-only'; cacheWrites: boolean; get?: boolean }
export type Fingerprint = { pid: number; startTime: string; executable: string; cwd: string; inode: string }
export type Condition = Controls & { name: string }
export type Summary = { name: string; cpu: number; elapsed: number; samples: number; requests: number; cache_saves: number; freshness_delays?: number[] }
export type ListenerIdentity = { address: string; port: number; pid: number; inode: string }
export type ProductionState = { process: Fingerprint; listener: ListenerIdentity }
export type StopOutcome = { kind: 'graceful' | 'already-exited' | 'forced' }
export type ActiveRun = { child: ChildProcess; fp: Fingerprint; port: number; descriptor: number; dir: string; listener: ListenerIdentity | null; termTimeoutMs?: number }
export type HttpSafetyCounters = { listenerVerifications: number; authenticatedRequests: number; authenticatedRequestsBeforeVerification: number }
export type FreshnessFailure = { status: 'inconclusive'; mode: Controls['refresh']; fixture_ordinal: number; old_count: number; last_count: number; elapsed_ms: number }
const WORKTREE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RELEASE_BINARY = path.join(WORKTREE, 'target/release/freshell-server')
const normal: Controls = { sweep: true, autoTitle: true, refresh: 'normal', cacheWrites: true, get: true }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function parseProcStat(raw: string) {
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
  return { ticks: Number(fields[11]) + Number(fields[12]), startTime: fields[19] }
}
function numericFields(raw: string) {
  return Object.fromEntries(raw.trim().split('\n').map((line) => { const [key, value] = line.split(':'); return [key, Number(value.trim().split(/\s+/)[0])] }))
}
export function parseProcStatus(raw: string) { const value = numericFields(raw); return { rssKb: value.VmRSS, hwmKb: value.VmHWM, threads: value.Threads } }
export function parseProcIo(raw: string) { const value = numericFields(raw); return { readBytes: value.read_bytes, writeBytes: value.write_bytes, syscr: value.syscr, syscw: value.syscw } }
export function cpuPercent(first: number, last: number, hz: number, seconds: number) { return (100 * (last - first)) / hz / seconds }
export function assertSafePort(port: number) { if (port === 3001 || port < 1 || port > 65535) throw new Error(`unsafe scratch port ${port}`) }
export function requireFingerprint(expected: Fingerprint, actual: Fingerprint) {
  for (const key of ['pid', 'startTime', 'executable', 'cwd', 'inode'] as const) if (expected[key] !== actual[key]) throw new Error(`process fingerprint changed: ${key}`)
}

const CHILD_KEYS = ['PATH', 'HOME', 'CLAUDE_HOME', 'CODEX_HOME', 'FRESHELL_AMPLIFIER_HOME', 'XDG_DATA_HOME', 'LANG', 'LC_ALL', 'TZ'] as const
export function buildEnvironment(base: NodeJS.ProcessEnv, root: string, port: number, token: string, controls: Controls): NodeJS.ProcessEnv {
  assertSafePort(port)
  const env: NodeJS.ProcessEnv = {}
  for (const key of CHILD_KEYS) if (base[key]) env[key] = base[key]
  return {
    ...env,
    PORT: String(port), AUTH_TOKEN: token, FRESHELL_HOME: root,
    FRESHELL_LOG_DIR: path.join(root, 'logs'), FRESHELL_BIND_HOST: '127.0.0.1',
    FRESHELL_LOG_MAX_BYTES: '1073741824', FRESHELL_LOG_MAX_BACKUPS: '0',
    FRESHELL_0GDD_LEVEL1: '1', FRESHELL_0GDD_SESSION_SWEEP: controls.sweep ? 'on' : 'off',
    FRESHELL_0GDD_AUTO_TITLE_SWEEP: controls.autoTitle ? 'on' : 'off',
    FRESHELL_0GDD_REFRESH_MODE: controls.refresh,
    FRESHELL_0GDD_CACHE_WRITES: controls.cacheWrites ? 'on' : 'off',
  }
}

const schemas: Record<string, { required: string[]; allowed: string[] }> = {
  '0gdd.index_refresh_started': { required: ['refresh_id'], allowed: ['refresh_id'] },
  '0gdd.index_source': { required: ['refresh_id', 'provider', 'duration_ms', 'discovered', 'parsed', 'rows', 'scan_failed'], allowed: ['refresh_id', 'provider', 'duration_ms', 'discovered', 'parsed', 'rows', 'scan_failed'] },
  '0gdd.index_refresh_finished': { required: ['refresh_id', 'duration_ms', 'source_duration_ms', 'rebuild_duration_ms', 'sort_duration_ms', 'discovered', 'parsed', 'rows', 'changed', 'scan_failure_count', 'loaded_cache_entries'], allowed: ['refresh_id', 'duration_ms', 'source_duration_ms', 'rebuild_duration_ms', 'sort_duration_ms', 'discovered', 'parsed', 'rows', 'changed', 'scan_failure_count', 'loaded_cache_entries'] },
  '0gdd.cache_save_started': { required: ['save_id', 'entries'], allowed: ['save_id', 'entries'] },
  '0gdd.cache_save_finished': { required: ['save_id', 'duration_ms', 'bytes', 'ok'], allowed: ['save_id', 'duration_ms', 'bytes', 'ok'] },
  '0gdd.sessions_sweep': { required: ['duration_ms', 'rows', 'identity_count', 'changed'], allowed: ['duration_ms', 'rows', 'identity_count', 'changed'] },
  '0gdd.auto_title_sweep': { required: ['duration_ms', 'rows', 'identity_count'], allowed: ['duration_ms', 'rows', 'identity_count'] },
}
export function reduceEvent(raw: Record<string, unknown>) {
  const schema = schemas[String(raw.event)]
  if (!schema) return null
  for (const key of schema.required) if (raw[key] === undefined) throw new Error(`${raw.event} missing ${key}`)
  return Object.fromEntries([['event', raw.event], ...schema.allowed.map((key) => [key, raw[key]])])
}
export function validateEvidence(value: unknown, token: string) {
  const forbidden = new Set(['cwd', 'source_file', 'title', 'message', 'token', 'headers', 'body', 'error', 'session_id', 'cache_path', 'auth_token'])
  const absolutePath = /(?:^|[\s"'(=:])\/(?:[^/\s]+\/)*[^/\s]+/
  const walk = (item: unknown, key = ''): void => {
    if (forbidden.has(key.toLowerCase())) throw new Error(`forbidden evidence field ${key}`)
    if (typeof item === 'string' && ((token && item.includes(token)) || path.isAbsolute(item) || absolutePath.test(item))) throw new Error('private string in evidence')
    if (Array.isArray(item)) item.forEach((entry) => walk(entry))
    else if (item && typeof item === 'object') Object.entries(item).forEach(([nestedKey, entry]) => walk(entry, nestedKey))
  }
  walk(value)
}

export class JsonlTail {
  private partial = Buffer.alloc(0)
  offset = 0
  readOffset = 0
  push(chunk: Buffer): Record<string, unknown>[] {
    this.readOffset += chunk.length
    const combined = Buffer.concat([this.partial, chunk])
    const finalNewline = combined.lastIndexOf(0x0a)
    if (finalNewline < 0) { this.partial = combined; return [] }
    const complete = combined.subarray(0, finalNewline + 1)
    this.partial = combined.subarray(finalNewline + 1)
    this.offset += complete.length
    return complete.toString('utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) as Record<string, unknown> } catch { throw new Error('invalid JSONL record') }
    })
  }
}

export class BoundaryTracker {
  private refresh = new Set<number>()
  private save = new Set<number>()
  private cleanAt: number | null = 0
  observe(event: Record<string, unknown>, at = performance.now()) {
    const transition = (set: Set<number>, id: number, start: boolean, name: string) => {
      if (!Number.isSafeInteger(id)) throw new Error(`${name} invalid id`)
      if (start) {
        if (set.has(id)) throw new Error(`${name} duplicate start ${id}`)
        set.add(id); this.cleanAt = null
      } else {
        if (!set.delete(id)) throw new Error(`${name} unmatched finish ${id}`)
      }
    }
    if (event.event === '0gdd.index_refresh_started') transition(this.refresh, Number(event.refresh_id), true, 'refresh')
    if (event.event === '0gdd.index_refresh_finished') transition(this.refresh, Number(event.refresh_id), false, 'refresh')
    if (event.event === '0gdd.cache_save_started') transition(this.save, Number(event.save_id), true, 'save')
    if (event.event === '0gdd.cache_save_finished') transition(this.save, Number(event.save_id), false, 'save')
    if (this.refresh.size === 0 && this.save.size === 0 && this.cleanAt === null) this.cleanAt = at
  }
  get clean() { return this.refresh.size === 0 && this.save.size === 0 }
  stablyClean(now: number, intervalMs: number) { return this.clean && this.cleanAt !== null && now - this.cleanAt >= intervalMs }
}

export function buildStageA(): Condition[] {
  return [{ name: 'normal-1', ...normal }, { name: 'quiet', sweep: false, autoTitle: false, refresh: 'warm-only', cacheWrites: false, get: false }, { name: 'normal-2', ...normal }]
}
export function isStable(first: number, second: number) { return Math.abs(first - second) <= Math.max(5, 0.15 * ((first + second) / 2)) }
export function isMaterial(first: number, quiet: number, second: number) { const mean = (first + second) / 2; return Math.min(first - quiet, second - quiet) >= 5 && mean - quiet >= 0.1 * mean }
export function cacheSeenInBracket(first: Pick<Summary, 'cache_saves'>, second: Pick<Summary, 'cache_saves'>) { return first.cache_saves > 0 || second.cache_saves > 0 }
export function buildVariants(material: boolean, cacheSeen: boolean, refreshMaterial: boolean): Condition[] {
  if (!material) return []
  const names: Array<[string, Partial<Controls>]> = [['normal-1', {}], ['warm-only', { refresh: 'warm-only' }], ['normal-2', {}], ['auto-title-off', { autoTitle: false }], ['normal-3', {}], ['session-sweep-off', { sweep: false }], ['normal-4', {}], ['get-off', { get: false }], ['normal-5', {}]]
  if (cacheSeen) names.push(['cache-normal-1', {}], ['cache-writes-off', { cacheWrites: false }], ['cache-normal-2', {}])
  if (refreshMaterial) names.push(['refresh-normal-1', {}], ['refresh-10s', { refresh: '10s' }], ['refresh-normal-2', {}], ['freshness', {}])
  return names.map(([name, delta]) => ({ name, ...normal, ...delta }))
}

/** Freshness fixtures are single-user-message Claude sessions, which the directory classifies as
 * non-interactive and hides unless the caller opts in, so every freshness probe must ask for them. */
export function freshnessRoute(limit = 50) {
  return `/api/session-directory?priority=visible&limit=${limit}&includeNonInteractive=1`
}
/** Retains only fixed, non-private diagnostics; anything else in `diagnostics` is deliberately dropped. */
export function freshnessFailure(diagnostics: { mode: Controls['refresh']; fixtureOrdinal: number; oldCount: number; lastCount: number; elapsedMs: number }): FreshnessFailure {
  return {
    status: 'inconclusive',
    mode: diagnostics.mode,
    fixture_ordinal: Math.trunc(diagnostics.fixtureOrdinal),
    old_count: Math.trunc(diagnostics.oldCount),
    last_count: Math.trunc(diagnostics.lastCount),
    elapsed_ms: Math.round(diagnostics.elapsedMs),
  }
}
/** The message repeats only the fixed, already-sanitized failure fields, so an operator reading stderr
 * learns which probe timed out without the error ever becoming a second, unvalidated evidence channel. */
export class FreshnessTimeoutError extends Error {
  constructor(readonly failure: FreshnessFailure) {
    super(`freshness timeout: mode=${failure.mode} fixture_ordinal=${failure.fixture_ordinal} old_count=${failure.old_count} last_count=${failure.last_count} elapsed_ms=${failure.elapsed_ms}`)
    this.name = 'FreshnessTimeoutError'
  }
}
export function withFreshnessCheckpoint(checkpoint: () => Promise<unknown>, runFreshness: (condition: Condition) => Promise<Summary>) {
  let checkpointed: Promise<unknown> | null = null
  return async (condition: Condition) => {
    checkpointed ??= checkpoint()
    await checkpointed
    return await runFreshness(condition)
  }
}

export async function runOrchestration(
  run: (condition: Condition) => Promise<Summary>,
  runFreshness: (condition: Condition) => Promise<Summary>,
  onFreshnessInconclusive?: (failure: FreshnessFailure) => void,
) {
  const runAll = async (conditions: Condition[]) => {
    const results: Summary[] = []
    for (const condition of conditions) results.push(await run(condition))
    return results
  }
  let stage = await runAll(buildStageA())
  if (!isStable(stage[0].cpu, stage[2].cpu)) {
    stage = await runAll(buildStageA())
    if (!isStable(stage[0].cpu, stage[2].cpu)) throw new Error('inconclusive unstable bracket')
  }
  const results = [...stage]
  if (!isMaterial(stage[0].cpu, stage[1].cpu, stage[2].cpu)) return results
  const base = await runAll(buildVariants(true, false, false))
  results.push(...base)
  const refreshCostly = isStable(base[0].cpu, base[2].cpu) && isMaterial(base[0].cpu, base[1].cpu, base[2].cpu)
  if (cacheSeenInBracket(stage[0], stage[2])) results.push(...await runAll(buildVariants(true, true, false).slice(-3)))
  if (!refreshCostly) return results
  const refresh = await runAll(buildVariants(true, false, true).slice(-4, -1))
  results.push(...refresh)
  if (isStable(refresh[0].cpu, refresh[2].cpu) && isMaterial(refresh[0].cpu, refresh[1].cpu, refresh[2].cpu)) {
    for (const mode of ['normal', '10s'] as const) {
      try {
        results.push(await runFreshness({ name: `freshness-${mode}`, ...normal, refresh: mode, autoTitle: false, cacheWrites: false, get: false }))
      } catch (error) {
        // Freshness is the optional last stage: an observation timeout is inconclusive, not fatal,
        // and the already-collected CPU comparisons still stand. Anything else is a real failure.
        if (!(error instanceof FreshnessTimeoutError)) throw error
        onFreshnessInconclusive?.(error.failure)
        break
      }
    }
  }
  return results
}

export function validateRun(summary: Pick<Summary, 'name' | 'elapsed' | 'samples' | 'requests'>, seconds: number, getEnabled: boolean) {
  if (seconds < 145) return
  if (
    summary.elapsed < 145 || summary.elapsed > 180
    || summary.samples < 145 || summary.samples > 151
    || (getEnabled ? summary.requests < 73 || summary.requests > 76 : summary.requests !== 0)
  ) throw new Error(`invalid run ${summary.name}`)
}

export async function runMeasurementSchedules(options: { durationMs: number; sample: (scheduledAt: number) => Promise<void>; get?: (scheduledAt: number) => Promise<void>; now?: () => number }) {
  const now = options.now ?? (() => performance.now())
  const started = now(); const end = started + options.durationMs
  const periodic = async (interval: number, task: (scheduledAt: number) => Promise<void>) => {
    let due = started
    while (due < end) {
      const wait = due - now()
      if (wait > 0) await delay(wait)
      if (now() >= end) break
      await task(Math.round(due - started))
      do { due += interval } while (due <= now())
    }
  }
  await Promise.all([periodic(1000, options.sample), ...(options.get ? [periodic(2000, options.get)] : [])])
  const remaining = end - now()
  if (remaining > 0) await delay(remaining)
}

function fingerprint(pid: number): Fingerprint {
  const stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  const executable = fs.realpathSync(`/proc/${pid}/exe`); const inode = fs.statSync(executable)
  return { pid, startTime: stat.startTime, executable, cwd: fs.realpathSync(`/proc/${pid}/cwd`), inode: `${inode.dev}:${inode.ino}` }
}
export function parseProcListeners(raw: string) {
  return raw.split('\n').slice(1).filter(Boolean).flatMap((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields[3] !== '0A') return []
    const [hexAddress, hexPort] = fields[1].split(':')
    if (hexAddress.length !== 8) return []
    const address = (hexAddress.match(/../g) ?? []).reverse().map((byte) => Number.parseInt(byte, 16)).join('.')
    return [{ address, port: Number.parseInt(hexPort, 16), inode: fields[9] }]
  })
}
function listenerIdentities(port: number, pid: number): ListenerIdentity[] {
  const owned = new Set<string>()
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        const match = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)
        if (match) owned.add(match[1])
      } catch {}
    }
  } catch {}
  const ipv4 = parseProcListeners(fs.readFileSync('/proc/net/tcp', 'utf8'))
  const ipv6 = fs.readFileSync('/proc/net/tcp6', 'utf8').split('\n').slice(1).filter(Boolean).flatMap((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields[3] !== '0A') return []
    const [, hexPort] = fields[1].split(':')
    return [{ address: 'ipv6', port: Number.parseInt(hexPort, 16), inode: fields[9] }]
  })
  return [...ipv4, ...ipv6]
    .filter((listener) => listener.port === port)
    .map((listener) => ({ ...listener, pid: owned.has(listener.inode) ? pid : -1 }))
}
export function assertScratchListener(listeners: ListenerIdentity[], port: number, pid: number) {
  if (listeners.length === 0) throw new Error('scratch listener missing')
  if (listeners.length !== 1) throw new Error('expected exactly one scratch listener')
  const listener = listeners[0]
  if (listener.address !== '127.0.0.1' || listener.port !== port) throw new Error('scratch listener is not loopback-only')
  if (listener.pid !== pid) throw new Error('scratch listener ownership mismatch')
  return listener
}
export function requireProductionState(expected: ProductionState, actual: ProductionState) {
  requireFingerprint(expected.process, actual.process)
  for (const key of ['address', 'port', 'pid', 'inode'] as const) {
    if (expected.listener[key] !== actual.listener[key]) throw new Error(`production listener changed: ${key}`)
  }
}
function production(): ProductionState {
  const pid = Number(fs.readFileSync(path.join(os.homedir(), '.freshell/rust-server-3001.pid'), 'utf8').trim())
  const process = fingerprint(pid)
  const listeners = listenerIdentities(3001, pid)
  if (listeners.length !== 1) throw new Error('expected exactly one production listener')
  if (listeners[0].pid !== pid || listeners[0].port !== 3001) throw new Error('production listener ownership mismatch')
  return { process, listener: listeners[0] }
}
export function assertFreshRelease(binary: string, sources: string[]) {
  const binaryMtime = fs.statSync(binary).mtimeMs
  const stale = sources.find((source) => fs.statSync(source).mtimeMs > binaryMtime)
  if (stale) throw new Error('release binary is stale relative to source')
}
export function assertServerInfo(info: Record<string, unknown>, commit: string, dirty: boolean) {
  if (info.runtime !== 'rust') throw new Error('server-info runtime mismatch')
  if (info.commit !== commit) throw new Error('server-info commit mismatch')
  if (info.buildDirty !== dirty) throw new Error('server-info dirty provenance mismatch')
}
async function freePort() {
  return await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : 0)) }) })
}
export class AuthenticatedClient {
  private verified = false
  constructor(private readonly port: number, private readonly token: string, private readonly counters: HttpSafetyCounters) {}
  verifyListener(_listener: ListenerIdentity) {
    if (this.verified) throw new Error('scratch listener already verified')
    this.verified = true
    this.counters.listenerVerifications++
  }
  private async request<T>(route: string, timeoutMs: number, read: (response: Response) => Promise<T>) {
    this.counters.authenticatedRequests++
    if (!this.verified) {
      this.counters.authenticatedRequestsBeforeVerification++
      throw new Error('authenticated request before listener verification')
    }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${route}`, {
        headers: { 'x-auth-token': this.token },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) throw new Error(`scratch HTTP redirect ${response.status}`)
      if (!response.ok) throw new Error(`scratch HTTP ${response.status}`)
      return await read(response)
    } finally { clearTimeout(timeout) }
  }
  json(route: string, timeoutMs = 5000) { return this.request(route, timeoutMs, async (response) => await response.json()) }
  bytes(route: string, timeoutMs = 5000) { return this.request(route, timeoutMs, async (response) => new Uint8Array(await response.arrayBuffer())) }
}
export async function copyRegularPrivate(source: string, destination: string) {
  const initial = await fsp.lstat(source)
  if (initial.isSymbolicLink()) throw new Error('production cache is a symlink')
  const input = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = await input.stat()
    if (!stat.isFile() || stat.size === 0) throw new Error('production cache absent, empty, or not regular')
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await fsp.chmod(path.dirname(destination), 0o700)
    const output = await fsp.open(destination, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    try {
      const buffer = Buffer.alloc(1024 * 1024)
      let position = 0
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        await output.write(buffer, 0, bytesRead, position)
        position += bytesRead
      }
    } finally { await output.close() }
    await fsp.chmod(destination, 0o600)
  } finally { await input.close() }
}

/** Copies already-sanitized evidence out of the disposable raw root into the final private output.
 * `copied` makes repeated checkpoints idempotent; returns the relative paths copied by this call. */
export async function checkpointOutput(source: string, destination: string, copied = new Set<string>()) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 }); await fsp.chmod(destination, 0o700)
  const added: string[] = []
  const visit = async (relative: string) => {
    const entries = await fsp.readdir(path.join(source, relative), { withFileTypes: true })
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      const key = path.join(relative, entry.name)
      if (entry.isSymbolicLink()) throw new Error('symlink in scratch output')
      if (entry.isDirectory()) {
        await fsp.mkdir(path.join(destination, key), { recursive: true, mode: 0o700 }); await fsp.chmod(path.join(destination, key), 0o700)
        await visit(key); continue
      }
      if (copied.has(key)) continue
      await copyRegularPrivate(path.join(source, key), path.join(destination, key))
      copied.add(key); added.push(key)
    }
  }
  if (fs.existsSync(source)) await visit('')
  return added
}

/** Decides the fate of the external final output on every non-success exit, including a signal.
 * It looks only at the already-sanitized output tree — never at raw state, which is removed
 * unconditionally by `CleanupOwner.cleanup`. An output with no checkpointed file is pure residue and
 * is removed; one with evidence is kept and must still be private. Returns whether it was retained. */
export async function finalizeOutput(output: string): Promise<boolean> {
  if (!fs.existsSync(output)) return false
  const countFiles = async (dir: string): Promise<number> => {
    let files = 0
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) files += await countFiles(path.join(dir, entry.name))
      else if (entry.isFile()) files++
    }
    return files
  }
  if (await countFiles(output) === 0) { await fsp.rm(output, { recursive: true, force: true }); return false }
  await assertPrivateTree(output)
  return true
}

type ReadHandle = {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}
export class EventReader {
  private tails = new Map<string, JsonlTail>()
  constructor(
    private readonly logDir: string,
    private readonly openFile: (file: string) => Promise<ReadHandle> = async (file) => await fsp.open(file, 'r'),
  ) {}
  async read() {
    const records: Record<string, unknown>[] = []
    const files = fs.existsSync(this.logDir) ? (await fsp.readdir(this.logDir)).filter((file) => file.endsWith('.jsonl')).sort() : []
    for (const file of files) {
      const full = path.join(this.logDir, file); const tail = this.tails.get(full) ?? new JsonlTail(); this.tails.set(full, tail)
      const stat = await fsp.stat(full)
      if (stat.size < tail.readOffset) throw new Error('diagnostic log truncated during run')
      if (stat.size === tail.readOffset) continue
      const handle = await this.openFile(full)
      try {
        const requested = stat.size - tail.readOffset
        const chunk = Buffer.alloc(requested)
        let bytesRead = 0
        while (bytesRead < requested) {
          const result = await handle.read(chunk, bytesRead, requested - bytesRead, tail.readOffset + bytesRead)
          if (result.bytesRead === 0) break
          bytesRead += result.bytesRead
        }
        if (bytesRead > 0) records.push(...tail.push(chunk.subarray(0, bytesRead)))
      } finally { await handle.close() }
    }
    return records
  }
}

function fingerprintIfPresent(pid: number) {
  try { return fingerprint(pid) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function requireScratchGone(active: ActiveRun) {
  if (fingerprintIfPresent(active.fp.pid)) throw new Error('scratch PID survived cleanup')
  const listeners = listenerIdentities(active.port, active.fp.pid)
  const owned = active.listener
    ? listeners.some((listener) => listener.inode === active.listener?.inode)
    : listeners.some((listener) => listener.pid === active.fp.pid)
  if (owned) throw new Error('scratch owned listener survived cleanup')
}
async function waitForScratchGone(active: ActiveRun, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try { requireScratchGone(active); return true } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('survived cleanup')) throw error
    }
    await delay(25)
  }
  return false
}
async function waitForProcessGone(pid: number, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (!fingerprintIfPresent(pid)) return true
    await delay(25)
  }
  return !fingerprintIfPresent(pid)
}
export async function stopExact(active: ActiveRun): Promise<StopOutcome> {
  const current = fingerprintIfPresent(active.fp.pid)
  if (!current) {
    if (!await waitForScratchGone(active, 5_000)) requireScratchGone(active)
    return { kind: 'already-exited' }
  }
  requireFingerprint(active.fp, current)
  try { process.kill(active.fp.pid, 'SIGTERM') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  if (await waitForProcessGone(active.fp.pid, active.termTimeoutMs ?? 15_000)) {
    if (!await waitForScratchGone(active, 5_000)) requireScratchGone(active)
    return { kind: 'graceful' }
  }
  const beforeKill = fingerprintIfPresent(active.fp.pid)
  if (!beforeKill) { requireScratchGone(active); return { kind: 'graceful' } }
  requireFingerprint(active.fp, beforeKill)
  process.kill(active.fp.pid, 'SIGKILL')
  if (!await waitForProcessGone(active.fp.pid, 5_000)) throw new Error('scratch PID survived SIGKILL')
  if (!await waitForScratchGone(active, 5_000)) requireScratchGone(active)
  return { kind: 'forced' }
}

export class CleanupOwner {
  active: ActiveRun | null = null
  private cleanupPromise: Promise<void> | null = null
  productionChecks = 0
  scratchStops = 0
  alreadyExited = 0
  forcedKills = 0
  invalidRuns = 0
  privateTreeChecks = 0
  cacheSourceChecks = 0
  readonly httpSafety: HttpSafetyCounters = { listenerVerifications: 0, authenticatedRequests: 0, authenticatedRequestsBeforeVerification: 0 }
  private readonly readProduction: () => ProductionState
  private readonly stopActive: (active: ActiveRun) => Promise<StopOutcome>
  constructor(
    readonly root: string,
    readonly seed: string | null,
    readonly prod: ProductionState | null,
    options: { readProduction?: () => ProductionState; stopActive?: (active: ActiveRun) => Promise<StopOutcome> } = {},
  ) {
    this.readProduction = options.readProduction ?? production
    this.stopActive = options.stopActive ?? stopExact
  }
  verifyProduction() { if (this.prod) { requireProductionState(this.prod, this.readProduction()); this.productionChecks++ } }
  private recordStop(outcome: StopOutcome) {
    this.scratchStops++
    if (outcome.kind === 'already-exited') { this.alreadyExited++; this.invalidRuns++ }
    if (outcome.kind === 'forced') { this.forcedKills++; this.invalidRuns++ }
  }
  private async releaseActive(errors: unknown[], invalidate: boolean) {
    if (!this.active) return
    const current = this.active
    let outcome: StopOutcome
    try { outcome = await this.stopActive(current); this.recordStop(outcome) } catch (error) { errors.push(error); return }
    try { fs.closeSync(current.descriptor) } catch (error) { errors.push(error) }
    this.active = null
    try { await assertPrivateTree(current.dir); this.privateTreeChecks++ } catch (error) { errors.push(error) }
    try { await fsp.rm(current.dir, { recursive: true }); if (fs.existsSync(current.dir)) throw new Error('run directory survived cleanup') } catch (error) { errors.push(error) }
    if (invalidate && outcome.kind !== 'graceful') errors.push(new Error(`scratch run invalid: ${outcome.kind}`))
  }
  async finishRun() {
    if (!this.active) throw new Error('no active scratch run')
    const errors: unknown[] = []
    await this.releaseActive(errors, true)
    try { this.verifyProduction() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'scratch run cleanup failed')
  }
  /** Removes every trace of the raw root (logs, cache copy, token-bearing fixtures, seed). Retained
   * evidence lives in the separate final output directory, which this never touches. */
  cleanup() {
    if (this.cleanupPromise) return this.cleanupPromise
    this.cleanupPromise = (async () => {
      const errors: unknown[] = []
      await this.releaseActive(errors, false)
      try { this.verifyProduction() } catch (error) { errors.push(error) }
      if (!this.active) try { await fsp.rm(this.root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
      else errors.push(new Error('refusing to remove private state while scratch process may be alive'))
      if (fs.existsSync(this.root)) errors.push(new Error('private root survived cleanup'))
      if (errors.length) throw new AggregateError(errors, 'outer cleanup failed')
    })()
    return this.cleanupPromise
  }
}

async function assertPrivateTree(root: string) {
  const visit = async (entry: string): Promise<void> => {
    const stat = await fsp.lstat(entry)
    if (stat.mode & 0o077) throw new Error('non-private scratch mode')
    if (stat.isSymbolicLink()) throw new Error('symlink in scratch output')
    if (stat.isDirectory()) for (const child of await fsp.readdir(entry)) await visit(path.join(entry, child))
  }
  await visit(root)
}
async function writePrivate(file: string, value: unknown, token = '') {
  validateEvidence(value, token); await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fsp.chmod(path.dirname(file), 0o700)
  const lines = Array.isArray(value) ? value.map((entry) => JSON.stringify(entry)).join('\n') : JSON.stringify(value)
  await fsp.writeFile(file, `${lines}\n`, { mode: 0o600 }); await fsp.chmod(file, 0o600)
}
async function fixture(root: string, number: number) {
  const id = `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`; const dir = path.join(root, '.claude/projects/test'); const file = path.join(dir, `${id}.jsonl`)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 }); await fsp.chmod(dir, 0o700)
  await fsp.writeFile(file, `${JSON.stringify({ type: 'user', uuid: id, sessionId: id, cwd: '/synthetic', timestamp: new Date().toISOString(), message: { role: 'user', content: `fixture ${number}` } })}\n`, { mode: 0o600 })
}

function releaseSources() {
  const sources = ['Cargo.toml', 'Cargo.lock', 'build.rs'].map((file) => path.join(WORKTREE, file)).filter(fs.existsSync)
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml') sources.push(full)
    }
  }
  visit(path.join(WORKTREE, 'crates'))
  return sources
}
function sourceProvenance(command: string) {
  try {
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: WORKTREE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().length > 0,
    }
  } catch {
    const commit = process.env.FRESHELL_0GDD_TEST_BUILD_COMMIT
    const dirty = process.env.FRESHELL_0GDD_TEST_BUILD_DIRTY
    if (command !== 'smoke' || !commit || !['true', 'false'].includes(dirty ?? '')) throw new Error('source provenance unavailable')
    return { commit, dirty: dirty === 'true' }
  }
}
async function waitForVerifiedListener(active: ActiveRun, client: AuthenticatedClient, provenance: ReturnType<typeof sourceProvenance>) {
  const deadline = performance.now() + 120_000
  while (performance.now() < deadline) {
    requireFingerprint(active.fp, fingerprint(active.fp.pid))
    const listeners = listenerIdentities(active.port, active.fp.pid)
    if (!listeners.length) { await delay(100); continue }
    const listener = assertScratchListener(listeners, active.port, active.fp.pid)
    active.listener = listener
    client.verifyListener(listener)
    const info = await client.json('/api/server-info') as Record<string, unknown>
    assertServerInfo(info, provenance.commit, provenance.dirty)
    return
  }
  throw new Error('scratch listener timeout')
}

async function runCondition(owner: CleanupOwner, binary: string, seed: string | null, condition: Condition, seconds: number, provenance: ReturnType<typeof sourceProvenance>): Promise<Summary> {
  owner.verifyProduction()
  const runId = `${condition.name}-${Date.now()}`; const dir = path.join(owner.root, runId); const state = path.join(dir, 'home'); const freshness = condition.name.startsWith('freshness-'); const isolated = seconds < 10 || freshness
  await fsp.mkdir(path.join(state, '.freshell'), { recursive: true, mode: 0o700 }); await fsp.chmod(dir, 0o700); await fsp.chmod(state, 0o700); await fsp.chmod(path.join(state, '.freshell'), 0o700)
  await fsp.writeFile(path.join(state, '.freshell/config.json'), '{"settings":{"network":{"configured":true,"host":"127.0.0.1"},"sidebar":{"autoGenerateTitles":false}}}', { mode: 0o600 })
  if (isolated) await fixture(state, 0)
  else if (seed) { const cache = path.join(state, '.freshell/rust-session-cache.json'); await copyRegularPrivate(seed, cache) }
  const port = await freePort(); const token = crypto.randomBytes(24).toString('hex'); const descriptor = fs.openSync(path.join(dir, 'stdio.log'), 'a', 0o600)
  const base = isolated ? { ...process.env, HOME: state, CLAUDE_HOME: path.join(state, '.claude'), CODEX_HOME: path.join(state, '.codex'), FRESHELL_AMPLIFIER_HOME: path.join(state, '.amplifier'), XDG_DATA_HOME: path.join(state, '.local/share') } : process.env
  const child = spawn(binary, [], { cwd: dir, env: buildEnvironment(base, state, port, token, condition), stdio: ['ignore', descriptor, descriptor] })
  if (!child.pid) throw new Error('scratch spawn failed')
  const actual = fingerprint(child.pid); const binaryStat = fs.statSync(binary)
  owner.active = { child, fp: actual, port, descriptor, dir, listener: null }
  const expected = { ...actual, executable: fs.realpathSync(binary), cwd: fs.realpathSync(dir), inode: `${binaryStat.dev}:${binaryStat.ino}` }
  requireFingerprint(expected, actual); owner.active.fp = expected
  const client = new AuthenticatedClient(port, token, owner.httpSafety)
  await waitForVerifiedListener(owner.active, client, provenance)
  if (process.env.FRESHELL_0GDD_TEST_FAIL_AFTER_SPAWN === '1') throw new Error('injected post-spawn failure')
  if (process.env.FRESHELL_0GDD_TEST_EXIT_AFTER_SPAWN === '1') {
    requireFingerprint(expected, fingerprint(expected.pid))
    process.kill(expected.pid, 'SIGTERM')
    if (!await waitForProcessGone(expected.pid, 5_000)) throw new Error('injected child exit timed out')
    throw new Error('injected already-exited cleanup')
  }
  if (process.env.FRESHELL_0GDD_TEST_FORCE_KILL === '1') {
    requireFingerprint(expected, fingerprint(expected.pid))
    process.kill(expected.pid, 'SIGSTOP')
    owner.active.termTimeoutMs = 50
    throw new Error('injected forced-kill cleanup')
  }
  if (process.env.FRESHELL_0GDD_TEST_HOLD_AFTER_SPAWN === '1') await delay(60_000)

  const tracker = new BoundaryTracker(); const events: Record<string, unknown>[] = []; const reader = new EventReader(path.join(state, 'logs')); let warmed = false
  const readEvents = async () => {
    for (const raw of await reader.read()) {
      warmed ||= raw.event === 'session_index_warm' || raw.msg === 'session index warm sweep complete'
      const reduced = reduceEvent(raw)
      if (reduced) { events.push(reduced); tracker.observe(reduced) }
    }
  }
  const warmDeadline = performance.now() + 120_000; const rss: number[] = []
  while (performance.now() < warmDeadline) {
    requireFingerprint(expected, fingerprint(expected.pid)); await readEvents()
    rss.push(parseProcStatus(fs.readFileSync(`/proc/${expected.pid}/status`, 'utf8')).rssKb)
    const recent = rss.slice(-10); const median = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)]
    const refresh = events.some((event) => event.event === '0gdd.index_refresh_finished' && Number(event.rows) > 0 && (isolated || Number(event.loaded_cache_entries) > 0))
    const sweeps = !condition.sweep || events.filter((event) => event.event === '0gdd.sessions_sweep').length >= 2
    const auto = !condition.autoTitle || events.filter((event) => event.event === '0gdd.auto_title_sweep').length >= 2
    if (warmed && refresh && sweeps && auto && recent.length === 10 && recent.every((value) => Math.abs(value - median) <= median * 0.05) && tracker.stablyClean(performance.now(), 1000)) break
    await delay(250)
  }
  if (performance.now() >= warmDeadline) throw new Error('scratch warm-up timeout')

  if (freshness) {
    const route = freshnessRoute()
    const visible = async () => ((await client.json(route)) as { items: unknown[] }).items.length
    const delays: number[] = []; let count = await visible()
    for (let number = 1; number <= 3; number++) {
      await fixture(state, number); const began = performance.now(); let last = count; let observed = false
      while (performance.now() - began < 30_000) {
        await delay(100)
        last = await visible()
        if (last > count) { delays.push(performance.now() - began); count = last; observed = true; break }
      }
      if (!observed) {
        const failure = freshnessFailure({ mode: condition.refresh, fixtureOrdinal: number, oldCount: count, lastCount: last, elapsedMs: performance.now() - began })
        await owner.finishRun()
        throw new FreshnessTimeoutError(failure)
      }
    }
    const summary = { name: condition.name, cpu: 0, elapsed: 0, samples: 0, requests: 0, cache_saves: 0, freshness_delays: delays }
    await owner.finishRun(); return summary
  }

  const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })); const began = performance.now(); const first = parseProcStat(fs.readFileSync(`/proc/${expected.pid}/stat`, 'utf8'))
  const eventStart = events.length; const samples: Record<string, unknown>[] = []; const requests: Record<string, unknown>[] = []
  await runMeasurementSchedules({
    durationMs: seconds * 1000,
    sample: async (scheduledAt) => {
      requireFingerprint(expected, fingerprint(expected.pid)); const stat = parseProcStat(fs.readFileSync(`/proc/${expected.pid}/stat`, 'utf8'))
      if (stat.startTime !== expected.startTime) throw new Error('scratch PID reused')
      samples.push({ at_ms: scheduledAt, ticks: stat.ticks, ...parseProcStatus(fs.readFileSync(`/proc/${expected.pid}/status`, 'utf8')), ...parseProcIo(fs.readFileSync(`/proc/${expected.pid}/io`, 'utf8')) }); await readEvents()
    },
    get: condition.get ? async (scheduledAt) => {
      const requestAt = performance.now(); const body = await client.bytes('/api/session-directory?priority=visible&limit=50', 10_000)
      requests.push({ at_ms: scheduledAt, status: 200, bytes: body.byteLength, latency_ms: performance.now() - requestAt })
    } : undefined,
  })
  const boundaryDeadline = performance.now() + 30_000
  while (performance.now() < boundaryDeadline) { await readEvents(); if (tracker.stablyClean(performance.now(), 1000)) break; await delay(100) }
  if (!tracker.stablyClean(performance.now(), 1000)) throw new Error('unclean sample boundary')
  const last = parseProcStat(fs.readFileSync(`/proc/${expected.pid}/stat`, 'utf8')); const elapsed = (performance.now() - began) / 1000; const windowEvents = events.slice(eventStart)
  const summary = { name: condition.name, cpu: cpuPercent(first.ticks, last.ticks, hz, elapsed), elapsed, samples: samples.length, requests: requests.length, cache_saves: windowEvents.filter((event) => event.event === '0gdd.cache_save_started').length }
  validateRun(summary, seconds, Boolean(condition.get))
  for (const [name, value] of [['proc', samples], ['requests', requests], ['events', windowEvents], ['summary', summary]] as const) await writePrivate(path.join(owner.root, 'output/runs', `${runId}.${name}.jsonl`), value, token)
  await owner.finishRun(); return summary
}

async function makeRoot(command: string) {
  const requested = process.env.FRESHELL_0GDD_TEST_ROOT
  if (requested) {
    if (command !== 'smoke' || !path.resolve(requested).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error('test root is allowed only for smoke under the temporary directory')
    if (fs.existsSync(requested)) throw new Error('test root already exists')
    await fsp.mkdir(requested, { mode: 0o700 }); await fsp.chmod(requested, 0o700); return requested
  }
  return await fsp.mkdtemp(path.join(os.tmpdir(), `freshell-0gdd-${process.pid}-`))
}

/** The final sanitized output lives outside the raw root so that raw-root cleanup — including the
 * cleanup that follows an optional-stage failure — can never destroy the evidence. */
async function makeOutputRoot(command: string) {
  const requested = process.env.FRESHELL_0GDD_TEST_ROOT
  const output = requested && command === 'smoke' ? `${path.resolve(requested)}-output` : null
  if (!output) return await fsp.mkdtemp(path.join(os.tmpdir(), `freshell-0gdd-output-${process.pid}-`))
  if (fs.existsSync(output)) throw new Error('test output root already exists')
  await fsp.mkdir(output, { mode: 0o700 }); await fsp.chmod(output, 0o700); return output
}

/** Creates the two roots as one unit: the raw root exists first (so nothing else can be stranded by
 * its own failure), and a failure to create the final output takes the raw root back down with it. */
export async function createRoots(makeRawRoot: () => Promise<string>, makeFinalOutput: () => Promise<string>) {
  const root = await makeRawRoot()
  try { return { root, output: await makeFinalOutput() } } catch (error) {
    await fsp.rm(root, { recursive: true, force: true })
    throw error
  }
}

async function runMain() {
  process.umask(0o077)
  const command = process.argv[2]
  if (!['smoke', 'run'].includes(command)) throw new Error('usage: measure-0gdd-level1.ts smoke|run')
  if (!fs.existsSync(RELEASE_BINARY)) throw new Error('fresh release freshell-server build required')
  assertFreshRelease(RELEASE_BINARY, releaseSources())
  if (command === 'run' && ['FRESHELL_0GDD_TEST_FAIL_AFTER_SPAWN', 'FRESHELL_0GDD_TEST_EXIT_AFTER_SPAWN', 'FRESHELL_0GDD_TEST_FORCE_KILL', 'FRESHELL_0GDD_TEST_HOLD_AFTER_SPAWN'].some((key) => process.env[key])) throw new Error('smoke-only test control set for real run')
  const provenance = sourceProvenance(command)
  const prod = command === 'run' ? production() : null
  const { root, output } = await createRoots(() => makeRoot(command), () => makeOutputRoot(command))
  const seed = command === 'run' ? path.join(root, 'seed.json') : null
  const owner = new CleanupOwner(root, seed, prod); let success = false; let signalExit = false
  const copied = new Set<string>()
  const checkpoint = () => checkpointOutput(path.join(root, 'output'), output, copied)
  // Raw-root cleanup is unconditional; the final output only survives when it already holds evidence.
  const releaseOutput = async () => {
    try { if (await finalizeOutput(output)) console.error(`retained sanitized output ${output}`) } catch (error) { console.error(describeError(error)) }
  }
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = () => {
      if (signalExit) return; signalExit = true
      void releaseOutput().then(() => owner.cleanup()).then(() => process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[signal])).catch((error) => { console.error(error); process.exit(1) })
    }
    signalHandlers.set(signal, handler); process.once(signal, handler)
  }
  try {
    if (seed) { await copyRegularPrivate(path.join(os.homedir(), '.freshell/rust-session-cache.json'), seed); owner.cacheSourceChecks++ }
    const run = (condition: Condition) => runCondition(owner, RELEASE_BINARY, seed, condition, command === 'smoke' ? 3 : 150, provenance)
    const results: Summary[] = command === 'smoke' ? [await run({ name: 'smoke', ...normal, get: false })] : []
    const failures: FreshnessFailure[] = []
    if (command === 'run') {
      results.push(...await runOrchestration(
        run,
        withFreshnessCheckpoint(checkpoint, (condition) => runCondition(owner, RELEASE_BINARY, null, condition, 30, provenance)),
        (failure) => failures.push(failure),
      ))
    }
    await checkpoint()
    const manifest = { command, commit: provenance.commit, build_dirty: provenance.dirty, binary_hash: crypto.createHash('sha256').update(await fsp.readFile(RELEASE_BINARY)).digest('hex') }
    await writePrivate(path.join(output, 'manifest.json'), manifest); await writePrivate(path.join(output, 'comparisons.json'), results)
    const freshness = results.filter((result) => result.freshness_delays)
    if (freshness.length || failures.length) await writePrivate(path.join(output, 'freshness.json'), { status: failures.length ? 'inconclusive' : 'complete', runs: freshness, failures })
    if (owner.httpSafety.authenticatedRequestsBeforeVerification !== 0) throw new Error('authenticated request occurred before listener verification')
    await writePrivate(path.join(output, 'safety.json'), {
      production_fingerprint_checks: owner.productionChecks,
      scratch_pid_and_listener_stops: owner.scratchStops,
      scratch_already_exited: owner.alreadyExited,
      scratch_forced_kills: owner.forcedKills,
      invalid_runs: owner.invalidRuns,
      private_tree_checks: owner.privateTreeChecks,
      cache_source_regular_checks: owner.cacheSourceChecks,
      ...owner.httpSafety,
    })
    await assertPrivateTree(output)
    await owner.cleanup(); success = true; console.log(output)
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    if (!success && !signalExit) {
      await releaseOutput()
      await owner.cleanup()
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(describeError).join('; ')}`
  return error instanceof Error ? error.message : String(error)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain().catch((error) => { console.error(describeError(error)); process.exitCode = 1 })
