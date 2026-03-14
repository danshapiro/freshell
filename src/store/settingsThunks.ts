import { createAsyncThunk } from '@reduxjs/toolkit'

import { api } from '@/lib/api'
import { stripLocalSettings, type ServerSettingsPatch } from '@shared/settings'
import { markSaved, previewServerSettingsPatch } from './settingsSlice'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeServerSettingsPatchForApi(patch: ServerSettingsPatch): ServerSettingsPatch | Record<string, unknown> {
  const normalizedPatch = isRecord(patch)
    ? { ...stripLocalSettings(patch) }
    : {}

  if (Object.prototype.hasOwnProperty.call(normalizedPatch, 'defaultCwd') && normalizedPatch.defaultCwd == null) {
    normalizedPatch.defaultCwd = ''
  }

  return normalizedPatch
}

export const saveServerSettingsPatch = createAsyncThunk(
  'settings/saveServerSettingsPatch',
  async (patch: ServerSettingsPatch, { dispatch }) => {
    dispatch(previewServerSettingsPatch(patch))
    await api.patch('/api/settings', normalizeServerSettingsPatchForApi(patch))
    dispatch(markSaved())
  },
)
