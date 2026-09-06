// test/unit/electron/window-state.configdir.test.ts
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

import { createWindowStatePersistence } from '../../../electron/window-state.js'
import { readDesktopConfig, _resetMutexForTesting } from '../../../electron/desktop-config.js'

describe('window-state with explicit configDir', () => {
  let homeDir: string
  let dir: string

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-profile-'))
    mockState.homeDir = homeDir
    dir = path.join(homeDir, '.freshell-work')
    _resetMutexForTesting()
  })

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true })
    _resetMutexForTesting()
  })

  it('loads defaults when the dir has no config', async () => {
    const persistence = createWindowStatePersistence(dir)
    expect(await persistence.load()).toEqual({ width: 1200, height: 800, maximized: false })
  })

  it('saves window state into the given dir', async () => {
    const persistence = createWindowStatePersistence(dir)
    await persistence.save({ x: 1, y: 2, width: 1000, height: 700, maximized: true })
    const config = await readDesktopConfig(dir)
    expect(config?.windowState).toEqual({ x: 1, y: 2, width: 1000, height: 700, maximized: true })
  })
})
