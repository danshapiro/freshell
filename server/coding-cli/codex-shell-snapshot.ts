import path from 'path'
import fsp from 'fs/promises'
import type { SessionLaunchOrigin } from './types.js'

type SnapshotCandidate = {
  filePath: string
  mtimeMs: number
}

export type CodexShellSnapshotIndex = Map<string, SnapshotCandidate>
export type CodexShellSnapshotIndexCache = Map<string, Promise<CodexShellSnapshotIndex>>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && (trimmed[0] === '"' || trimmed[0] === '\'')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseShellAssignment(content: string, name: string): string | undefined {
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(name)}=(.+)$`, 'm')
  const value = content.match(pattern)?.[1]?.trim()
  return value ? unquote(value) : undefined
}

function extractSessionIdFromSnapshotFile(fileName: string): string | undefined {
  if (!fileName.endsWith('.sh')) return undefined
  const stem = fileName.slice(0, -3)
  if (!stem) return undefined
  const separatorIndex = stem.indexOf('.')
  return separatorIndex >= 0 ? stem.slice(0, separatorIndex) : stem
}

async function loadCodexShellSnapshotIndex(shellSnapshotsDir: string): Promise<CodexShellSnapshotIndex> {
  let entries
  try {
    entries = await fsp.readdir(shellSnapshotsDir, { withFileTypes: true })
  } catch {
    return new Map()
  }

  const latestBySessionId: CodexShellSnapshotIndex = new Map()
  for (const entry of entries as Array<{ name: string; isFile: () => boolean }>) {
    if (!entry.isFile()) continue

    const sessionId = extractSessionIdFromSnapshotFile(entry.name)
    if (!sessionId) continue

    const filePath = path.join(shellSnapshotsDir, entry.name)
    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      // Snapshot files can disappear between readdir() and stat(); ignore the race.
      continue
    }

    const previous = latestBySessionId.get(sessionId)
    const mtimeMs = Number(stat.mtimeMs)
    if (!previous || mtimeMs > previous.mtimeMs) {
      latestBySessionId.set(sessionId, { filePath, mtimeMs })
    }
  }

  return latestBySessionId
}

async function getCodexShellSnapshotIndex(
  shellSnapshotsDir: string,
  directoryIndexCache?: CodexShellSnapshotIndexCache,
): Promise<CodexShellSnapshotIndex> {
  if (!directoryIndexCache) {
    return loadCodexShellSnapshotIndex(shellSnapshotsDir)
  }

  let inFlight = directoryIndexCache.get(shellSnapshotsDir)
  if (!inFlight) {
    inFlight = loadCodexShellSnapshotIndex(shellSnapshotsDir)
    directoryIndexCache.set(shellSnapshotsDir, inFlight)
  }

  try {
    return await inFlight
  } catch {
    directoryIndexCache.delete(shellSnapshotsDir)
    return new Map()
  }
}

export async function readCodexShellSnapshotLaunchOrigin(
  shellSnapshotsDir: string,
  sessionId: string,
  directoryIndexCache?: CodexShellSnapshotIndexCache,
): Promise<SessionLaunchOrigin | undefined> {
  const index = await getCodexShellSnapshotIndex(shellSnapshotsDir, directoryIndexCache)
  const candidate = index.get(sessionId)
  if (!candidate) return undefined

  let content: string
  try {
    content = await fsp.readFile(candidate.filePath, 'utf8')
  } catch {
    return undefined
  }

  const terminalId = parseShellAssignment(content, 'FRESHELL_TERMINAL_ID')
  if (!terminalId) return undefined

  const tabId = parseShellAssignment(content, 'FRESHELL_TAB_ID')
  const paneId = parseShellAssignment(content, 'FRESHELL_PANE_ID')
  return {
    terminalId,
    ...(tabId ? { tabId } : {}),
    ...(paneId ? { paneId } : {}),
  }
}
