import { describe, expect, it } from 'vitest'
import { TabRegistryRecordSchema } from '../../../../src/store/tabRegistryTypes'

describe('TabRegistryRecordSchema (client)', () => {
  it('accepts open tab records with device metadata and revision', () => {
    const parsed = TabRegistryRecordSchema.parse({
      tabKey: 'device-1:tab-1',
      tabId: 'tab-1',
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

  it('accepts closed records with closedAt', () => {
    const parsed = TabRegistryRecordSchema.parse({
      tabKey: 'device-2:tab-1',
      tabId: 'tab-1',
      deviceId: 'device-2',
      deviceLabel: 'danshapiromain',
      tabName: 'freshell',
      status: 'closed',
      revision: 8,
      createdAt: 1739491200000,
      updatedAt: 1739577600000,
      closedAt: 1739577700000,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    })
    expect(parsed.status).toBe('closed')
  })
})
