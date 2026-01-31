import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateSettingsLocal, markSaved, defaultSettings, mergeSettings } from '@/store/settingsSlice'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { terminalThemes, darkThemes, lightThemes, getTerminalTheme } from '@/lib/terminal-themes'
import type { SidebarSortMode, TerminalTheme, CodexSandboxMode, ClaudePermissionMode, CodingCliProviderName } from '@/store/types'
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

const terminalPreviewLines: PreviewToken[][] = [
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
].map((tokens) => normalizePreviewLine(tokens, terminalPreviewWidth))

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

export default function SettingsView() {
  const dispatch = useAppDispatch()
  const rawSettings = useAppSelector((s) => s.settings.settings)
  const settings = useMemo(
    () => mergeSettings(defaultSettings, rawSettings || {}),
    [rawSettings],
  )
  const lastSavedAt = useAppSelector((s) => s.settings.lastSavedAt)
  const enabledProviders = settings.codingCli?.enabledProviders ?? []

  const [availableTerminalFonts, setAvailableTerminalFonts] = useState(terminalFonts)
  const [fontsReady, setFontsReady] = useState(false)

  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    () => async (updates: any) => {
      await api.patch('/api/settings', updates)
      dispatch(markSaved())
    },
    [dispatch],
  )

  useEffect(() => {
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current)
    }
  }, [])

  const scheduleSave = useCallback((updates: any) => {
    if (pendingRef.current) clearTimeout(pendingRef.current)
    pendingRef.current = setTimeout(() => {
      patch(updates).catch((err) => console.warn('Failed to save settings', err))
      pendingRef.current = null
    }, 500)
  }, [patch])

  const setProviderEnabled = useCallback((provider: CodingCliProviderName, enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...enabledProviders, provider]))
      : enabledProviders.filter((p) => p !== provider)
    dispatch(updateSettingsLocal({ codingCli: { enabledProviders: next } } as any))
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

    dispatch(updateSettingsLocal({ terminal: { fontFamily: fallbackFontFamily } } as any))
    scheduleSave({ terminal: { fontFamily: fallbackFontFamily } })
  }, [
    dispatch,
    fallbackFontFamily,
    fontsReady,
    isSelectedFontAvailable,
    scheduleSave,
    settings.terminal.fontFamily,
  ])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border/30">
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
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-8">

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
                width: '40ch',
                height: `${terminalPreviewHeight * settings.terminal.lineHeight}em`,
                fontFamily: settings.terminal.fontFamily,
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
                  dispatch(updateSettingsLocal({ theme: v as any }))
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
                value={settings.sidebar?.sortMode || 'activity'}
                onChange={(e) => {
                  const v = e.target.value as SidebarSortMode
                  dispatch(updateSettingsLocal({ sidebar: { sortMode: v } } as any))
                  scheduleSave({ sidebar: { sortMode: v } })
                }}
                className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
              >
                <option value="recency">Recency</option>
                <option value="activity">Activity (tabs first)</option>
                <option value="project">Project</option>
              </select>
            </SettingsRow>

            <SettingsRow label="Show project badges">
              <Toggle
                checked={settings.sidebar?.showProjectBadges ?? true}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ sidebar: { showProjectBadges: checked } } as any))
                  scheduleSave({ sidebar: { showProjectBadges: checked } })
                }}
              />
            </SettingsRow>
          </SettingsSection>

          {/* Panes */}
          <SettingsSection title="Panes" description="New pane behavior">
            <SettingsRow label="Default new pane">
              <select
                aria-label="Default new pane"
                value={settings.panes?.defaultNewPane || 'ask'}
                onChange={(e) => {
                  const v = e.target.value as 'ask' | 'shell' | 'browser' | 'editor'
                  dispatch(updateSettingsLocal({ panes: { defaultNewPane: v } } as any))
                  scheduleSave({ panes: { defaultNewPane: v } })
                }}
                className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
              >
                <option value="ask">Ask</option>
                <option value="shell">Shell</option>
                <option value="browser">Browser</option>
                <option value="editor">Editor</option>
              </select>
            </SettingsRow>
          </SettingsSection>

          {/* Terminal */}
          <SettingsSection title="Terminal" description="Font and rendering options">
            <SettingsRow label="Color scheme">
              <select
                value={settings.terminal.theme}
                onChange={(e) => {
                  const v = e.target.value as TerminalTheme
                  dispatch(updateSettingsLocal({ terminal: { theme: v } } as any))
                  scheduleSave({ terminal: { theme: v } })
                }}
                className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
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
                  dispatch(updateSettingsLocal({ terminal: { fontSize: v } } as any))
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
                  dispatch(updateSettingsLocal({ terminal: { lineHeight: v } } as any))
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
                  dispatch(updateSettingsLocal({ terminal: { scrollback: v } } as any))
                  scheduleSave({ terminal: { scrollback: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Cursor blink">
              <Toggle
                checked={settings.terminal.cursorBlink}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ terminal: { cursorBlink: checked } } as any))
                  scheduleSave({ terminal: { cursorBlink: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Font family">
              <select
                value={isSelectedFontAvailable ? settings.terminal.fontFamily : fallbackFontFamily}
                onChange={(e) => {
                  dispatch(updateSettingsLocal({ terminal: { fontFamily: e.target.value } } as any))
                  scheduleSave({ terminal: { fontFamily: e.target.value } })
                }}
                className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
              >
                {availableTerminalFonts.map((font) => (
                  <option key={font.value} value={font.value}>{font.label}</option>
                ))}
              </select>
            </SettingsRow>
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
                  dispatch(updateSettingsLocal({ safety: { autoKillIdleMinutes: v } } as any))
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
                  dispatch(updateSettingsLocal({ safety: { warnBeforeKillMinutes: v } } as any))
                  scheduleSave({ safety: { warnBeforeKillMinutes: v } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Default working directory">
              <input
                type="text"
                value={settings.defaultCwd || ''}
                placeholder="e.g. C:\Users\you\projects"
                onChange={(e) => {
                  dispatch(updateSettingsLocal({ defaultCwd: e.target.value || undefined }))
                  scheduleSave({ defaultCwd: e.target.value || undefined })
                }}
                className="w-full max-w-xs h-8 px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border"
              />
            </SettingsRow>
          </SettingsSection>

          {/* Notifications */}
          <SettingsSection title="Notifications" description="Activity indicators and sounds">
            <SettingsRow label="Show when working">
              <Toggle
                checked={settings.notifications?.visualWhenWorking ?? true}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ notifications: { visualWhenWorking: checked } } as any))
                  scheduleSave({ notifications: { visualWhenWorking: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Show when finished">
              <Toggle
                checked={settings.notifications?.visualWhenFinished ?? true}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ notifications: { visualWhenFinished: checked } } as any))
                  scheduleSave({ notifications: { visualWhenFinished: checked } })
                }}
              />
            </SettingsRow>

            <SettingsRow label="Sound when finished">
              <Toggle
                checked={settings.notifications?.soundWhenFinished ?? true}
                onChange={(checked) => {
                  dispatch(updateSettingsLocal({ notifications: { soundWhenFinished: checked } } as any))
                  scheduleSave({ notifications: { soundWhenFinished: checked } })
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
                          } as any))
                          scheduleSave({ codingCli: { providers: { [provider.name]: { permissionMode: v } } } })
                        }}
                        className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
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
                          } as any))
                          scheduleSave({ codingCli: { providers: { [provider.name]: { model: model || undefined } } } })
                        }}
                        className="w-full max-w-xs h-8 px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border"
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
                          } as any))
                          scheduleSave({ codingCli: { providers: { [provider.name]: { sandbox } } } })
                        }}
                        className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
                      >
                        <option value="">Default</option>
                        <option value="read-only">Read-only</option>
                        <option value="workspace-write">Workspace write</option>
                        <option value="danger-full-access">Danger full access</option>
                      </select>
                    </SettingsRow>
                  )}
                </div>
              )
            })}
          </SettingsSection>

          {/* Keyboard shortcuts */}
          <SettingsSection title="Keyboard shortcuts" description="Quick navigation">
            <div className="space-y-2 text-sm">
              <ShortcutRow keys={['Ctrl', 'B', 'T']} description="New terminal" />
              <ShortcutRow keys={['Ctrl', 'B', 'W']} description="Close tab" />
              <ShortcutRow keys={['Ctrl', 'B', 'S']} description="Sessions view" />
              <ShortcutRow keys={['Ctrl', 'B', 'O']} description="Overview" />
              <ShortcutRow keys={['Ctrl', 'B', ',']} description="Settings" />
            </div>
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
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
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
    <div className="flex bg-muted rounded-md p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-3 py-1 text-xs rounded-md transition-colors',
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
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-9 h-5 rounded-full transition-colors',
        checked ? 'bg-foreground' : 'bg-muted'
      )}
    >
      <div
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full transition-all',
          checked ? 'left-[1.125rem] bg-background' : 'left-0.5 bg-muted-foreground'
        )}
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
  width = 'w-32',
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
    <div className="flex items-center gap-3">
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
