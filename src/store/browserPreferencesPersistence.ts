import type { Middleware } from '@reduxjs/toolkit'

import { mergeLocalSettings, defaultLocalSettings, type LocalSettings, type LocalSettingsPatch } from '@shared/settings'
import { DEFAULT_CLOSED_TAB_RETENTION_DAYS, loadBrowserPreferencesRecord, type BrowserPreferencesRecord } from '@/lib/browser-preferences'
import { BROWSER_PREFERENCES_STORAGE_KEY } from './storage-keys'
import { broadcastPersistedRaw } from './persistBroadcast'
import type { SettingsState } from './settingsSlice'
import type { TabRegistryState } from './tabRegistrySlice'

export const BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS = 500

type BrowserPreferencesState = {
  settings: SettingsState
  tabRegistry: Pick<TabRegistryState, 'closedTabRetentionDays' | 'searchRangeDays'>
}

type BrowserPreferencesWriteState = {
  settingsPatch?: LocalSettingsPatch
  hasPendingClosedTabRetentionDays: boolean
  closedTabRetentionDays: number
}

const DEFAULT_SEARCH_RANGE_DAYS = DEFAULT_CLOSED_TAB_RETENTION_DAYS

const flushCallbacks = new Set<() => void>()
let flushListenersAttached = false
let pendingWritesByGetState = new WeakMap<BrowserPreferencesMiddlewareGetState, BrowserPreferencesWriteState>()

type BrowserPreferencesMiddlewareGetState = () => unknown

function notifyFlushCallbacks() {
  for (const cb of flushCallbacks) {
    try {
      cb()
    } catch {
      // ignore
    }
  }
}

function attachFlushListeners() {
  if (flushListenersAttached) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      notifyFlushCallbacks()
    }
  }

  const handlePageHide = () => {
    notifyFlushCallbacks()
  }

  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('beforeunload', handlePageHide)

  flushListenersAttached = true
}

function registerFlushCallback(cb: () => void) {
  flushCallbacks.add(cb)
  attachFlushListeners()
}

export function resetBrowserPreferencesFlushListenersForTests() {
  flushCallbacks.clear()
  pendingWritesByGetState = new WeakMap()
}

function canUseStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

function assignChangedScalar<T extends Record<string, unknown>, K extends keyof T>(
  patch: Partial<Record<K, T[K]>>,
  current: T,
  defaults: T,
  key: K,
): void {
  if (current[key] !== defaults[key]) {
    patch[key] = current[key]
  }
}

export function buildLocalSettingsPatch(localSettings: LocalSettings): LocalSettingsPatch {
  const patch: LocalSettingsPatch = {}

  assignChangedScalar(patch, localSettings, defaultLocalSettings, 'theme')
  assignChangedScalar(patch, localSettings, defaultLocalSettings, 'uiScale')

  const terminal: LocalSettingsPatch['terminal'] = {}
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'fontSize')
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'fontFamily')
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'lineHeight')
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'cursorBlink')
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'theme')
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'warnExternalLinks')
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'osc52Clipboard')
  assignChangedScalar(terminal, localSettings.terminal, defaultLocalSettings.terminal, 'renderer')
  if (Object.keys(terminal).length > 0) {
    patch.terminal = terminal
  }

  const panes: LocalSettingsPatch['panes'] = {}
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'snapThreshold')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'iconsOnTabs')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'tabAttentionStyle')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'attentionDismiss')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'sessionOpenMode')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'multirowTabs')
  if (Object.keys(panes).length > 0) {
    patch.panes = panes
  }

  const sidebar: LocalSettingsPatch['sidebar'] = {}
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'sortMode')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showProjectBadges')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showSubagents')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'ignoreCodexSubagents')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showNoninteractiveSessions')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'hideEmptySessions')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'width')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'collapsed')
  if (Object.keys(sidebar).length > 0) {
    patch.sidebar = sidebar
  }

  const freshAgent: LocalSettingsPatch['freshAgent'] = {}
  assignChangedScalar(freshAgent, localSettings.freshAgent, defaultLocalSettings.freshAgent, 'showThinking')
  assignChangedScalar(freshAgent, localSettings.freshAgent, defaultLocalSettings.freshAgent, 'showTools')
  assignChangedScalar(freshAgent, localSettings.freshAgent, defaultLocalSettings.freshAgent, 'showTimecodes')
  if (Object.keys(freshAgent).length > 0) {
    patch.freshAgent = freshAgent
    patch.agentChat = freshAgent
  }

  const notifications: LocalSettingsPatch['notifications'] = {}
  assignChangedScalar(notifications, localSettings.notifications, defaultLocalSettings.notifications, 'soundEnabled')
  if (Object.keys(notifications).length > 0) {
    patch.notifications = notifications
  }

  return patch
}

