import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateSettingsLocal, markSaved, defaultSettings, mergeSettings } from '@/store/settingsSlice'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { terminalThemes, darkThemes, lightThemes, getTerminalTheme } from '@/lib/terminal-themes'
import { resolveTerminalFontFamily, saveLocalTerminalFontFamily } from '@/lib/terminal-fonts'
import type { AppSettings, SidebarSortMode, TerminalTheme, CodexSandboxMode, ClaudePermissionMode, CodingCliProviderName } from '@/store/types'
import type { DeepPartial } from '@/lib/type-utils'
import { configureNetwork, fetchNetworkStatus } from '@/store/networkSlice'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import { fetchFirewallConfig } from '@/lib/firewall-configure'
import { nanoid } from '@reduxjs/toolkit'
import type { AppView } from '@/components/Sidebar'
import { CODING_CLI_PROVIDER_CONFIGS } from '@/lib/coding-cli-utils'

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

const terminalPreviewWidth = 40
const terminalPreviewHeight = 8

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
  const dispatch = useAppDispatch()
  const rawSettings = useAppSelector((s) => s.settings.settings)
  const settings = useMemo(
    () => mergeSettings(defaultSettings, rawSettings || {}),
    [rawSettings],
  )
  const lastSavedAt = useAppSelector((s) => s.settings.lastSavedAt)
  const networkStatus = useAppSelector((s) => s.network.status)
  const configuring = useAppSelector((s) => s.network.configuring)
  const enabledProviders = useMemo(
    () => settings.codingCli?.enabledProviders ?? [],
    [settings.codingCli?.enabledProviders],
  )

  const [availableTerminalFonts, setAvailableTerminalFonts] = useState(terminalFonts)
  const [fontsReady, setFontsReady] = useState(false)
  const [terminalAdvancedOpen, setTerminalAdvancedOpen] = useState(false)
  const [defaultCwdInput, setDefaultCwdInput] = useState(settings.defaultCwd ?? '')
  const [defaultCwdError, setDefaultCwdError] = useState<string | null>(null)
  const terminalAdvancedId = useId()
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaultCwdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaultCwdValidationRef = useRef(0)
  const lastSettingsDefaultCwdRef = useRef(settings.defaultCwd ?? '')
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

  const patch = useMemo(
    () => async (updates: DeepPartial<AppSettings>) => {
      await api.patch('/api/settings', updates)
      dispatch(markSaved())
    },
    [dispatch],
  )

  useEffect(() => {
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current)
      if (defaultCwdTimerRef.current) clearTimeout(defaultCwdTimerRef.current)
      for (const timer of Object.values(providerCwdTimerRef.current)) {
        clearTimeout(timer)
      }
    }
  }, [])

  const scheduleSave = useCallback((updates: any) => {
    if (pendingRef.current) clearTimeout(pendingRef.current)
    pendingRef.current = setTimeout(() => {
      patch(updates).catch((err) => console.warn('Failed to save settings', err))
      pendingRef.current = null
    }, 500)
  }, [patch])

  useEffect(() => {
    const next = settings.defaultCwd ?? ''
    if (defaultCwdInput === lastSettingsDefaultCwdRef.current) {
      setDefaultCwdInput(next)
    }
    lastSettingsDefaultCwdRef.current = next
  }, [defaultCwdInput, settings.defaultCwd])

  const commitDefaultCwd = useCallback((nextValue: string | undefined) => {
    if (nextValue === settings.defaultCwd) return
    dispatch(updateSettingsLocal({ defaultCwd: nextValue }))
    // Send '' to API when clearing — JSON.stringify strips undefined, but server normalizes '' → undefined
    patch({ defaultCwd: nextValue ?? '' }).catch((err) => console.warn('Failed to save settings', err))
  }, [dispatch, patch, settings.defaultCwd])

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
    for (const config of CODING_CLI_PROVIDER_CONFIGS) {
      initial[config.name] = settings.codingCli?.providers?.[config.name]?.cwd ?? ''
    }
    return initial
  })
  const [providerCwdErrors, setProviderCwdErrors] = useState<Record<string, string | null>>({})
  const providerCwdTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const providerCwdValidationRef = useRef<Record<string, number>>({})
  const lastSettingsProviderCwdRef = useRef<Record<string, string>>(
    Object.fromEntries(
      CODING_CLI_PROVIDER_CONFIGS.map((c) => [c.name, settings.codingCli?.providers?.[c.name]?.cwd ?? ''])
    )
  )

  // Sync provider cwd inputs when settings load or change externally
  useEffect(() => {
    for (const config of CODING_CLI_PROVIDER_CONFIGS) {
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
        dispatch(updateSettingsLocal({
          codingCli: { providers: { [providerName]: { cwd: undefined } } },
        }))
        scheduleSave({ codingCli: { providers: { [providerName]: { cwd: undefined } } } })
        return
      }

      api.post<{ valid: boolean }>('/api/files/validate-dir', { path: trimmed })
        .then((result) => {
          if (providerCwdValidationRef.current[key] !== validationId) return
          if (result.valid) {
            setProviderCwdErrors((prev) => ({ ...prev, [key]: null }))
            dispatch(updateSettingsLocal({
              codingCli: { providers: { [providerName]: { cwd: trimmed } } },
            }))
            scheduleSave({ codingCli: { providers: { [providerName]: { cwd: trimmed } } } })
          } else {
            setProviderCwdErrors((prev) => ({ ...prev, [key]: 'directory not found' }))
          }
        })
        .catch(() => {
          if (providerCwdValidationRef.current[key] !== validationId) return
          setProviderCwdErrors((prev) => ({ ...prev, [key]: 'directory not found' }))
        })
    }, 500)
  }, [dispatch, scheduleSave])

  const setProviderEnabled = useCallback((provider: CodingCliProviderName, enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...enabledProviders, provider]))
      : enabledProviders.filter((p) => p !== provider)
    dispatch(updateSettingsLocal({ codingCli: { enabledProviders: next } }))
    scheduleSave({ codingCli: { enabledProviders: next } })
  }, [dispatch, enabledProviders, scheduleSave])

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

    dispatch(updateSettingsLocal({ terminal: { fontFamily: fallbackFontFamily } }))
    saveLocalTerminalFontFamily(fallbackFontFamily)
  }, [
    dispatch,
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
                  dispatch(updateSettingsLocal({ theme: v as AppSettings['theme'] }))
                  scheduleSave({ theme: v })
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
                  dispatch(updateSettingsLocal({ uiScale: v }))
                  scheduleSave({ uiScale: v })
                }}
              />
            </SettingsRow>

          </SettingsSection>

          {/* Sidebar */}
          <SettingsSection title="Sidebar" description="Session list and navigation">
            <SettingsRow label="Sort mode">
              <select
                value={settings.sidebar?.sortMode || 'recency-pinned'}
                onChange={(e) => {
                  const v = e.target.value as SidebarSortMode
                  dispatch(updateSettingsLocal({ sidebar: { sortMode: v } }))
                  scheduleSave({ sidebar: { sortMode: v } })
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
                  dispatch(updateSettingsLocal({ sidebar: { showProjectBadges: checked } }))
                  scheduleSave({ sidebar: { showProjectBadges: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Show subagent sessions">
              <Toggle
                checked={settings.sidebar?.showSubagents ?? false}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ sidebar: { showSubagents: checked } }))
                  scheduleSave({ sidebar: { showSubagents: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Show non-interactive sessions">
              <Toggle
                checked={settings.sidebar?.showNoninteractiveSessions ?? false}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ sidebar: { showNoninteractiveSessions: checked } }))
                  scheduleSave({ sidebar: { showNoninteractiveSessions: checked } })
                }}
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
                  dispatch(updateSettingsLocal({ panes: { defaultNewPane: v } }))
                  scheduleSave({ panes: { defaultNewPane: v } })
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
                  dispatch(updateSettingsLocal({ panes: { snapThreshold: v } }))
                  scheduleSave({ panes: { snapThreshold: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Icons on tabs">
              <Toggle
                checked={settings.panes?.iconsOnTabs ?? true}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ panes: { iconsOnTabs: checked } }))
                  scheduleSave({ panes: { iconsOnTabs: checked } })
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
                  dispatch(updateSettingsLocal({ panes: { tabAttentionStyle: v } }))
                  scheduleSave({ panes: { tabAttentionStyle: v } })
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
                  dispatch(updateSettingsLocal({ panes: { attentionDismiss: v } }))
                  scheduleSave({ panes: { attentionDismiss: v } })
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
                  dispatch(updateSettingsLocal({ notifications: { soundEnabled: checked } }))
                  scheduleSave({ notifications: { soundEnabled: checked } })
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
                  dispatch(updateSettingsLocal({ terminal: { theme: v } }))
                  scheduleSave({ terminal: { theme: v } })
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
                  dispatch(updateSettingsLocal({ terminal: { fontSize: v } }))
                  scheduleSave({ terminal: { fontSize: v } })
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
                  dispatch(updateSettingsLocal({ terminal: { lineHeight: v } }))
                  scheduleSave({ terminal: { lineHeight: v } })
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
                  dispatch(updateSettingsLocal({ terminal: { scrollback: v } }))
                  scheduleSave({ terminal: { scrollback: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Cursor blink">
              <Toggle
                checked={settings.terminal.cursorBlink}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ terminal: { cursorBlink: checked } }))
                  scheduleSave({ terminal: { cursorBlink: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Warn on external links">
              <Toggle
                checked={settings.terminal.warnExternalLinks}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ terminal: { warnExternalLinks: checked } }))
                  scheduleSave({ terminal: { warnExternalLinks: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Font family">
              <select
                value={isSelectedFontAvailable ? settings.terminal.fontFamily : fallbackFontFamily}
                onChange={(e) => {
                  dispatch(updateSettingsLocal({ terminal: { fontFamily: e.target.value } }))
                  saveLocalTerminalFontFamily(e.target.value)
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
                      dispatch(updateSettingsLocal({ terminal: { osc52Clipboard: v as 'ask' | 'always' | 'never' } } as any))
                      scheduleSave({ terminal: { osc52Clipboard: v as 'ask' | 'always' | 'never' } })
                    }}
                  />
                </SettingsRow>
              </div>
            </div>
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
                  dispatch(updateSettingsLocal({ safety: { autoKillIdleMinutes: v } }))
                  scheduleSave({ safety: { autoKillIdleMinutes: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Warn before kill (minutes)">
              <RangeSlider
                value={settings.safety.warnBeforeKillMinutes}
                min={1}
                max={60}
                step={1}
                format={(v) => String(v)}
                onChange={(v) => {
                  dispatch(updateSettingsLocal({ safety: { warnBeforeKillMinutes: v } }))
                  scheduleSave({ safety: { warnBeforeKillMinutes: v } })
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
                  dispatch(updateSettingsLocal({ logging: { debug: checked } }))
                  scheduleSave({ logging: { debug: checked } })
                }}
              />
            </SettingsRow>
          </SettingsSection>

          {/* Coding CLIs */}
          <SettingsSection title="Coding CLIs" description="Providers and defaults for coding sessions">
            {CODING_CLI_PROVIDER_CONFIGS.map((provider) => (
              <SettingsRow key={`enable-${provider.name}`} label={`Enable ${provider.label}`}>
                <Toggle
                  checked={enabledProviders.includes(provider.name)}
                  onChange={(checked) => setProviderEnabled(provider.name as CodingCliProviderName, checked)}
                />
              </SettingsRow>
            ))}

            {CODING_CLI_PROVIDER_CONFIGS.map((provider) => {
              const providerSettings = settings.codingCli?.providers?.[provider.name] || {}

              return (
                <div key={`provider-${provider.name}`} className="space-y-4">
                  {provider.supportsPermissionMode && (
                    <SettingsRow label={`${provider.label} permission mode`}>
                      <select
                        value={(providerSettings.permissionMode as ClaudePermissionMode) || 'default'}
                        onChange={(e) => {
                          const v = e.target.value as ClaudePermissionMode
                          dispatch(updateSettingsLocal({
                            codingCli: { providers: { [provider.name]: { permissionMode: v } } },
                          }))
                          scheduleSave({ codingCli: { providers: { [provider.name]: { permissionMode: v } } } })
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
                          dispatch(updateSettingsLocal({
                            codingCli: { providers: { [provider.name]: { model: model || undefined } } },
                          }))
                          scheduleSave({ codingCli: { providers: { [provider.name]: { model: model || undefined } } } })
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
                          dispatch(updateSettingsLocal({
                            codingCli: { providers: { [provider.name]: { sandbox } } },
                          }))
                          scheduleSave({ codingCli: { providers: { [provider.name]: { sandbox } } } })
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
              <ShortcutRow keys={['Ctrl', 'Shift', '[']} description="Previous tab" />
              <ShortcutRow keys={['Ctrl', 'Shift', ']']} description="Next tab" />
              <ShortcutRow keys={['Shift', 'Enter']} description="Newline (same as Ctrl+J)" />
              <ShortcutRow keys={['Ctrl', 'J']} description="Newline" />
            </div>
          </SettingsSection>

          {/* Network Access */}
          <SettingsSection title="Network Access" description="Control how Freshell is accessible on your network">
            <SettingsRow label="Remote access" description="Allow connections from other devices on your network">
              <Toggle
                checked={networkStatus?.host === '0.0.0.0'}
                disabled={configuring || networkStatus?.rebinding}
                aria-label="Remote access"
                onChange={async (checked) => {
                  await dispatch(configureNetwork({
                    host: checked ? '0.0.0.0' : '127.0.0.1',
                    configured: true,
                  })).unwrap()
                }}
              />
            </SettingsRow>

            {networkStatus?.host === '0.0.0.0' && (
              <>
                {networkStatus.firewall && (
                  <SettingsRow
                    label="Firewall"
                    description={
                      !networkStatus.firewall.active ? 'No firewall detected'
                        : networkStatus.firewall.portOpen === true ? 'Port is open'
                        : networkStatus.firewall.portOpen === false ? 'Port may be blocked'
                        : 'Firewall detected'
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{networkStatus.firewall.platform}</span>
                      {networkStatus.firewall.active && networkStatus.firewall.portOpen !== true && (
                        <button
                          onClick={async () => {
                            try {
                              const result = await fetchFirewallConfig()
                              if (result.method === 'terminal') {
                                const tabId = nanoid()
                                dispatch(addTab({ id: tabId, title: 'Firewall Setup', mode: 'shell', shell: 'system' }))
                                dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
                                onFirewallTerminal?.({ tabId, command: result.command })
                                onNavigate?.('terminal')
                              } else if (result.method === 'wsl2' || result.method === 'windows-elevated') {
                                // Server handles it; re-fetch status after a delay
                                setTimeout(() => dispatch(fetchNetworkStatus()), 2000)
                              }
                            } catch {
                              // Silently fail — user can retry
                            }
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

                {networkStatus.accessUrl && (
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

        </div>
      </div>
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
