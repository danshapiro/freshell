import { createAsyncThunk } from '@reduxjs/toolkit'

import { api } from '@/lib/api'
import { stripLocalSettings, type ServerSettingsPatch } from '@shared/settings'
import { markSaved, previewServerSettingsPatch } from './settingsSlice'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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

let saveServerSettingsQueue: Promise<void> = Promise.resolve()

type DispatchLike = (action: unknown) => unknown

export function resetServerSettingsSaveQueueForTests() {
  saveServerSettingsQueue = Promise.resolve()
}

function queueServerSettingsSave(dispatch: DispatchLike, patch: ServerSettingsPatch) {
  const run = async () => {
    await api.patch('/api/settings', normalizeServerSettingsPatchForApi(patch))
    dispatch(markSaved())
  }

  const queued = saveServerSettingsQueue.then(run, run)
  saveServerSettingsQueue = queued.catch(() => {})
  return queued
}

export const saveServerSettingsPatch = createAsyncThunk(
  'settings/saveServerSettingsPatch',
  async (patch: ServerSettingsPatch, { dispatch }) => {
    dispatch(previewServerSettingsPatch(patch))
    await queueServerSettingsSave(dispatch, patch)
  },
)
