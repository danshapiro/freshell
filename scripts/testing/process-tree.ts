import { spawnSync } from 'node:child_process'

export interface ProcessRecord {
  pid: number
  parentPid: number
  commandLine: string
}

export interface CommandResult {
  status: number | null
  stdout?: string
  stderr?: string
  error?: Error
}

type CommandRunner = (command: string, args: readonly string[]) => CommandResult

function runCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], { encoding: 'utf8' })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

function parsePositiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function commandExecutable(commandLine: string): string {
  const normalized = commandLine.replaceAll('\0', ' ').trim()
  if (!normalized) return ''

  if (normalized.startsWith('"')) {
    const closingQuote = normalized.indexOf('"', 1)
    return closingQuote === -1 ? normalized.slice(1) : normalized.slice(1, closingQuote)
  }

  return normalized.split(/\s+/, 1)[0] ?? ''
}

/**
 * Test the executable identity, rather than a substring anywhere in argv.
 * This keeps the source-runtime smoke test tied to the release artifact that
 * it is meant to start, including the `.exe` suffix used on Windows.
 */
export function isReleaseServerCommand(commandLine: string, platform: NodeJS.Platform): boolean {
  const executable = commandExecutable(commandLine).replaceAll('\\', '/')
  if (!executable) return false

  const normalized = platform === 'win32' ? executable.toLowerCase() : executable
  const suffix = platform === 'win32'
    ? 'target/release/freshell-server.exe'
    : 'target/release/freshell-server'

  return normalized === suffix || normalized.endsWith(`/${suffix}`)
}

/**
 * Return only descendants of the supplied owner, following every wrapper
 * process between npm and the Rust server. The owner itself is never returned.
 */
export function descendantPids(ownerPid: number, records: readonly ProcessRecord[]): number[] {
  const childrenByParent = new Map<number, number[]>()
  for (const record of records) {
    const children = childrenByParent.get(record.parentPid) ?? []
    children.push(record.pid)
    childrenByParent.set(record.parentPid, children)
  }

  const descendants: number[] = []
  const visited = new Set<number>([ownerPid])
  const queue = [ownerPid]
  while (queue.length > 0) {
    const parentPid = queue.shift()!
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      if (visited.has(childPid)) continue
      visited.add(childPid)
      descendants.push(childPid)
      queue.push(childPid)
    }
  }
  return descendants
}

/** Find the exact release server process owned by an npm-start process tree. */
export function findReleaseServerPid(
  ownerPid: number,
  records: readonly ProcessRecord[],
  platform: NodeJS.Platform,
): number | undefined {
  const byPid = new Map(records.map((record) => [record.pid, record]))
  return descendantPids(ownerPid, records)
    .map((pid) => byPid.get(pid))
    .find((record): record is ProcessRecord => record !== undefined && isReleaseServerCommand(record.commandLine, platform))
    ?.pid
}

function parsePosixSnapshot(stdout: string): ProcessRecord[] {
  const records: ProcessRecord[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/)
    if (!match) continue
    const pid = parsePositiveInteger(match[1])
    const parentPid = parsePositiveInteger(match[2])
    if (pid === undefined || parentPid === undefined) continue
    records.push({ pid, parentPid, commandLine: match[3] ?? '' })
  }
  return records
}

function parseWindowsSnapshot(stdout: string): ProcessRecord[] {
  if (!stdout.trim()) return []
  const parsed: unknown = JSON.parse(stdout)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const records: ProcessRecord[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    const pid = parsePositiveInteger(value.ProcessId)
    const parentPid = parsePositiveInteger(value.ParentProcessId)
    if (pid === undefined || parentPid === undefined) continue
    records.push({
      pid,
      parentPid,
      commandLine: typeof value.CommandLine === 'string' ? value.CommandLine : '',
    })
  }
  return records
}

/**
 * Read a process table using commands available on the host OS. The runner is
 * injectable so parsing and Windows behavior remain unit-testable without
 * spawning a shell or depending on a particular CI host.
 */
export function readProcessSnapshot(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = runCommand,
): ProcessRecord[] {
  if (platform === 'win32') {
    const result = runner('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
    ])
    if (result.error || result.status !== 0) {
      throw new Error(`could not read Windows process table: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`)
    }
    return parseWindowsSnapshot(result.stdout ?? '')
  }

  const result = runner('ps', ['-eo', 'pid=,ppid=,args='])
  if (result.error || result.status !== 0) {
    throw new Error(`could not read POSIX process table: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`)
  }
  return parsePosixSnapshot(result.stdout ?? '')
}
