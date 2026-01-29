import { useEffect, useMemo, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateSettingsLocal, markSaved } from '@/store/settingsSlice'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { SidebarSortMode } from '@/store/types'

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
            <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
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
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.75}
                  max={2}
                  step={0.125}
                  value={settings.uiScale ?? 1.25}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    dispatch(updateSettingsLocal({ uiScale: v }))
                    scheduleSave({ uiScale: v })
                  }}
                  className="w-32 h-1.5 bg-muted rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
                />
                <span className="text-sm tabular-nums w-12">{Math.round((settings.uiScale ?? 1.25) * 100)}%</span>
              </div>
            </SettingsRow>

            <SettingsRow label="Terminal theme">
              <SegmentedControl
                value={settings.terminal.theme}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                onChange={(v) => {
                  dispatch(updateSettingsLocal({ terminal: { theme: v as any } } as any))
                  scheduleSave({ terminal: { theme: v } })
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
            <SettingsRow label="Font size">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={10}
                  max={22}
                  step={1}
                  value={settings.terminal.fontSize}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    dispatch(updateSettingsLocal({ terminal: { fontSize: v } } as any))
                    scheduleSave({ terminal: { fontSize: v } })
                  }}
                  className="w-32 h-1.5 bg-muted rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
                />
                <span className="text-sm tabular-nums w-8">{settings.terminal.fontSize}</span>
              </div>
            </SettingsRow>

            <SettingsRow label="Line height">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={1.8}
                  step={0.05}
                  value={settings.terminal.lineHeight}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    dispatch(updateSettingsLocal({ terminal: { lineHeight: v } } as any))
                    scheduleSave({ terminal: { lineHeight: v } })
                  }}
                  className="w-32 h-1.5 bg-muted rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
                />
                <span className="text-sm tabular-nums w-10">{settings.terminal.lineHeight.toFixed(2)}</span>
              </div>
            </SettingsRow>

            <SettingsRow label="Scrollback lines">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1000}
                  max={20000}
                  step={500}
                  value={settings.terminal.scrollback}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    dispatch(updateSettingsLocal({ terminal: { scrollback: v } } as any))
                    scheduleSave({ terminal: { scrollback: v } })
                  }}
                  className="w-32 h-1.5 bg-muted rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
                />
                <span className="text-sm tabular-nums w-14">{settings.terminal.scrollback.toLocaleString()}</span>
              </div>
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
              <input
                type="text"
                value={settings.terminal.fontFamily}
                onChange={(e) => {
                  dispatch(updateSettingsLocal({ terminal: { fontFamily: e.target.value } } as any))
                  scheduleSave({ terminal: { fontFamily: e.target.value } })
                }}
                className="w-full max-w-xs h-8 px-3 text-sm bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
              />
            </SettingsRow>
          </SettingsSection>

          {/* Safety */}
          <SettingsSection title="Safety" description="Auto-kill and idle terminal management">
            <SettingsRow label="Auto-kill idle (minutes)">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={10}
                  max={720}
                  step={10}
                  value={settings.safety.autoKillIdleMinutes}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    dispatch(updateSettingsLocal({ safety: { autoKillIdleMinutes: v } } as any))
                    scheduleSave({ safety: { autoKillIdleMinutes: v } })
                  }}
                  className="w-32 h-1.5 bg-muted rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
                />
                <span className="text-sm tabular-nums w-14">{settings.safety.autoKillIdleMinutes}</span>
              </div>
            </SettingsRow>

            <SettingsRow label="Warn before kill (minutes)">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={60}
                  step={1}
                  value={settings.safety.warnBeforeKillMinutes}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    dispatch(updateSettingsLocal({ safety: { warnBeforeKillMinutes: v } } as any))
                    scheduleSave({ safety: { warnBeforeKillMinutes: v } })
                  }}
                  className="w-32 h-1.5 bg-muted rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
                />
                <span className="text-sm tabular-nums w-14">{settings.safety.warnBeforeKillMinutes}</span>
              </div>
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
          checked ? 'left-[18px] bg-background' : 'left-0.5 bg-muted-foreground'
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
