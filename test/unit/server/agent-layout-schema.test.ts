import { describe, it, expect } from 'vitest'
import { UiLayoutSyncSchema } from '../../../server/agent-api/layout-schema'

describe('UiLayoutSyncSchema', () => {
  it('accepts layout sync payloads', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{
        id: 'tab_a',
        title: 'alpha',
        fallbackSessionRef: {
          provider: 'codex',
          sessionId: 'older-open',
        },
      }],
      activeTabId: 'tab_a',
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.tabs[0]?.fallbackSessionRef).toEqual({
      provider: 'codex',
      sessionId: 'older-open',
    })
  })

  it('rejects fallbackSessionRef values that smuggle server locality into canonical identity', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{
        id: 'tab_a',
        title: 'alpha',
        fallbackSessionRef: {
          provider: 'codex',
          sessionId: 'older-open',
          serverInstanceId: 'srv-local',
        },
      }],
      activeTabId: 'tab_a',
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })

    expect(parsed.success).toBe(false)
  })
})
