import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  defaultSettings,
  mergeSettings,
  updateSettingsLocal,
} from '@/store/settingsSlice'
import {
  dismissDeviceIds,
  persistDeviceAliasesForDevices,
  persistOwnDeviceLabel,
  setTabRegistryDeviceAliases,
  setTabRegistryDismissedDeviceIds,
  setTabRegistryDeviceLabel,
} from '@/store/tabRegistrySlice'
import { api, type ApiError } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { cn } from '@/lib/utils'
import { terminalThemes, darkThemes, lightThemes, getTerminalTheme } from '@/lib/terminal-themes'
import { resolveTerminalFontFamily } from '@/lib/terminal-fonts'
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts'
import type {
  AppSettings,
  SidebarSortMode,
  TerminalTheme,
  CodexSandboxMode,
  ClaudePermissionMode,
  CodingCliProviderName,
  TabAttentionStyle,
  AttentionDismiss,
  LocalSettingsPatch,
  ServerSettingsPatch,
} from '@/store/types'
import {
  discardStagedServerSettingsPatch,
  saveServerSettingsPatch,
  stageServerSettingsPatchPreview,
} from '@/store/settingsThunks'
import { configureNetwork, fetchNetworkStatus, type NetworkStatusResponse } from '@/store/networkSlice'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import {
  fetchFirewallConfig,
  type ConfigureFirewallResult,
} from '@/lib/firewall-configure'
import { nanoid } from '@reduxjs/toolkit'
import type { AppView } from '@/components/Sidebar'
import { getCliProviderConfigs } from '@/lib/coding-cli-utils'
import { buildKnownDevices, type KnownDevice } from '@/lib/known-devices'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
import { isRemoteAccessEnabledStatus } from '@/lib/share-utils'
import { parseNormalizedLineList } from '@shared/string-list'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { ConfirmModal } from '@/components/ui/confirm-modal'
import { Puzzle, ChevronRight } from 'lucide-react'

const EMPTY_EXTENSION_ENTRIES: ClientExtensionEntry[] = []
const SETTINGS_FIREWALL_POLL_INTERVAL_MS = 2000
const SETTINGS_FIREWALL_POLL_MAX_ATTEMPTS = 10
const SERVER_TEXT_SETTINGS_DEBOUNCE_MS = 500
const log = createLogger('SettingsView')

/** Monospace fonts with good Unicode block element support for terminal use */
const terminalFonts = [
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Cascadia Code', label: 'Cascadia Code' },
  { value: 'Cascadia Mono', label: 'Cascadia Mono' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Meslo LG S', label: 'Meslo LG S' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'IBM Plex Mono', label: 'IBM Plex Mono' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'Monaco', label: 'Monaco' },
  { value: 'Menlo', label: 'Menlo' },
  { value: 'monospace', label: 'System monospace' },
]

type PreviewTokenKind =
  | 'comment'
  | 'keyword'
  | 'type'
  | 'function'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'property'
  | 'operator'
  | 'punctuation'
  | 'variable'

type PreviewToken = {
  text: string
  kind?: PreviewTokenKind
}

type FirewallConfirmation = Extract<ConfigureFirewallResult, { method: 'confirmation-required' }>
type PendingConfirmation =
  | { kind: 'firewall-fix'; request: FirewallConfirmation }
  | { kind: 'remote-access-disable'; request: FirewallConfirmation }
type FirewallState = NetworkStatusResponse['firewall']

const terminalPreviewWidth = 40
const terminalPreviewHeight = 8

function getFirewallDescription(firewall: FirewallState, override: string | null): string {
  if (override) return override
  if (firewall.configuring) return 'Firewall configuration already in progress'
  if (firewall.portOpen === true) return 'Port is open'
  if (firewall.platform === 'wsl2' && firewall.portOpen === false) return 'Port may be blocked'
  if (!firewall.active) return 'No firewall detected'
  if (firewall.portOpen === false) return 'Port may be blocked'
  return 'Firewall detected'
}

function isFirewallRefreshInProgress(firewall: FirewallState, override: string | null): boolean {
  return firewall.configuring || override === 'Firewall configuration already in progress'
}

function shouldShowFirewallFix(firewall: FirewallState, override: string | null): boolean {
  if (isFirewallRefreshInProgress(firewall, override)) {
    return false
  }
  if (firewall.platform === 'wsl2' && firewall.portOpen === false) {
    return true
  }
  return firewall.active && firewall.portOpen !== true
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
    && (error as { message: string }).message.trim().length > 0
  ) {
    return (error as { message: string }).message
  }

  return fallback
}

const terminalPreviewLinesRaw: PreviewToken[][] = [
  [{ text: '// terminal preview: syntax demo', kind: 'comment' }],
  [
    { text: 'const ', kind: 'keyword' },
    { text: 'answer', kind: 'variable' },
    { text: ': ', kind: 'punctuation' },
    { text: 'number', kind: 'type' },
    { text: ' = ', kind: 'operator' },
    { text: '42', kind: 'number' },
  ],
  [
    { text: 'type ', kind: 'keyword' },
    { text: 'User', kind: 'type' },
    { text: ' = ', kind: 'operator' },
    { text: '{ ', kind: 'punctuation' },
    { text: 'id', kind: 'property' },
    { text: ': ', kind: 'punctuation' },
    { text: 'number', kind: 'type' },
    { text: ' }', kind: 'punctuation' },
  ],
  [
    { text: 'const ', kind: 'keyword' },
    { text: 'user', kind: 'variable' },
    { text: ': ', kind: 'punctuation' },
    { text: 'User', kind: 'type' },
    { text: ' = ', kind: 'operator' },
    { text: '{ ', kind: 'punctuation' },
    { text: 'id', kind: 'property' },
    { text: ': ', kind: 'punctuation' },
    { text: '7', kind: 'number' },
    { text: ' }', kind: 'punctuation' },
  ],
  [
    { text: 'function ', kind: 'keyword' },
    { text: 'greet', kind: 'function' },
    { text: '(', kind: 'punctuation' },
    { text: 'name', kind: 'variable' },
    { text: ': ', kind: 'punctuation' },
    { text: 'string', kind: 'type' },
    { text: ') {', kind: 'punctuation' },
  ],
  [
    { text: '  ', kind: 'punctuation' },
    { text: 'return ', kind: 'keyword' },
    { text: '"hi, "', kind: 'string' },
    { text: ' + ', kind: 'operator' },
    { text: 'name', kind: 'variable' },
  ],
  [
    { text: '}', kind: 'punctuation' },
    { text: ' ', kind: 'punctuation' },
    { text: '// end', kind: 'comment' },
  ],
  [
    { text: 'const ', kind: 'keyword' },
    { text: 'ok', kind: 'variable' },
    { text: ' = ', kind: 'operator' },
    { text: 'true', kind: 'boolean' },
    { text: ' && ', kind: 'operator' },
    { text: 'null', kind: 'null' },
    { text: ' === ', kind: 'operator' },
    { text: '0', kind: 'number' },
  ],
]

const terminalPreviewLines: PreviewToken[][] = terminalPreviewLinesRaw.map((tokens) =>
  normalizePreviewLine(tokens, terminalPreviewWidth)
)

function normalizePreviewLine(tokens: PreviewToken[], width: number): PreviewToken[] {
  let remaining = width
  const normalized: PreviewToken[] = []

  for (const token of tokens) {
    if (remaining <= 0) break
    const text = token.text.slice(0, remaining)
    if (!text.length) continue
    normalized.push({ ...token, text })
    remaining -= text.length
  }

  if (remaining > 0) {
    normalized.push({ text: ' '.repeat(remaining) })
  }

  return normalized
}

