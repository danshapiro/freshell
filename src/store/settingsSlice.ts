import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { AppSettings, SidebarSortMode } from './types'

export const defaultSettings: AppSettings = {
  theme: 'system',
  uiScale: 1.0, // 100% = UI text matches terminal font size
  terminal: {
    fontSize: 16,
    fontFamily: 'Consolas',
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
    sortMode: 'activity',
    showProjectBadges: true,
    width: 288,
    collapsed: false,
  },
  panes: {
    defaultNewPane: 'ask' as const,
  },
}

export function migrateSortMode(mode: string | undefined): SidebarSortMode {
  if (mode === 'recency' || mode === 'activity' || mode === 'project') {
    return mode
  }
  return 'activity'
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
      state.settings = {
        ...action.payload,
        sidebar: {
          ...action.payload.sidebar,
          sortMode: migrateSortMode(action.payload.sidebar?.sortMode),
        },
      }
      state.loaded = true
    },
    updateSettingsLocal: (state, action: PayloadAction<Partial<AppSettings>>) => {
      const currentSidebar = state.settings.sidebar ?? defaultSettings.sidebar
      state.settings = {
        ...state.settings,
        ...action.payload,
        terminal: { ...state.settings.terminal, ...(action.payload.terminal || {}) },
        safety: { ...state.settings.safety, ...(action.payload.safety || {}) },
        sidebar: {
          ...currentSidebar,
          ...(action.payload.sidebar || {}),
          sortMode: migrateSortMode(action.payload.sidebar?.sortMode ?? currentSidebar.sortMode),
        },
        panes: { ...state.settings.panes, ...(action.payload.panes || {}) },
      }
    },
    markSaved: (state) => {
      state.lastSavedAt = Date.now()
    },
  },
})

export const { setSettings, updateSettingsLocal, markSaved } = settingsSlice.actions
export default settingsSlice.reducer
