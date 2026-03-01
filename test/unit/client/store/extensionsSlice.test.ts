import { describe, it, expect } from 'vitest'
import extensionsReducer, {
  setRegistry,
  updateServerStatus,
} from '../../../../src/store/extensionsSlice'
import type { ClientExtensionEntry } from '@shared/extension-types'

function makeEntry(overrides: Partial<ClientExtensionEntry> = {}): ClientExtensionEntry {
  return {
    name: 'test-ext',
    version: '1.0.0',
    label: 'Test Extension',
    description: 'A test extension',
    category: 'client',
    ...overrides,
  }
}

describe('extensionsSlice', () => {
  describe('initial state', () => {
    it('has empty entries array', () => {
      const state = extensionsReducer(undefined, { type: 'unknown' })
      expect(state.entries).toEqual([])
    })
  })

  describe('setRegistry', () => {
    it('populates entries', () => {
      const entries: ClientExtensionEntry[] = [
        makeEntry({ name: 'ext-a', label: 'Extension A' }),
        makeEntry({ name: 'ext-b', label: 'Extension B', category: 'server' }),
      ]

      const state = extensionsReducer(undefined, setRegistry(entries))

      expect(state.entries).toEqual(entries)
      expect(state.entries).toHaveLength(2)
    })

    it('replaces existing entries', () => {
      const oldEntries: ClientExtensionEntry[] = [
        makeEntry({ name: 'old-ext', label: 'Old Extension' }),
      ]
      const newEntries: ClientExtensionEntry[] = [
        makeEntry({ name: 'new-ext-a', label: 'New A' }),
        makeEntry({ name: 'new-ext-b', label: 'New B' }),
      ]

      const stateAfterFirst = extensionsReducer(undefined, setRegistry(oldEntries))
      expect(stateAfterFirst.entries).toHaveLength(1)

      const stateAfterSecond = extensionsReducer(stateAfterFirst, setRegistry(newEntries))
      expect(stateAfterSecond.entries).toEqual(newEntries)
      expect(stateAfterSecond.entries).toHaveLength(2)
      // Old entry should be gone
      expect(stateAfterSecond.entries.find((e) => e.name === 'old-ext')).toBeUndefined()
    })
  })

  describe('updateServerStatus', () => {
    it('updates matching extension serverRunning and serverPort', () => {
      const entries: ClientExtensionEntry[] = [
        makeEntry({ name: 'ext-a', serverRunning: false }),
        makeEntry({ name: 'ext-b', serverRunning: false }),
      ]

      const initial = extensionsReducer(undefined, setRegistry(entries))
      const state = extensionsReducer(
        initial,
        updateServerStatus({ name: 'ext-a', serverRunning: true, serverPort: 9001 })
      )

      const extA = state.entries.find((e) => e.name === 'ext-a')
      expect(extA?.serverRunning).toBe(true)
      expect(extA?.serverPort).toBe(9001)

      // ext-b should be untouched
      const extB = state.entries.find((e) => e.name === 'ext-b')
      expect(extB?.serverRunning).toBe(false)
      expect(extB?.serverPort).toBeUndefined()
    })

    it('is a no-op for unknown extension name', () => {
      const entries: ClientExtensionEntry[] = [
        makeEntry({ name: 'ext-a', serverRunning: false }),
      ]

      const initial = extensionsReducer(undefined, setRegistry(entries))
      const state = extensionsReducer(
        initial,
        updateServerStatus({ name: 'nonexistent', serverRunning: true, serverPort: 8080 })
      )

      // State should be unchanged
      expect(state.entries).toEqual(initial.entries)
    })
  })
})
