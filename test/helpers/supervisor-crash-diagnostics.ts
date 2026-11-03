import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

type RuntimeHarness = {
  buildDir: string
  testRoot: string
  runId: string
  inspectContainer(containerId: string): any
  execOwnedContainerExact(containerId: string, command: string[]): string
  startOwnedContainerDetachedExact(containerId: string, command: string[]): void
  writeIncident(name: string, value: unknown): void
}

type CrashCaptureRig = {
  runtime: RuntimeHarness
  supervisor: { containerId: string }
}

type SafeBacktraceFrame = { thread: number; frame: number; symbol: string }

export type SafeGdbSummary = {
  available: boolean
  attached: boolean
  exitCode?: number
  signal?: string
  threadCount: number
  threadDebugUnavailable: boolean
  frames: SafeBacktraceFrame[]
  outputTruncated: boolean
  observerStopped?: boolean
  observerStopRequested?: boolean
}

export type SafeGdbFailureSummary = {
  category: string
  log: SafeGdbSummary
  diagnosticLines: string[]
}

type ObserverWaitStage = 'gdb_wrapper_start' | 'gdb_script_start' | 'gdb_attach'
type SafeProcessState = 'running' | 'sleeping' | 'disk_sleep' | 'stopped' | 'tracing_stop' | 'zombie' | 'idle' | 'other' | 'unavailable'
type SafeWaitClass = 'ptrace' | 'wait' | 'poll' | 'futex' | 'sleep' | 'other' | 'unavailable'
type SafeThreadCount = 'none' | 'one' | '2_to_8' | '9_to_32' | '33_to_128' | 'over_128' | 'unavailable'

type RawProcessAttachFacts = {
  present: boolean
  identityMatches: boolean | null
  state: string | null
  waitChannel: string | null
  threads: number | null
  capEff: string | null
  tracerPid: number | null
}

type RawSupervisorGdbAttachFacts = {
  stage: ObserverWaitStage
  markers: { wrapperStarted: boolean; scriptStarted: boolean; attached: boolean; exited: boolean; exitCode?: number }
  container: { verified: boolean; running: boolean }
  gdb: RawProcessAttachFacts
  target: RawProcessAttachFacts
}

export type SafeSupervisorGdbAttachFacts = {
  stage: ObserverWaitStage
  markers: { wrapperStarted: boolean; scriptStarted: boolean; attached: boolean; exited: boolean; exitStatus: 'zero' | 'nonzero' | 'unknown' }
  container: { verified: boolean; running: boolean }
  gdb: {
    present: boolean
    identityMatches: boolean | null
    state: SafeProcessState
    waitClass: SafeWaitClass
    threadCount: SafeThreadCount
    hasSysPtrace: boolean | null
    tracerPresent: boolean | null
  }
  target: {
    present: boolean
    identityMatches: boolean | null
    state: SafeProcessState
    waitClass: SafeWaitClass
    threadCount: SafeThreadCount
    hasSysPtrace: boolean | null
    tracerPresent: boolean | null
  }
}

export type SupervisorCrashDiagnosticHandle = {
  policy: { capAdd: string[]; defaultSeccomp: boolean; network: string; privileged: boolean; threadDbMatchesTarget: boolean }
  probes: {
    sigsegv: { targetExitCode: number; gdbExitCode: number; threadCount: number; workerThreadCount: number; frames: SafeBacktraceFrame[] }
    sigterm: { targetExitCode: number; gdbExitCode: number; handlerCleanup: boolean; targetReaped: boolean }
  }
  finalizeObserver(): Promise<SafeGdbSummary>
  collectObserver(): SafeGdbSummary
  removeTemporaryFiles(): void
}

const HELPER_SOURCE = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

#define CAPTURE_ROOT __CAPTURE_ROOT__

static volatile sig_atomic_t terminate_requested = 0;

static void on_term(int signal_number) {
  (void)signal_number;
  terminate_requested = 1;
  int fd = open(CAPTURE_ROOT "/term-handled", O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd >= 0) {
    (void)write(fd, "handled\\n", 8);
    (void)close(fd);
  }
}

