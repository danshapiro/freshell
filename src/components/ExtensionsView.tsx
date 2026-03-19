// Extension management page — shows extensions with expandable config cards.

import { useCallback, useMemo, useRef, useState } from 'react'
import { useAppSelector, useAppDispatch } from '@/store/hooks'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import {
  stageServerSettingsPatchPreview,
} from '@/store/settingsThunks'
import { selectManagedItems, type ManagedItem, type ManagedItemConfig } from '@/store/managed-items'
import type { AppView } from '@/components/Sidebar'
import type { ServerSettingsPatch } from '@/store/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ArrowLeft, Puzzle, Server, Monitor, Terminal, ChevronDown } from 'lucide-react'

const SERVER_TEXT_SETTINGS_DEBOUNCE_MS = 500

interface ExtensionsViewProps {
  onNavigate: (view: AppView) => void
}

function categoryIcon(category: 'cli' | 'server' | 'client') {
  switch (category) {
    case 'server': return <Server className="w-4 h-4" />
    case 'client': return <Monitor className="w-4 h-4" />
    case 'cli': return <Terminal className="w-4 h-4" />
  }
}

function categoryLabel(category: 'cli' | 'server' | 'client') {
  switch (category) {
    case 'server': return 'Server'
    case 'client': return 'Client'
    case 'cli': return 'CLI'
  }
}

function groupLabel(kind: 'cli' | 'server' | 'client') {
  switch (kind) {
    case 'cli': return 'CLI Agents'
    case 'server': return 'Server Extensions'
    case 'client': return 'Client Extensions'
  }
}

interface ConfigFieldProps {
  item: ManagedItem
  field: ManagedItemConfig
  onConfigChange: (item: ManagedItem, key: string, value: unknown) => void
  cwdErrors: Record<string, string | null>
}

function ConfigField({ item, field, onConfigChange, cwdErrors }: ConfigFieldProps) {
  const fieldId = `${item.id}-${field.key}`

  if (field.type === 'select') {
    return (
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor={fieldId} className="text-xs text-muted-foreground">{field.label}</label>
        <select
          id={fieldId}
          value={field.value as string}
          onChange={(e) => onConfigChange(item, field.key, e.target.value)}
          className="h-8 w-full px-2 text-xs bg-muted border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border sm:w-auto sm:min-w-[10rem]"
        >
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === 'toggle') {
    return (
      <div className="flex items-center justify-between">
        <label htmlFor={fieldId} className="text-xs text-muted-foreground">{field.label}</label>
        <button
          id={fieldId}
          role="switch"
          aria-checked={field.value as boolean}
          onClick={() => onConfigChange(item, field.key, !(field.value as boolean))}
          className={cn(
            'relative w-8 h-4 rounded-full transition-colors',
            field.value ? 'bg-foreground' : 'bg-muted',
          )}
        >
          <div
            className={cn(
              'absolute top-0.5 h-3 w-3 rounded-full transition-all',
              field.value ? 'left-[1rem] bg-background' : 'left-0.5 bg-muted-foreground',
            )}
            aria-hidden="true"
          />
        </button>
      </div>
    )
  }

  if (field.type === 'path') {
    const error = cwdErrors[`${item.id}.${field.key}`]
    return (
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor={fieldId} className="text-xs text-muted-foreground">{field.label}</label>
        <div className="relative w-full sm:max-w-[14rem]">
          <input
            id={fieldId}
            type="text"
            value={field.value as string}
            placeholder="e.g. ~/projects/my-app"
            aria-label={field.label}
            aria-invalid={error ? true : undefined}
            onChange={(e) => onConfigChange(item, field.key, e.target.value)}
            className="h-8 w-full px-2 text-xs bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border"
          />
          {error && (
            <span className="pointer-events-none absolute right-1 -bottom-3.5 text-[10px] text-destructive">
              {error}
            </span>
          )}
        </div>
      </div>
    )
  }

  // text type
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <label htmlFor={fieldId} className="text-xs text-muted-foreground">{field.label}</label>
      <input
        id={fieldId}
        type="text"
        value={field.value as string}
        placeholder={field.key === 'model' ? (item.id === 'codex' ? 'e.g. gpt-5-codex' : 'e.g. claude-3-5-sonnet') : undefined}
        aria-label={field.label}
        onChange={(e) => onConfigChange(item, field.key, e.target.value)}
        className="h-8 w-full px-2 text-xs bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border sm:max-w-[14rem]"
      />
    </div>
  )
}

