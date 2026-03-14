import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

import {
  composeResolvedSettings,
  createDefaultResolvedSettings,
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  mergeLocalSettings,
  mergeServerSettings,
  resolveLocalSettings,
  stripLocalSettings,
  type LocalSettings,
  type LocalSettingsPatch,
  type ResolvedSettings,
  type ServerSettings,
  type ServerSettingsPatch,
} from '@shared/settings'
import { loadBrowserPreferencesRecord, resolveBrowserPreferenceSettings } from '@/lib/browser-preferences'
import type { AppSettings } from './types'
import type { DeepPartial } from '@/lib/type-utils'

export function resolveDefaultLoggingDebug(isDev: boolean = import.meta.env.DEV): boolean {
  return !!isDev
}

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: resolveDefaultLoggingDebug(),
})

export const defaultSettings: AppSettings = createDefaultResolvedSettings({
  loggingDebug: resolveDefaultLoggingDebug(),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeServerPatch(value: unknown): ServerSettingsPatch {
  if (!isRecord(value)) {
    return {}
  }
  return stripLocalSettings(value) as ServerSettingsPatch
}

function normalizeLocalPatch(value: unknown): LocalSettingsPatch {
  if (!isRecord(value)) {
    return {}
  }
  return extractLegacyLocalSettingsSeed(value) ?? {}
}

function resolveServerSettings(settings: ServerSettings): ServerSettings {
  return mergeServerSettings(defaultServerSettings, normalizeServerPatch(settings))
}

function resolveSettings(serverSettings: ServerSettings, localSettings: LocalSettings): ResolvedSettings {
  return composeResolvedSettings(serverSettings, localSettings)
}

function toServerSettings(settings: ResolvedSettings): ServerSettings {
  return mergeServerSettings(
    createDefaultServerSettings({ loggingDebug: settings.logging.debug }),
    normalizeServerPatch(settings),
  )
}

function toLocalSettingsPatch(settings: ResolvedSettings | LocalSettings): LocalSettingsPatch {
  return normalizeLocalPatch(settings)
}

function loadInitialLocalSettings(): LocalSettings {
  return resolveBrowserPreferenceSettings(loadBrowserPreferencesRecord())
}

export interface SettingsState {
  serverSettings: ServerSettings
  localSettings: LocalSettings
  settings: ResolvedSettings
  loaded: boolean
  lastSavedAt?: number
}

const initialLocalSettings = loadInitialLocalSettings()

const initialState: SettingsState = {
  serverSettings: defaultServerSettings,
  localSettings: initialLocalSettings,
  settings: resolveSettings(defaultServerSettings, initialLocalSettings),
  loaded: false,
}

export function mergeSettings(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const serverSettings = mergeServerSettings(
    toServerSettings(base),
    normalizeServerPatch(patch),
  )
  const localSettings = resolveLocalSettings(
    mergeLocalSettings(toLocalSettingsPatch(base), normalizeLocalPatch(patch)),
  )

  return resolveSettings(serverSettings, localSettings)
}

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setServerSettings: (state, action: PayloadAction<ServerSettings>) => {
      state.serverSettings = resolveServerSettings(action.payload)
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
      state.loaded = true
    },
    setLocalSettings: (state, action: PayloadAction<LocalSettings>) => {
      state.localSettings = resolveLocalSettings(action.payload)
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
    },
    updateSettingsLocal: (state, action: PayloadAction<LocalSettingsPatch>) => {
      state.localSettings = resolveLocalSettings(
        mergeLocalSettings(toLocalSettingsPatch(state.localSettings), normalizeLocalPatch(action.payload)),
      )
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
    },
    previewServerSettingsPatch: (state, action: PayloadAction<ServerSettingsPatch>) => {
      state.serverSettings = mergeServerSettings(state.serverSettings, normalizeServerPatch(action.payload))
      state.settings = resolveSettings(state.serverSettings, state.localSettings)
    },
    markSaved: (state) => {
      state.lastSavedAt = Date.now()
    },
  },
})

export const {
  setServerSettings,
  setLocalSettings,
  updateSettingsLocal,
  previewServerSettingsPatch,
  markSaved,
} = settingsSlice.actions

export default settingsSlice.reducer
