import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateSettingsLocal, markSaved } from '@/store/settingsSlice'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { terminalThemes, darkThemes, lightThemes } from '@/lib/terminal-themes'
import type { SidebarSortMode, TerminalTheme } from '@/store/types'

/** Monospace fonts with good Unicode block element support for terminal use */
const terminalFonts = [
  { value: 'Menlo', label: 'Menlo' },
  { value: 'Monaco', label: 'Monaco' },
  { value: 'SF Mono', label: 'SF Mono' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Cascadia Code', label: 'Cascadia Code' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'IBM Plex Mono', label: 'IBM Plex Mono' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'monospace', label: 'System monospace' },
]

export default function SettingsView() {
  const dispatch = useAppDispatch()
  const settings = useAppSelector((s) => s.settings.settings)
  const lastSavedAt = useAppSelector((s) => s.settings.lastSavedAt)

  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  function scheduleSave(updates: any) {
    if (pendingRef.current) clearTimeout(pendingRef.current)
    pendingRef.current = setTimeout(() => {
      patch(updates).catch((err) => console.warn('Failed to save settings', err))
      pendingRef.current = null
    }, 500)
  }

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
                value={settings.sidebar?.sortMode || 'hybrid'}
                onChange={(e) => {
                  const v = e.target.value as SidebarSortMode
                  dispatch(updateSettingsLocal({ sidebar: { sortMode: v } } as any))
                  scheduleSave({ sidebar: { sortMode: v } })
                }}
                className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
              >
                <option value="hybrid">Hybrid (running first)</option>
                <option value="recency">Recency</option>
                <option value="activity">Activity</option>
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
                value={settings.terminal.fontFamily}
                onChange={(e) => {
                  dispatch(updateSettingsLocal({ terminal: { fontFamily: e.target.value } } as any))
                  scheduleSave({ terminal: { fontFamily: e.target.value } })
                }}
                className="h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
              >
                {terminalFonts.map((font) => (
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
