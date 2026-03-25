// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildAgentChatBrowserStorageSeed,
  buildOffscreenTabBrowserStorageSeed,
  buildTerminalBrowserStorageSeed,
} from '@test/e2e-browser/perf/seed-browser-storage'
import { parsePersistedPanesRaw, parsePersistedTabsRaw } from '@/store/persistedState'

describe('visible-first browser storage seeds', () => {
  it('returns schema-compatible tabs and panes payloads', () => {
    const seed = buildOffscreenTabBrowserStorageSeed()
    expect(Object.keys(seed).sort()).toEqual([
      'freshell.panes.v2',
      'freshell.tabs.v2',
      'freshell_version',
    ])
    expect(seed.freshell_version).toBe('3')
    expect(parsePersistedTabsRaw(seed['freshell.tabs.v2'])).not.toBeNull()
    expect(parsePersistedPanesRaw(seed['freshell.panes.v2'])).not.toBeNull()
  })

  it('builds a focused agent-chat layout around the deterministic long-history session', () => {
    const seed = buildAgentChatBrowserStorageSeed()
    const parsedPanes = parsePersistedPanesRaw(seed['freshell.panes.v2'])
    expect(parsedPanes).not.toBeNull()
    expect(JSON.stringify(parsedPanes?.layouts)).toContain('00000000-0000-4000-8000-000000000241')
  })

  it('builds a focused terminal layout for the terminal-first scenarios', () => {
    const seed = buildTerminalBrowserStorageSeed()
    const parsedTabs = parsePersistedTabsRaw(seed['freshell.tabs.v2'])
    const parsedPanes = parsePersistedPanesRaw(seed['freshell.panes.v2'])
    expect(parsedTabs?.tabs.activeTabId).toBe('tab-terminal-audit')
    expect(JSON.stringify(parsedPanes?.layouts)).toContain('"kind":"terminal"')
    expect(JSON.stringify(parsedPanes?.layouts)).toContain('terminal-audit-create')
  })
})
