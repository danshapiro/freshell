import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const mockState = vi.hoisted(() => ({ homeDir: '' }))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => mockState.homeDir },
    homedir: () => mockState.homeDir,
  }
})

import { createWindowStatePersistence } from '../../../electron/window-state.js'
import { writeDesktopConfig, getDefaultDesktopConfig } from '../../../electron/desktop-config.js'

describe('WindowStatePersistence', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'window-state-test-'))
    mockState.homeDir = tempDir
  })

  afterEach(async () => {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('returns defaults when no persisted state exists', async () => {
    const persistence = createWindowStatePersistence()
    const state = await persistence.load()
    expect(state.width).toBe(1200)
    expect(state.height).toBe(800)
    expect(state.maximized).toBe(false)
    expect(state.x).toBeUndefined()
    expect(state.y).toBeUndefined()
  })

  it('returns defaults when config exists but has no windowState', async () => {
    await writeDesktopConfig(getDefaultDesktopConfig())
    const persistence = createWindowStatePersistence()
    const state = await persistence.load()
    expect(state.width).toBe(1200)
    expect(state.height).toBe(800)
  })

  it('loads and returns persisted state', async () => {
    await writeDesktopConfig({
      ...getDefaultDesktopConfig(),
      windowState: { x: 100, y: 200, width: 1400, height: 900, maximized: true },
    })

    const persistence = createWindowStatePersistence()
    const state = await persistence.load()
    expect(state.x).toBe(100)
    expect(state.y).toBe(200)
    expect(state.width).toBe(1400)
    expect(state.height).toBe(900)
    expect(state.maximized).toBe(true)
  })

  it('saves state via patchDesktopConfig', async () => {
    await writeDesktopConfig(getDefaultDesktopConfig())
    const persistence = createWindowStatePersistence()

    await persistence.save({ x: 50, y: 75, width: 1600, height: 1000, maximized: false })

    const loaded = await persistence.load()
    expect(loaded.x).toBe(50)
    expect(loaded.y).toBe(75)
    expect(loaded.width).toBe(1600)
    expect(loaded.height).toBe(1000)
    expect(loaded.maximized).toBe(false)
  })
})
