import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { AppSettings, SidebarSortMode } from './types'
import type { DeepPartial } from '@/lib/type-utils'

export function resolveDefaultLoggingDebug(isDev: boolean = import.meta.env.DEV): boolean {
  return !!isDev
}

export const defaultSettings: AppSettings = {
  theme: 'system',
  uiScale: 1.0, // 100% = UI text matches terminal font size
  terminal: {
    fontSize: 16,
    fontFamily: 'monospace',
    lineHeight: 1,
    cursorBlink: true,
    scrollback: 5000,
    theme: 'auto',
    warnExternalLinks: true,
    osc52Clipboard: 'ask',
    renderer: 'auto',
  },
  defaultCwd: undefined,
  logging: {
    debug: resolveDefaultLoggingDebug(),
  },
  safety: {
    autoKillIdleMinutes: 180,
    warnBeforeKillMinutes: 5,
  },
  sidebar: {
    sortMode: 'recency-pinned',
    showProjectBadges: true,
    showSubagents: false,
    showNoninteractiveSessions: false,
    width: 288,
    collapsed: false,
  },
  notifications: {
    soundEnabled: true,
  },
  panes: {
    defaultNewPane: 'ask' as const,
    snapThreshold: 2,
    iconsOnTabs: true,
    tabAttentionStyle: 'highlight' as const,
    attentionDismiss: 'click' as const,
  },
  codingCli: {
    enabledProviders: ['claude', 'codex'],
    providers: {
      claude: {
        permissionMode: 'default',
      },
      codex: {},
    },
  },
  freshclaude: {},
  network: {
    host: '127.0.0.1' as const,
    configured: false,
  },
}

export function migrateSortMode(mode: string | undefined): SidebarSortMode {
  if (mode === 'recency' || mode === 'recency-pinned' || mode === 'activity' || mode === 'project') {
    return mode
  }
  // Migrate legacy 'hybrid' mode to 'activity' (similar behavior)
  if (mode === 'hybrid') {
    return 'activity'
  }
  return 'recency-pinned'
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

export function mergeSettings(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const baseLogging = base.logging ?? defaultSettings.logging
  const baseCodingCli = base.codingCli ?? defaultSettings.codingCli
  const merged = {
    ...base,
    ...patch,
    terminal: { ...base.terminal, ...(patch.terminal || {}) },
    logging: { ...baseLogging, ...(patch.logging || {}) },
    safety: { ...base.safety, ...(patch.safety || {}) },
    sidebar: { ...base.sidebar, ...(patch.sidebar || {}) },
    notifications: { ...base.notifications, ...(patch.notifications || {}) },
    panes: { ...base.panes, ...(patch.panes || {}) },
    codingCli: {
      ...baseCodingCli,
      ...(patch.codingCli || {}),
      providers: {
        ...baseCodingCli.providers,
        ...(patch.codingCli?.providers || {}),
      },
    },
    freshclaude: { ...base.freshclaude, ...(patch.freshclaude || {}) },
    network: { ...base.network, ...(patch.network || {}) },
  }

  return {
    ...merged,
    sidebar: {
      ...merged.sidebar,
      sortMode: migrateSortMode(merged.sidebar?.sortMode),
    },
  }
}

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setSettings: (state, action: PayloadAction<AppSettings>) => {
      state.settings = mergeSettings(defaultSettings, action.payload)
      state.loaded = true
    },
    updateSettingsLocal: (state, action: PayloadAction<DeepPartial<AppSettings>>) => {
      state.settings = mergeSettings(state.settings, action.payload)
    },
    markSaved: (state) => {
      state.lastSavedAt = Date.now()
    },
  },
})

export const { setSettings, updateSettingsLocal, markSaved } = settingsSlice.actions
export default settingsSlice.reducer
