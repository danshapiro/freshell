import { createAsyncThunk, type Middleware } from '@reduxjs/toolkit'

import { api } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { mergeServerSettings, stripLocalSettings, type ServerSettings, type ServerSettingsPatch } from '@shared/settings'
import { markSaved, setServerSettings, type SettingsState } from './settingsSlice'

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
  sequence: number
  patch: ServerSettingsPatch
}
type StagedServerSettingsPatch = {
  key: string
  sequence: number
  patch: ServerSettingsPatch
}
type StageServerSettingsPatchPreviewArgs = {
  key: string
  patch: ServerSettingsPatch
}
type SaveServerSettingsPatchArgs = ServerSettingsPatch | {
  patch: ServerSettingsPatch
  confirmedServerSettings?: ServerSettings
  stagedKey?: string
}
type SaveServerSettingsPatchEnvelope = Extract<SaveServerSettingsPatchArgs, { patch: ServerSettingsPatch }>
type SaveServerSettingsState = {
  queue: Promise<void>
  confirmedServerSettings?: ServerSettings
  pendingPatches: PendingServerSettingsPatch[]
  stagedPatches: StagedServerSettingsPatch[]
}
type SaveQueueMeta = {
  saveQueueReconcile?: boolean
}

let saveServerSettingsStateByGetState = new WeakMap<SaveServerSettingsGetState, SaveServerSettingsState>()
let nextPendingServerSettingsPatchId = 1
let nextServerSettingsPatchSequence = 1

type DispatchLike = (action: unknown) => unknown

export function resetServerSettingsSaveQueueForTests() {
  saveServerSettingsStateByGetState = new WeakMap()
  nextPendingServerSettingsPatchId = 1
  nextServerSettingsPatchSequence = 1
}

