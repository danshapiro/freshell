import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  dismissDeviceIds,
  persistDeviceAliasesForDevices,
  persistOwnDeviceLabel,
  setTabRegistryDeviceAliases,
  setTabRegistryDismissedDeviceIds,
  setTabRegistryDeviceLabel,
} from '@/store/tabRegistrySlice'
import { buildKnownDevices, type KnownDevice } from '@/lib/known-devices'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
} from './settings-controls'

export default function DevicesSettings(_props: SettingsSectionProps) {
  const dispatch = useAppDispatch()
  const tabRegistryState = useAppSelector((s) => (s as any).tabRegistry)
  const fallbackTabRegistry = useMemo(() => ({
    deviceId: 'local-device',
    deviceLabel: 'local-device',
    deviceAliases: {} as Record<string, string>,
    dismissedDeviceIds: [] as string[],
    localOpen: [],
    sameDeviceOpen: [],
    remoteOpen: [],
    closed: [],
    devices: [],
  }), [])
  const tabRegistry = tabRegistryState ?? fallbackTabRegistry
  const [deviceNameInputs, setDeviceNameInputs] = useState<Record<string, string>>({})

  const knownDevices = useMemo(() => {
    return buildKnownDevices({
      ownDeviceId: tabRegistry.deviceId,
      ownDeviceLabel: tabRegistry.deviceLabel,
      deviceAliases: tabRegistry.deviceAliases,
      dismissedDeviceIds: tabRegistry.dismissedDeviceIds,
      localOpen: tabRegistry.localOpen,
      sameDeviceOpen: tabRegistry.sameDeviceOpen,
      remoteOpen: tabRegistry.remoteOpen,
      closed: tabRegistry.closed,
      devices: tabRegistry.devices,
    })
  }, [tabRegistry])

  useEffect(() => {
    setDeviceNameInputs((current) => {
      const next: Record<string, string> = {}
      for (const device of knownDevices) {
        next[device.key] = current[device.key] ?? device.effectiveLabel
      }
      const changed =
        Object.keys(current).length !== Object.keys(next).length ||
        Object.entries(next).some(([key, value]) => current[key] !== value)
      return changed ? next : current
    })
  }, [knownDevices])

  const saveDeviceName = useCallback((device: KnownDevice) => {
    const nextValue = (deviceNameInputs[device.key] || '').trim()
    if (device.isOwn) {
      const persisted = persistOwnDeviceLabel(nextValue || tabRegistry.deviceLabel)
      dispatch(setTabRegistryDeviceLabel(persisted))
      setDeviceNameInputs((current) => ({ ...current, [device.key]: persisted }))
      return
    }
    const aliases = persistDeviceAliasesForDevices(device.deviceIds, nextValue || undefined)
    dispatch(setTabRegistryDeviceAliases(aliases))
    setDeviceNameInputs((current) => ({
      ...current,
      [device.key]: device.deviceIds.map((deviceId) => aliases[deviceId]).find(Boolean) || device.baseLabel,
    }))
  }, [deviceNameInputs, dispatch, tabRegistry.deviceLabel])

  const deleteDevice = useCallback((device: KnownDevice) => {
    if (device.isOwn) return

    const aliases = persistDeviceAliasesForDevices(device.deviceIds, undefined)
    const dismissedIds = dismissDeviceIds(device.deviceIds)
    dispatch(setTabRegistryDeviceAliases(aliases))
    dispatch(setTabRegistryDismissedDeviceIds(dismissedIds))
    setDeviceNameInputs((current) => {
      const next = { ...current }
      delete next[device.key]
      return next
    })
  }, [dispatch])

  return (
    <SettingsSection
      title="Devices"
      description="Rename devices for the Tabs workspace. Remote device aliases apply only on this machine."
    >
      {knownDevices.map((device) => (
        <SettingsRow
          key={device.key}
          label={device.isOwn ? 'This machine' : device.baseLabel}
          description={device.isOwn ? 'Renaming this updates what other machines see.' : 'Alias stored locally on this machine only.'}
        >
          <div className="flex w-full items-center gap-2 md:w-auto">
            <input
              type="text"
              value={deviceNameInputs[device.key] ?? device.effectiveLabel}
              onChange={(event) => setDeviceNameInputs((current) => ({
                ...current,
                [device.key]: event.target.value,
              }))}
              className="h-10 w-full min-w-[14rem] px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-[20rem]"
              aria-label={`Device name for ${device.effectiveLabel}`}
              placeholder={device.baseLabel}
            />
            <button
              type="button"
              onClick={() => saveDeviceName(device)}
              className="h-10 px-3 text-sm rounded-md border border-border hover:bg-muted md:h-8"
            >
              Save
            </button>
            {!device.isOwn ? (
              <button
                type="button"
                onClick={() => deleteDevice(device)}
                className="h-10 px-3 text-sm rounded-md border border-border hover:bg-muted md:h-8"
                aria-label={`Delete device ${device.effectiveLabel}`}
              >
                Delete
              </button>
            ) : null}
          </div>
        </SettingsRow>
      ))}
    </SettingsSection>
  )
}
