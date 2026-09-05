// test/unit/electron/desktop-config.profiles.test.ts
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockState = vi.hoisted(() => ({ homeDir: '' }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => mockState.homeDir },
    homedir: () => mockState.homeDir,
  }
})

import {
  getDefaultDesktopConfig,
  patchDesktopConfig,
  readDesktopConfig,
  writeDesktopConfig,
  _resetMutexForTesting,
} from '../../../electron/desktop-config.js'

// NOTE: `os.tmpdir()` still resolves to the REAL temp dir because the mock
// spreads `importOriginal` — only `homedir()` is overridden.

describe('desktop-config with explicit configDir', () => {
  let homeDir: string
  let dirA: string
  let dirB: string

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-home-'))
    mockState.homeDir = homeDir
    dirA = path.join(homeDir, '.freshell-work')
    dirB = path.join(homeDir, '.freshell-home')
    _resetMutexForTesting()
  })

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true })
    _resetMutexForTesting()
  })

  it('readDesktopConfig returns null when the given dir has no config', async () => {
    expect(await readDesktopConfig(dirA)).toBeNull()
  })

  it('write then read roundtrips inside the given dir only', async () => {
    const config = {
      ...getDefaultDesktopConfig(),
      setupCompleted: true,
      serverMode: 'remote' as const,
      remoteUrl: 'http://a.example',
    }
    await writeDesktopConfig(config, dirA)
    expect(await readDesktopConfig(dirA)).toEqual(config)
    expect(await readDesktopConfig(dirB)).toBeNull()
  })

  it('patched state stays within its own directory', async () => {
    await patchDesktopConfig({ globalHotkey: 'CommandOrControl+1' }, dirA)
    await patchDesktopConfig({ globalHotkey: 'CommandOrControl+2' }, dirB)
    expect((await readDesktopConfig(dirA))?.globalHotkey).toBe('CommandOrControl+1')
    expect((await readDesktopConfig(dirB))?.globalHotkey).toBe('CommandOrControl+2')
  })

  it('concurrent patches on the same dir are serialized and both apply', async () => {
    await Promise.all([
      patchDesktopConfig({ serverMode: 'remote', remoteUrl: 'http://a.example' }, dirA),
      patchDesktopConfig({ globalHotkey: 'CommandOrControl+9' }, dirA),
    ])
    const config = await readDesktopConfig(dirA)
    expect(config?.serverMode).toBe('remote')
    expect(config?.globalHotkey).toBe('CommandOrControl+9')
  })
})