function buildBrowserPreferencesRecord(state: BrowserPreferencesState): BrowserPreferencesRecord {
  const current = loadBrowserPreferencesRecord()
  const next: BrowserPreferencesRecord = {}

  if (current.legacyLocalSettingsSeedApplied) {
    next.legacyLocalSettingsSeedApplied = true
  }

  const settingsPatch = buildLocalSettingsPatch(state.settings.localSettings)
  if (Object.keys(settingsPatch).length > 0) {
    next.settings = settingsPatch
  }

  const closedTabRetentionDays = Math.min(30, Math.max(1, state.tabRegistry.closedTabRetentionDays ?? state.tabRegistry.searchRangeDays))
  if (closedTabRetentionDays !== DEFAULT_SEARCH_RANGE_DAYS) {
    next.tabs = {
      closedTabRetentionDays,
    }
  }

  return next
}

function getOrCreatePendingWriteState(getState: BrowserPreferencesMiddlewareGetState): BrowserPreferencesWriteState {
  const existing = pendingWritesByGetState.get(getState)
  if (existing) {
    return existing
  }

  const created: BrowserPreferencesWriteState = {
    hasPendingClosedTabRetentionDays: false,
    closedTabRetentionDays: DEFAULT_SEARCH_RANGE_DAYS,
  }
  pendingWritesByGetState.set(getState, created)
  return created
}

function resetPendingWriteState(getState: BrowserPreferencesMiddlewareGetState) {
  pendingWritesByGetState.set(getState, {
    hasPendingClosedTabRetentionDays: false,
    closedTabRetentionDays: DEFAULT_SEARCH_RANGE_DAYS,
  })
}

export function getPendingBrowserPreferencesWriteState(store: { getState: BrowserPreferencesMiddlewareGetState }) {
  const pending = pendingWritesByGetState.get(store.getState)
  if (!pending) {
    return {
      hasPendingSearchRangeDays: false,
      searchRangeDays: DEFAULT_SEARCH_RANGE_DAYS,
      hasPendingClosedTabRetentionDays: false,
      closedTabRetentionDays: DEFAULT_SEARCH_RANGE_DAYS,
    }
  }
  return {
    settingsPatch: pending.settingsPatch,
    hasPendingSearchRangeDays: pending.hasPendingClosedTabRetentionDays,
    searchRangeDays: pending.closedTabRetentionDays,
    hasPendingClosedTabRetentionDays: pending.hasPendingClosedTabRetentionDays,
    closedTabRetentionDays: pending.closedTabRetentionDays,
  }
}

export const browserPreferencesPersistenceMiddleware: Middleware<{}, BrowserPreferencesState> = (store) => {
  let dirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let retrySuppressed = false
  resetPendingWriteState(store.getState as BrowserPreferencesMiddlewareGetState)

  const flush = () => {
    flushTimer = null
    if (!dirty) return

    if (!canUseStorage()) {
      retrySuppressed = true
      return
    }

    try {
      const raw = JSON.stringify(buildBrowserPreferencesRecord(store.getState()))
      localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, raw)
      broadcastPersistedRaw(BROWSER_PREFERENCES_STORAGE_KEY, raw)
      dirty = false
      retrySuppressed = false
      resetPendingWriteState(store.getState as BrowserPreferencesMiddlewareGetState)
    } catch {
      retrySuppressed = true
    }
  }

  const scheduleFlush = () => {
    if (flushTimer || retrySuppressed || !dirty) return
    flushTimer = setTimeout(flush, BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
  }

  const flushNow = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flush()
  }

  registerFlushCallback(flushNow)

  return (next) => (action: any) => {
    const result = next(action)

    if (action?.meta?.skipPersist) {
      return result
    }

    if (
      action?.type === 'settings/updateSettingsLocal'
      || action?.type === 'settings/setLocalSettings'
      || action?.type === 'tabRegistry/setTabRegistrySearchRangeDays'
      || action?.type === 'tabRegistry/setTabRegistryClosedTabRetentionDays'
    ) {
      const pending = getOrCreatePendingWriteState(store.getState as BrowserPreferencesMiddlewareGetState)
      if (action?.type === 'settings/updateSettingsLocal') {
        pending.settingsPatch = mergeLocalSettings(pending.settingsPatch, action.payload || {})
      } else if (action?.type === 'settings/setLocalSettings') {
        const nextPatch = buildLocalSettingsPatch(action.payload as LocalSettings)
        pending.settingsPatch = Object.keys(nextPatch).length > 0 ? nextPatch : undefined
      } else if (
        action?.type === 'tabRegistry/setTabRegistrySearchRangeDays'
        || action?.type === 'tabRegistry/setTabRegistryClosedTabRetentionDays'
      ) {
        pending.hasPendingClosedTabRetentionDays = true
        pending.closedTabRetentionDays = Math.min(30, Math.max(1, Math.floor(action.payload)))
      }
      retrySuppressed = false
      dirty = true
      scheduleFlush()
    }

    return result
  }
}
