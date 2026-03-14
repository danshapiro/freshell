import { createAsyncThunk } from '@reduxjs/toolkit'

import { api } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { mergeServerSettings, stripLocalSettings, type ServerSettings, type ServerSettingsPatch } from '@shared/settings'
import { markSaved, previewServerSettingsPatch, setServerSettings, type SettingsState } from './settingsSlice'

const log = createLogger('settingsThunks')

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isServerSettings(value: unknown): value is ServerSettings {
  return (
    isRecord(value)
    && isRecord(value.logging)
    && isRecord(value.safety)
    && isRecord(value.terminal)
    && isRecord(value.panes)
    && isRecord(value.sidebar)
    && isRecord(value.codingCli)
    && isRecord(value.editor)
    && isRecord(value.agentChat)
    && isRecord(value.network)
  )
}

function normalizeCodingCliProviderPatchForApi(
  providerPatch: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedProviderPatch = { ...providerPatch }

  if (Object.prototype.hasOwnProperty.call(providerPatch, 'cwd') && providerPatch.cwd === undefined) {
    normalizedProviderPatch.cwd = null
  }
  if (Object.prototype.hasOwnProperty.call(providerPatch, 'model') && providerPatch.model === undefined) {
    normalizedProviderPatch.model = null
  }
  if (Object.prototype.hasOwnProperty.call(providerPatch, 'sandbox') && providerPatch.sandbox === undefined) {
    normalizedProviderPatch.sandbox = null
  }

  return normalizedProviderPatch
}

export function normalizeServerSettingsPatchForApi(patch: ServerSettingsPatch): ServerSettingsPatch | Record<string, unknown> {
  const normalizedPatch = isRecord(patch)
    ? { ...stripLocalSettings(patch) }
    : {}

  if (Object.prototype.hasOwnProperty.call(normalizedPatch, 'defaultCwd') && normalizedPatch.defaultCwd == null) {
    normalizedPatch.defaultCwd = ''
  }

  if (isRecord(normalizedPatch.codingCli) && isRecord(normalizedPatch.codingCli.providers)) {
    normalizedPatch.codingCli = {
      ...normalizedPatch.codingCli,
      providers: Object.fromEntries(
        Object.entries(normalizedPatch.codingCli.providers).map(([providerName, providerPatch]) => (
          [providerName, isRecord(providerPatch) ? normalizeCodingCliProviderPatchForApi(providerPatch) : providerPatch]
        )),
      ),
    }
  }

  return normalizedPatch
}

type SaveServerSettingsGetState = () => { settings: Pick<SettingsState, 'serverSettings'> }
type PendingServerSettingsPatch = {
  id: number
  patch: ServerSettingsPatch
}
type SaveServerSettingsPatchArgs = ServerSettingsPatch | {
  patch: ServerSettingsPatch
  confirmedServerSettings?: ServerSettings
}
type SaveServerSettingsPatchEnvelope = Extract<SaveServerSettingsPatchArgs, { patch: ServerSettingsPatch }>
type SaveServerSettingsState = {
  queue: Promise<void>
  confirmedServerSettings?: ServerSettings
  pendingPatches: PendingServerSettingsPatch[]
}

let saveServerSettingsStateByGetState = new WeakMap<SaveServerSettingsGetState, SaveServerSettingsState>()
let nextPendingServerSettingsPatchId = 1

type DispatchLike = (action: unknown) => unknown

export function resetServerSettingsSaveQueueForTests() {
  saveServerSettingsStateByGetState = new WeakMap()
  nextPendingServerSettingsPatchId = 1
}

function getOrCreateSaveServerSettingsState(getState: SaveServerSettingsGetState): SaveServerSettingsState {
  const existing = saveServerSettingsStateByGetState.get(getState)
  if (existing) {
    return existing
  }

  const created: SaveServerSettingsState = {
    queue: Promise.resolve(),
    pendingPatches: [],
  }
  saveServerSettingsStateByGetState.set(getState, created)
  return created
}

function isSaveServerSettingsPatchEnvelope(
  args: SaveServerSettingsPatchArgs,
): args is SaveServerSettingsPatchEnvelope {
  return isRecord(args) && Object.prototype.hasOwnProperty.call(args, 'patch')
}

function normalizeSaveServerSettingsPatchArgs(
  args: SaveServerSettingsPatchArgs,
): { patch: ServerSettingsPatch; confirmedServerSettings?: ServerSettings } {
  if (isSaveServerSettingsPatchEnvelope(args)) {
    const confirmedServerSettings = isServerSettings(args.confirmedServerSettings)
      ? args.confirmedServerSettings
      : undefined
    return {
      patch: isRecord(args.patch) ? args.patch : {},
      confirmedServerSettings,
    }
  }

  return {
    patch: isRecord(args) ? args : {},
  }
}

function buildVisibleServerSettings(
  confirmedServerSettings: ServerSettings,
  pendingPatches: PendingServerSettingsPatch[],
): ServerSettings {
  return pendingPatches.reduce(
    (settings, pendingPatch) => mergeServerSettings(settings, pendingPatch.patch),
    confirmedServerSettings,
  )
}

function reconcileVisibleServerSettings(
  dispatch: DispatchLike,
  saveState: SaveServerSettingsState,
) {
  if (!saveState.confirmedServerSettings) {
    return
  }

  dispatch(setServerSettings(
    buildVisibleServerSettings(saveState.confirmedServerSettings, saveState.pendingPatches),
  ))
}

function removePendingServerSettingsPatch(
  saveState: SaveServerSettingsState,
  patchId: number,
) {
  saveState.pendingPatches = saveState.pendingPatches.filter((pendingPatch) => pendingPatch.id !== patchId)
}

function queueServerSettingsSave(
  dispatch: DispatchLike,
  getState: SaveServerSettingsGetState,
  patch: ServerSettingsPatch,
  patchId: number,
) {
  const saveState = getOrCreateSaveServerSettingsState(getState)
  const run = async () => {
    try {
      const response = await api.patch('/api/settings', normalizeServerSettingsPatchForApi(patch))
      const confirmedServerSettings = saveState.confirmedServerSettings ?? getState().settings.serverSettings
      saveState.confirmedServerSettings = isServerSettings(response)
        ? response
        : mergeServerSettings(confirmedServerSettings, patch)
      removePendingServerSettingsPatch(saveState, patchId)
      reconcileVisibleServerSettings(dispatch, saveState)
      dispatch(markSaved())
    } catch (error) {
      removePendingServerSettingsPatch(saveState, patchId)
      reconcileVisibleServerSettings(dispatch, saveState)
      log.warn('Failed to save server settings patch', error)
      throw error
    }
  }

  const queued = saveState.queue.then(run, run)
  saveState.queue = queued.catch(() => {})
  return queued
}

export const saveServerSettingsPatch = createAsyncThunk(
  'settings/saveServerSettingsPatch',
  async (args: SaveServerSettingsPatchArgs, { dispatch, getState }) => {
    const { patch, confirmedServerSettings } = normalizeSaveServerSettingsPatchArgs(args)
    const typedGetState = getState as SaveServerSettingsGetState
    const saveState = getOrCreateSaveServerSettingsState(typedGetState)
    if (saveState.pendingPatches.length === 0) {
      saveState.confirmedServerSettings = confirmedServerSettings ?? typedGetState().settings.serverSettings
    }
    const patchId = nextPendingServerSettingsPatchId++
    saveState.pendingPatches = [...saveState.pendingPatches, { id: patchId, patch }]
    dispatch(previewServerSettingsPatch(patch))
    await queueServerSettingsSave(dispatch, typedGetState, patch, patchId)
  },
)
