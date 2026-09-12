import { useCallback, useEffect, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { renameMachine } from '@/lib/api'
import { clearSelectedMachineId } from '@/lib/machine-identity'
import { updateSelectedMachine, type MachineIdentityState } from '@/store/machineIdentitySlice'
import { setTabRegistryDeviceMeta } from '@/store/tabRegistrySlice'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
} from './settings-controls'

/**
 * The wire protocol still calls this a device, but it is now the selected
 * server-owned machine. There is intentionally no local alias or delete
 * surface here: the server owns the canonical label and durable workspace.
 */
export default function DevicesSettings(_props: SettingsSectionProps) {
  const dispatch = useAppDispatch()
  const machineIdentity = useAppSelector(
    (state) => (state as unknown as { machineIdentity?: MachineIdentityState }).machineIdentity,
  )
  const machine = machineIdentity?.selectedMachine
  const [label, setLabel] = useState(machine?.label ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    setLabel(machine?.label ?? '')
  }, [machine?.id, machine?.label])

  const renameSelectedMachine = useCallback(async () => {
    const nextLabel = label.trim()
    if (!machine) {
      setError('No machine has been selected yet.')
      return
    }
    if (!nextLabel) {
      setError('Enter a machine name.')
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      const renamed = await renameMachine(machine.id, nextLabel)
      dispatch(updateSelectedMachine(renamed))
      // Keep the established wire fields canonical until the next hello/sync.
      dispatch(setTabRegistryDeviceMeta({
        deviceId: renamed.id,
        deviceLabel: renamed.label,
      }))
      setLabel(renamed.label)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rename this machine.')
    } finally {
      setSaving(false)
    }
  }, [dispatch, label, machine])

  const switchMachine = useCallback(() => {
    // The reload is a transport boundary. It stops the current tab-sync lane
    // before the chooser begins the next machine's scoped restoration.
    clearSelectedMachineId()
    window.location.reload()
  }, [])

  return (
    <SettingsSection
      title="Machine"
      description="This machine determines which saved workspace this Freshell client opens on this server."
    >
      <SettingsRow
        label="Current machine"
        description={machine ? 'Rename the machine shown to other Freshell clients.' : 'A machine is selected while Freshell starts.'}
      >
        <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center">
          <input
            type="text"
            value={label}
            disabled={!machine || saving}
            onChange={(event) => setLabel(event.target.value)}
            className="h-10 w-full min-w-[14rem] rounded-md border border-border bg-muted px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-[20rem]"
            aria-label="Machine name"
            placeholder="Machine name"
          />
          <button
            type="button"
            onClick={() => void renameSelectedMachine()}
            disabled={!machine || saving}
            className="h-10 shrink-0 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 md:h-8"
          >
            Rename machine
          </button>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Choose another machine"
        description="Open the chooser to use a different saved workspace or add this computer."
      >
        <button
          type="button"
          onClick={switchMachine}
          className="h-10 rounded-md border border-border px-3 text-sm hover:bg-muted md:h-8"
        >
          Switch machine
        </button>
      </SettingsRow>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </SettingsSection>
  )
}
