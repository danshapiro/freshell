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
  it('uses server device metadata as the source of truth and preserves distinct ids with the same label', () => {
    const devices = buildKnownDevices({
      ownDeviceId: 'local-device',
      ownDeviceLabel: 'local-device',
      remoteOpen: [
        makeRecord({ deviceId: 'remote-a', deviceLabel: 'studio-mac', tabKey: 'remote-a:tab-1' }),
      ],
      devices: [
        { deviceId: 'remote-a', deviceLabel: 'studio-mac', lastSeenAt: 10 },
        { deviceId: 'remote-b', deviceLabel: 'studio-mac', lastSeenAt: 5 },
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
    expect(remoteDevices).toHaveLength(2)
    expect(remoteDevices.map((device) => device.deviceIds)).toEqual([['remote-a'], ['remote-b']])
    expect(remoteDevices.map((device) => device.baseLabel)).toEqual(['studio-mac', 'studio-mac'])
  })

  it('does not infer remote device rows from open tab records when server metadata is absent', () => {
    const devices = buildKnownDevices({
      ownDeviceId: 'local-device',
      ownDeviceLabel: 'local-device',
      remoteOpen: [
        makeRecord({ deviceId: 'remote-a', deviceLabel: 'studio-mac', tabKey: 'remote-a:tab-1' }),
      ],
      devices: [],
    })

    expect(devices).toHaveLength(1)
    expect(devices[0]?.isOwn).toBe(true)
  })

  it('hides dismissed device ids from the rendered list', () => {
    const devices = buildKnownDevices({
      ownDeviceId: 'local-device',
      ownDeviceLabel: 'local-device',
      dismissedDeviceIds: ['remote-a', 'remote-b'],
      remoteOpen: [
        makeRecord({ deviceId: 'remote-a', deviceLabel: 'studio-mac', tabKey: 'remote-a:tab-1' }),
      ],
      devices: [
        { deviceId: 'remote-a', deviceLabel: 'studio-mac', lastSeenAt: 10 },
        { deviceId: 'remote-b', deviceLabel: 'studio-mac', lastSeenAt: 5 },
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
