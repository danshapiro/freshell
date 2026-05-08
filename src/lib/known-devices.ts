export type KnownDevice = {
  key: string
  deviceIds: string[]
  baseLabel: string
  effectiveLabel: string
  isOwn: boolean
  lastSeenAt: number
}

type BuildKnownDevicesInput = {
  ownDeviceId: string
  ownDeviceLabel: string
  deviceAliases?: Record<string, string>
  dismissedDeviceIds?: string[]
  localOpen?: unknown[]
  sameDeviceOpen?: unknown[]
  remoteOpen?: unknown[]
  closed?: unknown[]
  devices?: Array<{ deviceId: string; deviceLabel: string; lastSeenAt: number }>
}

type DeviceGroup = {
  key: string
  deviceIds: string[]
  baseLabel: string
  isOwn: boolean
  lastSeenAt: number
}

function resolveEffectiveLabel(deviceIds: string[], aliases: Record<string, string>, fallbackLabel: string): string {
  for (const deviceId of deviceIds) {
    const alias = aliases[deviceId]
    if (alias?.trim()) {
      return alias
    }
  }
  return fallbackLabel
}

function upsertRemoteDevice(groups: Map<string, DeviceGroup>, device: { deviceId: string; deviceLabel: string; lastSeenAt: number }): void {
  const key = `remote:${device.deviceId}`
  const current = groups.get(key)
  if (!current) {
    groups.set(key, {
      key,
      deviceIds: [device.deviceId],
      baseLabel: device.deviceLabel,
      isOwn: false,
      lastSeenAt: device.lastSeenAt,
    })
    return
  }

  current.baseLabel = device.deviceLabel
  current.lastSeenAt = Math.max(current.lastSeenAt, device.lastSeenAt)
}

export function buildKnownDevices(input: BuildKnownDevicesInput): KnownDevice[] {
  const aliases = input.deviceAliases ?? {}
  const dismissedDeviceIds = new Set(input.dismissedDeviceIds ?? [])
  const groups = new Map<string, DeviceGroup>()

  groups.set(`own:${input.ownDeviceId}`, {
    key: `own:${input.ownDeviceId}`,
    deviceIds: [input.ownDeviceId],
    baseLabel: input.ownDeviceLabel,
    isOwn: true,
    lastSeenAt: Number.MAX_SAFE_INTEGER,
  })

  for (const device of input.devices ?? []) {
    if (device.deviceId === input.ownDeviceId || dismissedDeviceIds.has(device.deviceId)) continue
    upsertRemoteDevice(groups, device)
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      effectiveLabel: group.isOwn
        ? input.ownDeviceLabel
        : resolveEffectiveLabel(group.deviceIds, aliases, group.baseLabel),
    }))
    .sort((a, b) => {
      if (a.isOwn !== b.isOwn) {
        return Number(b.isOwn) - Number(a.isOwn)
      }
      return a.effectiveLabel.localeCompare(b.effectiveLabel)
    })
}