export default function SettingsView({ onNavigate, onFirewallTerminal, onSharePanel }: { onNavigate?: (view: AppView) => void; onFirewallTerminal?: (cmd: { tabId: string; command: string }) => void; onSharePanel?: () => void } = {}) {
  useEnsureExtensionsRegistry()

  const dispatch = useAppDispatch()
  const rawSettings = useAppSelector((s) => s.settings.settings)
  const settings = useMemo(
    () => mergeSettings(defaultSettings, rawSettings || {}),
    [rawSettings],
  )
  const lastSavedAt = useAppSelector((s) => s.settings.lastSavedAt)
  const networkStatus = useAppSelector((s) => s.network.status)
  const configuring = useAppSelector((s) => s.network.configuring)
  const remoteAccessEnabled = isRemoteAccessEnabledStatus(networkStatus)
  const remoteAccessRequested = networkStatus?.remoteAccessRequested ?? remoteAccessEnabled
  const requiresPrivilegedRemoteAccessDisable = (
    networkStatus?.firewall?.platform === 'windows'
    || networkStatus?.firewall?.platform === 'wsl2'
  )
  const remoteAccessToggleChecked = remoteAccessEnabled || remoteAccessRequested
  const enabledProviders = useMemo(
    () => settings.codingCli?.enabledProviders ?? [],
    [settings.codingCli?.enabledProviders],
  )
  const extensionEntries = useAppSelector((s) => s.extensions?.entries ?? EMPTY_EXTENSION_ENTRIES)
  const cliProviderConfigs = useMemo(() => getCliProviderConfigs(extensionEntries), [extensionEntries])
  const tabRegistryState = useAppSelector((s) => (s as any).tabRegistry)
  const tabRegistry = tabRegistryState ?? {
    deviceId: 'local-device',
    deviceLabel: 'local-device',
    deviceAliases: {} as Record<string, string>,
    dismissedDeviceIds: [] as string[],
    localOpen: [],
    remoteOpen: [],
    closed: [],
  }

  const [availableTerminalFonts, setAvailableTerminalFonts] = useState(terminalFonts)
  const [fontsReady, setFontsReady] = useState(false)
  const [terminalAdvancedOpen, setTerminalAdvancedOpen] = useState(false)
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null)
  const [firewallRefreshDetail, setFirewallRefreshDetail] = useState<string | null>(null)
  const firewallRepairInProgress = networkStatus?.firewall
    ? isFirewallRefreshInProgress(networkStatus.firewall, firewallRefreshDetail)
    : false
  const [remoteAccessPending, setRemoteAccessPending] = useState(false)
  const [remoteAccessError, setRemoteAccessError] = useState<string | null>(null)
  const [defaultCwdInput, setDefaultCwdInput] = useState(settings.defaultCwd ?? '')
  const [defaultCwdError, setDefaultCwdError] = useState<string | null>(null)
  const [excludeFirstChatInput, setExcludeFirstChatInput] = useState(
    () => (settings.sidebar?.excludeFirstChatSubstrings ?? []).join('\n'),
  )
  const [deviceNameInputs, setDeviceNameInputs] = useState<Record<string, string>>({})
  const terminalAdvancedId = useId()
  const firewallRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firewallRefreshRequestRef = useRef(0)
  const remoteAccessRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remoteAccessRefreshRequestRef = useRef(0)
  const defaultCwdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const serverTextSaveTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const defaultCwdValidationRef = useRef(0)
  const lastSettingsDefaultCwdRef = useRef(settings.defaultCwd ?? '')
  const lastSettingsExcludeFirstChatRef = useRef(
    (settings.sidebar?.excludeFirstChatSubstrings ?? []).join('\n'),
  )
  const previewTheme = useMemo(
    () => getTerminalTheme(settings.terminal.theme, settings.theme),
    [settings.terminal.theme, settings.theme],
  )
  const previewColors = useMemo(
    () => ({
      comment: previewTheme.brightBlack ?? previewTheme.foreground ?? '#c0c0c0',
      keyword: previewTheme.blue ?? previewTheme.foreground ?? '#7aa2f7',
      type: previewTheme.magenta ?? previewTheme.foreground ?? '#bb9af7',
      function: previewTheme.cyan ?? previewTheme.foreground ?? '#7dcfff',
      string: previewTheme.green ?? previewTheme.foreground ?? '#9ece6a',
      number: previewTheme.yellow ?? previewTheme.foreground ?? '#e0af68',
      boolean: previewTheme.magenta ?? previewTheme.foreground ?? '#bb9af7',
      null: previewTheme.red ?? previewTheme.foreground ?? '#f7768e',
      property: previewTheme.cyan ?? previewTheme.foreground ?? '#7dcfff',
      operator: previewTheme.foreground ?? '#c0c0c0',
      punctuation: previewTheme.foreground ?? '#c0c0c0',
      variable: previewTheme.foreground ?? '#c0c0c0',
    }),
    [previewTheme],
  )

  useEffect(() => {
    return () => {
      if (firewallRefreshTimerRef.current) clearTimeout(firewallRefreshTimerRef.current)
      if (remoteAccessRefreshTimerRef.current) clearTimeout(remoteAccessRefreshTimerRef.current)
      if (defaultCwdTimerRef.current) clearTimeout(defaultCwdTimerRef.current)
      const pendingServerTextKeys = Object.keys(serverTextSaveTimerRef.current)
      for (const timer of Object.values(serverTextSaveTimerRef.current)) {
        clearTimeout(timer)
      }
      for (const key of pendingServerTextKeys) {
        dispatch(discardStagedServerSettingsPatch(key))
      }
      serverTextSaveTimerRef.current = {}
      for (const timer of Object.values(providerCwdTimerRef.current)) {
        clearTimeout(timer)
      }
    }
  }, [dispatch])
  const refreshFirewallStatusAfterNoop = useCallback(async (message?: string) => {
    setFirewallRefreshDetail(message ?? 'Refreshing firewall status...')
    try {
      await dispatch(fetchNetworkStatus()).unwrap()
      setFirewallRefreshDetail(null)
    } catch {
      setFirewallRefreshDetail('Failed to refresh firewall status')
    }
  }, [dispatch])

  const queueFirewallRefresh = useCallback((refreshRequestId: number, detail: string | null, attempts = 0) => {
    firewallRefreshTimerRef.current = setTimeout(() => {
      firewallRefreshTimerRef.current = null
      void dispatch(fetchNetworkStatus())
        .unwrap()
        .then((status) => {
          if (firewallRefreshRequestRef.current !== refreshRequestId) {
            return
          }

          if (status.firewall.configuring) {
            if (attempts + 1 >= SETTINGS_FIREWALL_POLL_MAX_ATTEMPTS) {
              setFirewallRefreshDetail('Firewall configuration timed out')
              return
            }

            queueFirewallRefresh(refreshRequestId, detail, attempts + 1)
            return
          }

          setFirewallRefreshDetail(null)
        })
        .catch(() => {
          if (firewallRefreshRequestRef.current === refreshRequestId) {
            setFirewallRefreshDetail('Failed to refresh firewall status')
          }
        })
    }, SETTINGS_FIREWALL_POLL_INTERVAL_MS)
  }, [dispatch])

  const scheduleFirewallRefresh = useCallback((detail: string | null = null) => {
    setFirewallRefreshDetail(detail)
    if (firewallRefreshTimerRef.current) {
      clearTimeout(firewallRefreshTimerRef.current)
    }
    firewallRefreshRequestRef.current += 1
    const refreshRequestId = firewallRefreshRequestRef.current
    queueFirewallRefresh(refreshRequestId, detail)
  }, [queueFirewallRefresh])

  const reconcileRemoteAccessRefreshFailure = useCallback(async (
    refreshRequestId: number,
    errorMessage: string,
  ) => {
    try {
      await dispatch(fetchNetworkStatus()).unwrap()
    } catch (refreshError) {
      log.warn('Failed to reconcile remote access status after polling error', refreshError)
    }
    if (remoteAccessRefreshRequestRef.current !== refreshRequestId) {
      return
    }
    setRemoteAccessPending(false)
    setRemoteAccessError(errorMessage)
  }, [dispatch])

  const queueRemoteAccessRefresh = useCallback((refreshRequestId: number, attempts = 0) => {
    remoteAccessRefreshTimerRef.current = setTimeout(() => {
      remoteAccessRefreshTimerRef.current = null
      void dispatch(fetchNetworkStatus())
        .unwrap()
        .then((status) => {
          if (remoteAccessRefreshRequestRef.current !== refreshRequestId) {
            return
          }

          if (status.firewall.configuring) {
            if (attempts + 1 >= SETTINGS_FIREWALL_POLL_MAX_ATTEMPTS) {
              void reconcileRemoteAccessRefreshFailure(
                refreshRequestId,
                'Timed out turning off remote access',
              )
              return
            }

            queueRemoteAccessRefresh(refreshRequestId, attempts + 1)
            return
          }

          const remoteAccessStillEnabled = isRemoteAccessEnabledStatus(status)
            || (status.remoteAccessRequested ?? false)
          if (remoteAccessStillEnabled) {
            setRemoteAccessPending(false)
            setRemoteAccessError('Remote access is still enabled')
            return
          }

          setRemoteAccessPending(false)
        })
        .catch((error) => {
          if (remoteAccessRefreshRequestRef.current === refreshRequestId) {
            log.warn('Failed to refresh remote access status', error)
            void reconcileRemoteAccessRefreshFailure(
              refreshRequestId,
              'Failed to refresh remote access status',
            )
          }
        })
    }, SETTINGS_FIREWALL_POLL_INTERVAL_MS)
  }, [dispatch, reconcileRemoteAccessRefreshFailure])

  const scheduleRemoteAccessRefresh = useCallback(() => {
    setRemoteAccessPending(true)
    setRemoteAccessError(null)
    if (remoteAccessRefreshTimerRef.current) {
      clearTimeout(remoteAccessRefreshTimerRef.current)
    }
    remoteAccessRefreshRequestRef.current += 1
    const refreshRequestId = remoteAccessRefreshRequestRef.current
    queueRemoteAccessRefresh(refreshRequestId)
  }, [queueRemoteAccessRefresh])

  const handleFirewallFixResult = useCallback((result: ConfigureFirewallResult) => {
    if (result.method === 'confirmation-required') {
      setPendingConfirmation({ kind: 'firewall-fix', request: result })
      return
    }

    if (result.method === 'none') {
      void refreshFirewallStatusAfterNoop(result.message)
      return
    }

    setFirewallRefreshDetail(null)

    if (result.method === 'terminal') {
      const tabId = nanoid()
      dispatch(addTab({ id: tabId, title: 'Firewall Setup', mode: 'shell', shell: 'system' }))
      dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
      onFirewallTerminal?.({ tabId, command: result.command })
      onNavigate?.('terminal')
      return
    }

    if (result.method === 'in-progress') {
      scheduleFirewallRefresh(result.error)
      return
    }

    if (result.method === 'wsl2' || result.method === 'windows-elevated') {
      scheduleFirewallRefresh('Firewall configuration already in progress')
    }
  }, [onFirewallTerminal, onNavigate, refreshFirewallStatusAfterNoop, scheduleFirewallRefresh])

  const requestFirewallFix = useCallback(async (
    body: { confirmElevation?: true; confirmationToken?: string } = {},
  ) => {
    setFirewallRefreshDetail(null)
    try {
      const result = await fetchFirewallConfig(body)
      handleFirewallFixResult(result)
    } catch (error) {
      log.warn('Failed to configure firewall', error)
      setFirewallRefreshDetail(getErrorMessage(error, 'Failed to configure firewall'))
    }
  }, [handleFirewallFixResult])

  const requestRemoteAccessDisable = useCallback(async (
    body: { confirmElevation?: true; confirmationToken?: string } = {},
  ) => {
    setRemoteAccessError(null)
    try {
      const result = await api.post<ConfigureFirewallResult>('/api/network/disable-remote-access', body)
      if (result.method === 'confirmation-required') {
        setPendingConfirmation({ kind: 'remote-access-disable', request: result })
        return
      }
      if (result.method === 'none') {
        setRemoteAccessPending(false)
        await dispatch(fetchNetworkStatus()).unwrap()
        return
      }
      if (
        result.method === 'in-progress'
        || result.method === 'windows-elevated'
        || result.method === 'wsl2'
      ) {
        scheduleRemoteAccessRefresh()
      }
    } catch (error) {
      const apiError = error as ApiError | undefined
      const details = apiError?.details as { method?: string; error?: string } | undefined
      if (apiError?.status === 409 && details?.method === 'in-progress') {
        scheduleRemoteAccessRefresh()
        return
      }

      log.warn('Failed to disable remote access', error)
      setRemoteAccessPending(false)
      setRemoteAccessError(getErrorMessage(error, 'Failed to disable remote access'))
    }
  }, [dispatch, scheduleRemoteAccessRefresh])

  const requestRemoteAccessConfigure = useCallback(async (host: '127.0.0.1' | '0.0.0.0') => {
    setRemoteAccessError(null)
    try {
      await dispatch(configureNetwork({
        host,
        configured: true,
      })).unwrap()
    } catch (error) {
      log.warn('Failed to configure remote access', error)
      setRemoteAccessError(getErrorMessage(error, 'Failed to configure remote access'))
    }
  }, [dispatch])

  const handleConfirmPendingAction = useCallback(() => {
    if (!pendingConfirmation) {
      return
    }

    const { kind, request } = pendingConfirmation
    const confirmationToken = request.confirmationToken
    setPendingConfirmation(null)

    if (kind === 'firewall-fix') {
      void requestFirewallFix({
        confirmElevation: true,
        confirmationToken,
      })
      return
    }

    void requestRemoteAccessDisable({
      confirmElevation: true,
      confirmationToken,
    })
  }, [pendingConfirmation, requestFirewallFix, requestRemoteAccessDisable])

  const handleCancelPendingAction = useCallback(() => {
    setPendingConfirmation(null)
  }, [pendingConfirmation])

  const applyLocalSetting = useCallback((updates: LocalSettingsPatch) => {
    dispatch(updateSettingsLocal(updates))
  }, [dispatch])

  const applyServerSetting = useCallback((updates: ServerSettingsPatch) => {
    void dispatch(saveServerSettingsPatch(updates))
  }, [dispatch])

  const scheduleServerTextSettingSave = useCallback((key: string, updates: ServerSettingsPatch) => {
    dispatch(stageServerSettingsPatchPreview({ key, patch: updates }))
    if (serverTextSaveTimerRef.current[key]) {
      clearTimeout(serverTextSaveTimerRef.current[key])
    }
    serverTextSaveTimerRef.current[key] = setTimeout(() => {
      delete serverTextSaveTimerRef.current[key]
      void dispatch(saveServerSettingsPatch({
        patch: updates,
        stagedKey: key,
      }))
    }, SERVER_TEXT_SETTINGS_DEBOUNCE_MS)
  }, [dispatch])

  useEffect(() => {
    const next = settings.defaultCwd ?? ''
    if (defaultCwdInput === lastSettingsDefaultCwdRef.current) {
      setDefaultCwdInput(next)
    }
    lastSettingsDefaultCwdRef.current = next
  }, [defaultCwdInput, settings.defaultCwd])

  useEffect(() => {
    const next = (settings.sidebar?.excludeFirstChatSubstrings ?? []).join('\n')
    if (excludeFirstChatInput === lastSettingsExcludeFirstChatRef.current) {
      setExcludeFirstChatInput(next)
    }
    lastSettingsExcludeFirstChatRef.current = next
  }, [excludeFirstChatInput, settings.sidebar?.excludeFirstChatSubstrings])

  const commitDefaultCwd = useCallback((nextValue: string | undefined) => {
    if (nextValue === settings.defaultCwd) return
    applyServerSetting({ defaultCwd: nextValue })
  }, [applyServerSetting, settings.defaultCwd])

  const scheduleDefaultCwdValidation = useCallback((value: string) => {
    defaultCwdValidationRef.current += 1
    const validationId = defaultCwdValidationRef.current
    if (defaultCwdTimerRef.current) clearTimeout(defaultCwdTimerRef.current)

    defaultCwdTimerRef.current = setTimeout(() => {
      if (defaultCwdValidationRef.current !== validationId) return
      const trimmed = value.trim()
      if (!trimmed) {
        setDefaultCwdError(null)
        commitDefaultCwd(undefined)
        return
      }

      api.post<{ valid: boolean }>('/api/files/validate-dir', { path: trimmed })
        .then((result) => {
          if (defaultCwdValidationRef.current !== validationId) return
          if (result.valid) {
            setDefaultCwdError(null)
            commitDefaultCwd(trimmed)
            return
          }
          setDefaultCwdError('directory not found')
          commitDefaultCwd(undefined)
        })
        .catch(() => {
          if (defaultCwdValidationRef.current !== validationId) return
          setDefaultCwdError('directory not found')
          commitDefaultCwd(undefined)
        })
    }, 500)
  }, [commitDefaultCwd])

  // Per-provider cwd state
  const [providerCwdInputs, setProviderCwdInputs] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const config of cliProviderConfigs) {
      initial[config.name] = settings.codingCli?.providers?.[config.name]?.cwd ?? ''
    }
    return initial
  })
  const [providerCwdErrors, setProviderCwdErrors] = useState<Record<string, string | null>>({})
  const providerCwdTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const providerCwdValidationRef = useRef<Record<string, number>>({})
  const lastSettingsProviderCwdRef = useRef<Record<string, string>>(
    Object.fromEntries(
      cliProviderConfigs.map((c) => [c.name, settings.codingCli?.providers?.[c.name]?.cwd ?? ''])
    )
  )

  // Sync provider cwd inputs when settings load or change externally
  useEffect(() => {
    for (const config of cliProviderConfigs) {
      const next = settings.codingCli?.providers?.[config.name]?.cwd ?? ''
      const last = lastSettingsProviderCwdRef.current[config.name] ?? ''
      if (next !== last) {
        // Only update the input if the user hasn't modified it from the last-known settings value
        setProviderCwdInputs((prev) => {
          if (prev[config.name] === last) {
            return { ...prev, [config.name]: next }
          }
          return prev
        })
        lastSettingsProviderCwdRef.current[config.name] = next
      }
    }
  }, [settings.codingCli?.providers])

  const scheduleProviderCwdValidation = useCallback((providerName: string, value: string) => {
    const key = providerName
    if (!providerCwdValidationRef.current[key]) providerCwdValidationRef.current[key] = 0
    providerCwdValidationRef.current[key] += 1
    const validationId = providerCwdValidationRef.current[key]
    if (providerCwdTimerRef.current[key]) clearTimeout(providerCwdTimerRef.current[key])

    providerCwdTimerRef.current[key] = setTimeout(() => {
      if (providerCwdValidationRef.current[key] !== validationId) return
      const trimmed = value.trim()
      if (!trimmed) {
        setProviderCwdErrors((prev) => ({ ...prev, [key]: null }))
        applyServerSetting({
          codingCli: { providers: { [providerName]: { cwd: undefined } } },
        })
        return
      }

      api.post<{ valid: boolean }>('/api/files/validate-dir', { path: trimmed })
        .then((result) => {
          if (providerCwdValidationRef.current[key] !== validationId) return
          if (result.valid) {
            setProviderCwdErrors((prev) => ({ ...prev, [key]: null }))
            applyServerSetting({
              codingCli: { providers: { [providerName]: { cwd: trimmed } } },
            })
          } else {
            setProviderCwdErrors((prev) => ({ ...prev, [key]: 'directory not found' }))
          }
        })
        .catch(() => {
          if (providerCwdValidationRef.current[key] !== validationId) return
          setProviderCwdErrors((prev) => ({ ...prev, [key]: 'directory not found' }))
        })
    }, 500)
  }, [applyServerSetting])

  const setProviderEnabled = useCallback((provider: CodingCliProviderName, enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...enabledProviders, provider]))
      : enabledProviders.filter((candidate) => candidate !== provider)
    applyServerSetting({ codingCli: { enabledProviders: next } })
  }, [applyServerSetting, enabledProviders])

  const knownDevices = useMemo(() => {
    return buildKnownDevices({
      ownDeviceId: tabRegistry.deviceId,
      ownDeviceLabel: tabRegistry.deviceLabel,
      deviceAliases: tabRegistry.deviceAliases,
      dismissedDeviceIds: tabRegistry.dismissedDeviceIds,
      localOpen: tabRegistry.localOpen,
      remoteOpen: tabRegistry.remoteOpen,
      closed: tabRegistry.closed,
    })
  }, [tabRegistry])

  useEffect(() => {
    setDeviceNameInputs((current) => {
      const next: Record<string, string> = {}
      for (const device of knownDevices) {
        next[device.key] = current[device.key] ?? device.effectiveLabel
      }
      const changed =
        Object.keys(current).length !== Object.keys(next).length ||
        Object.entries(next).some(([key, value]) => current[key] !== value)
      return changed ? next : current
    })
  }, [knownDevices])

  const saveDeviceName = useCallback((device: KnownDevice) => {
    const nextValue = (deviceNameInputs[device.key] || '').trim()
    if (device.isOwn) {
      const persisted = persistOwnDeviceLabel(nextValue || tabRegistry.deviceLabel)
      dispatch(setTabRegistryDeviceLabel(persisted))
      setDeviceNameInputs((current) => ({ ...current, [device.key]: persisted }))
      return
    }
    const aliases = persistDeviceAliasesForDevices(device.deviceIds, nextValue || undefined)
    dispatch(setTabRegistryDeviceAliases(aliases))
    setDeviceNameInputs((current) => ({
      ...current,
      [device.key]: device.deviceIds.map((deviceId) => aliases[deviceId]).find(Boolean) || device.baseLabel,
    }))
  }, [deviceNameInputs, dispatch, tabRegistry.deviceLabel])

  const deleteDevice = useCallback((device: KnownDevice) => {
    if (device.isOwn) return

    const aliases = persistDeviceAliasesForDevices(device.deviceIds, undefined)
    const dismissedIds = dismissDeviceIds(device.deviceIds)
    dispatch(setTabRegistryDeviceAliases(aliases))
    dispatch(setTabRegistryDismissedDeviceIds(dismissedIds))
    setDeviceNameInputs((current) => {
      const next = { ...current }
      delete next[device.key]
      return next
    })
  }, [dispatch])

  useEffect(() => {
    let cancelled = false

    const detectFonts = async () => {
      if (typeof document === 'undefined' || !document.fonts || !document.fonts.check) {
        if (!cancelled) {
          setAvailableTerminalFonts(terminalFonts.filter((font) => font.value === 'monospace'))
          setFontsReady(true)
        }
        return
      }

      try {
        await document.fonts.ready
      } catch {
        // Ignore font readiness errors and attempt checks anyway.
      }

      if (cancelled) return

      let ctx: CanvasRenderingContext2D | null = null
      if (typeof CanvasRenderingContext2D !== 'undefined') {
        const canvas = document.createElement('canvas')
        try {
          ctx = canvas.getContext('2d')
        } catch {
          ctx = null
        }
      }
      const testText = 'mmmmmmmmmmlilliiWWWWWW'
      const testSize = 72
      const baseFonts = ['monospace', 'serif', 'sans-serif']
      const baseWidths = ctx
        ? baseFonts.map((base) => {
          ctx.font = `${testSize}px ${base}`
          return ctx.measureText(testText).width
        })
        : []

      const isFontAvailable = (fontFamily: string) => {
        if (fontFamily === 'monospace') return true
        if (document.fonts && !document.fonts.check(`12px "${fontFamily}"`)) return false
        if (!ctx) return true
        return baseFonts.some((base, index) => {
          ctx.font = `${testSize}px "${fontFamily}", ${base}`
          return ctx.measureText(testText).width !== baseWidths[index]
        })
      }

      const available = terminalFonts.filter((font) => {
        if (font.value === 'monospace') return true
        return isFontAvailable(font.value)
      })

      setAvailableTerminalFonts(
        available.length > 0
          ? available
          : terminalFonts.filter((font) => font.value === 'monospace')
      )
      setFontsReady(true)
    }

    void detectFonts()

    return () => {
      cancelled = true
    }
  }, [])

  const availableFontValues = useMemo(
    () => new Set(availableTerminalFonts.map((font) => font.value)),
    [availableTerminalFonts]
  )
  const isSelectedFontAvailable = availableFontValues.has(settings.terminal.fontFamily)
  const fallbackFontFamily =
    availableTerminalFonts.find((font) => font.value === 'monospace')?.value
    ?? availableTerminalFonts[0]?.value
    ?? 'monospace'

  useEffect(() => {
    if (!fontsReady) return
    if (isSelectedFontAvailable) return
    if (fallbackFontFamily === settings.terminal.fontFamily) return

    applyLocalSetting({ terminal: { fontFamily: fallbackFontFamily } })
  }, [
    applyLocalSetting,
    fallbackFontFamily,
    fontsReady,
    isSelectedFontAvailable,
    settings.terminal.fontFamily,
  ])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border/30 px-3 py-4 md:px-6 md:py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">
              {lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}` : 'Configure your preferences'}
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-8 px-3 py-4 md:px-6 md:py-6">

          {/* Manage Extensions button */}
          <button
            onClick={() => onNavigate?.('extensions')}
            className="w-full flex items-center justify-between rounded-lg border border-border/40 bg-card px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            aria-label="Manage extensions"
          >
            <div className="flex items-center gap-3">
              <Puzzle className="w-5 h-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Manage Extensions</div>
                <div className="text-xs text-muted-foreground">View and configure installed extensions</div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>

          {/* Terminal preview */}
          <div className="space-y-2" data-testid="terminal-preview">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Terminal preview</h2>
              <span className="text-xs text-muted-foreground">40×8</span>
            </div>
            <div
              aria-label="Terminal preview"
              className="rounded-md border border-border/40 shadow-sm overflow-hidden font-mono"
              style={{
                width: 'min(100%, 40ch)',
                height: `${terminalPreviewHeight * settings.terminal.lineHeight}em`,
                fontFamily: resolveTerminalFontFamily(settings.terminal.fontFamily),
                fontSize: `${settings.terminal.fontSize}px`,
                lineHeight: settings.terminal.lineHeight,
                backgroundColor: previewTheme.background,
                color: previewTheme.foreground,
                whiteSpace: 'pre',
              }}
            >
              {terminalPreviewLines.map((line, lineIndex) => (
                <div key={lineIndex} data-testid="terminal-preview-line">
                  {line.map((token, tokenIndex) => (
                    <span
                      key={`${lineIndex}-${tokenIndex}`}
                      style={{
                        color: token.kind ? previewColors[token.kind] : previewTheme.foreground,
                      }}
                    >
                      {token.text}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Appearance */}
          <SettingsSection title="Appearance" description="Theme and visual preferences">
            <SettingsRow label="Theme">
              <SegmentedControl
                value={settings.theme}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                onChange={(v) => {
                  applyLocalSetting({ theme: v as AppSettings['theme'] })
                }}
              />
            </SettingsRow>

            <SettingsRow label="UI scale">
              <RangeSlider
                value={settings.uiScale ?? 1.0}
                min={0.75}
                max={1.5}
                step={0.05}
                labelWidth="w-12"
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => {
                  applyLocalSetting({ uiScale: v })
                }}
              />
            </SettingsRow>

          </SettingsSection>

          {/* Sidebar */}
          <SettingsSection title="Sidebar" description="Session list and navigation">
            <SettingsRow label="Sort mode">
              <select
                value={settings.sidebar?.sortMode || 'activity'}
                onChange={(e) => {
                  const v = e.target.value as SidebarSortMode
                  applyLocalSetting({ sidebar: { sortMode: v } })
                }}
                className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
              >
                <option value="recency">Recency</option>
                <option value="recency-pinned">Recency (pinned)</option>
                <option value="activity">Activity (tabs first)</option>
                <option value="project">Project</option>
              </select>
            </SettingsRow>

            <SettingsRow label="Show project badges">
              <Toggle
                checked={settings.sidebar?.showProjectBadges ?? true}
                onChange={(checked) => {
                  applyLocalSetting({ sidebar: { showProjectBadges: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Show subagent sessions">
              <Toggle
                checked={settings.sidebar?.showSubagents ?? false}
                onChange={(checked) => {
                  applyLocalSetting({ sidebar: { showSubagents: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Ignore Codex subagent sessions">
              <Toggle
                checked={settings.sidebar?.ignoreCodexSubagents ?? true}
                onChange={(checked) => {
                  applyLocalSetting({ sidebar: { ignoreCodexSubagents: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Show non-interactive sessions">
              <Toggle
                checked={settings.sidebar?.showNoninteractiveSessions ?? false}
                onChange={(checked) => {
                  applyLocalSetting({ sidebar: { showNoninteractiveSessions: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow
              label="Hide empty sessions"
              description="Hide sessions that have no messages yet (e.g. newly started Claude Code sessions)."
            >
              <Toggle
                checked={settings.sidebar?.hideEmptySessions ?? true}
                onChange={(checked) => {
                  applyLocalSetting({ sidebar: { hideEmptySessions: checked } })
                }}
                aria-label="Hide empty sessions"
              />
            </SettingsRow>

            <SettingsRow
              label="Hide sessions by first chat"
              description="One substring per line. Matching sessions are hidden from the sidebar."
            >
              <textarea
                value={excludeFirstChatInput}
                onChange={(event) => {
                  const nextInput = event.target.value
                  setExcludeFirstChatInput(nextInput)
                  const excludeFirstChatSubstrings = parseNormalizedLineList(nextInput)
                  scheduleServerTextSettingSave('sidebar.excludeFirstChatSubstrings', {
                    sidebar: { excludeFirstChatSubstrings },
                  })
                }}
                className="min-h-20 w-full rounded-md bg-muted border-0 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-border md:w-[24rem]"
                placeholder="__AUTO__"
                aria-label="Sidebar first chat exclusion substrings"
              />
            </SettingsRow>

            <SettingsRow label="First chat must start with match">
              <Toggle
                checked={settings.sidebar?.excludeFirstChatMustStart ?? false}
                onChange={(checked) => {
                  applyServerSetting({ sidebar: { excludeFirstChatMustStart: checked } })
                }}
                aria-label="Require first chat exclusion substring at start"
              />
            </SettingsRow>
          </SettingsSection>

          {/* AI */}
          <SettingsSection title="AI" description="Gemini-powered features">
            <SettingsRow
              label="Gemini API key"
              description="Required for AI features. Get a key from Google AI Studio."
            >
              <input
                type="password"
                value={settings.ai?.geminiApiKey || ''}
                placeholder="Enter Gemini API key"
                onChange={(e) => {
                  const key = e.target.value || undefined
                  scheduleServerTextSettingSave('ai.geminiApiKey', { ai: { geminiApiKey: key } })
                }}
                className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8"
              />
            </SettingsRow>

            <SettingsRow
              label="Auto-generate session titles"
              description="Use Gemini to generate titles for new coding sessions."
            >
              <Toggle
                checked={settings.sidebar?.autoGenerateTitles ?? true}
                onChange={(checked) => {
                  applyServerSetting({ sidebar: { autoGenerateTitles: checked } })
                }}
                aria-label="Auto-generate session titles"
              />
            </SettingsRow>

            <SettingsRow
              label="Title prompt"
              description="Instructions sent to Gemini for generating session titles."
            >
              <textarea
                value={settings.ai?.titlePrompt || ''}
                placeholder="Generate a short title (3-8 words) for a coding assistant conversation.&#10;The title should describe the task or topic, not the tool being used.&#10;Return ONLY the title text. No quotes, no markdown, no explanation."
                onChange={(e) => {
                  const prompt = e.target.value || undefined
                  scheduleServerTextSettingSave('ai.titlePrompt', { ai: { titlePrompt: prompt } })
                }}
                rows={4}
                className="w-full px-3 py-2 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border font-mono"
              />
            </SettingsRow>
          </SettingsSection>

          {/* Panes */}
          <SettingsSection title="Panes" description="Pane layout and behavior">
            <SettingsRow label="Default new pane">
              <select
                aria-label="Default new pane"
                value={settings.panes?.defaultNewPane || 'ask'}
                onChange={(e) => {
                  const v = e.target.value as 'ask' | 'shell' | 'browser' | 'editor'
                  applyServerSetting({ panes: { defaultNewPane: v } })
                }}
                className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
              >
                <option value="ask">Ask</option>
                <option value="shell">Shell</option>
                <option value="browser">Browser</option>
                <option value="editor">Editor</option>
              </select>
            </SettingsRow>

            <SettingsRow label="Snap distance">
              <RangeSlider
                value={settings.panes?.snapThreshold ?? 2}
                min={0}
                max={8}
                step={1}
                labelWidth="w-10"
                format={(v) => v === 0 ? 'Off' : `${v}%`}
                onChange={(v) => {
                  applyLocalSetting({ panes: { snapThreshold: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Icons on tabs">
              <Toggle
                checked={settings.panes?.iconsOnTabs ?? true}
                onChange={(checked) => {
                  applyLocalSetting({ panes: { iconsOnTabs: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Tab completion indicator">
              <SegmentedControl
                value={settings.panes?.tabAttentionStyle ?? 'highlight'}
                options={[
                  { value: 'highlight', label: 'Highlight' },
                  { value: 'pulse', label: 'Pulse' },
                  { value: 'darken', label: 'Darken' },
                  { value: 'none', label: 'None' },
                ]}
                onChange={(v: string) => {
                  const tabAttentionStyle = v as TabAttentionStyle
                  applyLocalSetting({ panes: { tabAttentionStyle } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Dismiss attention on">
              <SegmentedControl
                value={settings.panes?.attentionDismiss ?? 'click'}
                options={[
                  { value: 'click', label: 'Tab click' },
                  { value: 'type', label: 'Typing' },
                ]}
                onChange={(v: string) => {
                  const attentionDismiss = v as AttentionDismiss
                  applyLocalSetting({ panes: { attentionDismiss } })
                }}
              />
            </SettingsRow>
          </SettingsSection>

          {/* Notifications */}
          <SettingsSection title="Notifications" description="Sound and alert preferences">
            <SettingsRow label="Sound on completion">
              <Toggle
                checked={settings.notifications?.soundEnabled ?? true}
                onChange={(checked) => {
                  applyLocalSetting({ notifications: { soundEnabled: checked } })
                }}
              />
            </SettingsRow>
          </SettingsSection>

          {/* Terminal */}
          <SettingsSection title="Terminal" description="Font and rendering options">
            <SettingsRow label="Color scheme">
              <select
                value={settings.terminal.theme}
                onChange={(e) => {
                  const v = e.target.value as TerminalTheme
                  applyLocalSetting({ terminal: { theme: v } })
                }}
                className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
              >
                <option value="auto">Auto (follow app theme)</option>
                <optgroup label="Dark themes">
                  {darkThemes.map((t) => (
                    <option key={t} value={t}>{terminalThemes[t].name}</option>
                  ))}
                </optgroup>
                <optgroup label="Light themes">
                  {lightThemes.map((t) => (
                    <option key={t} value={t}>{terminalThemes[t].name}</option>
                  ))}
                </optgroup>
              </select>
            </SettingsRow>

            <SettingsRow label="Font size">
              <RangeSlider
                value={settings.terminal.fontSize}
                min={12}
                max={32}
                step={1}
                labelWidth="w-20"
                format={(v) => `${v}px (${Math.round(v / 16 * 100)}%)`}
                onChange={(v) => {
                  applyLocalSetting({ terminal: { fontSize: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Line height">
              <RangeSlider
                value={settings.terminal.lineHeight}
                min={1}
                max={1.8}
                step={0.05}
                labelWidth="w-10"
                format={(v) => v.toFixed(2)}
                onChange={(v) => {
                  applyLocalSetting({ terminal: { lineHeight: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Scrollback lines">
              <RangeSlider
                value={settings.terminal.scrollback}
                min={1000}
                max={20000}
                step={500}
                format={(v) => v.toLocaleString()}
                onChange={(v) => {
                  applyServerSetting({ terminal: { scrollback: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Cursor blink">
              <Toggle
                checked={settings.terminal.cursorBlink}
                onChange={(checked) => {
                  applyLocalSetting({ terminal: { cursorBlink: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Warn on external links">
              <Toggle
                checked={settings.terminal.warnExternalLinks}
                onChange={(checked) => {
                  applyLocalSetting({ terminal: { warnExternalLinks: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Font family">
              <select
                value={isSelectedFontAvailable ? settings.terminal.fontFamily : fallbackFontFamily}
                onChange={(e) => {
                  applyLocalSetting({ terminal: { fontFamily: e.target.value } })
                }}
                className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
              >
                {availableTerminalFonts.map((font) => (
                  <option key={font.value} value={font.value}>{font.label}</option>
                ))}
              </select>
            </SettingsRow>

            <div className="pt-1 border-t border-border/40">
              <button
                type="button"
                aria-expanded={terminalAdvancedOpen}
                aria-controls={terminalAdvancedId}
                className="h-10 w-full px-3 text-sm bg-muted rounded-md hover:bg-muted/80 focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
                onClick={() => setTerminalAdvancedOpen((open) => !open)}
              >
                Advanced
              </button>
              <div
                id={terminalAdvancedId}
                hidden={!terminalAdvancedOpen}
                className="mt-3 space-y-4"
              >
                <SettingsRow label="OSC52 clipboard access">
                  <SegmentedControl
                    value={settings.terminal.osc52Clipboard}
                    options={[
                      { value: 'ask', label: 'Ask' },
                      { value: 'always', label: 'Always' },
                      { value: 'never', label: 'Never' },
                    ]}
                    onChange={(v: string) => {
                      applyLocalSetting({ terminal: { osc52Clipboard: v as 'ask' | 'always' | 'never' } } as any)
                    }}
                  />
                </SettingsRow>
              </div>
            </div>
          </SettingsSection>

          {/* Editor */}
          <SettingsSection title="Editor" description="External editor for file opening">
            <SettingsRow label="External editor" description="Which editor to use when opening files from the editor pane">
              <select
                value={settings.editor?.externalEditor ?? 'auto'}
                onChange={(e) => {
                  const v = e.target.value as 'auto' | 'cursor' | 'code' | 'custom'
                  applyServerSetting({ editor: { externalEditor: v } })
                }}
                className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
              >
                <option value="auto">Auto (system default)</option>
                <option value="cursor">Cursor</option>
                <option value="code">VS Code</option>
                <option value="custom">Custom command</option>
              </select>
            </SettingsRow>
            {settings.editor?.externalEditor === 'custom' && (
              <SettingsRow
                label="Custom command"
                description="Command template. Use {file}, {line}, {col} as placeholders."
              >
                <input
                  type="text"
                  value={settings.editor?.customEditorCommand ?? ''}
                  placeholder="nvim +{line} {file}"
                  onChange={(e) => {
                    scheduleServerTextSettingSave('editor.customEditorCommand', {
                      editor: { customEditorCommand: e.target.value },
                    })
                  }}
                  className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:max-w-xs"
                />
              </SettingsRow>
            )}
          </SettingsSection>

          {/* Safety */}
          <SettingsSection title="Safety" description="Auto-kill and idle terminal management">
            <SettingsRow label="Auto-kill idle (minutes)">
              <RangeSlider
                value={settings.safety.autoKillIdleMinutes}
                min={10}
                max={720}
                step={10}
                format={(v) => String(v)}
                onChange={(v) => {
                  applyServerSetting({ safety: { autoKillIdleMinutes: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Default working directory">
              <div className="relative w-full md:max-w-xs">
                <input
                  type="text"
                  value={defaultCwdInput}
                  placeholder="e.g. C:\Users\you\projects"
                  aria-invalid={defaultCwdError ? true : undefined}
                  onChange={(e) => {
                    const nextValue = e.target.value
                    setDefaultCwdInput(nextValue)
                    setDefaultCwdError(null)
                    scheduleDefaultCwdValidation(nextValue)
                  }}
                  className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border md:h-8"
                />
                {defaultCwdError && (
                  <span
                    className="pointer-events-none absolute right-2 -bottom-4 text-[10px] text-destructive"
                  >
                    {defaultCwdError}
                  </span>
                )}
              </div>
            </SettingsRow>
          </SettingsSection>

          {/* Debugging */}
          <SettingsSection title="Debugging" description="Debug-level logs and perf instrumentation">
            <SettingsRow label="Debug logging">
              <Toggle
                checked={settings.logging?.debug ?? false}
                onChange={(checked) => {
                  applyServerSetting({ logging: { debug: checked } })
                }}
              />
            </SettingsRow>
          </SettingsSection>

          {/* Coding CLIs */}
          <SettingsSection title="Coding CLIs" description="Providers and defaults for coding sessions">
            {cliProviderConfigs.map((provider) => (
              <SettingsRow key={`enable-${provider.name}`} label={`Enable ${provider.label}`}>
                <Toggle
                  checked={enabledProviders.includes(provider.name)}
                  onChange={(checked) => setProviderEnabled(provider.name as CodingCliProviderName, checked)}
                />
              </SettingsRow>
            ))}

            {cliProviderConfigs.map((provider) => {
              const providerSettings = settings.codingCli?.providers?.[provider.name] || {}

              return (
                <div key={`provider-${provider.name}`} className="space-y-4">
                  {provider.supportsPermissionMode && (
                    <SettingsRow label={`${provider.label} permission mode`}>
                      <select
                        value={(providerSettings.permissionMode as ClaudePermissionMode) || 'default'}
                        onChange={(e) => {
                          const v = e.target.value as ClaudePermissionMode
                          applyServerSetting({
                            codingCli: { providers: { [provider.name]: { permissionMode: v } } },
                          })
                        }}
                        className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
                      >
                        <option value="default">Default</option>
                        <option value="plan">Plan</option>
                        <option value="acceptEdits">Accept edits</option>
                        <option value="bypassPermissions">Bypass permissions</option>
                      </select>
                    </SettingsRow>
                  )}

                  {provider.supportsModel && (
                    <SettingsRow label={`${provider.label} model`}>
                      <input
                        type="text"
                        value={providerSettings.model || ''}
                        placeholder={provider.name === 'codex' ? 'e.g. gpt-5-codex' : 'e.g. claude-3-5-sonnet'}
                        onChange={(e) => {
                          const model = e.target.value.trim()
                          scheduleServerTextSettingSave(`codingCli.providers.${provider.name}.model`, {
                            codingCli: { providers: { [provider.name]: { model: model || undefined } } },
                          })
                        }}
                        className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:max-w-xs"
                      />
                    </SettingsRow>
                  )}

                  {provider.supportsSandbox && (
                    <SettingsRow label={`${provider.label} sandbox`}>
                      <select
                        value={(providerSettings.sandbox as CodexSandboxMode) || ''}
                        onChange={(e) => {
                          const v = e.target.value as CodexSandboxMode
                          const sandbox = v || undefined
                          applyServerSetting({
                            codingCli: { providers: { [provider.name]: { sandbox } } },
                          })
                        }}
                        className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-auto"
                      >
                        <option value="">Default</option>
                        <option value="read-only">Read-only</option>
                        <option value="workspace-write">Workspace write</option>
                        <option value="danger-full-access">Danger full access</option>
                      </select>
                    </SettingsRow>
                  )}

                  <SettingsRow label={`${provider.label} starting directory`}>
                    <div className="relative w-full md:max-w-xs">
                      <input
                        type="text"
                        aria-label={`${provider.label} starting directory`}
                        value={providerCwdInputs[provider.name] ?? ''}
                        placeholder="e.g. ~/projects/my-app"
                        aria-invalid={providerCwdErrors[provider.name] ? true : undefined}
                        onChange={(e) => {
                          const nextValue = e.target.value
                          setProviderCwdInputs((prev) => ({ ...prev, [provider.name]: nextValue }))
                          setProviderCwdErrors((prev) => ({ ...prev, [provider.name]: null }))
                          scheduleProviderCwdValidation(provider.name, nextValue)
                        }}
                        className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border md:h-8"
                      />
                      {providerCwdErrors[provider.name] && (
                        <span className="pointer-events-none absolute right-2 -bottom-4 text-[10px] text-destructive">
                          {providerCwdErrors[provider.name]}
                        </span>
                      )}
                    </div>
                  </SettingsRow>
                </div>
              )
            })}
          </SettingsSection>

          {/* Keyboard shortcuts */}
          <SettingsSection title="Keyboard shortcuts" description="Navigation and terminal">
            <div className="space-y-2 text-sm">
              {KEYBOARD_SHORTCUTS.map((entry) => (
                <ShortcutRow key={entry.description} keys={entry.keys} description={entry.description} />
              ))}
            </div>
          </SettingsSection>

          {/* Network Access */}
          <SettingsSection title="Network Access" description="Control how Freshell is accessible on your network">
            <SettingsRow
              label="Remote access"
              description={remoteAccessError ?? 'Allow connections from other devices on your network'}
            >
              <Toggle
                checked={remoteAccessToggleChecked}
                disabled={configuring || networkStatus?.rebinding || remoteAccessPending || firewallRepairInProgress}
                aria-label="Remote access"
                onChange={async (checked) => {
                  setRemoteAccessError(null)
                  if (checked) {
                    await requestRemoteAccessConfigure('0.0.0.0')
                    return
                  }

                  if (requiresPrivilegedRemoteAccessDisable) {
                    await requestRemoteAccessDisable()
                    return
                  }

                  await requestRemoteAccessConfigure(checked ? '0.0.0.0' : '127.0.0.1')
                }}
              />
            </SettingsRow>

            {remoteAccessError && (
              <div
                role="alert"
                className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              >
                {remoteAccessError}
              </div>
            )}

            {(remoteAccessEnabled || remoteAccessRequested) && networkStatus && (
              <>
                {networkStatus.firewall && (
                  <SettingsRow
                    label="Firewall"
                    description={getFirewallDescription(networkStatus.firewall, firewallRefreshDetail)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{networkStatus.firewall.platform}</span>
                      {shouldShowFirewallFix(networkStatus.firewall, firewallRefreshDetail) && (
                        <button
                          onClick={() => {
                            void requestFirewallFix()
                          }}
                          className="rounded border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted"
                          aria-label="Fix firewall configuration"
                        >
                          Fix
                        </button>
                      )}
                    </div>
                  </SettingsRow>
                )}

                {remoteAccessEnabled && networkStatus.accessUrl && (
                  <SettingsRow label="Device access" description="Get a link to use from your phone or other computers">
                    <button
                      onClick={() => onSharePanel?.()}
                      className="rounded border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                      aria-label="Get link for your devices"
                    >
                      Get link
                    </button>
                  </SettingsRow>
                )}

                {networkStatus.devMode && networkStatus.firewall?.platform !== 'wsl2' && (
                  <div className="rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300" role="alert">
                    Dev mode: restart <code className="font-mono text-xs">npm run dev</code> for the Vite server to bind to the new address.
                  </div>
                )}
              </>
            )}
          </SettingsSection>

          <SettingsSection
            title="Devices"
            description="Rename devices for the Tabs workspace. Remote device aliases apply only on this machine."
          >
            {knownDevices.map((device) => (
              <SettingsRow
                key={device.key}
                label={device.isOwn ? 'This machine' : device.baseLabel}
                description={device.isOwn ? 'Renaming this updates what other machines see.' : 'Alias stored locally on this machine only.'}
              >
                <div className="flex w-full items-center gap-2 md:w-auto">
                  <input
                    type="text"
                    value={deviceNameInputs[device.key] ?? device.effectiveLabel}
                    onChange={(event) => setDeviceNameInputs((current) => ({
                      ...current,
                      [device.key]: event.target.value,
                    }))}
                    className="h-10 w-full min-w-[14rem] px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-[20rem]"
                    aria-label={`Device name for ${device.effectiveLabel}`}
                    placeholder={device.baseLabel}
                  />
                  <button
                    type="button"
                    onClick={() => saveDeviceName(device)}
                    className="h-10 px-3 text-sm rounded-md border border-border hover:bg-muted md:h-8"
                  >
                    Save
                  </button>
                  {!device.isOwn ? (
                    <button
                      type="button"
                      onClick={() => deleteDevice(device)}
                      className="h-10 px-3 text-sm rounded-md border border-border hover:bg-muted md:h-8"
                      aria-label={`Delete device ${device.effectiveLabel}`}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
              </SettingsRow>
            ))}
          </SettingsSection>

        </div>
      </div>
      <ConfirmModal
        open={pendingConfirmation !== null}
        title={pendingConfirmation?.request.title ?? ''}
        body={pendingConfirmation?.request.body ?? ''}
        confirmLabel={pendingConfirmation?.request.confirmLabel ?? 'Continue'}
        confirmVariant="default"
        onConfirm={handleConfirmPendingAction}
        onCancel={handleCancelPendingAction}
      />
    </div>
  )
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-medium">{title}</h2>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div className="space-y-4 pl-0.5">
        {children}
      </div>
    </div>
  )
}

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex w-full flex-col items-start gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
      {description ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="text-xs text-muted-foreground/60">{description}</span>
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">{label}</span>
      )}
      <div className="w-full md:w-auto">{children}</div>
    </div>
  )
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="flex w-full flex-wrap bg-muted rounded-md p-0.5 md:w-auto">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'min-h-10 flex-1 px-3 py-1 text-xs rounded-md transition-colors md:min-h-0 md:flex-none',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    <button
      role="switch"
      onClick={() => { if (!disabled) onChange(!checked) }}
      disabled={disabled}
      aria-label={ariaLabel ?? (checked ? 'Toggle off' : 'Toggle on')}
      aria-checked={checked}
      className={cn(
        'relative w-9 h-5 rounded-full transition-colors',
        checked ? 'bg-foreground' : 'bg-muted',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <div
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full transition-all',
          checked ? 'left-[1.125rem] bg-background' : 'left-0.5 bg-muted-foreground'
        )}
        aria-hidden="true"
      />
    </button>
  )
}

function ShortcutRow({
  keys,
  description,
}: {
  keys: string[]
  description: string
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{description}</span>
      <div className="flex items-center gap-1">
        {keys.map((key, i) => (
          <span key={i}>
            {i > 0 && <span className="text-muted-foreground/40 mx-0.5">+</span>}
            <kbd className="px-1.5 py-0.5 text-2xs bg-muted rounded font-mono">
              {key}
            </kbd>
          </span>
        ))}
      </div>
    </div>
  )
}

function RangeSlider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  width = 'w-full md:w-32',
  labelWidth = 'w-14',
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format: (value: number) => string
  width?: string
  labelWidth?: string
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  const displayValue = dragging ?? value

  return (
    <div className="flex w-full items-center gap-3 md:w-auto">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={displayValue}
        onChange={(e) => setDragging(Number(e.target.value))}
        onPointerUp={() => {
          if (dragging !== null) {
            onChange(dragging)
            setDragging(null)
          }
        }}
        onPointerLeave={() => {
          // Also commit if pointer leaves while dragging (edge case)
          if (dragging !== null) {
            onChange(dragging)
            setDragging(null)
          }
        }}
        className={cn(
          width,
          'h-1.5 bg-muted rounded-full appearance-none cursor-pointer',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground'
        )}
      />
      <span className={cn('text-sm tabular-nums', labelWidth)}>{format(displayValue)}</span>
    </div>
  )
}
