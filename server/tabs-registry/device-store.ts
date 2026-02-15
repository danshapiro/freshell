export type TabsDeviceRecord = {
  deviceId: string
  deviceLabel: string
  lastSeenAt: number
}

export class TabsDeviceStore {
  private readonly devices = new Map<string, TabsDeviceRecord>()

  upsert(deviceId: string, deviceLabel: string, lastSeenAt: number): void {
    const current = this.devices.get(deviceId)
    if (!current || lastSeenAt >= current.lastSeenAt) {
      this.devices.set(deviceId, { deviceId, deviceLabel, lastSeenAt })
    }
  }

  list(): TabsDeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }
}
