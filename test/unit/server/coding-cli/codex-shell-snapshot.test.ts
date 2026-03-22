import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { readCodexShellSnapshotLaunchOrigin } from '../../../../server/coding-cli/codex-shell-snapshot'

describe('readCodexShellSnapshotLaunchOrigin', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-shell-snapshot-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('accepts both filename patterns and prefers the newest matching snapshot', async () => {
    const shellSnapshotsDir = path.join(tempDir, 'shell_snapshots')
    await fsp.mkdir(shellSnapshotsDir, { recursive: true })

    const sessionId = 'codex-session-1'
    const olderSnapshot = path.join(shellSnapshotsDir, `${sessionId}.sh`)
    const newerSnapshot = path.join(shellSnapshotsDir, `${sessionId}.1700000000000.sh`)

    await fsp.writeFile(
      olderSnapshot,
      [
        'export FRESHELL_TERMINAL_ID="term-older"',
        'export FRESHELL_TAB_ID="tab-older"',
        'export FRESHELL_PANE_ID="pane-older"',
      ].join('\n'),
    )
    await fsp.writeFile(
      newerSnapshot,
      [
        'export FRESHELL_TERMINAL_ID="term-newer"',
        'export FRESHELL_TAB_ID="tab-newer"',
        'export FRESHELL_PANE_ID="pane-newer"',
      ].join('\n'),
    )
    await fsp.utimes(olderSnapshot, new Date('2026-03-21T10:00:00Z'), new Date('2026-03-21T10:00:00Z'))
    await fsp.utimes(newerSnapshot, new Date('2026-03-21T10:01:00Z'), new Date('2026-03-21T10:01:00Z'))

    await expect(readCodexShellSnapshotLaunchOrigin(shellSnapshotsDir, sessionId)).resolves.toEqual({
      terminalId: 'term-newer',
      tabId: 'tab-newer',
      paneId: 'pane-newer',
    })
  })

  it('returns undefined when no matching snapshot exists', async () => {
    const shellSnapshotsDir = path.join(tempDir, 'shell_snapshots')
    await fsp.mkdir(shellSnapshotsDir, { recursive: true })

    await expect(
      readCodexShellSnapshotLaunchOrigin(shellSnapshotsDir, 'missing-session'),
    ).resolves.toBeUndefined()
  })

  it('ignores snapshot files that disappear between readdir and stat', async () => {
    const shellSnapshotsDir = path.join(tempDir, 'shell_snapshots')
    await fsp.mkdir(shellSnapshotsDir, { recursive: true })

    const sessionId = 'codex-session-1'
    const missingSnapshot = path.join(shellSnapshotsDir, `${sessionId}.1700000000000.sh`)
    const stableSnapshot = path.join(shellSnapshotsDir, `${sessionId}.1699999999000.sh`)

    await fsp.writeFile(missingSnapshot, 'export FRESHELL_TERMINAL_ID="term-missing"\n')
    await fsp.writeFile(
      stableSnapshot,
      [
        'export FRESHELL_TERMINAL_ID="term-stable"',
        'export FRESHELL_TAB_ID="tab-stable"',
      ].join('\n'),
    )

    const originalStat = fsp.stat.bind(fsp)
    vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
      if (String(filePath) === missingSnapshot) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return originalStat(filePath)
    })

    await expect(readCodexShellSnapshotLaunchOrigin(shellSnapshotsDir, sessionId)).resolves.toEqual({
      terminalId: 'term-stable',
      tabId: 'tab-stable',
    })
  })
})
