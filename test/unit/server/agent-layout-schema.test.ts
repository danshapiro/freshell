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
          provider: 'kimi',
          sessionId: 'team:alpha',
          cwd: '/repo/worktrees/app',
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
      provider: 'kimi',
      sessionId: 'team:alpha',
      cwd: '/repo/worktrees/app',
    })
  })
})
