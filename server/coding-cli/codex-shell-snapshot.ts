import path from 'path'
import fsp from 'fs/promises'
import type { SessionLaunchOrigin } from './types.js'

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

function isMatchingSnapshotFile(fileName: string, sessionId: string): boolean {
  return fileName === `${sessionId}.sh` || (fileName.startsWith(`${sessionId}.`) && fileName.endsWith('.sh'))
}

export async function readCodexShellSnapshotLaunchOrigin(
  shellSnapshotsDir: string,
  sessionId: string,
): Promise<SessionLaunchOrigin | undefined> {
  let entries
  try {
    entries = await fsp.readdir(shellSnapshotsDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates = (entries as Array<{ name: string; isFile: () => boolean }>)
    .map((entry) => ({
      entry,
      fileName: entry.name,
    }))
    .filter(({ entry, fileName }) => entry.isFile() && isMatchingSnapshotFile(fileName, sessionId))
    .map(({ fileName }) => path.join(shellSnapshotsDir, fileName))

  if (candidates.length === 0) return undefined

  const dated: Array<{ filePath: string; stat: Awaited<ReturnType<typeof fsp.stat>> }> = []
  for (const filePath of candidates) {
    try {
      dated.push({
        filePath,
        stat: await fsp.stat(filePath),
      })
    } catch {
      // Snapshot files can disappear between readdir() and stat(); ignore the race.
    }
  }
  if (dated.length === 0) return undefined
  dated.sort((a, b) => Number(b.stat.mtimeMs) - Number(a.stat.mtimeMs))

  let content: string
  try {
    content = await fsp.readFile(dated[0]!.filePath, 'utf8')
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