function getOrCreateSaveServerSettingsState(getState: SaveServerSettingsGetState): SaveServerSettingsState {
  const existing = saveServerSettingsStateByGetState.get(getState)
  if (existing) {
    return existing
  }

  const created: SaveServerSettingsState = {
    queue: Promise.resolve(),
    pendingPatches: [],
    stagedPatches: [],
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
): { patch: ServerSettingsPatch; confirmedServerSettings?: ServerSettings; stagedKey?: string } {
  if (isSaveServerSettingsPatchEnvelope(args)) {
    const confirmedServerSettings = isServerSettings(args.confirmedServerSettings)
      ? args.confirmedServerSettings
      : undefined
    return {
      patch: isRecord(args.patch) ? args.patch : {},
      confirmedServerSettings,
      stagedKey: typeof args.stagedKey === 'string' ? args.stagedKey : undefined,
    }
  }

  return {
    patch: isRecord(args) ? args : {},
  }
}

function buildVisibleServerSettings(
  confirmedServerSettings: ServerSettings,
  stagedPatches: StagedServerSettingsPatch[],
  pendingPatches: PendingServerSettingsPatch[],
): ServerSettings {
  return [...stagedPatches, ...pendingPatches]
    .sort((left, right) => left.sequence - right.sequence)
    .reduce(
    (settings, pendingPatch) => mergeServerSettings(settings, pendingPatch.patch),
    confirmedServerSettings,
  )
}

function isSaveQueueReconcileAction(action: unknown): boolean {
  return (
    isRecord(action)
    && isRecord(action.meta)
    && (action.meta as SaveQueueMeta).saveQueueReconcile === true
  )
}

function reconcileVisibleServerSettings(
  dispatch: DispatchLike,
  saveState: SaveServerSettingsState,
) {
  if (!saveState.confirmedServerSettings) {
    return
  }

  dispatch({
    ...setServerSettings(
      buildVisibleServerSettings(
        saveState.confirmedServerSettings,
        saveState.stagedPatches,
        saveState.pendingPatches,
      ),
    ),
    meta: { saveQueueReconcile: true },
  })
}

function removePendingServerSettingsPatch(
  saveState: SaveServerSettingsState,
  patchId: number,
) {
  saveState.pendingPatches = saveState.pendingPatches.filter((pendingPatch) => pendingPatch.id !== patchId)
}

function removeStagedServerSettingsPatch(
  saveState: SaveServerSettingsState,
  key: string,
) {
  saveState.stagedPatches = saveState.stagedPatches.filter((stagedPatch) => stagedPatch.key !== key)
}

function ensureConfirmedServerSettings(
  saveState: SaveServerSettingsState,
  getState: SaveServerSettingsGetState,
  confirmedServerSettings?: ServerSettings,
) {
  if (!saveState.confirmedServerSettings) {
    saveState.confirmedServerSettings = confirmedServerSettings ?? getState().settings.serverSettings
  }
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

export const serverSettingsSaveStateMiddleware: Middleware<
  {},
  { settings: Pick<SettingsState, 'serverSettings'> }
> = (storeApi) => (next) => (action) => {
  const result = next(action)

  if (!setServerSettings.match(action) || isSaveQueueReconcileAction(action)) {
    return result
  }

  const typedGetState = storeApi.getState as SaveServerSettingsGetState
  const saveState = saveServerSettingsStateByGetState.get(typedGetState)
  if (!saveState) {
    return result
  }

  saveState.confirmedServerSettings = action.payload
  if (saveState.pendingPatches.length > 0 || saveState.stagedPatches.length > 0) {
    storeApi.dispatch({
      ...setServerSettings(buildVisibleServerSettings(
        action.payload,
        saveState.stagedPatches,
        saveState.pendingPatches,
      )),
      meta: { saveQueueReconcile: true },
    })
  }

  return result
}

export function stageServerSettingsPatchPreview(args: StageServerSettingsPatchPreviewArgs) {
  return (dispatch: DispatchLike, getState: SaveServerSettingsGetState) => {
    if (typeof args.key !== 'string' || !args.key) {
      return
    }

    const saveState = getOrCreateSaveServerSettingsState(getState)
    ensureConfirmedServerSettings(saveState, getState)
    removeStagedServerSettingsPatch(saveState, args.key)
    saveState.stagedPatches = [
      ...saveState.stagedPatches,
      {
        key: args.key,
        patch: isRecord(args.patch) ? args.patch : {},
        sequence: nextServerSettingsPatchSequence++,
      },
    ]
    reconcileVisibleServerSettings(dispatch, saveState)
  }
}

export function discardStagedServerSettingsPatch(key: string) {
  return (dispatch: DispatchLike, getState: SaveServerSettingsGetState) => {
    if (typeof key !== 'string' || !key) {
      return
    }

    const saveState = getOrCreateSaveServerSettingsState(getState)
    if (!saveState.confirmedServerSettings) {
      return
    }

    removeStagedServerSettingsPatch(saveState, key)
    reconcileVisibleServerSettings(dispatch, saveState)
  }
}

export const saveServerSettingsPatch = createAsyncThunk(
  'settings/saveServerSettingsPatch',
  async (args: SaveServerSettingsPatchArgs, { dispatch, getState }) => {
    const { patch, confirmedServerSettings, stagedKey } = normalizeSaveServerSettingsPatchArgs(args)
    const typedGetState = getState as SaveServerSettingsGetState
    const saveState = getOrCreateSaveServerSettingsState(typedGetState)
    ensureConfirmedServerSettings(saveState, typedGetState, confirmedServerSettings)
    const stagedPatch = stagedKey
      ? saveState.stagedPatches.find((candidate) => candidate.key === stagedKey)
      : undefined
    if (stagedKey) {
      removeStagedServerSettingsPatch(saveState, stagedKey)
    }
    const patchId = nextPendingServerSettingsPatchId++
    const patchSequence = stagedPatch?.sequence ?? nextServerSettingsPatchSequence++
    saveState.pendingPatches = [
      ...saveState.pendingPatches,
      { id: patchId, sequence: patchSequence, patch },
    ]
    reconcileVisibleServerSettings(dispatch, saveState)
    await queueServerSettingsSave(dispatch, typedGetState, patch, patchId)
  },
)
