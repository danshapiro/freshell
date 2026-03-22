import { describe, it, expect } from 'vitest'
import { UiLayoutSyncSchema } from '../../../server/agent-api/layout-schema'

describe('UiLayoutSyncSchema', () => {
  it('accepts layout sync payloads with durable title metadata', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{
        id: 'tab_a',
        title: 'alpha',
        titleSource: 'stable',
        fallbackSessionRef: {
          provider: 'codex',
          sessionId: 'older-open',
        },
      }],
      activeTabId: 'tab_a',
      layouts: {
        tab_a: {
          type: 'leaf',
          id: 'pane_1',
          content: { kind: 'terminal', terminalId: 'term_1', mode: 'codex', shell: 'system' },
        },
      },
      activePane: { tab_a: 'pane_1' },
      paneTitles: { tab_a: { pane_1: 'alpha' } },
      paneTitleSources: { tab_a: { pane_1: 'stable' } },
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.tabs[0]?.titleSource).toBe('stable')
    expect(parsed.data.paneTitleSources?.tab_a?.pane_1).toBe('stable')
    expect(parsed.data.tabs[0]?.fallbackSessionRef).toEqual({
      provider: 'codex',
      sessionId: 'older-open',
    })
  })

  it('remains tolerant of legacy payloads without durable title metadata', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{
        id: 'tab_a',
        title: 'alpha',
      }],
      activeTabId: 'tab_a',
      layouts: {},
      activePane: {},
      paneTitles: {},
      timestamp: Date.now(),
    })
    expect(parsed.success).toBe(true)
  })
})
