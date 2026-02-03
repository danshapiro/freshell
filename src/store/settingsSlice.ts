import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { AppSettings } from './types'

export const defaultSettings: AppSettings = {
  theme: 'system',
  uiScale: 1.0, // 100% = UI text matches terminal font size
  terminal: {
    fontSize: 16,
    fontFamily: 'Menlo, Monaco, Consolas, monospace',
    lineHeight: 1,
    cursorBlink: true,
    scrollback: 5000,
    theme: 'auto',
  },
  defaultCwd: undefined,
  safety: {
    autoKillIdleMinutes: 180,
    warnBeforeKillMinutes: 5,
  },
  sidebar: {
    sortMode: 'hybrid',
    showProjectBadges: true,
    width: 288,
    collapsed: false,
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
