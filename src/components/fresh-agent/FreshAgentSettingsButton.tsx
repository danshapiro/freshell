import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { mergePaneContent } from '@/store/panesSlice'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import {
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  getFreshAgentThinkingOptions,
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
  resolveFreshAgentType,
} from '@/lib/fresh-agent-registry'
import { cn } from '@/lib/utils'
import {
  DEFAULT_FRESH_AGENT_STYLE,
  FRESH_AGENT_STYLE_VALUES,
  normalizeFreshAgentStyle,
  type FreshAgentStyle,
} from '@shared/settings'

function getEffectiveFreshAgentModel(content: FreshAgentPaneContent): string | undefined {
  return normalizeFreshAgentModel(content.sessionType, content.provider, content.model)
}

function getEffectiveFreshAgentEffort(content: FreshAgentPaneContent): string | undefined {
  return normalizeFreshAgentEffort(content.sessionType, content.provider, getEffectiveFreshAgentModel(content), content.effort)
}

type PermissionModeOption = { value: string; label: string; description?: string }

/**
 * Permission modes per runtime provider. 'plan' maps to the Claude SDK's
 * read-only research mode; codex modes mirror its approval policies.
 */
const PERMISSION_MODES_BY_PROVIDER: Record<string, PermissionModeOption[]> = {
  claude: [
    { value: 'default', label: 'Default (ask)' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'bypassPermissions', label: 'Bypass permissions' },
    { value: 'plan', label: 'Plan mode (read-only)', description: 'Research and propose; no edits until approved.' },
  ],
  codex: [
    { value: 'read-only', label: 'Read-only' },
    { value: 'on-request', label: 'On request' },
    { value: 'on-failure', label: 'On failure' },
    { value: 'never', label: 'Never ask (full access)' },
  ],
}

export function FreshAgentSettingsButton({
  tabId,
  paneId,
  paneContent,
}: {
  tabId: string
  paneId: string
  paneContent: FreshAgentPaneContent
}) {
  const dispatch = useAppDispatch()
  const providerDefaults = useAppSelector(
    (state) => state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.settings.agentChat?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.agentChat?.providers?.[paneContent.sessionType],
  )
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const activeModel = getEffectiveFreshAgentModel(paneContent)
  const modelOptions = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[paneContent.sessionType] ?? []
  const modelValue = activeModel ?? ''
  const thinkingOptions = getFreshAgentThinkingOptions(paneContent.sessionType, paneContent.provider, activeModel)
  const thinkingValue = getEffectiveFreshAgentEffort(paneContent) ?? ''
  const descriptor = resolveFreshAgentType(paneContent.sessionType)
  const permissionModeVisible = descriptor?.settingsVisibility.permissionMode === true
  const permissionModes = permissionModeVisible
    ? PERMISSION_MODES_BY_PROVIDER[paneContent.provider] ?? []
    : []
  const permissionModeValue = paneContent.permissionMode
    ?? descriptor?.defaultPermissionMode
    ?? ''
  const settingsDisabled = paneContent.status === 'running' || paneContent.status === 'compacting'
  const styleValue = normalizeFreshAgentStyle(
    paneContent.style ?? providerDefaults?.style ?? DEFAULT_FRESH_AGENT_STYLE,
  )

  const close = useCallback(() => setOpen(false), [])
  const persistProviderDefaults = useCallback((defaults: {
    modelSelection?: { kind: 'exact'; modelId: string }
    defaultPermissionMode?: string
    effort?: string
    style?: FreshAgentStyle
  }) => {
    void dispatch(saveServerSettingsPatch({
      freshAgent: {
        providers: {
          [paneContent.sessionType]: defaults,
        },
      },
    }))
  }, [dispatch, paneContent.sessionType])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100 sm:h-4 sm:w-4',
          open && 'bg-background/50 opacity-100',
        )}
        title="Agent settings"
        aria-label="Agent settings"
        aria-expanded={open}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <Settings className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full z-50 mt-1 w-[min(16rem,calc(100vw-1rem))] rounded-md border border-border bg-card p-3 text-xs text-foreground shadow-lg"
          role="dialog"
          aria-label="Agent settings"
        >
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="font-medium">Style</span>
              <select
                aria-label="Style"
                className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                value={styleValue}
                onChange={(event) => {
                  const nextStyle = normalizeFreshAgentStyle(event.target.value)
                  dispatch(mergePaneContent({
                    tabId,
                    paneId,
                    updates: { style: nextStyle },
                  }))
                  persistProviderDefaults({ style: nextStyle })
                }}
              >
                {FRESH_AGENT_STYLE_VALUES.map((style) => (
                  <option key={style} value={style}>
                    {style === 'sans' ? 'Sans' : 'Serif'}
                  </option>
                ))}
              </select>
            </label>

            {modelOptions.length > 0 ? (
              <fieldset className="space-y-1">
                <legend className="font-medium">Model</legend>
                <div className="space-y-1" role="radiogroup" aria-label="Model">
                  {modelOptions.map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        'flex min-h-[2.5rem] cursor-pointer items-center gap-2 rounded border border-border/60 px-2 py-1 transition-colors sm:min-h-0',
                        modelValue === option.value ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                        settingsDisabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                      )}
                    >
                      <input
                        type="radio"
                        className="h-3 w-3"
                        name={`fresh-agent-model-${tabId}-${paneId}`}
                        value={option.value}
                        checked={modelValue === option.value}
                        disabled={settingsDisabled}
                        onChange={() => {
                          const nextModel = option.value
                          const nextEffort = normalizeFreshAgentEffort(
                            paneContent.sessionType,
                            paneContent.provider,
                            nextModel,
                            paneContent.effort,
                          )
                          dispatch(mergePaneContent({
                            tabId,
                            paneId,
                            updates: { model: nextModel, effort: nextEffort },
                          }))
                          persistProviderDefaults({
                            modelSelection: { kind: 'exact', modelId: nextModel },
                            ...(nextEffort ? { effort: nextEffort } : {}),
                          })
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            {thinkingOptions.length > 0 ? (
              <label className="block space-y-1">
                <span className="font-medium">Thinking</span>
                <select
                  aria-label="Thinking level"
                  className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                  value={thinkingValue}
                  disabled={settingsDisabled}
                  onChange={(event) => {
                    const nextEffort = event.target.value
                    dispatch(mergePaneContent({
                      tabId,
                      paneId,
                      updates: { effort: nextEffort },
                    }))
                    persistProviderDefaults({ effort: nextEffort })
                  }}
                >
                  {thinkingOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {permissionModes.length > 0 ? (
              <label className="block space-y-1">
                <span className="font-medium">Permission mode</span>
                <select
                  aria-label="Permission mode"
                  className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                  value={permissionModeValue}
                  disabled={settingsDisabled}
                  onChange={(event) => {
                    const nextPermissionMode = event.target.value
                    dispatch(mergePaneContent({
                      tabId,
                      paneId,
                      updates: { permissionMode: nextPermissionMode },
                    }))
                    persistProviderDefaults({ defaultPermissionMode: nextPermissionMode })
                  }}
                >
                  {permissionModes.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {permissionModes.find((option) => option.value === permissionModeValue)?.description ? (
                  <span className="block text-[11px] text-muted-foreground">
                    {permissionModes.find((option) => option.value === permissionModeValue)?.description}
                  </span>
                ) : null}
                <span className="block text-[11px] text-muted-foreground">
                  Applies from the next message.
                </span>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default FreshAgentSettingsButton
