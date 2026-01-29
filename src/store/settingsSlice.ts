import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { AppSettings } from './types'

export const defaultSettings: AppSettings = {
  theme: 'system',
  uiScale: 1.25, // 125% default for comfortable desktop viewing
  terminal: {
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: 1,
    cursorBlink: true,
    scrollback: 5000,
    theme: 'dark',
  },
  defaultCwd: undefined,
  safety: {
    autoKillIdleMinutes: 180,
    warnBeforeKillMinutes: 5,
  },
  sidebar: {
    sortMode: 'hybrid',
    showProjectBadges: true,
  },
}

export interface SettingsState {
  settings: AppSettings
  loaded: boolean
  lastSavedAt?: number
}

const initialState: SettingsState = {
  settings: defaultSettings,
  loaded: false,
}

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setSettings: (state, action: PayloadAction<AppSettings>) => {
      state.settings = action.payload
      state.loaded = true
    },
    updateSettingsLocal: (state, action: PayloadAction<Partial<AppSettings>>) => {
      state.settings = {
        ...state.settings,
        ...action.payload,
        terminal: { ...state.settings.terminal, ...(action.payload.terminal || {}) },
        safety: { ...state.settings.safety, ...(action.payload.safety || {}) },
        sidebar: { ...state.settings.sidebar, ...(action.payload.sidebar || {}) },
      }
    },
    markSaved: (state) => {
      state.lastSavedAt = Date.now()
    },
  },
})

export const { setSettings, updateSettingsLocal, markSaved } = settingsSlice.actions
export default settingsSlice.reducer