interface ExtensionCardProps {
  item: ManagedItem
  expanded: boolean
  onToggleExpand: () => void
  onToggleEnabled: (item: ManagedItem, enabled: boolean) => void
  onConfigChange: (item: ManagedItem, key: string, value: unknown) => void
  cwdErrors: Record<string, string | null>
}

function ExtensionCard({ item, expanded, onToggleExpand, onToggleEnabled, onConfigChange, cwdErrors }: ExtensionCardProps) {
  const isRunning = item.kind === 'server' && item.status?.running

  return (
    <div
      className={cn(
        'rounded-lg border border-border/40 bg-card flex flex-col',
        !item.enabled && 'opacity-50',
      )}
      data-testid={`extension-card-${item.id}`}
    >
      {/* Card header */}
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start gap-3">
          {item.iconUrl ? (
            <img src={item.iconUrl} alt="" className="w-10 h-10 rounded" />
          ) : (
            <div className="w-10 h-10 rounded bg-muted flex items-center justify-center text-muted-foreground">
              <Puzzle className="w-5 h-5" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm truncate">{item.name}</h3>
              <span className="text-xs text-muted-foreground shrink-0">v{item.version}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.description}</p>
          </div>
        </div>

        {/* Footer: category badge + status + expand + toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {categoryIcon(item.kind)}
              {categoryLabel(item.kind)}
            </span>
            {item.enabled && isRunning && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
                Running
              </span>
            )}
            {item.picker?.shortcut && (
              <span className="text-xs text-muted-foreground" title="Keyboard shortcut in pane picker">
                <kbd className="rounded border border-border/40 px-1 py-0.5 text-[10px] font-mono">{item.picker.shortcut}</kbd>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {item.config.length > 0 && (
              <button
                onClick={onToggleExpand}
                className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.name} details`}
              >
                <ChevronDown className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')} />
              </button>
            )}
            <button
              role="switch"
              aria-checked={item.enabled}
              aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`}
              onClick={() => onToggleEnabled(item, !item.enabled)}
              className={cn(
                'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                item.enabled ? 'bg-emerald-500' : 'bg-zinc-600',
              )}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                  item.enabled ? 'translate-x-[22px]' : 'translate-x-[3px]',
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Expanded config */}
      {expanded && item.config.length > 0 && (
        <div className="border-t border-border/30 px-4 py-3 space-y-3">
          {item.config.map((field) => (
            <ConfigField
              key={field.key}
              item={item}
              field={field}
              onConfigChange={onConfigChange}
              cwdErrors={cwdErrors}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function ExtensionsView({ onNavigate }: ExtensionsViewProps) {
  useEnsureExtensionsRegistry()

  const dispatch = useAppDispatch()
  const items = useAppSelector(selectManagedItems)
  const disabledList = useAppSelector((s) => s.settings?.settings?.extensions?.disabled ?? [])
  const enabledProviders = useAppSelector((s) => s.settings?.settings?.codingCli?.enabledProviders ?? [])

  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [cwdErrors, setCwdErrors] = useState<Record<string, string | null>>({})
  const cwdTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const cwdValidationRef = useRef<Record<string, number>>({})
  const textSaveTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const toggleExpand = useCallback((id: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleToggleEnabled = useCallback((item: ManagedItem, enabled: boolean) => {
    if (item.kind === 'cli') {
      const nextProviders = enabled
        ? Array.from(new Set([...enabledProviders, item.id]))
        : enabledProviders.filter((p) => p !== item.id)
      void dispatch(saveServerSettingsPatch({ codingCli: { enabledProviders: nextProviders } }))
    } else {
      const next = enabled
        ? disabledList.filter((n) => n !== item.id)
        : [...new Set([...disabledList, item.id])]
      void dispatch(saveServerSettingsPatch({ extensions: { disabled: next } }))
    }
  }, [dispatch, disabledList, enabledProviders])

  const scheduleTextSave = useCallback((key: string, patch: ServerSettingsPatch) => {
    dispatch(stageServerSettingsPatchPreview({ key, patch }))
    if (textSaveTimerRef.current[key]) {
      clearTimeout(textSaveTimerRef.current[key])
    }
    textSaveTimerRef.current[key] = setTimeout(() => {
      delete textSaveTimerRef.current[key]
      void dispatch(saveServerSettingsPatch({ patch, stagedKey: key }))
    }, SERVER_TEXT_SETTINGS_DEBOUNCE_MS)
  }, [dispatch])

  const scheduleCwdValidation = useCallback((itemId: string, key: string, value: string) => {
    const cwdKey = `${itemId}.${key}`
    if (!cwdValidationRef.current[cwdKey]) cwdValidationRef.current[cwdKey] = 0
    cwdValidationRef.current[cwdKey] += 1
    const validationId = cwdValidationRef.current[cwdKey]
    if (cwdTimerRef.current[cwdKey]) clearTimeout(cwdTimerRef.current[cwdKey])

    cwdTimerRef.current[cwdKey] = setTimeout(() => {
      if (cwdValidationRef.current[cwdKey] !== validationId) return
      const trimmed = value.trim()
      if (!trimmed) {
        setCwdErrors((prev) => ({ ...prev, [cwdKey]: null }))
        void dispatch(saveServerSettingsPatch({
          codingCli: { providers: { [itemId]: { cwd: undefined } } },
        }))
        return
      }

      api.post<{ valid: boolean }>('/api/files/validate-dir', { path: trimmed })
        .then((result) => {
          if (cwdValidationRef.current[cwdKey] !== validationId) return
          if (result.valid) {
            setCwdErrors((prev) => ({ ...prev, [cwdKey]: null }))
            void dispatch(saveServerSettingsPatch({
              codingCli: { providers: { [itemId]: { cwd: trimmed } } },
            }))
          } else {
            setCwdErrors((prev) => ({ ...prev, [cwdKey]: 'directory not found' }))
          }
        })
        .catch(() => {
          if (cwdValidationRef.current[cwdKey] !== validationId) return
          setCwdErrors((prev) => ({ ...prev, [cwdKey]: 'directory not found' }))
        })
    }, 500)
  }, [dispatch])

  const handleConfigChange = useCallback((item: ManagedItem, key: string, value: unknown) => {
    if (item.kind === 'cli') {
      if (key === 'cwd') {
        scheduleCwdValidation(item.id, key, value as string)
        return
      }
      if (key === 'model') {
        const model = (value as string).trim()
        scheduleTextSave(`codingCli.providers.${item.id}.model`, {
          codingCli: { providers: { [item.id]: { model: model || undefined } } },
        })
        return
      }
      // Immediate saves for select fields
      const settingValue = (value === '' || value === 'default') ? undefined : value
      void dispatch(saveServerSettingsPatch({
        codingCli: { providers: { [item.id]: { [key]: settingValue } } },
      }))
    }
  }, [dispatch, scheduleCwdValidation, scheduleTextSave])

  const groups = useMemo(() => {
    const cli = items.filter((i) => i.kind === 'cli')
    const server = items.filter((i) => i.kind === 'server')
    const client = items.filter((i) => i.kind === 'client')
    return [
      { kind: 'cli' as const, items: cli },
      { kind: 'server' as const, items: server },
      { kind: 'client' as const, items: client },
    ].filter((g) => g.items.length > 0)
  }, [items])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border/30 px-3 py-4 md:px-6 md:py-5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate('settings')}
            className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to settings"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Extensions</h1>
            <p className="text-sm text-muted-foreground">
              {items.length} extension{items.length !== 1 ? 's' : ''} installed
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-3 py-4 md:px-6 md:py-6 space-y-6">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Puzzle className="w-12 h-12 mb-4 opacity-50" />
              <p className="text-lg font-medium">No extensions installed</p>
              <p className="text-sm mt-1">
                Drop a directory with a <code className="rounded bg-muted px-1 py-0.5 text-xs">freshell.json</code> into <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.freshell/extensions/</code> and restart.
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.kind}>
                <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                  {groupLabel(group.kind)}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {group.items.map((item) => (
                    <ExtensionCard
                      key={item.id}
                      item={item}
                      expanded={expandedCards.has(item.id)}
                      onToggleExpand={() => toggleExpand(item.id)}
                      onToggleEnabled={handleToggleEnabled}
                      onConfigChange={handleConfigChange}
                      cwdErrors={cwdErrors}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
