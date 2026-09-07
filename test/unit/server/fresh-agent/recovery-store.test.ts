// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  FreshAgentRecoveryStore,
  getFreshAgentRecoveryStore,
  resetFreshAgentRecoveryStoreForTests,
} from '../../../../server/fresh-agent/recovery-store.js'

describe('FreshAgentRecoveryStore', () => {
  let filePath: string
  beforeEach(async () => {
    filePath = path.join(await mkdtemp(path.join(tmpdir(), 'recovery-')), 'recovery.json')
  })

  it('persists interrupt intent across store instances (simulated restart)', async () => {
    const store = new FreshAgentRecoveryStore({ filePath })
    await store.recordInterrupt('ses_1')
    const reborn = new FreshAgentRecoveryStore({ filePath })
    expect(await reborn.hasInterrupt('ses_1')).toBe(true)
    await reborn.clearInterrupt('ses_1')
    expect(await new FreshAgentRecoveryStore({ filePath }).hasInterrupt('ses_1')).toBe(false)
  })

  it('records at most one recovery per (session, message) and persists it', async () => {
    const store = new FreshAgentRecoveryStore({ filePath })
    expect(await store.hasRecovery('ses_1', 'm2')).toBe(false)
    await store.recordRecovery('ses_1', 'm2')
    expect(await store.hasRecovery('ses_1', 'm2')).toBe(true)
    expect(await new FreshAgentRecoveryStore({ filePath }).hasRecovery('ses_1', 'm2')).toBe(true)
  })

  it('starts empty on a corrupt file instead of throwing', async () => {
    await writeFile(filePath, '{not json', 'utf8')
    const store = new FreshAgentRecoveryStore({ filePath })
    expect(await store.hasInterrupt('ses_1')).toBe(false)
    await store.recordInterrupt('ses_1') // and can still write
    expect(JSON.parse(await readFile(filePath, 'utf8')).version).toBe(1)
  })

  it('starts empty when the file is missing', async () => {
    const store = new FreshAgentRecoveryStore({ filePath })
    expect(await store.hasInterrupt('ses_1')).toBe(false)
    expect(await store.hasRecovery('ses_1', 'm1')).toBe(false)
  })

  it('caps interrupts at the 100 most recent entries (drops oldest on insert)', async () => {
    const store = new FreshAgentRecoveryStore({ filePath })
    for (let i = 0; i < 101; i++) {
      await store.recordInterrupt(`ses_${i}`)
    }
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(Object.keys(persisted.interrupts)).toHaveLength(100)
    expect(persisted.interrupts.ses_0).toBeUndefined()
    expect(persisted.interrupts.ses_100).toBeTypeOf('number')
    expect(await store.hasInterrupt('ses_0')).toBe(false)
    expect(await store.hasInterrupt('ses_100')).toBe(true)
  })

  it('caps per-session recoveries at the 100 most recent entries (drops oldest on insert)', async () => {
    const store = new FreshAgentRecoveryStore({ filePath })
    for (let i = 0; i < 101; i++) {
      await store.recordRecovery('ses_1', `m_${i}`)
    }
    await store.recordRecovery('ses_2', 'm_only')
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(Object.keys(persisted.recoveries.ses_1)).toHaveLength(100)
    expect(persisted.recoveries.ses_1.m_0).toBeUndefined()
    expect(persisted.recoveries.ses_1.m_100).toBeTypeOf('number')
    // Other sessions are untouched by ses_1's cap.
    expect(await store.hasRecovery('ses_2', 'm_only')).toBe(true)
    expect(await store.hasRecovery('ses_1', 'm_0')).toBe(false)
    expect(await store.hasRecovery('ses_1', 'm_100')).toBe(true)
  })

  it('does not lose updates from interleaved concurrent mutators', async () => {
    const store = new FreshAgentRecoveryStore({ filePath })
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => store.recordInterrupt(`ses_${i}`)),
      ...Array.from({ length: 10 }, (_, i) => store.recordRecovery('ses_x', `m_${i}`)),
    ])
    const reborn = new FreshAgentRecoveryStore({ filePath })
    for (let i = 0; i < 10; i++) {
      expect(await reborn.hasInterrupt(`ses_${i}`)).toBe(true)
      expect(await reborn.hasRecovery('ses_x', `m_${i}`)).toBe(true)
    }
  })

  it('clearInterrupt persists removal and is a no-op for unknown sessions', async () => {
    const store = new FreshAgentRecoveryStore({ filePath })
    await store.clearInterrupt('never_recorded') // must not throw
    await store.recordInterrupt('ses_1')
    await store.clearInterrupt('ses_1')
    expect(await store.hasInterrupt('ses_1')).toBe(false)
    expect(await new FreshAgentRecoveryStore({ filePath }).hasInterrupt('ses_1')).toBe(false)
  })

  describe('singleton', () => {
    beforeEach(() => {
      resetFreshAgentRecoveryStoreForTests()
    })

    it('getFreshAgentRecoveryStore returns the same lazy instance', () => {
      const a = getFreshAgentRecoveryStore()
      const b = getFreshAgentRecoveryStore()
      expect(a).toBeInstanceOf(FreshAgentRecoveryStore)
      expect(b).toBe(a)
    })

    it('resetFreshAgentRecoveryStoreForTests(filePath) pins the singleton to a test file', async () => {
      resetFreshAgentRecoveryStoreForTests(filePath)
      const store = getFreshAgentRecoveryStore()
      await store.recordInterrupt('ses_1')
      expect(JSON.parse(await readFile(filePath, 'utf8')).interrupts.ses_1).toBeTypeOf('number')
      resetFreshAgentRecoveryStoreForTests()
      expect(getFreshAgentRecoveryStore()).not.toBe(store)
    })
  })
})

describe('default path + FRESHELL_CONFIG_DIR', () => {
  it('persists to <configDir>/fresh-agent-recovery.json when no filePath is given', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'fx-config-dir-'))
    const original = { ...process.env }
    process.env.FRESHELL_CONFIG_DIR = configDir
    try {
      const store = new FreshAgentRecoveryStore()
      await store.recordInterrupt('ses_scoped')
      const expected = path.join(configDir, 'fresh-agent-recovery.json')
      const persisted = JSON.parse(await readFile(expected, 'utf8'))
      expect(persisted.interrupts.ses_scoped).toBeTypeOf('number')
    } finally {
      process.env = original
      const { rm } = await import('node:fs/promises')
      await rm(configDir, { recursive: true, force: true })
    }
  })
})
