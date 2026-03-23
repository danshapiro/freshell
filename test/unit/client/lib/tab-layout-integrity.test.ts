import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import {
  detectMissingLayoutCorruption,
  isPaneBackedTab,
  validateWorkspaceSnapshot,
} from '@/lib/tab-layout-integrity'

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: overrides.id ?? 'tab-1',
    createRequestId: overrides.createRequestId ?? overrides.id ?? 'tab-1',
    title: overrides.title ?? 'Tab 1',
    status: overrides.status ?? 'creating',
    mode: overrides.mode ?? 'shell',
    shell: overrides.shell ?? 'system',
    createdAt: overrides.createdAt ?? 1,
    ...overrides,
  }
}

function makeLayout(overrides: Partial<Extract<PaneNode, { type: 'leaf' }>> = {}): PaneNode {
  return {
    type: 'leaf',
    id: overrides.id ?? 'pane-1',
    content: overrides.content ?? {
      kind: 'terminal',
      createRequestId: 'create-1',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    },
  }
}

describe('tab layout integrity helpers', () => {
  describe('isPaneBackedTab', () => {
    it('returns true for shell tabs, browser/editor tabs, PTY-backed coding tabs, and restored pane-backed tabs', () => {
      expect(isPaneBackedTab(makeTab({ mode: 'shell' }))).toBe(true)
      expect(isPaneBackedTab(makeTab({ mode: 'shell', title: 'Browser' }))).toBe(true)
      expect(isPaneBackedTab(makeTab({ mode: 'shell', title: 'Editor' }))).toBe(true)
      expect(isPaneBackedTab(makeTab({ mode: 'codex', resumeSessionId: 'codex-session' }))).toBe(true)
      expect(isPaneBackedTab(makeTab({ mode: 'claude', terminalId: 'term-1' }))).toBe(true)
    })

    it('returns false for coding session-view tabs', () => {
      expect(
        isPaneBackedTab(
          makeTab({
            mode: 'codex',
            codingCliSessionId: 'coding-session-1',
          }),
        ),
      ).toBe(false)
    })
  })

  describe('detectMissingLayoutCorruption', () => {
    it('reports corruption for pane-backed tabs with no layout', () => {
      expect(
        detectMissingLayoutCorruption({
          tab: makeTab({ id: 'broken-tab', mode: 'codex', resumeSessionId: 'resume-1' }),
          layout: undefined,
        }),
      ).toEqual({
        kind: 'missing-layout',
        tabId: 'broken-tab',
      })
    })

    it('reports corruption for pane-backed tabs with malformed layouts', () => {
      expect(
        detectMissingLayoutCorruption({
          tab: makeTab({ id: 'broken-tab', mode: 'shell' }),
          layout: {} as any,
        }),
      ).toEqual({
        kind: 'missing-layout',
        tabId: 'broken-tab',
      })
    })

    it('ignores session-view tabs and tabs with layouts', () => {
      expect(
        detectMissingLayoutCorruption({
          tab: makeTab({
            id: 'session-view-tab',
            mode: 'codex',
            codingCliSessionId: 'coding-session-1',
          }),
          layout: undefined,
        }),
      ).toBeNull()
      expect(
        detectMissingLayoutCorruption({
          tab: makeTab({ id: 'healthy-tab', mode: 'shell' }),
          layout: makeLayout(),
        }),
      ).toBeNull()
    })
  })

  describe('validateWorkspaceSnapshot', () => {
    it('accepts valid pane-backed tabs and session-view tabs', () => {
      expect(
        validateWorkspaceSnapshot({
          tabs: {
            tabs: [
              makeTab({ id: 'pane-tab', mode: 'shell' }),
              makeTab({
                id: 'session-view-tab',
                mode: 'codex',
                codingCliSessionId: 'coding-session-1',
              }),
            ],
            activeTabId: 'pane-tab',
            renameRequestTabId: null,
          },
          panes: {
            layouts: {
              'pane-tab': makeLayout(),
            },
          },
        }),
      ).toEqual({ ok: true })
    })

    it('rejects snapshots with pane-backed tabs missing layouts', () => {
      expect(
        validateWorkspaceSnapshot({
          tabs: {
            tabs: [
              makeTab({ id: 'tab-1', mode: 'shell' }),
              makeTab({ id: 'tab-2', mode: 'claude', resumeSessionId: 'claude-session-1' }),
            ],
            activeTabId: 'tab-1',
            renameRequestTabId: null,
          },
          panes: {
            layouts: {
              'tab-1': makeLayout(),
            },
          },
        }),
      ).toEqual({
        ok: false,
        missingLayoutTabIds: ['tab-2'],
      })
    })
  })
})
