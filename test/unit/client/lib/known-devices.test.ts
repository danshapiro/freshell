import { describe, expect, it } from 'vitest'
import { buildKnownDevices } from '@/lib/known-devices'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'

function makeRecord(overrides: Partial<RegistryTabRecord>): RegistryTabRecord {
  return {
    tabKey: 'remote-a:tab-1',
    tabId: 'tab-1',
    serverInstanceId: 'srv-test',
    deviceId: 'remote-a',
    deviceLabel: 'studio-mac',
    tabName: 'work item',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

describe('buildKnownDevices', () => {
  it('deduplicates remote devices that share the same stored machine label', () => {
    const devices = buildKnownDevices({
      ownDeviceId: 'local-device',
      ownDeviceLabel: 'local-device',
      remoteOpen: [
        makeRecord({ deviceId: 'remote-a', deviceLabel: 'studio-mac', tabKey: 'remote-a:tab-1' }),
      ],
      closed: [
        makeRecord({
          deviceId: 'remote-b',
          deviceLabel: 'studio-mac',
          tabKey: 'remote-b:tab-2',
          tabId: 'tab-2',
          status: 'closed',
          closedAt: 5,
          updatedAt: 5,
        }),
      ],
    })

    const remoteDevices = devices.filter((device) => !device.isOwn)
    expect(remoteDevices).toHaveLength(1)
    expect(remoteDevices[0]?.baseLabel).toBe('studio-mac')
    expect([...(remoteDevices[0]?.deviceIds || [])].sort()).toEqual(['remote-a', 'remote-b'])
  })

  it('hides dismissed device ids from the rendered list', () => {
    const devices = buildKnownDevices({
      ownDeviceId: 'local-device',
      ownDeviceLabel: 'local-device',
      dismissedDeviceIds: ['remote-a', 'remote-b'],
      remoteOpen: [
        makeRecord({ deviceId: 'remote-a', deviceLabel: 'studio-mac', tabKey: 'remote-a:tab-1' }),
      ],
      closed: [
        makeRecord({
          deviceId: 'remote-b',
          deviceLabel: 'studio-mac',
          tabKey: 'remote-b:tab-2',
          tabId: 'tab-2',
          status: 'closed',
          closedAt: 5,
          updatedAt: 5,
        }),
      ],
    })

    expect(devices).toHaveLength(1)
    expect(devices[0]?.isOwn).toBe(true)
  })
})
