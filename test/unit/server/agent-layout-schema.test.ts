import { describe, it, expect } from 'vitest'
import { UiLayoutSyncSchema } from '../../../server/agent-api/layout-schema'

describe('UiLayoutSyncSchema', () => {
  it('accepts layout sync payloads', () => {
    const parsed = UiLayoutSyncSchema.safeParse({
      type: 'ui.layout.sync',
      tabs: [{ id: 'tab_a', title: 'alpha' }],
      activeTabId: 'tab_a',
      layouts: {},
      activePane: {},
      paneTitles: {},
      timestamp: Date.now(),
    })
    expect(parsed.success).toBe(true)
  })
})
