import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const mockState = vi.hoisted(() => ({
  homeDir: process.env.TEMP || process.env.TMP || '/tmp',
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => mockState.homeDir },
    homedir: () => mockState.homeDir,
  }
})

import { ConfigStore } from '../../../server/config-store'

const KEY = 'claude:session-abc'

describe('ConfigStore session override title-source ladder', () => {
  let tempDir: string
  let store: ConfigStore

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'config-store-ladder-'))
    mockState.homeDir = tempDir
    store = new ConfigStore()
    await store.load()
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('keeps a finalized user title when an auto (first-message) write tries to downgrade it', async () => {
    await store.patchSessionOverride(KEY, { titleOverride: 'My Name', titleSource: 'user' })
    await store.patchSessionOverride(KEY, { titleOverride: 'Auto Title', titleSource: 'first-message' })

    const ov = await store.getSessionOverride(KEY)
    expect(ov?.titleOverride).toBe('My Name')
    expect(ov?.titleSource).toBe('user')
  })

  it('still applies non-title fields (archived) even while refusing the title downgrade', async () => {
    await store.patchSessionOverride(KEY, { titleOverride: 'My Name', titleSource: 'user' })
    await store.patchSessionOverride(KEY, { titleOverride: 'Auto', titleSource: 'ai', archived: true })

    const ov = await store.getSessionOverride(KEY)
    expect(ov?.titleOverride).toBe('My Name')
    expect(ov?.titleSource).toBe('user')
    expect(ov?.archived).toBe(true)
  })

  it('lets the first-message name replace the unfinalized dir placeholder', async () => {
    await store.patchSessionOverride(KEY, { titleOverride: 'freshell', titleSource: 'dir' })
    await store.patchSessionOverride(KEY, { titleOverride: 'Add login form', titleSource: 'first-message' })

    const ov = await store.getSessionOverride(KEY)
    expect(ov?.titleOverride).toBe('Add login form')
    expect(ov?.titleSource).toBe('first-message')
  })

  it('lets an explicit user rename override a finalized ai name', async () => {
    await store.patchSessionOverride(KEY, { titleOverride: 'AI generated', titleSource: 'ai' })
    await store.patchSessionOverride(KEY, { titleOverride: 'My Name', titleSource: 'user' })

    const ov = await store.getSessionOverride(KEY)
    expect(ov?.titleOverride).toBe('My Name')
    expect(ov?.titleSource).toBe('user')
  })

  it('does not gate a legacy title write that carries no source (back-compat)', async () => {
    await store.patchSessionOverride(KEY, { titleOverride: 'First', titleSource: 'user' })
    // A sourceless title write keeps the old blind-merge behaviour.
    await store.patchSessionOverride(KEY, { titleOverride: 'Sourceless' })

    const ov = await store.getSessionOverride(KEY)
    expect(ov?.titleOverride).toBe('Sourceless')
  })
})
