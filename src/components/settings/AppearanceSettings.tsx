// Theme, font, and terminal preview settings.

import { useEffect, useMemo, useState } from 'react'
import { terminalThemes, darkThemes, lightThemes, getTerminalTheme } from '@/lib/terminal-themes'
import { resolveTerminalFontFamily } from '@/lib/terminal-fonts'
import type { AppSettings, TerminalTheme } from '@/store/types'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  SegmentedControl,
  Toggle,
  RangeSlider,
} from './settings-controls'

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
  [],
]

function normalizePreviewLine(tokens: PreviewToken[], width: number): PreviewToken[] {
  let usedWidth = 0
  const result: PreviewToken[] = []
  for (const token of tokens) {
    if (usedWidth >= width) break
    const remaining = width - usedWidth
    if (token.text.length <= remaining) {
      result.push(token)
      usedWidth += token.text.length
    } else {
      result.push({ ...token, text: token.text.slice(0, remaining) })
      usedWidth = width
    }
  }
  if (usedWidth < width) {
    result.push({ text: ' '.repeat(width - usedWidth) })
  }
  return result
}

const terminalPreviewLines: PreviewToken[][] = terminalPreviewLinesRaw.map((tokens) =>
  normalizePreviewLine(tokens, terminalPreviewWidth),
)

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

export default function AppearanceSettings({
  settings,
  applyLocalSetting,
}: SettingsSectionProps) {
  const [availableTerminalFonts, setAvailableTerminalFonts] = useState(terminalFonts)
  const [fontsReady, setFontsReady] = useState(false)

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
    <>
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

      <SettingsSection id="appearance" title="Appearance" description="Theme and visual preferences">
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

        <SettingsRow label="Cursor blink">
          <Toggle
            checked={settings.terminal.cursorBlink}
            onChange={(checked) => {
              applyLocalSetting({ terminal: { cursorBlink: checked } })
            }}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )
}