static void *worker(void *unused) {
  (void)unused;
  for (;;) usleep(1000000);
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  if (strcmp(argv[1], "segv") == 0) {
    pthread_t threads[3];
    for (int index = 0; index < 3; index++) {
      int result = pthread_create(&threads[index], NULL, worker, NULL);
      if (result != 0) return result;
    }
    int ready = open(CAPTURE_ROOT "/segv-ready", O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (ready >= 0) { (void)write(ready, "ready\\n", 6); (void)close(ready); }
    while (access(CAPTURE_ROOT "/trigger-segv", F_OK) != 0) usleep(10000);
    raise(SIGSEGV);
    return 0;
  }
  if (strcmp(argv[1], "term") == 0) {
    struct sigaction action = {0};
    action.sa_handler = on_term;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0) return errno;
    int ready = open(CAPTURE_ROOT "/term-ready", O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (ready >= 0) { (void)write(ready, "ready\\n", 6); (void)close(ready); }
    while (!terminate_requested) pause();
    return 0;
  }
  return 65;
}
`

function runHost(program: string, args: string[]): string {
  return execFileSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim()
}

function copyExecutableDependencies(gdbPath: string, bundleRoot: string): { loader: string; libDir: string; dataDir: string } {
  const libDir = path.join(bundleRoot, 'lib')
  const binDir = path.join(bundleRoot, 'bin')
  const lib64Dir = path.join(bundleRoot, 'lib64')
  const dataDir = path.join(bundleRoot, 'share', 'gdb')
  fs.mkdirSync(libDir, { recursive: true, mode: 0o755 })
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 })
  fs.mkdirSync(lib64Dir, { recursive: true, mode: 0o755 })

  const dependencies = runHost('ldd', [gdbPath])
  if (/not found/i.test(dependencies)) throw new Error('host GDB has an unresolved shared library')
  for (const line of dependencies.split('\n')) {
    const named = line.match(/^\s*(\S+)\s+=>\s+(\/\S+)/)
    const loader = line.match(/^\s*(\/\S+)\s+\(/)
    const source = named?.[2] ?? loader?.[1]
    if (!source || source.includes('linux-vdso')) continue
    if (!fs.statSync(source).isFile()) throw new Error('host GDB dependency is not a regular file')
    const destination = path.join(named ? libDir : lib64Dir, named ? named[1] : 'ld-linux-x86-64.so.2')
    if (!fs.existsSync(destination)) fs.copyFileSync(source, destination)
  }
  const hostLoader = fs.realpathSync('/lib64/ld-linux-x86-64.so.2')
  const loader = path.join(lib64Dir, 'ld-linux-x86-64.so.2')
  fs.copyFileSync(hostLoader, loader)

  const bundledGdb = path.join(binDir, 'gdb')
  fs.copyFileSync(gdbPath, bundledGdb)
  fs.chmodSync(bundledGdb, 0o755)
  if (!fs.existsSync('/usr/share/gdb')) throw new Error('host GDB data directory is missing')
  fs.cpSync('/usr/share/gdb', dataDir, { recursive: true, dereference: true })
  return { loader, libDir, dataDir }
}

function readBoundedTail(filePath: string, maxBytes = 256 * 1024): { text: string; truncated: boolean } {
  if (!fs.existsSync(filePath)) return { text: '', truncated: false }
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(descriptor).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    fs.readSync(descriptor, buffer, 0, length, size - length)
    return { text: buffer.toString('utf8'), truncated: size > length }
  } finally {
    fs.closeSync(descriptor)
  }
}

export function summarizeSupervisorGdbOutput(text: string): SafeGdbSummary {
  const attached = text.includes('FRESHELL_GDB_ATTACHED')
  const signalMatch = text.match(/Program received signal (SIG[A-Z0-9]+)/)
  const threads = new Set<number>()
  const frames: SafeBacktraceFrame[] = []
  let currentThread = 0
  for (const line of text.split('\n')) {
    const thread = line.match(/^Thread (\d+)\b/)
    if (thread) {
      currentThread = Number(thread[1])
      threads.add(currentThread)
      continue
    }
    const frame = line.match(/^#(\d+)\s+(.*)$/)
    if (!frame || frames.length >= 256) continue
    const body = frame[2]!.trim()
    const withoutAddress = body.replace(/^(?:0x[0-9a-f]+\s+)?(?:in\s+)?/i, '')
    const rawSymbol = withoutAddress.split(/\s*(?:\(|\s+(?:at|from)\s+)/, 1)[0]?.trim() ?? ''
    const symbol = /[\\/]/.test(rawSymbol) ? 'unknown' : rawSymbol.replace(/[^A-Za-z0-9_:$<>~*.,+?-]/g, '?').slice(0, 160)
    frames.push({ thread: currentThread, frame: Number(frame[1]), symbol: symbol || 'unknown' })
  }
  return {
    available: text.length > 0,
    attached,
    ...(signalMatch ? { signal: signalMatch[1] } : {}),
    threadCount: threads.size,
    threadDebugUnavailable: /thread debugging will not be available/i.test(text),
    frames,
    outputTruncated: false,
  }
}

function readStatus(filePath: string): number | undefined {
  if (!fs.existsSync(filePath)) return undefined
  const value = fs.readFileSync(filePath, 'utf8').trim()
  return /^\d{1,3}$/.test(value) ? Number(value) : undefined
}

function readPid(filePath: string): number | undefined {
  if (!fs.existsSync(filePath)) return undefined
  const value = fs.readFileSync(filePath, 'utf8').trim()
  if (!/^\d{1,10}$/.test(value)) return undefined
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}

function safeProcessState(value: string | null): SafeProcessState {
  const state = value?.trim().match(/^[RSDTtZIX]/)?.[0]
  switch (state) {
    case 'R': return 'running'
    case 'S': return 'sleeping'
    case 'D': return 'disk_sleep'
    case 'T': return 'stopped'
    case 't': return 'tracing_stop'
    case 'Z': return 'zombie'
    case 'I': return 'idle'
    case 'X': return 'other'
    default: return 'unavailable'
  }
}

function safeWaitClass(value: string | null): SafeWaitClass {
  if (!value || value === '0') return 'unavailable'
  const normalized = value.toLowerCase()
  if (normalized.includes('ptrace')) return 'ptrace'
  if (normalized.includes('wait')) return 'wait'
  if (/poll|epoll|select/.test(normalized)) return 'poll'
  if (normalized.includes('futex')) return 'futex'
  if (/sleep|schedule/.test(normalized)) return 'sleep'
  return 'other'
}

function safeThreadCount(value: number | null): SafeThreadCount {
  if (!Number.isSafeInteger(value) || value! < 0) return 'unavailable'
  if (value === 0) return 'none'
  if (value === 1) return 'one'
  if (value! <= 8) return '2_to_8'
  if (value! <= 32) return '9_to_32'
  if (value! <= 128) return '33_to_128'
  return 'over_128'
}

function hasSysPtraceCapability(value: string | null): boolean | null {
  if (!value || !/^[a-f0-9]+$/i.test(value)) return null
  try {
    return (BigInt(`0x${value}`) & (1n << 19n)) !== 0n
  } catch {
    return null
  }
}

function safeProcessAttachFacts(facts: RawProcessAttachFacts) {
  const trustworthy = facts.present && facts.identityMatches === true
  return {
    present: facts.present,
    identityMatches: facts.identityMatches,
    state: trustworthy ? safeProcessState(facts.state) : 'unavailable' as const,
    waitClass: trustworthy ? safeWaitClass(facts.waitChannel) : 'unavailable' as const,
    threadCount: trustworthy ? safeThreadCount(facts.threads) : 'unavailable' as const,
    hasSysPtrace: trustworthy ? hasSysPtraceCapability(facts.capEff) : null,
    tracerPresent: trustworthy && Number.isSafeInteger(facts.tracerPid) && facts.tracerPid! >= 0
      ? facts.tracerPid! > 0
      : null,
  }
}

export function summarizeSupervisorGdbAttachFacts(facts: RawSupervisorGdbAttachFacts): SafeSupervisorGdbAttachFacts {
  return {
    stage: facts.stage,
    markers: {
      wrapperStarted: facts.markers.wrapperStarted,
      scriptStarted: facts.markers.scriptStarted,
      attached: facts.markers.attached,
      exited: facts.markers.exited,
      exitStatus: facts.markers.exitCode === undefined ? 'unknown' : facts.markers.exitCode === 0 ? 'zero' : 'nonzero',
    },
    container: { verified: facts.container.verified, running: facts.container.running },
    gdb: safeProcessAttachFacts(facts.gdb),
    target: safeProcessAttachFacts(facts.target),
  }
}

export function classifySupervisorGdbFailure(...texts: string[]): string {
  const text = texts.join('\n')
  if (!text.trim()) return 'empty-output'
  if (/ptrace: Operation not permitted/i.test(text)) return 'ptrace-denied'
  if (/No such process/i.test(text)) return 'target-missing'
  if (/Unable to find libthread_db|thread debugging will not be available/i.test(text)) return 'thread-db-unavailable'
  if (/error while loading shared libraries|cannot open shared object file/i.test(text)) return 'missing-shared-library'
  if (/Undefined command|No symbol table|This command cannot be used/i.test(text)) return 'unsupported-gdb-command'
  if (/Could not attach|Cannot attach/i.test(text)) return 'attach-rejected'
  return 'unclassified-gdb-output'
}

function redactGdbDiagnosticLine(line: string): string {
  return line
    .replace(/0x[0-9a-f]+/gi, '<address>')
    .replace(/(?:[A-Za-z]:)?\/[^\s:()]+(?::\d+)?/g, '<path>')
    .replace(/\b(pid|process)\s+\d+\b/gi, '$1 <pid>')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '?')
    .slice(0, 240)
}

export function summarizeSupervisorGdbFailureOutput(logText: string, launchOutputText: string): SafeGdbFailureSummary {
  const interestingLine = /error|warning|cannot|could not|failed|ptrace|attach|thread|debugg|signal|process|target|exited/i
  const diagnosticLines = [logText, launchOutputText]
    .flatMap(text => text.split('\n'))
    .filter(line => interestingLine.test(line))
    .slice(-12)
    .map(redactGdbDiagnosticLine)
  return {
    category: classifySupervisorGdbFailure(logText, launchOutputText),
    log: summarizeSupervisorGdbOutput(logText),
    diagnosticLines,
  }
}

function createPrivateOutputFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'w', 0o600)
  fs.closeSync(descriptor)
  fs.chmodSync(filePath, 0o600)
  if ((fs.statSync(filePath).mode & 0o777) !== 0o600) {
    throw new Error('GDB launch output file permissions are not private')
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function gdbQuote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

async function waitForFile(
  filePath: string,
  timeoutMs: number,
  failStatusPath?: string,
  diagnosticPaths: string[] = [],
  markerName = 'GDB marker',
  deadlineAt?: number,
): Promise<void> {
  const deadline = deadlineAt ?? Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    if (failStatusPath && fs.existsSync(failStatusPath)) {
      const exitCode = readStatus(failStatusPath)
      const category = classifySupervisorGdbFailure(...diagnosticPaths.map(file => readBoundedTail(file).text))
      throw new Error(`${markerName} process exited first (exit=${exitCode ?? 'unknown'}, output=${category})`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const category = classifySupervisorGdbFailure(...diagnosticPaths.map(file => readBoundedTail(file).text))
  throw new Error(`${markerName} timed out (output=${category})`)
}

function gdbProgram(loader: string, libDir: string, gdbPath: string, dataDir: string, scriptPath: string): string {
  return [shellQuote(loader), '--library-path', shellQuote(libDir), shellQuote(gdbPath),
    '--data-directory', shellQuote(dataDir), '-nx', '--batch', '-x', shellQuote(scriptPath)].join(' ')
}

function gdbScript(options: {
  pid: number
  libDir: string
  logPath: string
  scriptStartedPath?: string
  attachedPath: string
  capturedPath: string
  includeBacktrace: boolean
}) {
  const lines = [
    ...(options.scriptStartedPath ? ['shell touch ' + shellQuote(options.scriptStartedPath)] : []),
    'set pagination off',
    'set confirm off',
    'set print address off',
    'set print frame-arguments none',
    'set print entry-values no',
    'set debuginfod enabled off',
    'set auto-load safe-path ' + gdbQuote(options.libDir),
    'set libthread-db-search-path ' + gdbQuote(options.libDir),
    'set backtrace limit 24',
    'set logging file ' + gdbQuote(options.logPath),
    'set logging overwrite on',
    'set logging redirect on',
    'set logging enabled on',
    'handle SIGSEGV stop print pass',
    'handle SIGABRT stop print pass',
    'handle SIGBUS stop print pass',
    'handle SIGILL stop print pass',
    'handle SIGFPE stop print pass',
    'handle SIGTERM nostop noprint pass',
    'handle SIGINT nostop noprint pass',
    'attach ' + String(options.pid),
    'shell touch ' + shellQuote(options.attachedPath),
    'echo FRESHELL_GDB_ATTACHED\\n',
    'continue',
  ]
  if (options.includeBacktrace) {
    lines.push('thread apply all bt')
    lines.push('shell touch ' + shellQuote(options.capturedPath))
    lines.push('continue')
  } else {
    lines.push('echo FRESHELL_GDB_TARGET_EXITED\\n')
  }
  return lines.join('\n') + '\n'
}

function unavailableProcessAttachFacts(): RawProcessAttachFacts {
  return {
    present: false,
    identityMatches: null,
    state: null,
    waitChannel: null,
    threads: null,
    capEff: null,
    tracerPid: null,
  }
}

function readObserverProcessAttachFacts(
  runtime: RuntimeHarness,
  containerId: string,
  runId: string,
  gdbPid: number | undefined,
  gdbBin: string,
  scriptPath: string,
): { container: { verified: boolean; running: boolean }; gdb: RawProcessAttachFacts; target: RawProcessAttachFacts } {
  let verified = false
  let running = false
  let gdb = unavailableProcessAttachFacts()
  let target = unavailableProcessAttachFacts()
  try {
    const inspected = runtime.inspectContainer(containerId)
    verified = inspected.Id === containerId
      && inspected.Config?.Labels?.['com.freshell.runtime-test-run-id'] === runId
    running = verified && Boolean(inspected.State?.Running)
    if (!running) return { container: { verified, running }, gdb, target }

    const processProbe = [
      'import json, os, sys',
      'gdb_pid = int(sys.argv[1])',
      'expected_gdb = os.fsencode(sys.argv[2])',
      'expected_script = os.fsencode(sys.argv[3])',
      'def snapshot(pid, expected=None):',
      '    result = {"present": False, "identityMatches": None, "state": None, "waitChannel": None, "threads": None, "capEff": None, "tracerPid": None}',
      '    try:',
      '        with open(f"/proc/{pid}/status", "r", encoding="ascii") as source:',
      '            rows = source.read().splitlines()',
      '    except OSError:',
      '        return result',
      '    result["present"] = True',
      '    try:',
      '        if expected is None:',
      '            matches = os.path.basename(os.readlink(f"/proc/{pid}/exe")) == "freshell-supervisor-test"',
      '        else:',
      '            with open(f"/proc/{pid}/cmdline", "rb") as source:',
      '                argv = source.read().split(b"\\0")',
      '            matches = expected[0] in argv and expected[1] in argv',
      '    except OSError:',
      '        matches = False',
      '    result["identityMatches"] = matches',
      '    if not matches:',
      '        return result',
      '    fields = {}',
      '    for row in rows:',
      '        if ":" in row:',
      '            key, value = row.split(":", 1)',
      '            fields[key] = value.strip()',
      '    result["state"] = fields.get("State")',
      '    result["threads"] = int(fields["Threads"]) if fields.get("Threads", "").isdigit() else None',
      '    result["capEff"] = fields.get("CapEff")',
      '    result["tracerPid"] = int(fields["TracerPid"]) if fields.get("TracerPid", "").isdigit() else None',
      '    try:',
      '        with open(f"/proc/{pid}/wchan", "r", encoding="ascii") as source:',
      '            result["waitChannel"] = source.read().strip()',
      '    except OSError:',
      '        pass',
      '    return result',
      'print(json.dumps({"gdb": snapshot(gdb_pid, (expected_gdb, expected_script)), "target": snapshot(1)}))',
    ].join('\n')
    const output = runtime.execOwnedContainerExact(containerId, [
      'python3', '-I', '-c', processProbe,
      String(gdbPid ?? -1), gdbBin, scriptPath,
    ])
    const parsed = JSON.parse(output) as { gdb?: RawProcessAttachFacts; target?: RawProcessAttachFacts }
    if (parsed.gdb) gdb = parsed.gdb
    if (parsed.target) target = parsed.target
  } catch {
    // A missing container or unreadable /proc facts are recorded as unavailable.
    // The diagnostic failure remains the primary result.
  }
  return { container: { verified, running }, gdb, target }
}

function parseSummary(filePath: string, exitPath?: string): SafeGdbSummary {
  const tail = readBoundedTail(filePath)
  const summary = summarizeSupervisorGdbOutput(tail.text)
  const exitCode = exitPath ? readStatus(exitPath) : undefined
  return { ...summary, ...(exitCode !== undefined ? { exitCode } : {}), outputTruncated: tail.truncated }
}

export async function startSupervisorCrashDiagnostics(rig: CrashCaptureRig): Promise<SupervisorCrashDiagnosticHandle> {
  const containerId = rig.supervisor.containerId
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('supervisor diagnostic requires a full owned container id')
  const inspected = rig.runtime.inspectContainer(containerId)
  if (inspected.Id !== containerId || inspected.Config?.Labels?.['com.freshell.runtime-test-run-id'] !== rig.runtime.runId
    || !inspected.State?.Running) throw new Error('supervisor diagnostic container is not the exact running rig container')
  const host = inspected.HostConfig ?? {}
  const capAdd = (Array.isArray(host.CapAdd) ? host.CapAdd : []).map((value: string) => value.replace(/^CAP_/, '')).sort()
  const capDrop = (Array.isArray(host.CapDrop) ? host.CapDrop : []).map((value: string) => value.replace(/^CAP_/, '')).sort()
  const securityOpt = (Array.isArray(host.SecurityOpt) ? host.SecurityOpt : [])
    .map((value: string) => value === 'no-new-privileges:true' ? 'no-new-privileges' : value).sort()
  if (JSON.stringify(capAdd) !== JSON.stringify(['CHOWN', 'DAC_OVERRIDE', 'SYS_PTRACE'])
    || JSON.stringify(capDrop) !== JSON.stringify(['ALL'])
    || host.Privileged !== false || host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true
    || JSON.stringify(securityOpt) !== JSON.stringify(['no-new-privileges'])) {
    throw new Error('supervisor diagnostic container security does not match the approved opt-in policy')
  }
  if (rig.runtime.execOwnedContainerExact(containerId, [
    'python3', '-I', '-c',
    "import os,sys; sys.stdout.write('ok' if os.path.basename(os.readlink('/proc/1/exe')) == 'freshell-supervisor-test' else 'no')",
  ]).trim() !== 'ok') throw new Error('supervisor diagnostic target is not PID 1 of the exact rig container')

  const gdbPath = process.env.FRESHELL_TEST_GDB_PATH ?? '/usr/bin/gdb'
  if (!path.isAbsolute(gdbPath) || !fs.existsSync(gdbPath)) throw new Error('opt-in GDB executable is unavailable')
  const pythonVersion = runHost('python3', ['--version']).match(/Python (\d+\.\d+)/)?.[1]
  const targetPython = rig.runtime.execOwnedContainerExact(containerId, ['python3', '--version']).match(/Python (\d+\.\d+)/)?.[1]
  if (!pythonVersion || targetPython !== pythonVersion) throw new Error('host and supervisor GDB Python versions do not match')
  const hostThreadDbPath = [
    '/lib/x86_64-linux-gnu/libthread_db.so.1',
    '/usr/lib/x86_64-linux-gnu/libthread_db.so.1',
  ].find(candidate => fs.existsSync(candidate))
  if (!hostThreadDbPath) throw new Error('host libthread_db is unavailable')
  const targetThreadDbPath = rig.runtime.execOwnedContainerExact(containerId, [
    'python3', '-I', '-c',
    "import glob; paths=glob.glob('/lib/*/libthread_db.so.1')+glob.glob('/usr/lib/*/libthread_db.so.1'); print(paths[0] if paths else '')",
  ]).trim()
  if (!/^\/(?:usr\/)?lib\/[A-Za-z0-9_.+-]+\/libthread_db\.so\.1$/.test(targetThreadDbPath)) {
    throw new Error('supervisor libthread_db is unavailable')
  }
  const hostThreadDbHash = createHash('sha256').update(fs.readFileSync(hostThreadDbPath)).digest('hex')
  const targetThreadDbHash = rig.runtime.execOwnedContainerExact(containerId, [
    'sha256sum', targetThreadDbPath,
  ]).trim().split(/\s+/, 1)[0]
  if (!/^[a-f0-9]{64}$/.test(targetThreadDbHash) || targetThreadDbHash !== hostThreadDbHash) {
    throw new Error('host and supervisor libthread_db do not match')
  }

  const bundleRoot = path.join(rig.runtime.buildDir, 'supervisor-gdb-diagnostic')
  const gdbBin = path.join(bundleRoot, 'bin', 'gdb')
  const captureRoot = path.join(rig.runtime.testRoot, 'supervisor-gdb-diagnostic')
  let cleanupObserver: (() => Promise<void>) | undefined
  let collectObserverAttachFacts: ((stage: ObserverWaitStage) => SafeSupervisorGdbAttachFacts) | undefined
  let failureOutputPaths: string[] = []
  let failureStage: ObserverWaitStage | undefined
  try {
    const { loader, libDir, dataDir } = copyExecutableDependencies(gdbPath, bundleRoot)
    fs.copyFileSync(hostThreadDbPath, path.join(libDir, 'libthread_db.so.1'))
    fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o755 })
    fs.mkdirSync(captureRoot, { recursive: true, mode: 0o700 })
    const helperSource = path.join(bundleRoot, 'preflight-helper.c')
    const helperBinary = path.join(captureRoot, 'preflight-helper')
    const source = HELPER_SOURCE.replace('__CAPTURE_ROOT__', JSON.stringify(captureRoot))
    fs.writeFileSync(helperSource, source, { mode: 0o600 })
    rig.runtime.execOwnedContainerExact(containerId, [
      'g++', '-g', '-O0', '-fno-omit-frame-pointer', '-pthread', '-o', helperBinary, helperSource,
    ])

    const policy = {
      capAdd,
      defaultSeccomp: true,
      network: 'none',
      privileged: false,
      threadDbMatchesTarget: true,
    }
    const observer = {
      logPath: path.join(captureRoot, 'supervisor.gdb.log'),
      launchOutputPath: path.join(captureRoot, 'supervisor.gdb.launch.log'),
      scriptPath: path.join(bundleRoot, 'supervisor.gdb'),
      wrapperStartedPath: path.join(captureRoot, 'supervisor.gdb.wrapper-started'),
      scriptStartedPath: path.join(captureRoot, 'supervisor.gdb.script-started'),
      attachedPath: path.join(captureRoot, 'supervisor.gdb.attached'),
      capturedPath: path.join(captureRoot, 'supervisor.gdb.captured'),
      pidPath: path.join(captureRoot, 'supervisor.gdb.pid'),
      exitPath: path.join(captureRoot, 'supervisor.gdb.exit'),
    }
    for (const file of [observer.wrapperStartedPath, observer.scriptStartedPath, observer.attachedPath,
      observer.capturedPath, observer.pidPath, observer.exitPath]) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true })
    }
    fs.writeFileSync(observer.scriptPath, gdbScript({
      pid: 1, libDir, logPath: observer.logPath, attachedPath: observer.attachedPath,
      scriptStartedPath: observer.scriptStartedPath, capturedPath: observer.capturedPath, includeBacktrace: true,
    }), { mode: 0o600 })
    const observerCommand = gdbProgram(loader, libDir, gdbBin, dataDir, observer.scriptPath)
    createPrivateOutputFile(observer.launchOutputPath)
    let observerStopRequested = false
    let observerFinalized = false
    collectObserverAttachFacts = (stage: ObserverWaitStage): SafeSupervisorGdbAttachFacts => {
      const processFacts = readObserverProcessAttachFacts(
        rig.runtime,
        containerId,
        rig.runtime.runId,
        readPid(observer.pidPath),
        gdbBin,
        observer.scriptPath,
      )
      return summarizeSupervisorGdbAttachFacts({
        stage,
        markers: {
          wrapperStarted: fs.existsSync(observer.wrapperStartedPath),
          scriptStarted: fs.existsSync(observer.scriptStartedPath),
          attached: fs.existsSync(observer.attachedPath),
          exited: fs.existsSync(observer.exitPath),
          exitCode: readStatus(observer.exitPath),
        },
        container: processFacts.container,
        gdb: processFacts.gdb,
        target: processFacts.target,
      })
    }
    const stopObserver = async (): Promise<void> => {
      if (fs.existsSync(observer.exitPath)) {
        observerFinalized = true
        return
      }
      const inspected = rig.runtime.inspectContainer(containerId)
      if (inspected.Id !== containerId || inspected.Config?.Labels?.['com.freshell.runtime-test-run-id'] !== rig.runtime.runId) {
        throw new Error('refusing to stop a GDB observer in a changed container')
      }
      if (!inspected.State?.Running) {
        throw new Error('GDB observer container exited before its wrapper wrote an exit marker')
      }
      const pid = readPid(observer.pidPath)
      if (pid === undefined) throw new Error('GDB observer pid marker is unavailable')
      const stopResult = rig.runtime.execOwnedContainerExact(containerId, [
        'python3', '-I', '-c', [
          'import os,signal,sys',
          'pid=int(sys.argv[1])',
          'expected_gdb=os.fsencode(sys.argv[2])',
          'expected_script=os.fsencode(sys.argv[3])',
          'try:',
          ' argv=open(f"/proc/{pid}/cmdline","rb").read().split(b"\\0")',
          'except FileNotFoundError:',
          ' print("already-exited"); raise SystemExit(0)',
          'if expected_gdb not in argv or expected_script not in argv:',
          ' raise SystemExit("observer pid no longer names this run\\u2019s GDB process")',
          'try:',
          ' os.kill(pid, signal.SIGTERM)',
          'except ProcessLookupError:',
          ' print("already-exited")',
          'else:',
          ' print("term-sent")',
        ].join('\n'),
        String(pid), gdbBin, observer.scriptPath,
      ]).trim()
      if (stopResult !== 'term-sent' && stopResult !== 'already-exited') {
        throw new Error('GDB observer stop acknowledgement was invalid')
      }
      observerStopRequested = stopResult === 'term-sent'
      await waitForFile(observer.exitPath, 10_000, undefined, [observer.logPath, observer.launchOutputPath])
      const afterStop = rig.runtime.inspectContainer(containerId)
      if (afterStop.Id !== containerId || afterStop.Config?.Labels?.['com.freshell.runtime-test-run-id'] !== rig.runtime.runId) {
        throw new Error('owned supervisor identity changed while stopping the GDB observer')
      }
      if (afterStop.State?.Running) {
        const targetState = rig.runtime.execOwnedContainerExact(containerId, [
          'python3', '-I', '-c', [
            'status={line.split(":",1)[0]:line.split(":",1)[1].strip() for line in open("/proc/1/status") if ":" in line}',
            'state=status.get("State", "?").split()[0]',
            'tracer_pid=status.get("TracerPid", "?")',
            'print(state, tracer_pid)',
          ].join('\n'),
        ]).trim()
        const [state, tracerPid] = targetState.split(/\s+/)
        if (!state || /[TtZX]/.test(state) || tracerPid !== '0') {
          throw new Error('supervisor did not resume and detach from the GDB observer')
        }
      }
      observerFinalized = true
    }
    cleanupObserver = stopObserver
    const observerWrapper = [
      'umask 077',
      'ulimit -c 0',
      'printf started > ' + shellQuote(observer.wrapperStartedPath),
      observerCommand + ' > ' + shellQuote(observer.launchOutputPath) + ' 2>&1 &',
      'observer_pid=$!',
      'printf "%s\\n" "$observer_pid" > ' + shellQuote(observer.pidPath),
      'wait "$observer_pid"',
      'status=$?',
      'printf "%s\\n" "$status" > ' + shellQuote(observer.exitPath),
      'exit "$status"',
    ].join('; ')
    failureOutputPaths = [observer.logPath, observer.launchOutputPath]
    failureStage = 'gdb_wrapper_start'
    rig.runtime.startOwnedContainerDetachedExact(containerId, ['/bin/sh', '-c', observerWrapper])
    const observerDeadline = Date.now() + 15_000
    await waitForFile(observer.wrapperStartedPath, 15_000, observer.exitPath, failureOutputPaths,
      'GDB wrapper-start marker', observerDeadline)
    failureStage = 'gdb_script_start'
    await waitForFile(observer.scriptStartedPath, 15_000, observer.exitPath, failureOutputPaths,
      'GDB script-start marker', observerDeadline)
    failureStage = 'gdb_attach'
    await waitForFile(observer.attachedPath, 15_000, observer.exitPath, failureOutputPaths,
      'GDB attach marker', observerDeadline)
    failureStage = undefined

    async function runProbe(mode: 'segv'): Promise<SupervisorCrashDiagnosticHandle['probes']['sigsegv']>
    async function runProbe(mode: 'term'): Promise<SupervisorCrashDiagnosticHandle['probes']['sigterm']>
    async function runProbe(mode: 'segv' | 'term'): Promise<
      SupervisorCrashDiagnosticHandle['probes']['sigsegv'] | SupervisorCrashDiagnosticHandle['probes']['sigterm']
    > {
      const prefix = path.join(captureRoot, mode)
      const paths = {
        pid: prefix + '.pid',
        targetExit: prefix + '.target-exit',
        gdbExit: prefix + '.gdb-exit',
        gdbAttached: prefix + '.gdb-attached',
        gdbCaptured: prefix + '.gdb-captured',
        log: prefix + '.gdb.log',
        launchOutput: prefix + '.gdb-launch.log',
        ready: path.join(captureRoot, mode === 'segv' ? 'segv-ready' : 'term-ready'),
        trigger: path.join(captureRoot, mode === 'segv' ? 'trigger-segv' : 'unused-trigger'),
        handled: path.join(captureRoot, 'term-handled'),
      }
      for (const file of Object.values(paths)) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true })
      }
      const targetWrapper = [
        'ulimit -c 0',
        shellQuote(helperBinary) + ' ' + mode + ' &',
        'target=$!',
        'printf "%s\\n" "$target" > ' + shellQuote(paths.pid),
        'wait "$target"',
        'status=$?',
        'printf "%s\\n" "$status" > ' + shellQuote(paths.targetExit),
        'exit "$status"',
      ].join('; ')
      rig.runtime.startOwnedContainerDetachedExact(containerId, ['/bin/sh', '-c', targetWrapper])
      await waitForFile(paths.ready, 5_000)
      const targetPidText = fs.readFileSync(paths.pid, 'utf8').trim()
      if (!/^\d+$/.test(targetPidText)) throw new Error('diagnostic target pid marker is malformed')
      const targetPid = Number(targetPidText)
      const scriptPath = path.join(bundleRoot, mode + '.gdb')
      fs.writeFileSync(scriptPath, gdbScript({
        pid: targetPid, libDir, logPath: paths.log, attachedPath: paths.gdbAttached,
        capturedPath: paths.gdbCaptured, includeBacktrace: mode === 'segv',
      }), { mode: 0o600 })
      createPrivateOutputFile(paths.launchOutput)
      const gdbWrapper = [
        'umask 077',
        'ulimit -c 0',
        gdbProgram(loader, libDir, gdbBin, dataDir, scriptPath) + ' > ' + shellQuote(paths.launchOutput) + ' 2>&1',
        'status=$?',
        'printf "%s\\n" "$status" > ' + shellQuote(paths.gdbExit),
        'exit "$status"',
      ].join('; ')
      rig.runtime.startOwnedContainerDetachedExact(containerId, ['/bin/sh', '-c', gdbWrapper])
      await waitForFile(paths.gdbAttached, 10_000, paths.gdbExit, [paths.log, paths.launchOutput])
      if (mode === 'segv') {
        fs.writeFileSync(paths.trigger, '', { mode: 0o600 })
      } else {
        const delivered = rig.runtime.execOwnedContainerExact(containerId, ['/bin/kill', '-TERM', String(targetPid)]).trim()
        if (delivered) throw new Error('SIGTERM delivery unexpectedly returned output')
      }
      await waitForFile(paths.targetExit, 10_000)
      await waitForFile(paths.gdbExit, 10_000)
      const targetExitCode = readStatus(paths.targetExit)
      const gdbExitCode = readStatus(paths.gdbExit)
      const log = parseSummary(paths.log)
      const workerThreads = new Set(log.frames.filter(frame => frame.symbol === 'worker').map(frame => frame.thread))
      const stillAlive = rig.runtime.execOwnedContainerExact(containerId, [
        '/bin/sh', '-c', '/bin/kill -0 ' + String(targetPid) + ' 2>/dev/null && printf yes || printf no',
      ]).trim() === 'yes'
      if (stillAlive) throw new Error('diagnostic target process was not reaped')
      if (mode === 'segv') {
        if (targetExitCode !== 139 || gdbExitCode !== 0 || log.signal !== 'SIGSEGV'
          || log.threadCount < 4 || workerThreads.size !== 3 || log.threadDebugUnavailable || !fs.existsSync(paths.gdbCaptured)) {
          throw new Error('same-rig SIGSEGV capture did not preserve the signal and all three worker stacks')
        }
        return { targetExitCode, gdbExitCode, threadCount: log.threadCount, workerThreadCount: workerThreads.size, frames: log.frames }
      }
      const handlerCleanup = fs.existsSync(paths.handled)
      if (targetExitCode !== 0 || gdbExitCode !== 0 || !handlerCleanup) {
        throw new Error('same-rig SIGTERM delivery or target cleanup failed')
      }
      return { targetExitCode, gdbExitCode, handlerCleanup, targetReaped: true }
    }

    const probes = {
      sigsegv: await runProbe('segv'),
      sigterm: await runProbe('term'),
    }
    return {
      policy,
      probes,
      async finalizeObserver(): Promise<SafeGdbSummary> {
        await stopObserver()
        return {
          ...parseSummary(observer.logPath, observer.exitPath),
          observerStopped: observerFinalized,
          observerStopRequested,
        }
      },
      collectObserver(): SafeGdbSummary {
        return {
          ...parseSummary(observer.logPath, observer.exitPath),
          observerStopped: observerFinalized,
          observerStopRequested,
        }
      },
      removeTemporaryFiles(): void {
        if (!observerFinalized && !fs.existsSync(observer.exitPath)) {
          throw new Error('GDB observer must finish before diagnostic files are removed')
        }
        fs.rmSync(captureRoot, { recursive: true, force: true })
        fs.rmSync(bundleRoot, { recursive: true, force: true })
      },
    }
  } catch (error) {
    let observerAttachFacts: SafeSupervisorGdbAttachFacts | undefined
    if (failureStage && collectObserverAttachFacts) {
      try { observerAttachFacts = collectObserverAttachFacts(failureStage) } catch { /* the GDB failure remains primary */ }
    }
    try { await cleanupObserver?.() } catch { /* rig teardown owns any observer that could not be settled here */ }
    if (failureOutputPaths.length > 0) {
      const [logPath, launchOutputPath] = failureOutputPaths
      const log = readBoundedTail(logPath)
      const launchOutput = readBoundedTail(launchOutputPath)
      try {
        rig.runtime.writeIncident('supervisor-gdb-diagnostic-startup-failure', {
          errorName: error instanceof Error ? error.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 60) || 'Error' : 'Error',
          errorMessage: error instanceof Error ? redactGdbDiagnosticLine(error.message) : 'unknown failure',
          ...(observerAttachFacts ? { observerAttachFacts } : {}),
          ...summarizeSupervisorGdbFailureOutput(log.text, launchOutput.text),
          logTruncated: log.truncated,
          launchOutputTruncated: launchOutput.truncated,
        })
      } catch { /* the original diagnostic failure remains primary */ }
    }
    fs.rmSync(captureRoot, { recursive: true, force: true })
    fs.rmSync(bundleRoot, { recursive: true, force: true })
    throw error
  }
}
