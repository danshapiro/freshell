import { describe, expect, it } from 'vitest'
import { TabRegistryRecordSchema } from '../../../../server/tabs-registry/types.js'

describe('TabRegistryRecordSchema (server)', () => {
  it('accepts open tab records with device metadata and revision', () => {
    const parsed = TabRegistryRecordSchema.parse({
      tabKey: 'device-1:tab-1',
      tabId: 'tab-1',
      serverInstanceId: 'srv-test',
      deviceId: 'device-1',
      deviceLabel: 'danlaptop',
      tabName: 'freshell',
      status: 'open',
      revision: 7,
      createdAt: 1739491200000,
      updatedAt: 1739577600000,
      paneCount: 3,
      titleSetByUser: true,
      panes: [
        {
          paneId: 'pane-1',
          kind: 'terminal',
          payload: { shell: 'zsh' },
        },
      ],
    })
    expect(parsed.status).toBe('open')
  })

  it('rejects invalid status', () => {
    const result = TabRegistryRecordSchema.safeParse({
      tabKey: 'device-1:tab-1',
      tabId: 'tab-1',
      serverInstanceId: 'srv-test',
      deviceId: 'device-1',
      deviceLabel: 'danlaptop',
      tabName: 'freshell',
      status: 'detached',
      revision: 7,
      createdAt: 1739491200000,
      updatedAt: 1739577600000,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    })
    expect(result.success).toBe(false)
  })
})
