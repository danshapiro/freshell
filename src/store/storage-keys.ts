export const STORAGE_KEYS = {
  tabs: 'freshell.tabs.v2',
  panes: 'freshell.panes.v2',
  sessionActivity: 'freshell.sessionActivity.v2',
  terminalCursor: 'freshell.terminal-cursors.v1',
  deviceId: 'freshell.device-id.v2',
  deviceLabel: 'freshell.device-label.v2',
  deviceLabelCustom: 'freshell.device-label-custom.v2',
  deviceFingerprint: 'freshell.device-fingerprint.v2',
  deviceAliases: 'freshell.device-aliases.v2',
} as const

export const TABS_STORAGE_KEY = STORAGE_KEYS.tabs
export const PANES_STORAGE_KEY = STORAGE_KEYS.panes
export const SESSION_ACTIVITY_STORAGE_KEY = STORAGE_KEYS.sessionActivity
export const TERMINAL_CURSOR_STORAGE_KEY = STORAGE_KEYS.terminalCursor
export const DEVICE_ID_STORAGE_KEY = STORAGE_KEYS.deviceId
export const DEVICE_LABEL_STORAGE_KEY = STORAGE_KEYS.deviceLabel
export const DEVICE_LABEL_CUSTOM_STORAGE_KEY = STORAGE_KEYS.deviceLabelCustom
export const DEVICE_FINGERPRINT_STORAGE_KEY = STORAGE_KEYS.deviceFingerprint
export const DEVICE_ALIASES_STORAGE_KEY = STORAGE_KEYS.deviceAliases
