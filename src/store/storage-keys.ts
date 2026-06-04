export const STORAGE_KEYS = {
  layout: 'freshell.layout.v3',
  tabs: 'freshell.tabs.v2',
  panes: 'freshell.panes.v2',
  sessionActivity: 'freshell.sessionActivity.v2',
  terminalCursor: 'freshell.terminal-cursors.v1',
  browserPreferences: 'freshell.browser-preferences.v1',
  tabRecency: 'freshell.tab-recency.v1',
  turnCompletion: 'freshell.turn-completion.v1',
  deviceId: 'freshell.device-id.v2',
  deviceLabel: 'freshell.device-label.v2',
  deviceLabelCustom: 'freshell.device-label-custom.v2',
  deviceFingerprint: 'freshell.device-fingerprint.v2',
  deviceAliases: 'freshell.device-aliases.v2',
  deviceDismissed: 'freshell.device-dismissed.v1',
  tabRegistryClientInstanceId: 'freshell.tabs.client-instance-id.v1',
  tabRegistrySnapshotRevision: 'freshell.tabs.snapshot-revision.v1',
  inputHistory: 'freshell.input-history.v1',
} as const

export const LAYOUT_STORAGE_KEY = STORAGE_KEYS.layout
export const TABS_STORAGE_KEY = STORAGE_KEYS.tabs
export const PANES_STORAGE_KEY = STORAGE_KEYS.panes
export const SESSION_ACTIVITY_STORAGE_KEY = STORAGE_KEYS.sessionActivity
export const TERMINAL_CURSOR_STORAGE_KEY = STORAGE_KEYS.terminalCursor
export const BROWSER_PREFERENCES_STORAGE_KEY = STORAGE_KEYS.browserPreferences
export const TAB_RECENCY_STORAGE_KEY = STORAGE_KEYS.tabRecency
export const TURN_COMPLETION_STORAGE_KEY = STORAGE_KEYS.turnCompletion
export const DEVICE_ID_STORAGE_KEY = STORAGE_KEYS.deviceId
export const DEVICE_LABEL_STORAGE_KEY = STORAGE_KEYS.deviceLabel
export const DEVICE_LABEL_CUSTOM_STORAGE_KEY = STORAGE_KEYS.deviceLabelCustom
export const DEVICE_FINGERPRINT_STORAGE_KEY = STORAGE_KEYS.deviceFingerprint
export const DEVICE_ALIASES_STORAGE_KEY = STORAGE_KEYS.deviceAliases
export const DEVICE_DISMISSED_STORAGE_KEY = STORAGE_KEYS.deviceDismissed
export const TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY = STORAGE_KEYS.tabRegistryClientInstanceId
export const TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY = STORAGE_KEYS.tabRegistrySnapshotRevision
