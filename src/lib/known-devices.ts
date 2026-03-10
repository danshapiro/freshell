import type { RegistryTabRecord } from '@/store/tabRegistryTypes'

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
  localOpen?: RegistryTabRecord[]
  remoteOpen?: RegistryTabRecord[]
  closed?: RegistryTabRecord[]
}

type DeviceGroup = {
  key: string
  deviceIds: string[]
  baseLabel: string
  isOwn: boolean
  lastSeenAt: number
}

function pushUnique(values: string[], value: string): void {
  if (!value || values.includes(value)) return
  values.push(value)
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

function upsertRemoteGroup(groups: Map<string, DeviceGroup>, record: RegistryTabRecord): void {
  // Collapse device-id rotations from the same machine into one row using the stored machine label.
  const key = `remote:${record.deviceLabel}`
  const current = groups.get(key)
  if (!current) {
    groups.set(key, {
      key,
      deviceIds: [record.deviceId],
      baseLabel: record.deviceLabel,
      isOwn: false,
      lastSeenAt: record.closedAt ?? record.updatedAt,
    })
    return
  }

  pushUnique(current.deviceIds, record.deviceId)
  current.lastSeenAt = Math.max(current.lastSeenAt, record.closedAt ?? record.updatedAt)
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

  for (const record of [
    ...(input.localOpen ?? []),
    ...(input.remoteOpen ?? []),
    ...(input.closed ?? []),
  ]) {
    if (record.deviceId === input.ownDeviceId) {
      continue
    }
    if (dismissedDeviceIds.has(record.deviceId)) {
      continue
    }
    upsertRemoteGroup(groups, record)
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
